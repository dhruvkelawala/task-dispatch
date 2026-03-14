import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { initDb, isValidTransition, rowToTask } from "../src/plugin/db";

const dbPath = `/tmp/task-dispatch-db-test-${Date.now()}.db`;

afterEach(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {}
});

describe("db", () => {
  test("tables exist after initDb()", () => {
    const db = initDb(dbPath);
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const names = new Set(rows.map((r: any) => r.name));
    expect(names.has("tasks")).toBeTrue();
    expect(names.has("schedules")).toBeTrue();
    expect(names.has("comments")).toBeTrue();
  });

  test("rowToTask() maps snake_case to camelCase", () => {
    const task = rowToTask({
      id: "t1",
      title: "Title",
      description: "Desc",
      agent: "zeus",
      runtime: "acp",
      project_id: "p1",
      channel_id: "c1",
      cwd: "/tmp",
      model: "m",
      thinking: "high",
      depends_on: '["a","b"]',
      chain_id: "ch1",
      status: "ready",
      manual_complete: 1,
      session_key: "s",
      run_id: "r",
      timeout_ms: 1000,
      thread_id: "th",
      output: "out",
      retries: 2,
      review_attempts: 1,
      qa_required: 1,
      error: null,
      created_at: 1,
      updated_at: 2,
      completed_at: null,
    });
    expect(task?.projectId).toBe("p1");
    expect(task?.channelId).toBe("c1");
    expect(task?.dependsOn).toEqual(["a", "b"]);
    expect(task?.manualComplete).toBeTrue();
  });

  test("qaRequired defaults true when db value is 1", () => {
    const task = rowToTask({
      id: "t1",
      title: "Title",
      agent: "zeus",
      depends_on: "[]",
      status: "ready",
      manual_complete: 0,
      retries: 0,
      review_attempts: 0,
      qa_required: 1,
      created_at: 1,
      updated_at: 2,
    });
    expect(task?.qaRequired).toBeTrue();
  });

  test("isValidTransition allows and blocks correctly", () => {
    expect(isValidTransition("pending", "ready")).toBeTrue();
    expect(isValidTransition("done", "ready")).toBeFalse();
  });
});
