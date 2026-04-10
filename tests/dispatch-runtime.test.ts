import { describe, expect, test } from "bun:test";
import { createDispatchRuntime } from "../src/plugin/dispatch-runtime";
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
      api: { runtime: {} },
      config: {},
      db: {
        prepare: () => ({ run: () => {}, get: () => null, all: () => [] }),
        transaction: (fn: () => void) => fn,
      },
      defaultCwd: "/tmp",
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
      postToThread: track("postToThread") as unknown as () => Promise<void>,
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
      stderr: { write: () => true },
      ...overrides,
    },
  };
}

describe("dispatch-runtime", () => {
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
});
