import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { initDb, listTaskEvents, deleteTaskCascade } from "../src/plugin/db";
import { handleCreateTask } from "../src/plugin/routes/tasks";

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

const dbPath = `/tmp/task-dispatch-plugin-test-${Date.now()}.db`;

afterEach(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {}
});

describe("plugin integration-ish behavior", () => {
  test("event log behavior returns ordered events", async () => {
    const db = initDb(dbPath);
    const insert = db.prepare("INSERT INTO tasks (id, title, description, agent, runtime, project_id, channel_id, cwd, model, thinking, depends_on, chain_id, status, manual_complete, timeout_ms, review_attempts, qa_required, created_at, updated_at) VALUES (@id, @title, @description, @agent, @runtime, @project_id, @channel_id, @cwd, @model, @thinking, @depends_on, @chain_id, @status, @manual_complete, @timeout_ms, @review_attempts, @qa_required, @created_at, @updated_at)");
    const getTask = (id: string) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);

    const res = createRes();
    await handleCreateTask(
      { body: { title: "T", agent: "builder", dependsOn: ["blocked-dep"], qaRequired: false } },
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
    const created = JSON.parse(res.body) as { id: string };

    db.prepare("INSERT INTO task_events (task_id, event_type, payload, created_at) VALUES (@task_id, @event_type, @payload, @created_at)").run({
      task_id: created.id,
      event_type: "task.created",
      payload: JSON.stringify({ status: "pending" }),
      created_at: 1,
    });
    db.prepare("INSERT INTO task_events (task_id, event_type, payload, created_at) VALUES (@task_id, @event_type, @payload, @created_at)").run({
      task_id: created.id,
      event_type: "qa.started",
      payload: JSON.stringify({ model: "kimi-code" }),
      created_at: 2,
    });

    const events = listTaskEvents(db, created.id, { order: "asc", limit: 10 });
    expect(events.length).toBe(2);
    expect(events[0]?.eventType).toBe("task.created");
    expect(events[1]?.eventType).toBe("qa.started");
  });

  test("delete cleanup removes task_events and comments before deleting task", async () => {
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
      status: "pending",
      manual_complete: 0,
      timeout_ms: 60_000,
      review_attempts: 0,
      qa_required: 1,
      created_at: now,
      updated_at: now,
    });
    db.prepare("INSERT INTO comments (id, task_id, author, body, created_at) VALUES (@id, @task_id, @author, @body, @created_at)").run({
      id: "comment-1",
      task_id: "task-1",
      author: "operator",
      body: "hello",
      created_at: now,
    });
    db.prepare("INSERT INTO task_events (task_id, event_type, payload, created_at) VALUES (@task_id, @event_type, @payload, @created_at)").run({
      task_id: "task-1",
      event_type: "task.created",
      payload: JSON.stringify({ status: "pending" }),
      created_at: now,
    });

    deleteTaskCascade(db, "task-1");

    const taskCount = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE id = ?").get("task-1") as { c: number };
    const commentCount = db.prepare("SELECT COUNT(*) as c FROM comments WHERE task_id = ?").get("task-1") as { c: number };
    const eventCount = db.prepare("SELECT COUNT(*) as c FROM task_events WHERE task_id = ?").get("task-1") as { c: number };

    expect(taskCount.c).toBe(0);
    expect(commentCount.c).toBe(0);
    expect(eventCount.c).toBe(0);
  });
});
