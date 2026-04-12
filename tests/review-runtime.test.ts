import { describe, expect, test } from "bun:test";
import { createReviewRuntime } from "../src/plugin/review-runtime";
import type { ReviewStateRow } from "../src/plugin/review";
import type { Task } from "../src/plugin/types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Review task",
    description: null,
    agent: "nemesis",
    runtime: null,
    projectId: "web-app",
    channelId: null,
    cwd: "/tmp/test",
    model: null,
    thinking: null,
    dependsOn: [],
    chainId: "review:org/web-app",
    status: "done",
    manualComplete: false,
    sessionKey: "session-1",
    runId: "run-1",
    timeoutMs: 60000,
    threadId: "thread-1",
    output: null,
    retries: 0,
    reviewAttempts: 0,
    qaRequired: false,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: Date.now(),
    ...overrides,
  };
}

function makeReviewState(overrides: Partial<ReviewStateRow> = {}): ReviewStateRow {
  return {
    repo: "org/web-app",
    last_reviewed_sha: "aaa111",
    last_review_at: 1,
    pending_from_sha: null,
    pending_to_sha: null,
    pending_task_id: null,
    pending_updated_at: null,
    active_from_sha: "aaa111",
    active_to_sha: "bbb222",
    active_task_id: "task-1",
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

  const reviewState = makeReviewState();
  const savedStates: ReviewStateRow[] = [];

  return {
    calls,
    savedStates,
    deps: {
      config: { projects: { "web-app": { repo: "org/web-app", cwd: "/tmp" } } },
      defaultAgent: "nemesis",
      defaultCwd: "/tmp",
      reviewTimers: new Map(),
      db: {
        prepare: () => ({ run: () => {}, get: () => null, all: () => [] }),
        transaction: (fn: () => void) => fn,
      },
      stmts: {
        getReviewStateByRepo: {
          get: () => reviewState,
        },
        getReviewStateByActiveTaskId: {
          get: (taskId: string) => (taskId === "task-1" ? reviewState : undefined),
        },
        upsertReviewState: {
          run: (state: ReviewStateRow) => {
            savedStates.push({ ...state });
          },
        },
        getReviewDeliveryByKey: { get: () => undefined },
        getReviewDeliveryByRepoSha: { get: () => undefined },
        upsertReviewDelivery: { run: () => {} },
      },
      loadTask: () => makeTask(),
      createTaskRecord: () => makeTask({ id: "retry-task" }),
      recordTaskEvent: track("recordTaskEvent") as unknown as () => void,
      onTaskChanged: track("onTaskChanged") as unknown as () => void,
      resolveReviewAgentId: () => "nemesis",
      stderr: { write: () => true },
      ...overrides,
    },
  };
}

describe("review-runtime", () => {
  test("finalizeReviewTask advances cursor on clean success with no findings", async () => {
    const task = makeTask({
      output: [
        "Clean review.",
        "```json",
        '{"schemaVersion":1,"reviewOutcome":"success","findingsCount":0,"findings":[]}',
        "```",
      ].join("\n"),
    });

    const { calls, savedStates, deps } = makeDeps();
    const runtime = createReviewRuntime(
      deps as unknown as Parameters<typeof createReviewRuntime>[0],
    );

    await runtime.finalizeReviewTask(task);

    expect(savedStates.length).toBeGreaterThan(0);
    const lastState = savedStates[savedStates.length - 1]!;
    expect(lastState.last_reviewed_sha).toBe("bbb222");
    expect(lastState.active_task_id).toBeNull();

    const cursorEvents = (calls.recordTaskEvent || []).filter(
      (args) => args[1] === "review.cursor_advanced",
    );
    expect(cursorEvents).toHaveLength(1);
  });

  test("finalizeReviewTask advances cursor with empty-output event when output is missing", async () => {
    const task = makeTask({ output: null });

    const { calls, deps } = makeDeps();
    const runtime = createReviewRuntime(
      deps as unknown as Parameters<typeof createReviewRuntime>[0],
    );

    await runtime.finalizeReviewTask(task);

    const advancedEmptyEvents = (calls.recordTaskEvent || []).filter(
      (args) => args[1] === "review.cursor_advanced_empty_output",
    );
    expect(advancedEmptyEvents).toHaveLength(1);
  });

  test("finalizeReviewTask does not advance cursor for non-empty invalid output and schedules retry", async () => {
    const task = makeTask({ output: "Reviewed range. Incomplete json follows\n```json\n{\n" });

    const { calls, savedStates, deps } = makeDeps();
    const runtime = createReviewRuntime(
      deps as unknown as Parameters<typeof createReviewRuntime>[0],
    );

    await runtime.finalizeReviewTask(task);

    const advancedEmptyEvents = (calls.recordTaskEvent || []).filter(
      (args) => args[1] === "review.cursor_advanced_empty_output",
    );
    expect(advancedEmptyEvents).toHaveLength(0);

    const notAdvancedEvents = (calls.recordTaskEvent || []).filter(
      (args) => args[1] === "review.cursor_not_advanced",
    );
    expect(notAdvancedEvents).toHaveLength(1);
    expect(savedStates.length).toBeGreaterThan(0);
    const lastState = savedStates[savedStates.length - 1]!;
    expect(lastState.pending_task_id).toBe("retry-task");
  });

  test("finalizeReviewTask does not advance cursor for error status tasks", async () => {
    const task = makeTask({ status: "error", output: null });

    const { calls, deps } = makeDeps();
    const runtime = createReviewRuntime(
      deps as unknown as Parameters<typeof createReviewRuntime>[0],
    );

    await runtime.finalizeReviewTask(task);

    const cursorEvents = (calls.recordTaskEvent || []).filter(
      (args) => args[1] === "review.cursor_advanced",
    );
    expect(cursorEvents).toHaveLength(0);
  });

  test("finalizeReviewTask skips tasks not in review_state", async () => {
    const task = makeTask({ id: "unknown-task" });

    const { calls, deps } = makeDeps();
    const runtime = createReviewRuntime(
      deps as unknown as Parameters<typeof createReviewRuntime>[0],
    );

    await runtime.finalizeReviewTask(task);

    expect(calls.recordTaskEvent || []).toHaveLength(0);
  });
});
