import crypto from "node:crypto";
import { getAcpSessionManager } from "openclaw/plugin-sdk/acp-runtime";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-binding-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatTaskPrompt } from "./dispatch";
import {
  buildQAReviewPrompt,
  extractCommitHash,
  extractOutputFromMessages,
  parseMaatVerdict,
  truncateForPrompt,
} from "./qa";
import { parseReviewSummary } from "./review";

import { buildExistingThreadDispatchMessage } from "./thread-messages";
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
      if (trimmed.startsWith("🚀 **Task dispatched")) return false;
      if (trimmed.startsWith("✅ **Task completed**")) return false;
      if (trimmed.startsWith("🔄 **Resuming session**")) return false;
      if (trimmed.startsWith("✅ **Resume completed**")) return false;
      if (trimmed.startsWith("🔍 **QA in progress**")) return false;
      if (trimmed.startsWith("🔎 **QA verdict**")) return false;
      if (trimmed.startsWith("⛔ **Task blocked**")) return false;
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
  limit?: number;
  validator?: (text: string) => boolean;
  pollIntervalMs?: number;
}): Promise<string> {
  const deadline = Date.now() + params.timeoutMs;
  const interval = params.pollIntervalMs ?? 250;
  let lastText = "";
  while (Date.now() <= deadline) {
    try {
      const messages = await params.readThreadMessages(
        params.threadId,
        params.accountId,
        params.limit ?? 20,
      );
      const text = buildAcpOutputFromThreadMessages(messages);
      if (text) {
        lastText = text;
        if (!params.validator || params.validator(text)) {
          return text;
        }
      }
    } catch {
      // Discord API may transiently fail; keep polling
    }
    if (Date.now() >= deadline) break;
    await sleep(interval);
  }
  return lastText;
}

async function waitForNewAcpThreadOutput(params: {
  readThreadMessages: (threadId: string, accountId: string, limit?: number) => Promise<string[]>;
  threadId: string;
  accountId: string;
  timeoutMs: number;
  baselineMessages: string[];
}): Promise<string> {
  const baseline = new Set(
    (params.baselineMessages || [])
      .map((message) => sanitizeAcpThreadOutput(message))
      .filter((message) => message.length > 0),
  );
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() <= deadline) {
    const messages = await params.readThreadMessages(params.threadId, params.accountId, 20);
    const newMessages = (messages || []).filter((message) => {
      const sanitized = sanitizeAcpThreadOutput(message);
      if (!sanitized) return false;
      return !baseline.has(sanitized);
    });
    const text = buildAcpOutputFromThreadMessages(newMessages);
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
  reviewThreadPollTimeoutMs: number;
  reviewThreadPollLimit: number;
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
  getAcpSessionManager?: () => {
    initializeSession: (input: {
      cfg: OpenClawConfig;
      sessionKey: string;
      agent: string;
      mode: "persistent" | "oneshot";
      resumeSessionId?: string;
      cwd?: string;
      backendId?: string;
    }) => Promise<unknown>;
    runTurn: (input: {
      cfg: OpenClawConfig;
      sessionKey: string;
      text: string;
      mode: "prompt" | "steer";
      requestId: string;
    }) => Promise<void>;
  };
  getSessionBindingService?: () => {
    bind: (input: {
      targetSessionKey: string;
      targetKind: "session";
      conversation: {
        channel: string;
        accountId: string;
        conversationId: string;
        parentConversationId?: string;
      };
      placement?: "current" | "child";
      metadata?: Record<string, unknown>;
    }) => Promise<{
      conversation: {
        conversationId: string;
      };
    }>;
  };
  stderr: Pick<typeof process.stderr, "write">;
};

export function createDispatchRuntime(deps: DispatchRuntimeDeps) {
  function requireOpenClawConfig(): OpenClawConfig {
    const cfg = deps.api.config as OpenClawConfig | undefined;
    if (!cfg) {
      throw new Error("OpenClaw runtime config not available");
    }
    return cfg;
  }

  function acpManager() {
    return deps.getAcpSessionManager?.() ?? getAcpSessionManager();
  }

  function bindingService() {
    return deps.getSessionBindingService?.() ?? getSessionBindingService();
  }

  async function startAcpPromptTurn(params: {
    sessionKey: string;
    text: string;
  }): Promise<{ runId: string; completion: Promise<void> }> {
    const runId = crypto.randomUUID();
    const completion = acpManager().runTurn({
      cfg: requireOpenClawConfig(),
      sessionKey: params.sessionKey,
      text: params.text,
      mode: "prompt",
      requestId: runId,
    });
    return { runId, completion };
  }

  async function runAcpTurnWithThreadOutput(params: {
    sessionKey: string;
    text: string;
    threadId: string | null;
    accountId: string;
    timeoutMs: number;
    limit?: number;
    validator?: (text: string) => boolean;
    pollIntervalMs?: number;
    baselineMessages?: string[];
  }): Promise<{ runId: string; text: string }> {
    const { runId, completion } = await startAcpPromptTurn({
      sessionKey: params.sessionKey,
      text: params.text,
    });
    const textPromise = params.threadId
      ? params.baselineMessages
        ? waitForNewAcpThreadOutput({
            readThreadMessages: deps.readThreadMessages,
            threadId: params.threadId,
            accountId: params.accountId,
            timeoutMs: params.timeoutMs,
            baselineMessages: params.baselineMessages,
          })
        : waitForAcpThreadOutput({
            readThreadMessages: deps.readThreadMessages,
            threadId: params.threadId,
            accountId: params.accountId,
            timeoutMs: params.timeoutMs,
            limit: params.limit,
            validator: params.validator,
            pollIntervalMs: params.pollIntervalMs,
          })
      : Promise.resolve("");
    const [text] = await Promise.all([textPromise, completion]);
    return { runId, text: sanitizeAcpThreadOutput(text) };
  }

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
    const prompt = [
      `@${task.agent}`,
      "",
      "QA requested changes on your latest submission.",
      "Apply the requested fixes, update code as needed, and report back with the new commit hash.",
      "",
      "QA feedback:",
      reviewText,
    ].join("\n");

    if (!task.sessionKey) {
      throw new Error("Task has no session to prompt");
    }

    const accountId = deps.resolveAccountId(task.agent);
    const baselineThreadMessages = task.threadId
      ? await deps.readThreadMessages(task.threadId, accountId, 20).catch(() => [])
      : [];
    const { text } = await runAcpTurnWithThreadOutput({
      sessionKey: task.sessionKey,
      text: prompt,
      threadId: task.threadId,
      accountId,
      timeoutMs: deps.resolveTaskTimeoutMs(task),
      baselineMessages: baselineThreadMessages,
    });
    return text;
  }

  async function promptTaskSession(task: Task, text: string): Promise<{ runId: string }> {
    if (!task.sessionKey) {
      throw new Error("Task has no session to prompt");
    }

    const { runId, completion } = await startAcpPromptTurn({
      sessionKey: task.sessionKey,
      text,
    });
    void completion.catch((error) => {
      deps.stderr.write(
        `[ACP.PROMPT] session=${task.sessionKey} failed: ${getErrorMessage(error)}\n`,
      );
    });
    return { runId };
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
    if (!task || !task.sessionKey) return;
    if (!["error", "dispatched", "in_progress"].includes(task.status)) return;

    const priorStatus = task.status;

    try {
      await waitForAcpStartupGate(deps.acpStartupCooldownMs);
      const accountId = deps.resolveAccountId(task.agent);
      const baselineThreadMessages =
        task.threadId && deps.readThreadMessages
          ? await deps.readThreadMessages(task.threadId, accountId, 20).catch(() => [])
          : [];

      deps.db
        .prepare(
          "UPDATE tasks SET status = 'in_progress', error = NULL, updated_at = @updated_at WHERE id = @id",
        )
        .run({ id: task.id, updated_at: Date.now() });
      deps.recordTaskEvent(task.id, "task.resume_triggered", {
        priorStatus,
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

      const resumeText =
        "Gateway restart interrupted your previous turn. Continue the same task from where you left off, keep the original instructions, avoid redoing already-completed work, and post your final response in this thread.";
      const resumeTimeoutMs = deps.resolveTaskTimeoutMs(task);
      const { runId: childRunId, text } = await runAcpTurnWithThreadOutput({
        sessionKey: task.sessionKey,
        text: resumeText,
        threadId: task.threadId,
        accountId,
        timeoutMs: resumeTimeoutMs,
        limit: 20,
        validator: (candidate) => {
          const cleaned = sanitizeAcpThreadOutput(candidate);
          return cleaned.length > 0 && cleaned !== sanitizeAcpThreadOutput(
            baselineThreadMessages.join("\n"),
          );
        },
        pollIntervalMs: Math.min(5_000, Math.floor(resumeTimeoutMs / 4)),
        baselineMessages: baselineThreadMessages,
      });

      deps.db
        .prepare(
          "UPDATE tasks SET run_id = @runId, updated_at = @updated_at WHERE id = @id",
        )
        .run({
          id: task.id,
          runId: childRunId,
          updated_at: Date.now(),
        });
      if (text) {
        deps.stderr.write(
          `[DISPATCH.RESUME] Recovered ${text.length} chars from Discord thread for ${task.id}\n`,
        );
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
    } catch (error) {
      const message = getErrorMessage(error);
      const currentTask = deps.getTask(task.id) || task;
      deps.db
        .prepare(
          "UPDATE tasks SET status = 'error', error = @error, retries = retries + 1, updated_at = @updated_at WHERE id = @id",
        )
        .run({
          id: task.id,
          error: message,
          updated_at: Date.now(),
        });
      deps.recordTaskEvent(task.id, "task.resume_failed", {
        priorStatus,
        error: message,
        sessionKey: task.sessionKey,
        threadId: task.threadId || null,
      });
      if (task.threadId) {
        await deps
          .postToThread(
            task.threadId,
            `❌ **Resume failed**\n\n${message}`,
            deps.resolveAccountId(task.agent),
          )
          .catch(() => {});
      }
      deps.onTaskChanged(task.id);
      await deps.notifyMainSession({ ...currentTask, error: message }, "error");
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
    const { completion } = await startAcpPromptTurn({ sessionKey, text });
    void completion.catch((error) => {
      deps.stderr.write(
        `[NOTIFY-SESSION] Failed prompting operator session: ${getErrorMessage(error)}\n`,
      );
    });
    deps.stderr.write(
      `[NOTIFY-SESSION] Prompted operator session (${status}) for task ${task.id.slice(0, 8)}\n`,
    );
  }

  async function dispatchAcp(task: Task, sessionKey: string, cwd: string | null): Promise<void> {
    const isReviewTask = task.chainId?.startsWith("review:") || false;

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
    const harness = deps.resolveHarness(task);
    const cfg = requireOpenClawConfig();
    await acpManager().initializeSession({
      cfg,
      sessionKey: childSessionKey,
      agent: harness,
      mode: "persistent",
      cwd: resolvedCwd,
      backendId: cfg.acp?.backend,
    });

    deps.db
      .prepare(
        "UPDATE tasks SET session_key = @sessionKey, run_id = @runId, updated_at = @updated_at WHERE id = @id",
      )
      .run({
        id: task.id,
        sessionKey: childSessionKey,
        runId: null,
        updated_at: Date.now(),
      });

    const binding = await bindingService().bind({
      targetSessionKey: childSessionKey,
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId,
        conversationId: existingThreadId || channelId || "",
      },
      placement: existingThreadId ? "current" : "child",
      metadata: {
        agentId: harness,
        label: task.title,
        boundBy: "task-dispatch",
      },
    });
    const dispatchThreadId = binding.conversation.conversationId?.trim() || null;
    if (!dispatchThreadId) {
      throw new Error("ACP session initialized but Discord thread binding did not return a thread id");
    }

    deps.db
      .prepare(
        "UPDATE tasks SET session_key = @sessionKey, run_id = @runId, thread_id = @threadId, updated_at = @updated_at WHERE id = @id",
      )
      .run({
        id: task.id,
        sessionKey: childSessionKey,
        runId: null,
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
        runId: null,
      });
    }

    const pollTimeoutMs = deps.resolveTaskTimeoutMs(task);
    const pollLimit = isReviewTask ? deps.reviewThreadPollLimit : 20;
    const validator = isReviewTask
      ? (candidate: string) => parseReviewSummary(candidate) !== null
      : (candidate: string) => candidate.length > 0;
    const { runId: childRunId, text } = await runAcpTurnWithThreadOutput({
      sessionKey: childSessionKey,
      text: prompt,
      threadId: task.threadId,
      accountId,
      timeoutMs: pollTimeoutMs,
      limit: pollLimit,
      validator,
      pollIntervalMs: Math.min(5_000, Math.floor(pollTimeoutMs / 4)),
    });
    deps.db
      .prepare("UPDATE tasks SET run_id = @runId, updated_at = @updated_at WHERE id = @id")
      .run({
        id: task.id,
        runId: childRunId,
        updated_at: Date.now(),
      });
    if (text) {
      deps.stderr.write(`[DISPATCH.ACP] Recovered ${text.length} chars from Discord thread for ${task.id}\n`);
    }

    if (isReviewTask && (!text || !parseReviewSummary(text))) {
      const error = text
        ? "Review summary missing or incomplete JSON block"
        : "Review produced no recoverable output";
      deps.db
        .prepare(
          "UPDATE tasks SET status = 'error', output = @output, error = @error, retries = retries + 1, updated_at = @updated_at WHERE id = @id",
        )
        .run({
          id: task.id,
          output: text.slice(0, 10000),
          error,
          updated_at: Date.now(),
        });
      deps.recordTaskEvent(task.id, "review.output_invalid", {
        reason: error,
        hasOutput: Boolean(text),
      });
      deps.onTaskChanged(task.id);
      await deps.notifyMainSession({ ...task, output: text, error }, "error");
      return;
    }

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
    promptTaskSession,
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
