import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type { Comment, Schedule, Task, TaskStatus } from "./types";
import type { DatabaseLike, JsonObject, PreparedStatementLike } from "./runtime-types";

const require = createRequire(import.meta.url);

export const PROJECT_SEED_ROWS: Array<{
  id: string;
  name: string;
  repo: string | null;
  priority: number;
  status: string;
  description: string | null;
  cwd: string | null;
  tags: string | null;
}> = [];

export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["ready", "cancelled"],
  ready: ["dispatched", "cancelled"],
  dispatched: ["in_progress", "error", "cancelled"],
  in_progress: ["review", "blocked", "error", "cancelled"],
  blocked: ["in_progress", "cancelled"],
  review: ["done", "in_progress", "blocked", "error"],
  done: [],
  error: ["ready"],
  cancelled: ["ready"],
};

export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

type DbRowObject = Record<string, unknown>;

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toRowObject(value: unknown): DbRowObject {
  return typeof value === "object" && value !== null ? { ...(value as DbRowObject) } : {};
}

function createInMemoryDb(): DatabaseLike {
  const tables: {
    tasks: DbRowObject[];
    schedules: DbRowObject[];
    comments: DbRowObject[];
    task_events: DbRowObject[];
    projects: DbRowObject[];
    project_commits: DbRowObject[];
    project_snapshots: DbRowObject[];
    review_state: DbRowObject[];
    review_deliveries: DbRowObject[];
  } = {
    tasks: [],
    schedules: [],
    comments: [],
    task_events: [],
    projects: [],
    project_commits: [],
    project_snapshots: [],
    review_state: [],
    review_deliveries: [],
  };

  function selectById(
    table: "tasks" | "schedules" | "comments",
    id: string,
  ): DbRowObject | undefined {
    return tables[table].find((row) => row.id === id);
  }

  function runUpdate(sql: string, params: DbRowObject): void {
    const row = selectById("tasks", String(params.id));
    if (!row) return;
    const setSql = sql.split("SET")[1]?.split("WHERE")[0] || "";
    const assignments = setSql
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    for (const assignment of assignments) {
      if (assignment.includes("= NULL")) {
        const col = assignment.split("=")[0]?.trim();
        if (col) row[col] = null;
        continue;
      }
      if (assignment.includes("= 0")) {
        const col = assignment.split("=")[0]?.trim();
        if (col) row[col] = 0;
        continue;
      }
      const [colRaw, valueRaw] = assignment.split("=");
      const col = colRaw?.trim();
      const valueKey = valueRaw?.trim().replace("@", "");
      if (!col || !valueKey) continue;
      row[col] = params[valueKey];
    }
  }

  return {
    pragma() {},
    exec() {},
    transaction<TArgs extends unknown[]>(fn: (...args: TArgs) => void) {
      return (...args: TArgs) => fn(...args);
    },
    prepare<TResult = unknown>(sql: string) {
      const statement: PreparedStatementLike<unknown> = {
        run: (...args: unknown[]) => {
          if (sql.startsWith("INSERT INTO tasks")) {
            const row = toRowObject(args[0]);
            tables.tasks.push({ ...row });
            return;
          }
          if (sql.startsWith("UPDATE tasks SET")) {
            runUpdate(sql, toRowObject(args[0]));
            return;
          }
          if (sql.startsWith("INSERT INTO comments")) {
            tables.comments.push(toRowObject(args[0]));
            return;
          }
          if (sql.startsWith("INSERT INTO task_events")) {
            tables.task_events.push(toRowObject(args[0]));
            return;
          }
          if (sql.startsWith("INSERT INTO schedules")) {
            tables.schedules.push(toRowObject(args[0]));
            return;
          }
          if (sql.startsWith("INSERT INTO review_state")) {
            const row = toRowObject(args[0]);
            tables.review_state = tables.review_state.filter((entry) => entry.repo !== row.repo);
            tables.review_state.push(row);
            return;
          }
          if (sql.startsWith("INSERT INTO review_deliveries")) {
            const row = toRowObject(args[0]);
            tables.review_deliveries = tables.review_deliveries.filter(
              (entry) => entry.delivery_key !== row.delivery_key,
            );
            tables.review_deliveries.push(row);
            return;
          }
          if (sql.startsWith("UPDATE review_state SET")) {
            const params = toRowObject(args[0]);
            const row = tables.review_state.find((entry) => entry.repo === String(params.repo));
            if (row) {
              Object.assign(row, params);
            }
            return;
          }
          if (sql.startsWith("UPDATE review_deliveries SET")) {
            const params = toRowObject(args[0]);
            const row = tables.review_deliveries.find(
              (entry) => entry.delivery_key === String(params.delivery_key),
            );
            if (row) {
              Object.assign(row, params);
            }
            return;
          }
          if (sql.startsWith("DELETE FROM task_events WHERE task_id = ?")) {
            const id = String(args[0]);
            tables.task_events = tables.task_events.filter((row) => row.task_id !== id);
            return;
          }
          if (sql.startsWith("DELETE FROM comments WHERE task_id = ?")) {
            const id = String(args[0]);
            tables.comments = tables.comments.filter((row) => row.task_id !== id);
            return;
          }
          if (sql.startsWith("DELETE FROM tasks WHERE id = ?")) {
            const id = String(args[0]);
            tables.tasks = tables.tasks.filter((row) => row.id !== id);
          }
        },
        get: (...args: unknown[]) => {
          if (sql.startsWith("SELECT * FROM tasks WHERE id = ?")) {
            return selectById("tasks", String(args[0]));
          }
          if (sql.startsWith("SELECT * FROM review_state WHERE repo = ?")) {
            return tables.review_state.find((row) => row.repo === String(args[0]));
          }
          if (sql.startsWith("SELECT * FROM review_state WHERE active_task_id = ?")) {
            return tables.review_state.find((row) => row.active_task_id === String(args[0]));
          }
          if (sql.startsWith("SELECT * FROM review_deliveries WHERE delivery_key = ?")) {
            return tables.review_deliveries.find((row) => row.delivery_key === String(args[0]));
          }
          if (sql.startsWith("SELECT * FROM review_deliveries WHERE repo = ? AND sha = ?")) {
            return tables.review_deliveries.find(
              (row) => row.repo === String(args[0]) && row.sha === String(args[1]),
            );
          }
          if (sql.includes("SELECT COUNT(*) as c FROM tasks WHERE id IN")) {
            const ids = args.map(String);
            const c = tables.tasks.filter(
              (row) => ids.includes(String(row.id)) && row.status === "done",
            ).length;
            return { c };
          }
          if (sql.startsWith("SELECT COUNT(*) as c FROM tasks WHERE id = ?")) {
            return { c: tables.tasks.filter((row) => row.id === String(args[0])).length };
          }
          if (sql.startsWith("SELECT COUNT(*) as c FROM comments WHERE task_id = ?")) {
            return { c: tables.comments.filter((row) => row.task_id === String(args[0])).length };
          }
          if (sql.startsWith("SELECT COUNT(*) as c FROM task_events WHERE task_id = ?")) {
            return {
              c: tables.task_events.filter((row) => row.task_id === String(args[0])).length,
            };
          }
          return undefined;
        },
        all: (...args: unknown[]) => {
          if (sql.includes("sqlite_master")) {
            return [
              { name: "tasks" },
              { name: "schedules" },
              { name: "comments" },
              { name: "task_events" },
              { name: "projects" },
              { name: "project_commits" },
              { name: "project_snapshots" },
              { name: "review_state" },
              { name: "review_deliveries" },
            ];
          }
          if (sql.startsWith("SELECT * FROM tasks")) {
            return [...tables.tasks];
          }
          if (sql.startsWith("SELECT * FROM comments WHERE task_id = ?")) {
            return tables.comments.filter((row) => row.task_id === args[0]);
          }
          if (sql.startsWith("SELECT * FROM task_events WHERE task_id = ?")) {
            const taskId = String(args[0]);
            const limit = Number(args[1] || tables.task_events.length);
            const ordered = [...tables.task_events]
              .filter((row) => row.task_id === taskId)
              .sort((a, b) => {
                const desc = sql.includes("ORDER BY created_at DESC");
                return desc
                  ? Number(b.created_at) - Number(a.created_at)
                  : Number(a.created_at) - Number(b.created_at);
              });
            return ordered.slice(0, limit);
          }
          return [];
        },
      };
      return statement as PreparedStatementLike<TResult>;
    },
  };
}

export function initDb(dbPath: string): DatabaseLike {
  mkdirSync(dirname(dbPath), { recursive: true });
  let db: DatabaseLike;
  try {
    const Database = require("better-sqlite3") as new (path: string) => DatabaseLike;
    db = new Database(dbPath);
  } catch {
    db = createInMemoryDb();
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      agent TEXT NOT NULL,
      runtime TEXT,
      project_id TEXT,
      channel_id TEXT,
      cwd TEXT,
      model TEXT,
      thinking TEXT,
      depends_on TEXT DEFAULT '[]',
      chain_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      manual_complete INTEGER DEFAULT 0,
      session_key TEXT,
      run_id TEXT,
      timeout_ms INTEGER,
      thread_id TEXT,
      output TEXT,
      retries INTEGER DEFAULT 0,
      review_attempts INTEGER DEFAULT 0,
      qa_required INTEGER DEFAULT 1,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_agent ON tasks(agent);
    CREATE INDEX IF NOT EXISTS idx_chain ON tasks(chain_id);
    CREATE INDEX IF NOT EXISTS idx_project ON tasks(project_id);

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      agent TEXT NOT NULL DEFAULT 'default',
      project_id TEXT,
      cwd TEXT,
      category TEXT,
      qa_required INTEGER DEFAULT 1,
      cron TEXT NOT NULL,
      nl_expression TEXT,
      timeout_ms INTEGER,
      enabled INTEGER DEFAULT 1,
      last_run_at INTEGER,
      next_run_at INTEGER,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);
    CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules(next_run_at);

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_comments_task_created
      ON comments(task_id, created_at);

    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_task_events_task_created
      ON task_events(task_id, created_at);

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repo TEXT,
      branch TEXT DEFAULT 'main',
      priority INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      description TEXT,
      cwd TEXT,
      tags TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_commits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id),
      sha TEXT NOT NULL,
      message TEXT,
      author TEXT,
      date TEXT,
      branch TEXT,
      UNIQUE(project_id, sha)
    );

    CREATE TABLE IF NOT EXISTS project_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id),
      summary TEXT,
      progress_pct INTEGER,
      blockers TEXT,
      generated_at TEXT DEFAULT (datetime('now')),
      model TEXT
    );

    CREATE TABLE IF NOT EXISTS review_state (
      repo TEXT PRIMARY KEY,
      last_reviewed_sha TEXT,
      last_review_at INTEGER,
      pending_from_sha TEXT,
      pending_to_sha TEXT,
      pending_task_id TEXT,
      pending_updated_at INTEGER,
      active_from_sha TEXT,
      active_to_sha TEXT,
      active_task_id TEXT
    );

    CREATE TABLE IF NOT EXISTS review_deliveries (
      delivery_key TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      sha TEXT NOT NULL,
      task_id TEXT,
      status TEXT NOT NULL,
      accepted_at INTEGER NOT NULL
    );
  `);

  try {
    db.exec("ALTER TABLE tasks ADD COLUMN run_id TEXT");
  } catch {}
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN timeout_ms INTEGER");
  } catch {}
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN review_attempts INTEGER DEFAULT 0");
  } catch {}
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN qa_required INTEGER DEFAULT 1");
  } catch {}

  seedProjectsIfEmpty(db);

  return db;
}

export function seedProjectsIfEmpty(db: DatabaseLike): void {
  const row = db.prepare<{ count: number }>("SELECT COUNT(*) AS count FROM projects").get();
  const count = Number(row?.count || 0);
  if (count > 0) return;

  const insertProject = db.prepare(`
    INSERT INTO projects (id, name, repo, priority, status, description, cwd, tags)
    VALUES (@id, @name, @repo, @priority, @status, @description, @cwd, @tags)
  `);

  if (typeof db.transaction === "function") {
    const insertMany = db.transaction((rows: typeof PROJECT_SEED_ROWS) => {
      for (const project of rows) {
        insertProject.run(project);
      }
    });
    insertMany(PROJECT_SEED_ROWS);
    return;
  }

  for (const project of PROJECT_SEED_ROWS) {
    insertProject.run(project);
  }
}

export type DbRow = DbRowObject | null | undefined;

export function rowToTask(row: DbRow): Task | null {
  if (!row) return null;
  return {
    id: String(row.id),
    title: String(row.title),
    description: stringOrNull(row.description),
    agent: String(row.agent),
    runtime: stringOrNull(row.runtime),
    projectId: stringOrNull(row.project_id),
    channelId: stringOrNull(row.channel_id),
    cwd: stringOrNull(row.cwd),
    model: stringOrNull(row.model),
    thinking: stringOrNull(row.thinking),
    dependsOn: typeof row.depends_on === "string" ? (JSON.parse(row.depends_on) as string[]) : [],
    chainId: stringOrNull(row.chain_id),
    status: row.status as TaskStatus,
    manualComplete: Boolean(row.manual_complete),
    sessionKey: stringOrNull(row.session_key),
    runId: stringOrNull(row.run_id),
    timeoutMs: numberOrNull(row.timeout_ms),
    threadId: stringOrNull(row.thread_id),
    output: stringOrNull(row.output),
    retries: Number(row.retries || 0),
    reviewAttempts: Number(row.review_attempts || 0),
    qaRequired: row.qa_required !== 0,
    error: stringOrNull(row.error),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: numberOrNull(row.completed_at),
  };
}

export function rowToSchedule(row: DbRow): Schedule | null {
  if (!row) return null;
  return {
    id: String(row.id),
    title: String(row.title),
    description: stringOrNull(row.description),
    agent: String(row.agent),
    projectId: stringOrNull(row.project_id),
    cwd: stringOrNull(row.cwd),
    category: stringOrNull(row.category),
    qaRequired: row.qa_required !== 0,
    cronExpression: String(row.cron),
    nlExpression: stringOrNull(row.nl_expression),
    timeoutMs: numberOrNull(row.timeout_ms),
    enabled: row.enabled !== 0,
    lastRunAt: numberOrNull(row.last_run_at),
    nextRunAt: numberOrNull(row.next_run_at),
    createdAt: numberOrNull(row.created_at),
    updatedAt: numberOrNull(row.updated_at),
  };
}

export function rowToComment(row: DbRow): Comment | null {
  if (!row) return null;
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    author: String(row.author),
    body: String(row.body),
    createdAt: Number(row.created_at),
  };
}

export function rowToTaskEvent(row: DbRow): {
  id: number;
  taskId: string;
  eventType: string;
  payload: JsonObject | null;
  createdAt: number;
} | null {
  if (!row) return null;
  return {
    id: Number(row.id),
    taskId: String(row.task_id),
    eventType: String(row.event_type),
    payload: typeof row.payload === "string" ? (JSON.parse(row.payload) as JsonObject) : null,
    createdAt: Number(row.created_at),
  };
}

export function listTaskEvents(
  db: DatabaseLike,
  taskId: string,
  opts: { order?: "asc" | "desc"; limit?: number } = {},
) {
  const limit = Math.max(1, Math.min(Number(opts.limit || 100), 500));
  const order = String(opts.order || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  return db
    .prepare(`SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ${order} LIMIT ?`)
    .all(taskId, limit)
    .map((row) => rowToTaskEvent(row as DbRow));
}

export function deleteTaskCascade(db: DatabaseLike, taskId: string): void {
  db.prepare("DELETE FROM task_events WHERE task_id = ?").run(taskId);
  db.prepare("DELETE FROM comments WHERE task_id = ?").run(taskId);
  db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
}
