import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { initDb } from "../src/plugin/db";
import { handleCreateTask, handleUpdateTask } from "../src/plugin/routes/tasks";

function createRes() {
  return {
    status: 0,
    body: "",
    headers: {} as Record<string, string>,
    writeHead(status: number, headers: Record<string, string>) {
      this.status = status;
      this.headers = headers;
    },
    end(payload: string) {
      this.body = payload;
    },
  };
}

const dbPath = `/tmp/task-dispatch-routes-test-${Date.now()}.db`;

afterEach(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {}
});

describe("routes", () => {
  test("POST /api/tasks with valid body returns 201", async () => {
    const db = initDb(dbPath);
    const insert = db.prepare(`
      INSERT INTO tasks (id, title, description, agent, runtime, project_id, channel_id, cwd, model, thinking, depends_on, chain_id, status, manual_complete, timeout_ms, review_attempts, qa_required, created_at, updated_at)
      VALUES (@id, @title, @description, @agent, @runtime, @project_id, @channel_id, @cwd, @model, @thinking, @depends_on, @chain_id, @status, @manual_complete, @timeout_ms, @review_attempts, @qa_required, @created_at, @updated_at)
    `);
    const getTask = (id: string) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);

    const res = createRes();
    await handleCreateTask(
      { body: { title: "T", agent: "builder" } },
      res,
      {
        db,
        insert,
        getTask,
        defaultTaskTimeoutMs: 60_000,
        triggerDispatch: () => {},
      },
    );

    expect(res.status).toBe(201);
  });

  test("POST /api/tasks missing title returns 400", async () => {
    const db = initDb(dbPath);
    const insert = db.prepare(`
      INSERT INTO tasks (id, title, description, agent, runtime, project_id, channel_id, cwd, model, thinking, depends_on, chain_id, status, manual_complete, timeout_ms, review_attempts, qa_required, created_at, updated_at)
      VALUES (@id, @title, @description, @agent, @runtime, @project_id, @channel_id, @cwd, @model, @thinking, @depends_on, @chain_id, @status, @manual_complete, @timeout_ms, @review_attempts, @qa_required, @created_at, @updated_at)
    `);
    const getTask = (id: string) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);

    const res = createRes();
    await handleCreateTask(
      { body: { agent: "builder" } },
      res,
      {
        db,
        insert,
        getTask,
        defaultTaskTimeoutMs: 60_000,
        triggerDispatch: () => {},
      },
    );
    expect(res.status).toBe(400);
  });

  test("invalid status transition returns 400", async () => {
    const db = initDb(dbPath);
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (id, title, description, agent, runtime, project_id, channel_id, cwd, model, thinking, depends_on, chain_id, status, manual_complete, timeout_ms, review_attempts, qa_required, created_at, updated_at)
      VALUES (@id, @title, @description, @agent, @runtime, @project_id, @channel_id, @cwd, @model, @thinking, @depends_on, @chain_id, @status, @manual_complete, @timeout_ms, @review_attempts, @qa_required, @created_at, @updated_at)`
    ).run({
      id: "task-1",
      title: "T",
      description: null,
      agent: "builder",
      runtime: null,
      project_id: null,
      channel_id: null,
      cwd: null,
      model: null,
      thinking: null,
      depends_on: "[]",
      chain_id: null,
      status: "done",
      manual_complete: 0,
      timeout_ms: 60_000,
      review_attempts: 0,
      qa_required: 1,
      created_at: now,
      updated_at: now,
    });

    const res = createRes();
    await handleUpdateTask(
      { body: { status: "ready" } },
      res,
      "task-1",
      {
        db,
        getTask: (id: string) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id),
        defaultTaskTimeoutMs: 60_000,
      },
    );
    expect(res.status).toBe(400);
  });
});
