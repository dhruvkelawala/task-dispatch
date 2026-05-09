import { describe, expect, test } from "bun:test";
import {
  buildAcpOutputFromThreadMessages,
  createDispatchRuntime,
  sanitizeAcpThreadOutput,
} from "../src/plugin/dispatch-runtime";
import { parseReviewSummary } from "../src/plugin/review";
import type { Task } from "../src/plugin/types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Test task",
    description: null,
    agent: "nemesis",
    runtime: null,
    projectId: "web-app",
    channelId: null,
    cwd: "/tmp/test",
    model: null,
    thinking: null,
    dependsOn: [],
    chainId: null,
    status: "ready",
    manualComplete: false,
    sessionKey: null,
    runId: null,
    timeoutMs: 60000,
    threadId: null,
    output: null,
    retries: 0,
    reviewAttempts: 0,
    qaRequired: false,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    ...overrides,
  };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const calls: Record<string, unknown[][]> = {};
  function track(name: string) {
    calls[name] = [];
    return (...args: unknown[]) => {
      calls[name]!.push(args);
    };
  }

  const task = makeTask();
  return {
    calls,
    deps: {
      api: { config: { acp: { backend: "acpx" } }, runtime: {} },
      config: {},
      db: {
        prepare: () => ({ run: () => {}, get: () => null, all: () => [] }),
        transaction: (fn: () => void) => fn,
      },
      defaultCwd: "/tmp",
      acpStartupCooldownMs: 0,
      defaultReviewTimeoutMs: 60000,
      maxConcurrentSessions: 6,
      maxReviewCycles: 3,
      defaultDiscordAccountId: "default",
      resolveCwd: () => "/tmp/test",
      resolveRuntime: () => "subagent",
      resolveChannel: () => "chan-1",
      resolveTaskTimeoutMs: () => 60000,
      resolveQaRequired: () => false,
      resolveAccountId: (agent: string) => agent,
      createDiscordThread: track("createDiscordThread") as unknown as () => Promise<string | null>,
      postToThread: ((...args: unknown[]) => {
        (calls.postToThread ??= []).push(args);
        return Promise.resolve();
      }) as unknown as () => Promise<void>,
      readThreadMessages: ((...args: unknown[]) => {
        (calls.readThreadMessages ??= []).push(args);
        return Promise.resolve([]);
      }) as unknown as () => Promise<string[]>,
      formatDiscordThreadUrl: () => null,
      operatorLabel: "operator",
      getActiveSessionCount: () => 0,
      getTask: () => task,
      rowToTask: () => task,
      onTaskChanged: track("onTaskChanged") as unknown as () => void,
      recordTaskEvent: track("recordTaskEvent") as unknown as () => void,
      triggerDependents: track("triggerDependents") as unknown as () => void,
      notifyMainSession: track("notifyMainSession") as unknown as () => Promise<void>,
      backgroundEnqueue: track("backgroundEnqueue") as unknown as () => void,
      getAcpSessionManager: () => ({
        initializeSession: async () => undefined,
        runTurn: async () => undefined,
      }),
      callGatewayAgent: async (params: Record<string, unknown>) => {
        await (
          overrides.getAcpSessionManager as
            | (() => { runTurn?: (input: Record<string, unknown>) => Promise<void> })
            | undefined
        )?.().runTurn?.({
          cfg: { acp: { backend: "acpx" } },
          sessionKey: params.sessionKey,
          text: params.message,
          mode: "prompt",
          requestId: params.idempotencyKey,
        });
        return { runId: params.idempotencyKey as string };
      },
      getSessionBindingService: () => ({
        bind: async () => ({ conversation: { conversationId: "thread-created" } }),
      }),
      stderr: { write: () => true },
      ...overrides,
    },
  };
}

describe("dispatch-runtime", () => {
  test("sanitizeAcpThreadOutput removes ACP boilerplate lines", () => {
    expect(
      sanitizeAcpThreadOutput(
        [
          "⚙️ codex session active (idle auto-unfocus after 24h inactivity). Messages here go directly to this session.",
          "cwd: /tmp/test",
          "Background task done: ACP background task (run abc123).",
          "REAL_OUTPUT",
        ].join("\n"),
      ),
    ).toBe("REAL_OUTPUT");
  });

  test("buildAcpOutputFromThreadMessages rebuilds chronological multi-message output", () => {
    const rebuilt = buildAcpOutputFromThreadMessages([
      // newest first, matching Discord API order
      "  ]\n}\n```",
      '```json\n{\n  "schemaVersion": 1,\n  "reviewOutcome": "success",\n  "findingsCount": 0,\n  "findings": [',
      "Review summary line",
      "Background task done: ACP background task (run abc123).",
      "⚙️ codex session active (idle auto-unfocus after 24h inactivity). Messages here go directly to this session.\ncwd: /tmp/test",
    ]);

    expect(rebuilt).toContain("Review summary line");
    expect(parseReviewSummary(rebuilt)).toEqual({
      schemaVersion: 1,
      reviewOutcome: "success",
      findingsCount: 0,
      findings: [],
    });
  });

  test("triggerDispatch enqueues background job for ready tasks", () => {
    const { calls, deps } = makeDeps();
    const runtime = createDispatchRuntime(
      deps as unknown as Parameters<typeof createDispatchRuntime>[0],
    );

    runtime.triggerDispatch("task-1");

    expect(calls.backgroundEnqueue).toHaveLength(1);
    expect(calls.backgroundEnqueue![0]).toEqual(["task-1"]);
    expect(calls.recordTaskEvent).toHaveLength(1);
    expect(calls.recordTaskEvent![0]![0]).toBe("task-1");
    expect(calls.recordTaskEvent![0]![1]).toBe("dispatch.queued");
  });

  test("triggerDispatch skips non-ready tasks", () => {
    const task = makeTask({ status: "pending" });
    const { calls, deps } = makeDeps({ getTask: () => task });
    const runtime = createDispatchRuntime(
      deps as unknown as Parameters<typeof createDispatchRuntime>[0],
    );

    runtime.triggerDispatch("task-1");

    expect(calls.backgroundEnqueue).toHaveLength(0);
    expect(calls.recordTaskEvent).toHaveLength(0);
  });

  test("triggerDispatch skips null tasks", () => {
    const { calls, deps } = makeDeps({ getTask: () => null });
    const runtime = createDispatchRuntime(
      deps as unknown as Parameters<typeof createDispatchRuntime>[0],
    );

    runtime.triggerDispatch("task-1");

    expect(calls.backgroundEnqueue).toHaveLength(0);
  });

  test("dispatchTask passes parent channel when creating a Discord child thread", async () => {
    const task = makeTask({ status: "ready", agent: "zeus", qaRequired: false });
    const bindInputs: Array<{
      conversation?: { conversationId?: string; parentConversationId?: string };
      placement?: string;
    }> = [];
    const { deps } = makeDeps({
      getTask: () => task,
      resolveRuntime: () => "acp",
      resolveHarness: () => "opencode",
      resolveChannel: () => "123456789012345678",
      resolveAccountId: () => "zeus",
      readThreadMessages: async () => ["DISPATCH_OK"],
      getAcpSessionManager: () => ({
        initializeSession: async () => undefined,
        runTurn: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        },
      }),
      getSessionBindingService: () => ({
        bind: async (input: {
          conversation: { conversationId?: string; parentConversationId?: string };
          placement?: string;
        }) => {
          bindInputs.push(input);
          return { conversation: { conversationId: "thread-created" } };
        },
      }),
    });
    const runtime = createDispatchRuntime(
      deps as unknown as Parameters<typeof createDispatchRuntime>[0],
    );

    await runtime.dispatchTask(task);

    expect(bindInputs[0]?.placement).toBe("child");
    expect(bindInputs[0]?.conversation?.conversationId).toBe("channel:123456789012345678");
    expect(bindInputs[0]?.conversation?.parentConversationId).toBe("123456789012345678");
  });

  test("dispatchTask marks task error when Discord thread binding returns empty", async () => {
    const task = makeTask({ status: "ready", agent: "zeus", timeoutMs: 50 });
    const updates: Array<Record<string, unknown>> = [];
    let runTurnCalled = false;
    const { calls, deps } = makeDeps({
      getTask: () => task,
      resolveRuntime: () => "acp",
      resolveHarness: () => "opencode",
      getAcpSessionManager: () => ({
        initializeSession: async () => undefined,
        runTurn: async () => {
          runTurnCalled = true;
        },
      }),
      getSessionBindingService: () => ({
        bind: async () => ({ conversation: { conversationId: "" } }),
      }),
      db: {
        prepare: (sql: string) => ({
          run: (params: Record<string, unknown>) => {
            if (sql.includes("UPDATE tasks SET status = 'error'")) {
              updates.push(params);
            }
          },
          get: () => null,
          all: () => [],
        }),
        transaction: (fn: () => void) => fn,
      },
    });
    const runtime = createDispatchRuntime(
      deps as unknown as Parameters<typeof createDispatchRuntime>[0],
    );

    await runtime.dispatchTask(task);

    expect(runTurnCalled).toBeFalse();
    expect(updates).toHaveLength(1);
    expect(String(updates[0]?.error || "")).toContain("Discord thread binding failed");
    expect(calls.recordTaskEvent?.some((args) => args[1] === "dispatch.failed")).toBeTrue();
  });


  test("dispatchTask marks task error when ACP thread produces no Discord output", async () => {
    const task = makeTask({ status: "ready", agent: "zeus", qaRequired: false, timeoutMs: 30 });
    const updates: Array<Record<string, unknown>> = [];
    const { calls, deps } = makeDeps({
      getTask: () => task,
      resolveRuntime: () => "acp",
      resolveHarness: () => "opencode",
      resolveChannel: () => "123456789012345678",
      resolveAccountId: () => "zeus",
      resolveTaskTimeoutMs: () => 30,
      readThreadMessages: async () => [],
      getAcpSessionManager: () => ({
        initializeSession: async () => undefined,
        runTurn: async () => undefined,
      }),
      getSessionBindingService: () => ({
        bind: async () => ({ conversation: { conversationId: "thread-created" } }),
      }),
      db: {
        prepare: (sql: string) => ({
          run: (params: Record<string, unknown>) => {
            if (sql.includes("UPDATE tasks SET status = 'error'")) {
              updates.push(params);
            }
          },
          get: () => null,
          all: () => [],
        }),
        transaction: (fn: () => void) => fn,
      },
    });
    const runtime = createDispatchRuntime(
      deps as unknown as Parameters<typeof createDispatchRuntime>[0],
    );

    await runtime.dispatchTask(task);

    expect(updates).toHaveLength(1);
    expect(String(updates[0]?.error || "")).toContain("Discord thread produced no agent output");
    expect(calls.recordTaskEvent?.some((args) => args[1] === "dispatch.failed")).toBeTrue();
    expect(calls.postToThread ?? []).toHaveLength(0);
  });

  test("dispatchTask marks task error when ACP spawn fails", async () => {
    const task = makeTask({ status: "ready", agent: "nemesis" });
    const updates: Array<Record<string, unknown>> = [];
    const { calls, deps } = makeDeps({
      getTask: () => task,
      resolveRuntime: () => "acp",
      resolveHarness: () => "codex",
      getAcpSessionManager: () => ({
        initializeSession: async () => {
          throw new Error("spawn failed");
        },
        runTurn: async () => undefined,
      }),
      db: {
        prepare: (sql: string) => ({
          run: (params: Record<string, unknown>) => {
            if (sql.includes("UPDATE tasks SET status = 'error'")) {
              updates.push(params);
            }
          },
          get: () => null,
          all: () => [],
        }),
        transaction: (fn: () => void) => fn,
      },
    });
    const runtime = createDispatchRuntime(
      deps as unknown as Parameters<typeof createDispatchRuntime>[0],
    );

    await runtime.dispatchTask(task);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.error).toBe("spawn failed");
    expect(calls.recordTaskEvent?.some((args) => args[1] === "dispatch.failed")).toBeTrue();
    expect(calls.notifyMainSession).toHaveLength(1);
  });

  test("dispatchTask marks review task error when ACP output has incomplete JSON", async () => {
    const task = makeTask({
      status: "ready",
      agent: "nemesis",
      chainId: "review:org/web-app",
      threadId: "thread-1",
    });
    const updates: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const { deps } = makeDeps({
      getTask: () => task,
      resolveRuntime: () => "acp",
      resolveHarness: () => "claude",
      readThreadMessages: async () => [
        '```json\n{\n  "schemaVersion": 1,\n  "reviewOutcome": "success",\n',
        "Reviewed range. 1 finding.",
      ],
      resolveTaskTimeoutMs: () => 500,
      db: {
        prepare: (sql: string) => ({
          run: (params: Record<string, unknown>) => {
            updates.push({ sql, params });
          },
          get: () => null,
          all: () => [],
        }),
        transaction: (fn: () => void) => fn,
      },
    });
    const runtime = createDispatchRuntime(
      deps as unknown as Parameters<typeof createDispatchRuntime>[0],
    );

    await runtime.dispatchTask(task);

    expect(updates.some((entry) => entry.sql.includes("status = 'error'"))).toBeTrue();
  });

  test("resumeTask accepts dispatched ACP tasks and resumes the prior session", async () => {
    const task = makeTask({
      status: "dispatched",
      agent: "zeus",
      sessionKey: "session-1",
      threadId: "thread-resume-1",
    });
    const updates: string[] = [];
    let promptPayload: { sessionKey?: string; text?: string } | null = null;
    const { calls, deps } = makeDeps({
      getTask: () => task,
      readThreadMessages: async () => {
        if (!promptPayload) return [];
        return ["RESUMED_OK"];
      },
      resolveTaskTimeoutMs: () => 500,
      getAcpSessionManager: () => ({
        initializeSession: async () => undefined,
        runTurn: async (payload: { sessionKey: string; text: string }) => {
          promptPayload = payload;
        },
      }),
      db: {
        prepare: (sql: string) => ({
          run: () => {
            updates.push(sql);
          },
          get: () => null,
          all: () => [],
        }),
        transaction: (fn: () => void) => fn,
      },
    });
    const runtime = createDispatchRuntime(
      deps as unknown as Parameters<typeof createDispatchRuntime>[0],
    );

    await runtime.resumeTask("task-1");

    const resumedPrompt = (promptPayload as { sessionKey?: string; text?: string } | null) ?? null;
    expect(resumedPrompt?.sessionKey).toBe("session-1");
    expect(resumedPrompt?.text).toContain("Gateway restart interrupted your previous turn");
    expect(updates.some((sql) => sql.includes("status = 'in_progress'"))).toBeTrue();
    expect(updates.some((sql) => sql.includes("status = 'review'"))).toBeTrue();
    expect(updates.some((sql) => sql.includes("status = 'done'"))).toBeTrue();
    expect(calls.recordTaskEvent?.some((args) => args[1] === "task.resume_triggered")).toBeTrue();
    expect(calls.notifyMainSession).toHaveLength(1);
  });

  test("resumeTask accepts in_progress ACP tasks and keeps status progression", async () => {
    const task = makeTask({
      status: "in_progress",
      agent: "zeus",
      sessionKey: "session-1",
      threadId: "thread-resume-2",
    });
    const updates: string[] = [];
    let readCount = 0;
    const { calls, deps } = makeDeps({
      getTask: () => task,
      readThreadMessages: async () => {
        readCount += 1;
        return readCount <= 1 ? [] : ["IN_PROGRESS_RESUMED_OK"];
      },
      resolveTaskTimeoutMs: () => 500,
      db: {
        prepare: (sql: string) => ({
          run: () => {
            updates.push(sql);
          },
          get: () => null,
          all: () => [],
        }),
        transaction: (fn: () => void) => fn,
      },
    });
    const runtime = createDispatchRuntime(
      deps as unknown as Parameters<typeof createDispatchRuntime>[0],
    );

    await runtime.resumeTask("task-1");

    expect(updates.some((sql) => sql.includes("status = 'in_progress'"))).toBeTrue();
    expect(updates.some((sql) => sql.includes("status = 'review'"))).toBeTrue();
    expect(updates.some((sql) => sql.includes("status = 'done'"))).toBeTrue();
    expect(calls.recordTaskEvent?.some((args) => args[1] === "task.resume_triggered")).toBeTrue();
  });

  test("resumeTask marks task error when resume fails", async () => {
    const task = makeTask({
      status: "dispatched",
      agent: "zeus",
      sessionKey: "session-1",
      threadId: null,
    });
    const updates: string[] = [];
    const { calls, deps } = makeDeps({
      getTask: () => task,
      getAcpSessionManager: () => ({
        initializeSession: async () => undefined,
        runTurn: async () => {
          throw new Error("resume failed");
        },
      }),
      db: {
        prepare: (sql: string) => ({
          run: () => {
            updates.push(sql);
          },
          get: () => null,
          all: () => [],
        }),
        transaction: (fn: () => void) => fn,
      },
    });
    const runtime = createDispatchRuntime(
      deps as unknown as Parameters<typeof createDispatchRuntime>[0],
    );

    await runtime.resumeTask("task-1");

    expect(updates.some((sql) => sql.includes("status = 'error'"))).toBeTrue();
    expect(calls.recordTaskEvent?.some((args) => args[1] === "task.resume_failed")).toBeTrue();
    expect(calls.notifyMainSession).toHaveLength(1);
  });
});
