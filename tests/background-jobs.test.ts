import { describe, expect, test } from "bun:test";
import { createBackgroundJobQueue } from "../src/plugin/background-jobs";

describe("background job queue", () => {
  test("dedupes the same kind and task id until drained", async () => {
    const seen: string[] = [];
    const queue = createBackgroundJobQueue({
      runJob: async (job: { kind: string; taskId: string }) => {
        seen.push(`${job.kind}:${job.taskId}`);
      },
    });

    expect(queue.enqueue({ kind: "dispatch", taskId: "task-1" })).toBe(true);
    expect(queue.enqueue({ kind: "dispatch", taskId: "task-1" })).toBe(false);

    await queue.drainOnce();

    expect(seen).toEqual(["dispatch:task-1"]);
    expect(queue.enqueue({ kind: "dispatch", taskId: "task-1" })).toBe(true);
  });

  test("allows different job kinds for the same task id", async () => {
    const seen: string[] = [];
    const queue = createBackgroundJobQueue({
      runJob: async (job: { kind: string; taskId: string }) => {
        seen.push(`${job.kind}:${job.taskId}`);
      },
    });

    expect(queue.enqueue({ kind: "dispatch", taskId: "task-1" })).toBe(true);
    expect(queue.enqueue({ kind: "qa", taskId: "task-1" })).toBe(true);

    await queue.drainOnce();

    expect(seen).toEqual(["dispatch:task-1", "qa:task-1"]);
  });

  test("clear removes pending jobs and releases the dedupe lock", async () => {
    const seen: string[] = [];
    const queue = createBackgroundJobQueue({
      runJob: async (job: { kind: string; taskId: string }) => {
        seen.push(`${job.kind}:${job.taskId}`);
      },
    });

    expect(queue.enqueue({ kind: "dispatch", taskId: "task-1" })).toBe(true);
    queue.clear({ kind: "dispatch", taskId: "task-1" });
    expect(queue.enqueue({ kind: "dispatch", taskId: "task-1" })).toBe(true);

    await queue.drainOnce();

    expect(seen).toEqual(["dispatch:task-1"]);
  });

  test("releases dedupe lock after failures", async () => {
    const seen: string[] = [];
    let shouldFail = true;
    const queue = createBackgroundJobQueue({
      runJob: async (job: { kind: string; taskId: string }) => {
        seen.push(`${job.kind}:${job.taskId}`);
        if (shouldFail) {
          shouldFail = false;
          throw new Error("boom");
        }
      },
    });

    expect(queue.enqueue({ kind: "dispatch", taskId: "task-1" })).toBe(true);
    await queue.drainOnce();
    expect(queue.enqueue({ kind: "dispatch", taskId: "task-1" })).toBe(true);
    await queue.drainOnce();

    expect(seen).toEqual(["dispatch:task-1", "dispatch:task-1"]);
  });
});
