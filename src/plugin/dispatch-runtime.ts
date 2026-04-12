import crypto from "node:crypto";
import { formatTaskPrompt } from "./dispatch";
import {
  buildQAReviewPrompt,
  extractCommitHash,
  extractOutputFromMessages,
  parseMaatVerdict,
  truncateForPrompt,
} from "./qa";

import {
  buildDiscordAcpPromptContext,
  buildDiscordAgentTarget,
  buildExistingThreadDispatchMessage,
} from "./thread-messages";
import type { PluginApi, PluginConfig, Task } from "./types";
import type { DatabaseLike } from "./runtime-types";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let acpStartupGateResolved = false;
let acpStartupGatePromise: Promise<void> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function waitForAcpStartupGate(cooldownMs: number): Promise<void> {
  if (cooldownMs <= 0) return Promise.resolve();
  if (acpStartupGateResolved) return Promise.resolve();
  if (!acpStartupGatePromise) {
    acpStartupGatePromise = sleep(cooldownMs).then(() => {
      acpStartupGateResolved = true;
    });
  }
  return acpStartupGatePromise;
}

export function sanitizeAcpThreadOutput(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith("cwd:")) return false;
      if (trimmed.startsWith("Background task done:")) return false;
      if (trimmed.startsWith("⚙️") && trimmed.includes("session active")) return false;
      return true;
    })
    .join("\n")
    .trim();
}

export function buildAcpOutputFromThreadMessages(messages: string[]): string {
  return messages
    .slice()
    .reverse()
    .map((message) => sanitizeAcpThreadOutput(message))
    .filter((message) => message.length > 0)
    .join("\n\n")
    .trim();
}

async function resolveBoundThreadIdForSession(sessionKey: string): Promise<string | null> {
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const bindingsPath = path.join(home, ".openclaw", "discord", "thread-bindings.json");
    const raw = fs.readFileSync(bindingsPath, "utf-8");
    const data = JSON.parse(raw) as {
      bindings?: Record<string, { targetSessionKey?: string; threadId?: string }>;
    };
    for (const entry of Object.values(data.bindings ?? {})) {
      if (entry.targetSessionKey === sessionKey && entry.threadId) {
        return entry.threadId;
      }
    }
  } catch {
    // best-effort
  }
  return null;
}

async function waitForBoundThreadIdForSession(
  sessionKey: string,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const threadId = await resolveBoundThreadIdForSession(sessionKey);
    if (threadId) return threadId;
    if (Date.now() >= deadline) break;
    await sleep(250);
  }
  return null;
}

async function waitForAcpThreadOutput(params: {
  readThreadMessages: (threadId: string, accountId: string, limit?: number) => Promise<string[]>;
  threadId: string;
  accountId: string;
  timeoutMs: number;
}): Promise<string> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() <= deadline) {
    const messages = await params.readThreadMessages(params.threadId, params.accountId, 20);
    const text = buildAcpOutputFromThreadMessages(messages);
    if (text) return text;
    if (Date.now() >= deadline) break;
    await sleep(250);
  }
  return "";
}

type DispatchRuntimeDeps = {
  api: PluginApi;
  config: PluginConfig;
  db: DatabaseLike;
  defaultCwd: string;
  acpStartupCooldownMs: number;
  defaultReviewTimeoutMs: number;
  maxConcurrentSessions: number;
  maxReviewCycles: number;
  defaultDiscordAccountId: string;
  resolveCwd: (task: Partial<Task>) => string | null;
  resolveRuntime: (task: Partial<Task>) => string;
  resolveHarness: (task: Partial<Task>) => string;
  resolveChannel: (task: Partial<Task>) => string | null;
  resolveTaskTimeoutMs: (task: Partial<Task>) => number;
  resolveQaRequired: (task: Partial<Task>) => boolean;
  resolveAccountId: (agent: string) => string;
  createDiscordThread: (task: Task) => Promise<string | null>;
  postToThread: (threadId: string | null, content: string, accountId: string) => Promise<void>;
  readThreadMessages: (threadId: string, accountId: string, limit?: number) => Promise<string[]>;
  formatDiscordThreadUrl: (threadId: string | null | undefined) => string | null;
  operatorLabel: string;
  getActiveSessionCount: () => number;
  getTask: (id: string) => Task | null;
  rowToTask: (row: Record<string, unknown> | null | undefined) => Task | null;
  onTaskChanged: (taskId: string) => void;
  recordTaskEvent: (
    taskId: string,
    eventType: string,
    payload?: Record<string, unknown> | null,
  ) => void;
  triggerDependents: (taskId: string) => void;
  notifyMainSession: (task: Task, status: string) => Promise<void>;
  backgroundEnqueue: (taskId: string) => void;
  stderr: Pick<typeof process.stderr, "write">;
};

export function createDispatchRuntime(deps: DispatchRuntimeDeps) {
  async function runMaatOneShotReview(task: Task) {
    const subagent = deps.api.runtime?.subagent;
    if (!subagent?.run || !subagent.waitForRun || !subagent.getSessionMessages) {
      throw new Error("subagent review runtime not available");
    }

    if (task.threadId) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await deps
        .postToThread(task.threadId, "🔍 **QA in progress** — Nemesis is reviewing...", "nemesis")
        .catch(() => {});
    }

    const maatSessionKey = `agent:nemesis:subagent:review:${crypto.randomUUID()}`;
    const reviewPrompt = buildQAReviewPrompt(task, deps.resolveCwd);
    const qaModel = deps.config.agents?.nemesis?.model || "kimi-code";
    deps.recordTaskEvent(task.id, "qa.started", {
      reviewer: "nemesis",
      model: qaModel,
      threadId: task.threadId || null,
    });

    const run = await subagent.run({
      sessionKey: maatSessionKey,
      message: reviewPrompt,
      idempotencyKey: crypto.randomUUID(),
      lane: "subagent",
      model: qaModel,
    });
    const reviewRunId = typeof run?.runId === "string" ? run.runId.trim() : "";
    if (!reviewRunId) throw new Error("QA review run did not return runId");

    const wait = await subagent.waitForRun({
      runId: reviewRunId,
      timeoutMs: deps.defaultReviewTimeoutMs,
    });
    const waitStatus = wait?.status || "timeout";
    if (waitStatus !== "ok") {
      const waitError = wait?.error ? `: ${wait.error}` : "";
      throw new Error(`QA review run failed (${waitStatus})${waitError}`);
    }

    const sessionMessages = await subagent.getSessionMessages({
      sessionKey: maatSessionKey,
      limit: 200,
    });
    const verdictText = extractOutputFromMessages(sessionMessages?.messages || []);
    const parsed = parseMaatVerdict(verdictText);
    return {
      runId: reviewRunId,
      text: verdictText,
      verdict: parsed.verdict,
      summary: parsed.summary,
    };
  }

  async function requestAgentFix(task: Task, reviewText: string): Promise<string> {
    const acp = deps.api.runtime?.acp;
    const subagent = deps.api.runtime?.subagent;
    if (!acp?.prompt || !subagent?.waitForRun) {
      throw new Error("agent fix runtime not available");
    }

    const accountId = deps.resolveAccountId(task.agent);
    const prompt = [
      `@${task.agent}`,
      "",
      "QA requested changes on your latest submission.",
      "Apply the requested fixes, update code as needed, and report back with the new commit hash.",
      "",
      "QA feedback:",
      reviewText,
    ].join("\n");

    const result = await acp.prompt({
      sessionKey: task.sessionKey || "",
      text: prompt,
      ...buildDiscordAcpPromptContext(task.threadId, accountId),
    });
    const runId = typeof result?.runId === "string" ? result.runId.trim() : "";
    if (!runId) throw new Error("acp.prompt did not return runId");

    const wait = await subagent.waitForRun({ runId, timeoutMs: deps.resolveTaskTimeoutMs(task) });
    const waitStatus = wait?.status || "timeout";
    if (waitStatus !== "ok") {
      const waitError = wait?.error ? `: ${wait.error}` : "";
      throw new Error(`revision run failed (${waitStatus})${waitError}`);
    }

    if (!subagent.getSessionMessages || !task.sessionKey) return "";
    const sessionMessages = await subagent.getSessionMessages({
      sessionKey: task.sessionKey,
      limit: 200,
    });
    return extractOutputFromMessages(sessionMessages?.messages || []);
  }

  async function runMaatReviewLoop(taskId: string): Promise<void> {
    let task = deps.getTask(taskId);
    if (!task || task.status !== "review") return;
    if (!task.sessionKey) {
      deps.stderr.write(`[MAAT] Task ${task.id} missing sessionKey, skipping review\n`);
      return;
    }

    while (task && task.status === "review") {
      const review = await runMaatOneShotReview(task);
      const reviewText = truncateForPrompt(review.text || "", 2000);
      deps.recordTaskEvent(task.id, `qa.${review.verdict}`, {
        summary: review.summary,
        attempts: task.reviewAttempts || 0,
      });
      const reviewMessage = [
        `VERDICT: ${review.verdict === "approve" ? "APPROVE" : "REQUEST_CHANGES"}`,
        `SUMMARY: ${review.summary}`,
      ].join("\n");

      if (task.threadId) {
        await deps.postToThread(task.threadId, `🔎 **QA verdict**\n\n${reviewMessage}`, "nemesis");
      }

      const outputWithReview =
        `${task.output || ""}\n\n[QA Review]\n${reviewMessage}\n\n${reviewText}`
          .trim()
          .slice(0, 10000);

      if (review.verdict === "approve") {
        const now = Date.now();
        deps.db
          .prepare(
            "UPDATE tasks SET status = 'done', output = @output, completed_at = @completed_at, updated_at = @updated_at WHERE id = @id",
          )
          .run({ id: task.id, output: outputWithReview, completed_at: now, updated_at: now });
        await deps.notifyMainSession(task, "done");
        deps.onTaskChanged(task.id);
        deps.triggerDependents(task.id);
        return;
      }

      const nextAttempts = (task.reviewAttempts || 0) + 1;
      if (nextAttempts >= deps.maxReviewCycles) {
        const now = Date.now();
        const blockError = "QA rejected 3 times. Manual intervention required.";
        deps.db
          .prepare(
            "UPDATE tasks SET status = 'blocked', review_attempts = @attempts, output = @output, error = @error, updated_at = @updated_at WHERE id = @id",
          )
          .run({
            id: task.id,
            attempts: nextAttempts,
            output: outputWithReview,
            error: blockError,
            updated_at: now,
          });
        deps.onTaskChanged(task.id);
        const blockedTask = deps.getTask(task.id);
        if (task.threadId) {
          await deps.postToThread(
            task.threadId,
            "⛔ **Task blocked** — review failed 3 times, needs human intervention.",
            deps.resolveAccountId(task.agent),
          );
        }
        await deps.notifyMainSession(blockedTask || task, "blocked");
        return;
      }

      deps.db
        .prepare(
          "UPDATE tasks SET status = 'in_progress', review_attempts = @attempts, output = @output, updated_at = @updated_at WHERE id = @id",
        )
        .run({
          id: task.id,
          attempts: nextAttempts,
          output: outputWithReview,
          updated_at: Date.now(),
        });
      deps.onTaskChanged(task.id);

      const agentFixOutput = await requestAgentFix(task, `${reviewMessage}\n\n${reviewText}`);
      deps.db
        .prepare(
          "UPDATE tasks SET status = 'review', output = @output, completed_at = NULL, updated_at = @updated_at WHERE id = @id",
        )
        .run({
          id: task.id,
          output: (agentFixOutput || task.output || "").slice(0, 10000),
          updated_at: Date.now(),
        });
      deps.onTaskChanged(task.id);
      task = deps.getTask(task.id);
    }
  }

  function triggerDispatch(taskId: string): void {
    const task = deps.getTask(taskId);
    if (!task || task.status !== "ready") return;
    deps.backgroundEnqueue(taskId);
    deps.recordTaskEvent(taskId, "dispatch.queued", null);
  }

  async function dispatchTask(task: Task): Promise<void> {
    deps.stderr.write(`[DISPATCH] Starting task ${task.id} agent=${task.agent}\n`);
    if (deps.getActiveSessionCount() >= deps.maxConcurrentSessions) {
      deps.stderr.write(`[DISPATCH] Session limit reached\n`);
      return;
    }

    try {
      const runtimeType = deps.resolveRuntime(task);
      const harness = deps.resolveHarness(task);
      const acpBackend = runtimeType === "acp" ? harness : task.agent;
      const sessionKey = `agent:${acpBackend}:${runtimeType}:${crypto.randomUUID()}`;
      const cwd = deps.resolveCwd(task);
      deps.stderr.write(`[DISPATCH] ${runtimeType} spawn for ${task.id}\n`);

      if (runtimeType === "acp") {
        await dispatchAcp(task, sessionKey, cwd);
      } else {
        await dispatchSubagent(task, sessionKey);
      }
    } catch (error) {
      const message = getErrorMessage(error);
      const currentTask = deps.getTask(task.id) || task;
      if (!["done", "cancelled", "error"].includes(currentTask.status)) {
        deps.db
          .prepare(
            "UPDATE tasks SET status = 'error', error = @error, retries = retries + 1, updated_at = @updated_at WHERE id = @id",
          )
          .run({
            id: task.id,
            error: message,
            updated_at: Date.now(),
          });
      }
      deps.recordTaskEvent(task.id, "dispatch.failed", { error: message });
      deps.onTaskChanged(task.id);
      await deps.notifyMainSession({ ...currentTask, error: message }, "error");
    }
  }

  async function resumeTask(taskId: string): Promise<void> {
    const task = deps.getTask(taskId);
    if (!task || task.status !== "error" || !task.sessionKey) return;
    const acp = deps.api.runtime?.acp;
    const subagent = deps.api.runtime?.subagent;
    if (!acp?.spawn || !subagent?.waitForRun) throw new Error("resume runtime not available");
    const spawnAcp = acp.spawn;
    const resumeSessionId = task.sessionKey;

    await waitForAcpStartupGate(deps.acpStartupCooldownMs);

    const resolvedCwd = task.cwd || deps.resolveCwd(task);
    if (!resolvedCwd) throw new Error("Task has no cwd");
    const accountId = deps.resolveAccountId(task.agent);
    const channelId = deps.resolveChannel(task);

    deps.db
      .prepare(
        "UPDATE tasks SET status = 'in_progress', error = NULL, updated_at = @updated_at WHERE id = @id",
      )
      .run({ id: task.id, updated_at: Date.now() });
    deps.recordTaskEvent(task.id, "task.resume_triggered", {
      sessionKey: task.sessionKey,
      threadId: task.threadId || null,
    });
    deps.onTaskChanged(task.id);

    if (task.threadId) {
      await deps
        .postToThread(
          task.threadId,
          "🔄 **Resuming session** — picking up where we left off...",
          deps.resolveAccountId(task.agent),
        )
        .catch(() => {});
    }

    const resumeHarness = deps.resolveHarness(task);
    const resumeThreadId = task.threadId || undefined;
    const result = await spawnAcp(
      {
        task: "Continue where you left off. Your previous session was interrupted. Check git log and git status to see your progress, then complete the remaining work.",
        agentId: resumeHarness,
        cwd: resolvedCwd,
        resumeSessionId,
        mode: "session",
        thread: true,
      },
      {
        agentChannel: "discord",
        agentAccountId: accountId,
        agentTo: buildDiscordAgentTarget(resumeThreadId, channelId),
        agentThreadId: resumeThreadId,
      },
    );

    if (result?.status !== "accepted") {
      throw new Error(
        result?.error || `resume spawn failed with status=${result?.status || "unknown"}`,
      );
    }

    const childRunId = typeof result?.runId === "string" ? result.runId.trim() : "";
    const childSessionKey = result?.childSessionKey || task.sessionKey;
    if (!childRunId) throw new Error("resume spawn did not return runId");

    deps.db
      .prepare(
        "UPDATE tasks SET session_key = @sessionKey, run_id = @runId, updated_at = @updated_at WHERE id = @id",
      )
      .run({ id: task.id, sessionKey: childSessionKey, runId: childRunId, updated_at: Date.now() });

    const wait = await subagent.waitForRun({
      runId: childRunId,
      timeoutMs: deps.resolveTaskTimeoutMs(task),
    });
    const waitStatus = wait?.status || "timeout";
    if (waitStatus !== "ok") {
      const waitError = wait?.error ? `: ${wait.error}` : "";
      throw new Error(`resumed run failed (${waitStatus})${waitError}`);
    }

    let text = "";
    if (subagent.getSessionMessages) {
      const msgs = await subagent.getSessionMessages({ sessionKey: childSessionKey, limit: 200 });
      text = extractOutputFromMessages(msgs?.messages || []);
    }

    deps.db
      .prepare(
        "UPDATE tasks SET status = 'review', output = @output, completed_at = NULL, updated_at = @updated_at WHERE id = @id",
      )
      .run({ id: task.id, output: text.slice(0, 10000), updated_at: Date.now() });

    if (task.threadId) {
      const summary = text.slice(0, 1500);
      await deps.postToThread(
        task.threadId,
        `✅ **Resume completed**\n\n${summary}${text.length > 1500 ? "..." : ""}`,
        deps.resolveAccountId(task.agent),
      );
    }
    deps.onTaskChanged(task.id);
    const freshTask = deps.getTask(task.id);
    if (deps.resolveQaRequired(freshTask || task)) await runMaatReviewLoop(task.id);
    else {
      const doneNow = Date.now();
      deps.db
        .prepare(
          "UPDATE tasks SET status = 'done', completed_at = @completed_at, updated_at = @updated_at WHERE id = @id",
        )
        .run({ id: task.id, completed_at: doneNow, updated_at: doneNow });
      await deps.notifyMainSession(freshTask || task, "done");
      deps.onTaskChanged(task.id);
      deps.triggerDependents(task.id);
    }
  }

  async function runQueuedQaReview(taskId: string): Promise<void> {
    try {
      await runMaatReviewLoop(taskId);
    } catch (error) {
      deps.db
        .prepare(
          "UPDATE tasks SET status = 'error', error = @error, retries = retries + 1, updated_at = @updated_at WHERE id = @id",
        )
        .run({
          id: taskId,
          error: `Manual QA review failed: ${getErrorMessage(error)}`,
          updated_at: Date.now(),
        });
      deps.onTaskChanged(taskId);
    }
  }

  async function notifyMainSession(task: Task, status: string): Promise<void> {
    const prompt = deps.api.runtime?.acp?.prompt;
    if (!prompt) {
      deps.stderr.write(`[NOTIFY-SESSION] api.runtime.acp.prompt not available\n`);
      return;
    }
    const sessionKey = deps.config.notifications?.operatorSessionKey;
    if (!sessionKey) return;
    const threadLink = task.threadId ? deps.formatDiscordThreadUrl(task.threadId) || "" : "";
    const commitHash = extractCommitHash(task.output || "");
    const icon =
      status === "done" ? "✅" : status === "error" ? "❌" : status === "blocked" ? "⚠️" : "ℹ️";
    const text = [
      `[Task Completion — relay to configured operator]`,
      "",
      `${icon} Task ${status}: "${task.title}"`,
      `ID: ${task.id.slice(0, 8)}`,
      commitHash ? `Commit: ${commitHash}` : null,
      task.error ? `Error: ${task.error.slice(0, 200)}` : null,
      threadLink ? `Thread: ${threadLink}` : null,
      "",
      `ACTION REQUIRED: Use the message tool to notify the configured ${deps.operatorLabel} about this task completion. Summarize what was done and include the thread link if available.`,
    ]
      .filter(Boolean)
      .join("\n");
    await prompt({ sessionKey, text });
    deps.stderr.write(
      `[NOTIFY-SESSION] Prompted operator session (${status}) for task ${task.id.slice(0, 8)}\n`,
    );
  }

  async function dispatchAcp(task: Task, sessionKey: string, cwd: string | null): Promise<void> {
    const acp = deps.api.runtime?.acp;
    const subagent = deps.api.runtime?.subagent;
    if (!acp?.spawn)
      throw new Error(
        "api.runtime.acp.spawn not available — OpenClaw build with ACP plugin runtime required",
      );
    if (!subagent?.waitForRun) throw new Error("subagent.waitForRun not available");
    const spawnAcp = acp.spawn;

    // After a gateway restart, Discord's full child-thread binding adapter can
    // take a while to register. A single startup cooldown is less noisy than
    // speculative retries that create stray ACP sessions.
    await waitForAcpStartupGate(deps.acpStartupCooldownMs);

    const resolvedCwd = cwd || deps.defaultCwd;
    const prompt = formatTaskPrompt(task);
    const channelId = deps.resolveChannel(task);
    const accountId = deps.resolveAccountId(task.agent);
    const existingThreadId =
      typeof task.threadId === "string" && task.threadId.trim() ? task.threadId.trim() : null;

    deps.db
      .prepare(
        "UPDATE tasks SET status = 'dispatched', session_key = @sessionKey, run_id = NULL, updated_at = @updated_at WHERE id = @id",
      )
      .run({ id: task.id, sessionKey, updated_at: Date.now() });
    deps.onTaskChanged(task.id);

    let childSessionKey = sessionKey;
    let childRunId = "";
    const harness = deps.resolveHarness(task);
    // Let ACP own thread creation via "child" placement.  Pass the parent
    // channel as agentTo so ACP creates a new thread inside it and binds the
    // session to that thread.  If the task already has a thread (e.g. requeue),
    // target that thread directly with agentThreadId so ACP binds to it.
    const spawnCtx = existingThreadId
      ? {
          agentChannel: "discord",
          agentAccountId: accountId,
          agentTo: `channel:${existingThreadId}`,
          agentThreadId: existingThreadId,
        }
      : {
          agentChannel: "discord",
          agentAccountId: accountId,
          agentTo: channelId ? `channel:${channelId}` : undefined,
          agentGroupId: channelId || undefined,
        };
    const result = await spawnAcp(
      {
        task: prompt,
        agentId: harness,
        cwd: resolvedCwd,
        mode: "session",
        thread: true,
      },
      spawnCtx,
    );
    if (result?.status !== "accepted") {
      throw new Error(result?.error || `acp spawn failed with status=${result?.status || "unknown"}`);
    }
    childSessionKey = result?.childSessionKey || sessionKey;
    childRunId = typeof result?.runId === "string" ? result.runId.trim() : "";
    if (!childRunId) throw new Error("acp spawn did not return runId");

    deps.db
      .prepare(
        "UPDATE tasks SET session_key = @sessionKey, run_id = @runId, updated_at = @updated_at WHERE id = @id",
      )
      .run({
        id: task.id,
        sessionKey: childSessionKey,
        runId: childRunId,
        updated_at: Date.now(),
      });

    // Resolve the thread ID: for existing threads we already know it; for new
    // spawns ACP created the thread via "child" placement — read it from the
    // thread-bindings.json file using the child session key.
    let dispatchThreadId = existingThreadId;
    if (!dispatchThreadId) {
      dispatchThreadId = await waitForBoundThreadIdForSession(childSessionKey, 4000);
      if (!dispatchThreadId) {
        throw new Error(
          "acp spawn accepted but no Discord child thread binding was created within 4s",
        );
      }
    }

    deps.db
      .prepare(
        "UPDATE tasks SET session_key = @sessionKey, run_id = @runId, thread_id = @threadId, updated_at = @updated_at WHERE id = @id",
      )
      .run({
        id: task.id,
        sessionKey: childSessionKey,
        runId: childRunId,
        threadId: dispatchThreadId || null,
        updated_at: Date.now(),
      });
    task.threadId = dispatchThreadId || null;
    task.sessionKey = childSessionKey;

    if (existingThreadId) {
      await deps
        .postToThread(
          existingThreadId,
          buildExistingThreadDispatchMessage(task, resolvedCwd ?? undefined),
          accountId,
        )
        .catch(() => {});
      deps.recordTaskEvent(task.id, "thread.reused.notified", {
        threadId: existingThreadId,
        sessionKey: childSessionKey,
        runId: childRunId,
      });
    }

    const wait = await subagent.waitForRun({
      runId: childRunId,
      timeoutMs: deps.resolveTaskTimeoutMs(task),
    });
    const waitStatus = wait?.status || "timeout";
    const waitError = wait?.error || "";
    if (waitStatus !== "ok") {
      const error =
        waitStatus === "timeout"
          ? "ACP run timed out while waiting for completion"
          : `ACP run failed${waitError ? `: ${waitError}` : ""}`;
      deps.db
        .prepare(
          "UPDATE tasks SET status = 'error', error = @error, retries = retries + 1, updated_at = @updated_at WHERE id = @id",
        )
        .run({ id: task.id, error, updated_at: Date.now() });
      deps.onTaskChanged(task.id);
      await deps.notifyMainSession({ ...task, error }, "error");
      return;
    }

    let text = "";
    if (subagent.getSessionMessages) {
      const sessionMessages = await subagent.getSessionMessages({
        sessionKey: childSessionKey,
        limit: 200,
      });
      text = extractOutputFromMessages(sessionMessages?.messages || []);
      text = sanitizeAcpThreadOutput(text);
    }

    // ACP sessions don't store messages in the subagent message store.
    // Fall back to reading the Discord thread for the agent's output.
    // First resolve the created/bound thread id from the binding store if ACP
    // created one for us.
    if (!task.threadId) {
      task.threadId = await resolveBoundThreadIdForSession(childSessionKey);
      if (task.threadId) {
        deps.db
          .prepare(
            "UPDATE tasks SET thread_id = @threadId, updated_at = @updated_at WHERE id = @id",
          )
          .run({ id: task.id, threadId: task.threadId, updated_at: Date.now() });
      }
    }

    if (task.threadId) {
      const accountId = deps.resolveAccountId(task.agent);
      const threadText = await waitForAcpThreadOutput({
        readThreadMessages: deps.readThreadMessages,
        threadId: task.threadId,
        accountId,
        timeoutMs: 8000,
      });
      if (threadText) {
        text =
          !text || threadText.includes("```json") || threadText.length > text.length
            ? threadText
            : [text, threadText].filter(Boolean).join("\n\n");
        deps.stderr.write(
          `[DISPATCH.ACP] Recovered ${threadText.length} chars from Discord thread for ${task.id}\n`,
        );
      }
    }
    text = sanitizeAcpThreadOutput(text);

    deps.db
      .prepare(
        "UPDATE tasks SET status = 'review', output = @output, completed_at = NULL, updated_at = @updated_at WHERE id = @id",
      )
      .run({ id: task.id, output: text.slice(0, 10000), updated_at: Date.now() });
    deps.onTaskChanged(task.id);
    const freshTask = deps.getTask(task.id);
    if (deps.resolveQaRequired(freshTask || task)) {
      try {
        await runMaatReviewLoop(task.id);
      } catch (error) {
        deps.db
          .prepare(
            "UPDATE tasks SET status = 'error', error = @error, retries = retries + 1, updated_at = @updated_at WHERE id = @id",
          )
          .run({
            id: task.id,
            error: `QA review loop failed: ${getErrorMessage(error)}`,
            updated_at: Date.now(),
          });
        deps.onTaskChanged(task.id);
      }
    } else {
      const now = Date.now();
      deps.db
        .prepare(
          "UPDATE tasks SET status = 'done', completed_at = @completed_at, updated_at = @updated_at WHERE id = @id",
        )
        .run({ id: task.id, completed_at: now, updated_at: now });
      await deps.notifyMainSession(freshTask || task, "done");
      deps.onTaskChanged(task.id);
      deps.triggerDependents(task.id);
    }
  }

  function triggerDependents(completedTaskId: string): void {
    try {
      const candidates = deps.db
        .prepare<Record<string, unknown>>(
          `SELECT * FROM tasks WHERE status = 'pending'
           AND EXISTS (
             SELECT 1 FROM json_each(depends_on) d WHERE d.value = ?
           )`,
        )
        .all(completedTaskId)
        .map((row) => deps.rowToTask(row));

      for (const candidate of candidates) {
        if (!candidate) continue;
        const depIds = candidate.dependsOn || [];
        if (depIds.length === 0) continue;
        const placeholders = depIds.map(() => "?").join(",");
        const doneCount = deps.db
          .prepare<{ c: number }>(
            `SELECT COUNT(*) as c FROM tasks WHERE id IN (${placeholders}) AND status = 'done'`,
          )
          .get(...depIds);
        if (doneCount && doneCount.c === depIds.length) {
          deps.db
            .prepare("UPDATE tasks SET status = 'ready', updated_at = ? WHERE id = ?")
            .run(Date.now(), candidate.id);
          deps.onTaskChanged(candidate.id);
          deps.backgroundEnqueue(candidate.id);
        }
      }
    } catch (error) {
      deps.stderr.write(`[DAG] triggerDependents error: ${getErrorMessage(error)}\n`);
    }
  }

  async function dispatchSubagent(task: Task, sessionKey: string): Promise<void> {
    const subagent = deps.api.runtime?.subagent;
    if (!subagent?.run) throw new Error("api.runtime.subagent.run not available");

    deps.db
      .prepare(
        "UPDATE tasks SET session_key = @sessionKey, run_id = NULL, status = 'dispatched', updated_at = @updated_at WHERE id = @id",
      )
      .run({ id: task.id, sessionKey, updated_at: Date.now() });
    deps.onTaskChanged(task.id);

    const threadId = await deps.createDiscordThread(task);
    if (threadId) task.threadId = threadId;
    const prompt = formatTaskPrompt(task);
    const run = await subagent.run({
      sessionKey,
      message: prompt,
      idempotencyKey: crypto.randomUUID(),
      lane: "subagent",
    });
    const runId = typeof run?.runId === "string" ? run.runId.trim() : "";
    if (runId) {
      deps.db
        .prepare("UPDATE tasks SET run_id = @runId, updated_at = @updated_at WHERE id = @id")
        .run({
          id: task.id,
          runId,
          updated_at: Date.now(),
        });
    }
    if (!subagent.waitForRun) throw new Error("api.runtime.subagent.waitForRun not available");
    if (runId) {
      const wait = await subagent.waitForRun({ runId, timeoutMs: deps.resolveTaskTimeoutMs(task) });
      const waitStatus = wait?.status || "timeout";
      if (waitStatus !== "ok") {
        const waitError = wait?.error ? `: ${wait.error}` : "";
        deps.db
          .prepare(
            "UPDATE tasks SET status = 'error', error = @error, retries = retries + 1, updated_at = @updated_at WHERE id = @id",
          )
          .run({
            id: task.id,
            error: `subagent run failed (${waitStatus})${waitError}`,
            updated_at: Date.now(),
          });
        deps.onTaskChanged(task.id);
        return;
      }
    }
    let output = "";
    try {
      if (subagent.getSessionMessages) {
        const sessionMessages = await subagent.getSessionMessages({ sessionKey, limit: 200 });
        output = extractOutputFromMessages(sessionMessages?.messages || []);
      }
    } catch (error) {
      deps.stderr.write(`[DISPATCH.subagent] Could not get messages: ${getErrorMessage(error)}\n`);
    }

    deps.db
      .prepare(
        "UPDATE tasks SET status = 'review', output = @output, completed_at = NULL, updated_at = @updated_at WHERE id = @id",
      )
      .run({ id: task.id, output: output.slice(0, 10000), updated_at: Date.now() });
    if (task.threadId) {
      const summary = output.slice(0, 1500);
      await deps.postToThread(
        task.threadId,
        `✅ **Task completed**\n\n**Output:**\n${summary}${output.length > 1500 ? "..." : ""}`,
        deps.resolveAccountId(task.agent),
      );
    }
    deps.onTaskChanged(task.id);
    if (deps.resolveQaRequired(task)) {
      try {
        await runMaatReviewLoop(task.id);
      } catch (error) {
        deps.db
          .prepare(
            "UPDATE tasks SET status = 'error', error = @error, retries = retries + 1, updated_at = @updated_at WHERE id = @id",
          )
          .run({
            id: task.id,
            error: `QA review loop failed: ${getErrorMessage(error)}`,
            updated_at: Date.now(),
          });
        deps.onTaskChanged(task.id);
      }
    } else {
      const now = Date.now();
      deps.db
        .prepare(
          "UPDATE tasks SET status = 'done', completed_at = @completed_at, updated_at = @updated_at WHERE id = @id",
        )
        .run({ id: task.id, completed_at: now, updated_at: now });
      await deps.notifyMainSession(task, "done");
      deps.onTaskChanged(task.id);
      deps.triggerDependents(task.id);
    }
  }

  return {
    runMaatOneShotReview,
    requestAgentFix,
    runMaatReviewLoop,
    triggerDispatch,
    dispatchTask,
    resumeTask,
    runQueuedQaReview,
    notifyMainSession,
    dispatchAcp,
    triggerDependents,
    dispatchSubagent,
  };
}
