import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type { Comment, Schedule, Task, TaskStatus } from "./types";

const require = createRequire(import.meta.url);

export const PROJECT_SEED_ROWS = [
  {
    id: "visaroy",
    name: "Visaroy",
    repo: "dhruvkelawala/visaroy",
    priority: 1,
    status: "shipping",
    description: "Schengen visa prep assistant",
    cwd: "~/.openclaw/workspace/visaroy/visaroy-app",
    tags: '["ship", "personal"]',
  },
  {
    id: "forayy",
    name: "Forayy",
    repo: null,
    priority: 2,
    status: "active",
    description: "AI street-view missions app",
    cwd: "~/.openclaw/workspace/forayy",
    tags: '["side"]',
  },
  {
    id: "beryl",
    name: "BERYL",
    repo: "argentlabs/poc-friendly-pancake",
    priority: 4,
    status: "exploring",
    description: "Secure embedded wallet with delegated agent access",
    cwd: null,
    tags: '["work", "career"]',
  },
  {
    id: "mc3",
    name: "Mission Control v3",
    repo: null,
    priority: 3,
    status: "active",
    description: "Agent operations console",
    cwd: "~/.openclaw/workspace/mission-control-v3",
    tags: '["infra"]',
  },
];

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

function createInMemoryDb(): any {
  const tables: {
    tasks: Array<Record<string, any>>;
    schedules: Array<Record<string, any>>;
    comments: Array<Record<string, any>>;
    task_events: Array<Record<string, any>>;
    projects: Array<Record<string, any>>;
    project_commits: Array<Record<string, any>>;
    project_snapshots: Array<Record<string, any>>;
  } = {
    tasks: [],
    schedules: [],
    comments: [],
    task_events: [],
    projects: [],
    project_commits: [],
    project_snapshots: [],
  };

  function selectById(
    table: "tasks" | "schedules" | "comments",
    id: string,
  ): Record<string, any> | undefined {
    return tables[table].find((row) => row.id === id);
  }

  function runUpdate(sql: string, params: Record<string, any>): void {
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
    prepare(sql: string) {
      return {
        run: (...args: any[]) => {
          if (sql.startsWith("INSERT INTO tasks")) {
            const row = args[0] as Record<string, any>;
            tables.tasks.push({ ...row });
            return;
          }
          if (sql.startsWith("UPDATE tasks SET")) {
            runUpdate(sql, (args[0] || {}) as Record<string, any>);
            return;
          }
          if (sql.startsWith("INSERT INTO comments")) {
            tables.comments.push({ ...(args[0] || {}) });
            return;
          }
          if (sql.startsWith("INSERT INTO task_events")) {
            tables.task_events.push({ ...(args[0] || {}) });
            return;
          }
          if (sql.startsWith("INSERT INTO schedules")) {
            tables.schedules.push({ ...(args[0] || {}) });
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
        get: (...args: any[]) => {
          if (sql.startsWith("SELECT * FROM tasks WHERE id = ?")) {
            return selectById("tasks", String(args[0]));
          }
          if (sql.includes("SELECT COUNT(*) as c FROM tasks WHERE id IN")) {
            const ids = args.map(String);
            const c = tables.tasks.filter((row) => ids.includes(String(row.id)) && row.status === "done").length;
            return { c };
          }
          return undefined;
        },
        all: (...args: any[]) => {
          if (sql.includes("sqlite_master")) {
            return [
              { name: "tasks" },
              { name: "schedules" },
              { name: "comments" },
              { name: "task_events" },
              { name: "projects" },
              { name: "project_commits" },
              { name: "project_snapshots" },
            ];
          }
          if (sql.startsWith("SELECT * FROM tasks")) {
            return [...tables.tasks];
          }
          if (sql.startsWith("SELECT * FROM comments WHERE task_id = ?")) {
            return tables.comments.filter((row) => row.task_id === args[0]);
          }
          return [];
        },
      };
    },
  };
}

export function initDb(dbPath: string): any {
  mkdirSync(dirname(dbPath), { recursive: true });
  let db: any;
  try {
    const Database = require("better-sqlite3") as new (path: string) => any;
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
      agent TEXT NOT NULL DEFAULT 'zeus',
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

export function seedProjectsIfEmpty(db: any): void {
  const row = db.prepare("SELECT COUNT(*) AS count FROM projects").get();
  const count = Number(row?.count || 0);
  if (count > 0) return;

  const insertProject = db.prepare(`
    INSERT INTO projects (id, name, repo, priority, status, description, cwd, tags)
    VALUES (@id, @name, @repo, @priority, @status, @description, @cwd, @tags)
  `);

  if (typeof db.transaction === "function") {
    const insertMany = db.transaction((rows: any[]) => {
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

type DbRow = Record<string, any> | null | undefined;

export function rowToTask(row: DbRow): Task | null {
  if (!row) return null;
  return {
    id: String(row.id),
    title: String(row.title),
    description: row.description ?? null,
    agent: String(row.agent),
    runtime: row.runtime ?? null,
    projectId: row.project_id ?? null,
    channelId: row.channel_id ?? null,
    cwd: row.cwd ?? null,
    model: row.model ?? null,
    thinking: row.thinking ?? null,
    dependsOn: JSON.parse(row.depends_on || "[]") as string[],
    chainId: row.chain_id ?? null,
    status: row.status as TaskStatus,
    manualComplete: Boolean(row.manual_complete),
    sessionKey: row.session_key ?? null,
    runId: row.run_id ?? null,
    timeoutMs: row.timeout_ms ?? null,
    threadId: row.thread_id ?? null,
    output: row.output ?? null,
    retries: Number(row.retries || 0),
    reviewAttempts: Number(row.review_attempts || 0),
    qaRequired: row.qa_required !== 0,
    error: row.error ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at ?? null,
  };
}

export function rowToSchedule(row: DbRow): Schedule | null {
  if (!row) return null;
  return {
    id: String(row.id),
    title: String(row.title),
    description: row.description ?? null,
    agent: String(row.agent),
    projectId: row.project_id ?? null,
    cwd: row.cwd ?? null,
    category: row.category ?? null,
    qaRequired: row.qa_required !== 0,
    cronExpression: String(row.cron),
    nlExpression: row.nl_expression ?? null,
    timeoutMs: row.timeout_ms ?? null,
    enabled: row.enabled !== 0,
    lastRunAt: row.last_run_at ?? null,
    nextRunAt: row.next_run_at ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
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
