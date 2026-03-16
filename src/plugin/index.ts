// @ts-nocheck
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const PROJECT_SEED_ROWS = [
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload, null, 2));
}

function sendError(res, status, message) {
  sendJson(res, { error: message }, status);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function parseQuery(url) {
  const idx = url.indexOf("?");
  if (idx === -1) return {};
  const params = {};
  const search = new URLSearchParams(url.slice(idx));
  for (const [k, v] of search) params[k] = v;
  return params;
}

/**
 * Parse URL path segments after /api/tasks
 * /api/tasks         → { segments: [] }
 * /api/tasks/stats   → { segments: ["stats"] }
 * /api/tasks/abc-123 → { segments: ["abc-123"] }
 */
function parsePath(url) {
  const pathname = url.split("?")[0];
  const parts = pathname.split("/").filter(Boolean); // ["api", "tasks", ...]
  return { segments: parts.slice(2) }; // everything after "api/tasks"
}

function collectStringValues(value, out) {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringValues(item, out);
    }
    return;
  }
  for (const child of Object.values(value)) {
    collectStringValues(child, out);
  }
}

function extractOutputFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "";
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") {
      continue;
    }

    const direct = msg.content;
    if (typeof direct === "string" && direct.trim()) {
      return direct;
    }

    const strings = [];
    collectStringValues(direct, strings);
    if (strings.length > 0) {
      return strings.join("\n");
    }
  }

  return "";
}

function normalizeTimeoutMs(value, fallbackMs) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallbackMs;
  }
  return Math.max(1_000, Math.floor(value));
}

function normalizeNlExpression(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function parseNlExpressionToCron(nlExpression) {
  const normalized = normalizeNlExpression(nlExpression);
  const map = {
    "every morning at 9am": "0 9 * * *",
    "every hour": "0 * * * *",
    "every 2 hours": "0 */2 * * *",
    "every day at midnight": "0 0 * * *",
    "every monday at 10am": "0 10 * * 1",
  };
  return map[normalized] || null;
}

function parseCronField(field, min, max) {
  if (field === "*") {
    return null;
  }

  const values = new Set();
  const parts = field.split(",").map((part) => part.trim());
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("*/")) {
      const step = Number(part.slice(2));
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error("Invalid cron step");
      }
      for (let value = min; value <= max; value += step) {
        values.add(value);
      }
      continue;
    }

    const value = Number(part);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error("Invalid cron value");
    }
    values.add(value);
  }

  if (values.size === 0) {
    throw new Error("Invalid cron field");
  }

  return values;
}

function normalizeDayOfWeek(day) {
  return day === 7 ? 0 : day;
}

function parseCronExpression(cron) {
  if (typeof cron !== "string") {
    throw new Error("cron must be a string");
  }

  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("cron must have 5 fields");
  }

  const minute = parseCronField(fields[0], 0, 59);
  const hour = parseCronField(fields[1], 0, 23);
  const dayOfMonth = parseCronField(fields[2], 1, 31);
  const month = parseCronField(fields[3], 1, 12);
  const dayOfWeekRaw = parseCronField(fields[4], 0, 7);
  const dayOfWeek =
    dayOfWeekRaw === null
      ? null
      : new Set(Array.from(dayOfWeekRaw).map(normalizeDayOfWeek));

  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function doesDateMatchCron(date, parsedCron) {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay();

  if (parsedCron.minute && !parsedCron.minute.has(minute)) return false;
  if (parsedCron.hour && !parsedCron.hour.has(hour)) return false;
  if (parsedCron.dayOfMonth && !parsedCron.dayOfMonth.has(dayOfMonth)) {
    return false;
  }
  if (parsedCron.month && !parsedCron.month.has(month)) return false;
  if (parsedCron.dayOfWeek && !parsedCron.dayOfWeek.has(dayOfWeek)) {
    return false;
  }
  return true;
}

function getNextRunAt(cron, fromTimestamp = Date.now()) {
  const parsedCron = parseCronExpression(cron);
  const start = new Date(fromTimestamp);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  const maxIterations = 60 * 24 * 366;
  for (let i = 0; i < maxIterations; i += 1) {
    if (doesDateMatchCron(start, parsedCron)) {
      return start.getTime();
    }
    start.setMinutes(start.getMinutes() + 1);
  }

  throw new Error("Could not compute next run for cron");
}

function extractCommitHash(text) {
  if (typeof text !== "string" || !text.trim()) {
    return null;
  }

  const explicit = text.match(
    /commit(?:\s+hash)?\s*[:`\s]+([0-9a-f]{7,40})\b/i,
  );
  if (explicit) {
    return explicit[1];
  }

  const fallback = text.match(/\b[0-9a-f]{7,40}\b/i);
  return fallback ? fallback[0] : null;
}

function truncateForPrompt(text, maxChars) {
  if (typeof text !== "string") {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n[truncated]`;
}

function safeJsonParse(text) {
  if (typeof text !== "string") {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJsonObject(text) {
  if (typeof text !== "string") {
    return null;
  }

  const direct = safeJsonParse(text.trim());
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return direct;
  }

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    const parsed = safeJsonParse(fencedMatch[1].trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const parsed = safeJsonParse(text.slice(start, end + 1).trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  }

  return null;
}

async function fetchRepoCommits(repo, perPage = 10) {
  const { stdout } = await execFileAsync("gh", [
    "api",
    `repos/${repo}/commits?per_page=${perPage}`,
  ]);
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [];
}

// ---------------------------------------------------------------------------
// Status Machine
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS = {
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

function isValidTransition(from, to) {
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

// ---------------------------------------------------------------------------
// Database layer
// ---------------------------------------------------------------------------

function initDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });

  const Database = require("better-sqlite3");
  const db = new Database(dbPath);
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

    CREATE TABLE IF NOT EXISTS heartbeat_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      agent_name TEXT,
      status TEXT NOT NULL,
      action TEXT,
      detail TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS heartbeat_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      heartbeat_id INTEGER NOT NULL REFERENCES heartbeat_logs(id),
      check_type TEXT NOT NULL,
      result TEXT,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  try {
    db.exec("ALTER TABLE tasks ADD COLUMN run_id TEXT");
  } catch {
    // Column already exists on upgraded installs.
  }
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN timeout_ms INTEGER");
  } catch {
    // Column already exists on upgraded installs.
  }
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN review_attempts INTEGER DEFAULT 0");
  } catch {
    // Column already exists on upgraded installs.
  }
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN qa_required INTEGER DEFAULT 1");
  } catch {
    // Column already exists on upgraded installs.
  }

  return db;
}

function seedProjectsIfEmpty(db) {
  const row = db.prepare("SELECT COUNT(*) AS count FROM projects").get();
  const count = Number(row?.count || 0);
  if (count > 0) {
    return;
  }

  const insertProject = db.prepare(`
    INSERT INTO projects (id, name, repo, priority, status, description, cwd, tags)
    VALUES (@id, @name, @repo, @priority, @status, @description, @cwd, @tags)
  `);

  const insertMany = db.transaction((rows) => {
    for (const project of rows) {
      insertProject.run(project);
    }
  });

  insertMany(PROJECT_SEED_ROWS);
}

// ---------------------------------------------------------------------------
// Row helpers — snake_case DB ↔ camelCase API
// ---------------------------------------------------------------------------

function rowToTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    agent: row.agent,
    runtime: row.runtime,
    projectId: row.project_id,
    channelId: row.channel_id,
    cwd: row.cwd,
    model: row.model,
    thinking: row.thinking,
    dependsOn: JSON.parse(row.depends_on || "[]"),
    chainId: row.chain_id,
    status: row.status,
    manualComplete: Boolean(row.manual_complete),
    sessionKey: row.session_key,
    runId: row.run_id,
    timeoutMs: row.timeout_ms,
    threadId: row.thread_id,
    output: row.output,
    retries: row.retries,
    reviewAttempts: row.review_attempts || 0,
    qaRequired: row.qa_required !== 0, // SQLite integer → boolean, default true
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function rowToSchedule(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    agent: row.agent,
    projectId: row.project_id,
    cwd: row.cwd,
    category: row.category,
    qaRequired: row.qa_required !== 0,
    cronExpression: row.cron,
    nlExpression: row.nl_expression,
    timeoutMs: row.timeout_ms,
    enabled: row.enabled !== 0,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToComment(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    author: row.author,
    body: row.body,
    createdAt: row.created_at,
  };
}

function rowToProjectCommit(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    sha: row.sha,
    message: row.message,
    author: row.author,
    date: row.date,
    branch: row.branch,
  };
}

function rowToProjectSnapshot(row) {
  if (!row || row.snapshot_id == null) {
    return null;
  }
  let blockers = [];
  if (typeof row.snapshot_blockers === "string" && row.snapshot_blockers) {
    try {
      blockers = JSON.parse(row.snapshot_blockers);
    } catch {
      blockers = [];
    }
  }

  return {
    id: row.snapshot_id,
    projectId: row.id,
    summary: row.snapshot_summary,
    progressPct: row.snapshot_progress_pct,
    blockers,
    generatedAt: row.snapshot_generated_at,
    model: row.snapshot_model,
  };
}

function parseJsonArray(value) {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    repo: row.repo,
    branch: row.branch,
    priority: row.priority,
    status: row.status,
    description: row.description,
    cwd: row.cwd,
    tags: parseJsonArray(row.tags),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    linkedTasksCount: Number(row.linked_tasks_count || 0),
    latestSnapshot: rowToProjectSnapshot(row),
    lastCommit:
      row.commit_sha != null
        ? {
            sha: row.commit_sha,
            message: row.commit_message,
            author: row.commit_author,
            date: row.commit_date,
            branch: row.commit_branch,
          }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Load Config
// ---------------------------------------------------------------------------

function loadConfig() {
  const { readFileSync, existsSync } = require("fs");
  const configPath = `${process.env.HOME}/.openclaw/data/task-dispatch-config.json`;
  try {
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, "utf8"));
    }
  } catch (e) {
    process.stderr.write(`[WARN] Could not load config: ${e.message}\n`);
  }
  return {};
}

const CONFIG = loadConfig();
const HOME = process.env.HOME || "/Users/sumo-deus";

// Build maps from config
const PROJECT_CHANNELS = {};
const PROJECT_CWD = {};
if (CONFIG.projects) {
  for (const [key, val] of Object.entries(CONFIG.projects)) {
    if (val.channel) PROJECT_CHANNELS[key] = val.channel;
    if (val.cwd) PROJECT_CWD[key] = val.cwd;
  }
}

const AGENT_FALLBACK_CHANNELS = {
  zeus: "1475499310417182810",
  atum: "1475499340574494740",
  ibis: "1475499396169990276",
  athena: "1475499360031739944",
  hathor: "1475499468051976367",
  sphinx: "1475499433373470823",
};

const AGENT_RUNTIME = {};
if (CONFIG.agents) {
  for (const [key, val] of Object.entries(CONFIG.agents)) {
    if (val.runtime) AGENT_RUNTIME[key] = val.runtime;
  }
}

const maxConcurrentSessions = CONFIG.defaults?.maxConcurrentSessions || 6;
const defaultCwd = CONFIG.defaults?.defaultCwd || `${HOME}/.openclaw/workspace`;
const defaultTaskTimeoutMs = normalizeTimeoutMs(
  CONFIG.defaults?.taskTimeoutMs,
  10 * 60_000,
);
const defaultReviewTimeoutMs = normalizeTimeoutMs(
  CONFIG.defaults?.reviewTimeoutMs,
  3 * 60_000,
);
const maxReviewCycles = Number.isFinite(CONFIG.defaults?.maxReviewCycles)
  ? Math.max(1, Math.floor(CONFIG.defaults.maxReviewCycles))
  : 3;
// qaRequired is per-task (default true). Check via resolveQaRequired(task)
function resolveQaRequired(task) {
  if (typeof task.qaRequired === "boolean") return task.qaRequired;
  return true; // default: QA is required
}

function resolveTaskTimeoutMs(task) {
  return normalizeTimeoutMs(task?.timeoutMs, defaultTaskTimeoutMs);
}

function resolveChannel(task) {
  if (task.channelId) return task.channelId;
  if (task.projectId && PROJECT_CHANNELS[task.projectId])
    return PROJECT_CHANNELS[task.projectId];
  if (task.agent && AGENT_FALLBACK_CHANNELS[task.agent])
    return AGENT_FALLBACK_CHANNELS[task.agent];
  return null;
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default function setup(api) {
  const config = api.config || {};
  const dbPath =
    config.dbPath || `${process.env.HOME}/.openclaw/data/task-dispatch.db`;

  const db = initDb(dbPath);
  seedProjectsIfEmpty(db);

  // ---- Phase 5: Restart resilience — recover stuck tasks ----
  const stuckTasks = db
    .prepare(
      "SELECT * FROM tasks WHERE status IN ('dispatched', 'in_progress', 'blocked')",
    )
    .all();
  if (stuckTasks.length > 0) {
    process.stderr.write(
      `[STARTUP] Found ${stuckTasks.length} stuck active tasks\n`,
    );
    for (const row of stuckTasks) {
      // Mark as error with retry flag — user can re-run manually
      db.prepare(
        "UPDATE tasks SET status = 'error', error = 'Gateway restart during execution', retries = retries + 1, updated_at = ? WHERE id = ?",
      ).run(Date.now(), row.id);
      process.stderr.write(
        `[STARTUP] Marked task ${row.id} as error (was stuck)\n`,
      );
    }
  }

  // ---- Session Pool (inside setup for closure access) ----
  const sessionPool = new Map();
  const sseClients = new Set();

  function getActiveSessionCount() {
    return sessionPool.size;
  }

  function broadcastTaskEvent(task) {
    if (!task || sseClients.size === 0) {
      return;
    }

    const serializedTask = JSON.stringify(task);
    const payloads = [`data: ${serializedTask}\n\n`];
    if (task.status) {
      payloads.push(`event: task_${task.status}\ndata: ${serializedTask}\n\n`);
      payloads.push(`event: task:${task.status}\ndata: ${serializedTask}\n\n`);
    }

    for (const client of sseClients) {
      try {
        for (const payload of payloads) {
          client.write(payload);
        }
      } catch {
        sseClients.delete(client);
      }
    }
  }

  function broadcastSseEvent(type, payload = {}) {
    if (sseClients.size === 0) {
      return;
    }

    const eventPayload = JSON.stringify({
      type,
      timestamp: Date.now(),
      ...payload,
    });
    const packets = [
      `data: ${eventPayload}\n\n`,
      `event: ${type}\ndata: ${eventPayload}\n\n`,
    ];

    for (const client of sseClients) {
      try {
        for (const packet of packets) {
          client.write(packet);
        }
      } catch {
        sseClients.delete(client);
      }
    }
  }

  // ---- Dispatch functions (inside setup for db closure) ----

  function resolveCwd(task) {
    // Do NOT realpath — the NVMe path has a space which breaks acpx subprocess spawn
    return task.cwd || (task.projectId && PROJECT_CWD[task.projectId]) || null;
  }

  function resolveRuntime(task) {
    if (task.runtime) return task.runtime;
    return AGENT_RUNTIME[task.agent] || "subagent";
  }

  // ---- Discord Thread Creation ----
  async function createDiscordThread(task) {
    if (!task.projectId && !AGENT_FALLBACK_CHANNELS[task.agent]) {
      process.stderr.write(
        `[DISCORD] No channel for task ${task.id}, skipping thread\n`,
      );
      return null;
    }

    const channelId =
      PROJECT_CHANNELS[task.projectId] || AGENT_FALLBACK_CHANNELS[task.agent];
    const shortId = task.id.slice(0, 8);
    const threadName = `${task.title.slice(0, 70)} — #${shortId}`;

    // Get bot token for the assigned agent, fall back to sumodeus
    const discordConfig = config.channels?.discord?.accounts || {};
    const agentToken =
      discordConfig[task.agent]?.token ||
      discordConfig.sumodeus?.token ||
      discordConfig.default?.token;
    if (!agentToken) {
      process.stderr.write(
        `[DISCORD] No bot token for ${task.agent}, skipping thread\n`,
      );
      return null;
    }

    try {
      // Create thread
      const threadResp = await fetch(
        `https://discord.com/api/v10/channels/${channelId}/threads`,
        {
          method: "POST",
          headers: {
            Authorization: `Bot ${agentToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: threadName,
            type: 11, // private thread
            auto_archive_duration: 4320,
          }),
        },
      );

      if (!threadResp.ok) {
        const err = await threadResp.text();
        process.stderr.write(
          `[DISCORD] Failed to create thread: ${threadResp.status} ${err}\n`,
        );
        return null;
      }

      const thread = await threadResp.json();
      const threadId = thread.id;

      // Post initial message
      const msgResp = await fetch(
        `https://discord.com/api/v10/channels/${threadId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bot ${agentToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: `🚀 **Task dispatched to ${task.agent}**\n\n**Title:** ${task.title}\n**Task ID:** \`${task.id}\`\n**Status:** dispatched`,
          }),
        },
      );

      if (!msgResp.ok) {
        const err = await msgResp.text();
        process.stderr.write(
          `[DISCORD] Failed to post message: ${msgResp.status} ${err}\n`,
        );
      }

      // Update task with threadId
      const now = Date.now();
      db.prepare(
        "UPDATE tasks SET thread_id = ?, updated_at = ? WHERE id = ?",
      ).run(threadId, now, task.id);

      process.stderr.write(
        `[DISCORD] Created thread ${threadId} for task ${task.id}\n`,
      );
      return threadId;
    } catch (e) {
      process.stderr.write(`[DISCORD] Error creating thread: ${e.message}\n`);
      return null;
    }
  }

  async function postToThread(threadId, content, accountId) {
    if (!threadId) return;

    // Use specified account token, fall back to sumodeus/default
    const discordConfig = config.channels?.discord?.accounts || {};
    const token =
      (accountId && discordConfig[accountId]?.token) ||
      discordConfig.sumodeus?.token ||
      discordConfig.default?.token;
    if (!token) return;

    try {
      await fetch(`https://discord.com/api/v10/channels/${threadId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content }),
      });
    } catch (e) {
      process.stderr.write(`[DISCORD] Error posting to thread: ${e.message}\n`);
    }
  }

  // ---- Orchestration ----

  // Detect if a task involves UI/UX work
  function taskNeedsAthena(task) {
    // Skip Athena for test/infra/docs tasks — even if they mention UI keywords
    const skipKeywords = ["test", "maestro", "e2e", "ci", "infra", "docs", "refactor", "migration", "stabilize"];
    const text = `${task.title} ${task.description || ""}`.toLowerCase();
    if (skipKeywords.some((kw) => text.includes(kw))) return false;

    const uiKeywords = [
      "screen",
      "tab",
      "design",
      "layout",
      "style",
      "css",
      "tailwind",
      "animation",
      "responsive",
      "landing page",
      "visual redesign",
      "typography",
      "theme",
    ];
    return uiKeywords.some((kw) => text.includes(kw));
  }

  function formatTaskPrompt(task) {
    let prompt = `# Task: ${task.title}\n\n`;
    if (task.description) {
      prompt += `## Description\n${task.description}\n\n`;
    }
    if (task.projectId) {
      prompt += `**Project:** ${task.projectId}\n`;
    }
    if (task.cwd) {
      prompt += `**Working directory:** ${task.cwd}\n`;
    }
    if (task.model) {
      prompt += `**Model:** ${task.model}\n`;
    }
    if (task.thinking) {
      prompt += `**Thinking:** ${task.thinking}\n`;
    }

    // ---- Subagent instructions ----
    prompt += `\n## Instructions`;

    // Athena: UI/UX spec (only for UI tasks)
    if (taskNeedsAthena(task)) {
      prompt += `\n1. First, use the task tool with subagent: athena to get a UI/UX spec for this task. Wait for the spec, then implement following it closely.`;
      prompt += `\n2. Before committing, use the task tool with subagent: maat to review your code changes. Only commit after maat approves.`;
    } else {
      prompt += `\n1. Before committing, use the task tool with subagent: maat to review your code changes. Only commit after maat approves.`;
    }

    prompt += `\n3. Report: commit hash, files changed, build pass/fail.`;
    return prompt;
  }

  function parseMaatVerdict(text) {
    const normalized = typeof text === "string" ? text : "";
    const verdictMatch = normalized.match(
      /^VERDICT:\s*(APPROVE|REQUEST_CHANGES)\s*$/im,
    );
    const summaryMatch = normalized.match(/^SUMMARY:\s*(.+)$/im);
    const verdict = verdictMatch
      ? verdictMatch[1].toUpperCase() === "APPROVE"
        ? "approve"
        : "request_changes"
      : "request_changes";
    const summary = summaryMatch
      ? summaryMatch[1].trim()
      : "No summary provided.";
    return { verdict, summary };
  }

  function buildQAReviewPrompt(task) {
    const output = truncateForPrompt(task.output || "", 2000);
    const commitHash = extractCommitHash(task.output || "");
    const cwd = task.cwd || resolveCwd(task);
    const project = task.projectId || "unknown";

    // Structured JSON block for reliability
    const taskData = JSON.stringify(
      {
        id: task.id,
        title: task.title,
        agent: task.agent,
        project,
        cwd,
        commitHash: commitHash || null,
        description: task.description || null,
        agentOutput: output || null,
      },
      null,
      2,
    );

    return [
      "You are a QA engineer. Your job: verify that the implementation meets the task requirements.",
      "",
      "## Task Data",
      "```json",
      taskData,
      "```",
      "",
      "## Verification Steps",
      `Run these commands IN ORDER. All commands must be run from the project directory: \`${cwd}\``,
      "",
      "```bash",
      `cd ${cwd}`,
      "git log --oneline -3",
      commitHash
        ? `git show ${commitHash} --stat`
        : "# no commit hash available — check git log",
      "npx tsc --noEmit 2>&1 | tail -20",
      "pnpm build 2>&1 | tail -20",
      ...(project === "forayy"
        ? [
            "# Maestro E2E tests (Forayy only)",
            "xcrun simctl privacy 12671090-B3C0-4268-8F87-4D88F4EA18B6 grant location com.forayy.app",
            "xcrun simctl privacy 12671090-B3C0-4268-8F87-4D88F4EA18B6 grant photos com.forayy.app",
            "xcrun simctl location 12671090-B3C0-4268-8F87-4D88F4EA18B6 set 51.5074,-0.1278",
            'PATH="$HOME/.maestro/bin:$PATH" maestro test apps/mobile/.maestro/flows/ 2>&1 | tail -30',
          ]
        : []),
      "```",
      "",
      "## Decision Criteria",
      "- APPROVE if: tsc passes, build passes, changed files align with task description",
      "- REQUEST_CHANGES if: tsc errors, build errors, or implementation doesn't match requirements",
      "- Do NOT reject for pre-existing errors unrelated to this task",
      "",
      "## Response Format (MANDATORY — no other format accepted)",
      "Your ENTIRE response must end with exactly these two lines:",
      "",
      "VERDICT: APPROVE",
      "SUMMARY: <one sentence>",
      "",
      "or",
      "",
      "VERDICT: REQUEST_CHANGES",
      "SUMMARY: <one sentence explaining what specifically needs fixing>",
    ].join("\n");
  }

  async function runMaatOneShotReview(task) {
    if (!api.runtime?.subagent?.run) {
      throw new Error("api.runtime.subagent.run not available");
    }
    if (!api.runtime?.subagent?.waitForRun) {
      throw new Error("api.runtime.subagent.waitForRun not available");
    }
    if (!api.runtime?.subagent?.getSessionMessages) {
      throw new Error("api.runtime.subagent.getSessionMessages not available");
    }

    // Post "QA in progress" to thread
    if (task.threadId) {
      await postToThread(task.threadId, "🔍 **QA in progress** — Nemesis is reviewing...", "nemesis").catch(() => {});
    }

    const maatSessionKey = `agent:nemesis:subagent:review:${crypto.randomUUID()}`;
    const reviewPrompt = buildQAReviewPrompt(task);
    const run = await api.runtime.subagent.run({
      sessionKey: maatSessionKey,
      message: reviewPrompt,
      idempotencyKey: crypto.randomUUID(),
      lane: "subagent",
    });
    const reviewRunId = typeof run?.runId === "string" ? run.runId.trim() : "";
    if (!reviewRunId) {
      throw new Error("QA review run did not return runId");
    }

    const wait = await api.runtime.subagent.waitForRun({
      runId: reviewRunId,
      timeoutMs: defaultReviewTimeoutMs,
    });
    const waitStatus = wait?.status || "timeout";
    if (waitStatus !== "ok") {
      const waitError = wait?.error ? `: ${wait.error}` : "";
      throw new Error(`QA review run failed (${waitStatus})${waitError}`);
    }

    const sessionMessages = await api.runtime.subagent.getSessionMessages({
      sessionKey: maatSessionKey,
      limit: 200,
    });
    const verdictText = extractOutputFromMessages(
      sessionMessages?.messages || [],
    );
    const parsed = parseMaatVerdict(verdictText);
    return {
      runId: reviewRunId,
      text: verdictText,
      verdict: parsed.verdict,
      summary: parsed.summary,
    };
  }

  async function requestAgentFix(task, reviewText) {
    if (!api.runtime?.acp?.prompt) {
      throw new Error("api.runtime.acp.prompt not available");
    }
    if (!api.runtime?.subagent?.waitForRun) {
      throw new Error("api.runtime.subagent.waitForRun not available");
    }

    const accountId = resolveAccountId(task.agent);
    const prompt = [
      `@${task.agent}`,
      "",
      "QA requested changes on your latest submission.",
      "Apply the requested fixes, update code as needed, and report back with the new commit hash.",
      "",
      "QA feedback:",
      reviewText,
    ].join("\n");

    const result = await api.runtime.acp.prompt({
      sessionKey: task.sessionKey,
      text: prompt,
      channel: "discord",
      accountId,
      threadId: task.threadId || undefined,
    });

    const runId = typeof result?.runId === "string" ? result.runId.trim() : "";
    if (!runId) {
      throw new Error("acp.prompt did not return runId");
    }

    const wait = await api.runtime.subagent.waitForRun({
      runId,
      timeoutMs: resolveTaskTimeoutMs(task),
    });
    const waitStatus = wait?.status || "timeout";
    if (waitStatus !== "ok") {
      const waitError = wait?.error ? `: ${wait.error}` : "";
      throw new Error(`revision run failed (${waitStatus})${waitError}`);
    }

    let output = "";
    if (api.runtime?.subagent?.getSessionMessages) {
      const sessionMessages = await api.runtime.subagent.getSessionMessages({
        sessionKey: task.sessionKey,
        limit: 200,
      });
      output = extractOutputFromMessages(sessionMessages?.messages || []);
    }
    return output;
  }

  async function runMaatReviewLoop(taskId) {
    let task = rowToTask(getTask(taskId));
    if (!task || task.status !== "review") {
      return;
    }
    if (!task.sessionKey) {
      process.stderr.write(
        `[MAAT] Task ${task.id} missing sessionKey, skipping review\n`,
      );
      return;
    }

    while (task && task.status === "review") {
      const review = await runMaatOneShotReview(task);
      const reviewText = truncateForPrompt(review.text || "", 2000);
      const reviewMessage = [
        `VERDICT: ${review.verdict === "approve" ? "APPROVE" : "REQUEST_CHANGES"}`,
        `SUMMARY: ${review.summary}`,
      ].join("\n");

      if (task.threadId) {
        await postToThread(
          task.threadId,
          `🔎 **QA verdict**\n\n${reviewMessage}`,
          "nemesis",
        );
      }

      const outputWithReview =
        `${task.output || ""}\n\n[QA Review]\n${reviewMessage}\n\n${reviewText}`
          .trim()
          .slice(0, 10000);

      if (review.verdict === "approve") {
        const now = Date.now();
        db.prepare(
          "UPDATE tasks SET status = 'done', output = @output, completed_at = @completed_at, updated_at = @updated_at WHERE id = @id",
        ).run({
          id: task.id,
          output: outputWithReview,
          completed_at: now,
          updated_at: now,
        });
        notifyMainSession(task, "done");
        // notifyTelegram(rowToTask(getTask(task.id)) || task, "done");
        onTaskChanged(task.id);
        triggerDependents(task.id);
        return;
      }

      const nextAttempts = (task.reviewAttempts || 0) + 1;
      if (nextAttempts >= maxReviewCycles) {
        const now = Date.now();
        const blockError = `QA rejected 3 times. Manual intervention required.`;
        db.prepare(
          "UPDATE tasks SET status = 'blocked', review_attempts = @attempts, output = @output, error = @error, updated_at = @updated_at WHERE id = @id",
        ).run({
          id: task.id,
          attempts: nextAttempts,
          output: outputWithReview,
          error: blockError,
          updated_at: now,
        });
        onTaskChanged(task.id);
        const blockedTask = rowToTask(getTask(task.id));
        if (task.threadId) {
          await postToThread(
            task.threadId,
            `⛔ **Task blocked** — review failed 3 times, needs human intervention.`,
          );
        }
        notifyMainSession(blockedTask || task, "blocked");
        // notifyTelegram(blockedTask || task, "blocked");
        return;
      }

      const now = Date.now();
      db.prepare(
        "UPDATE tasks SET status = 'in_progress', review_attempts = @attempts, output = @output, updated_at = @updated_at WHERE id = @id",
      ).run({
        id: task.id,
        attempts: nextAttempts,
        output: outputWithReview,
        updated_at: now,
      });
      onTaskChanged(task.id);

      const agentFixOutput = await requestAgentFix(
        task,
        `${reviewMessage}\n\n${reviewText}`,
      );
      db.prepare(
        "UPDATE tasks SET status = 'review', output = @output, completed_at = NULL, updated_at = @updated_at WHERE id = @id",
      ).run({
        id: task.id,
        output: (agentFixOutput || task.output || "").slice(0, 10000),
        updated_at: Date.now(),
      });
      onTaskChanged(task.id);

      task = rowToTask(getTask(task.id));
    }
  }

  // Direct dispatch — spawnAcpDirect is an internal function that doesn't
  // require a gateway handler context, so no self-call HTTP round-trip needed.
  function triggerDispatch(taskId) {
    const row = getTask(taskId);
    if (!row || row.status !== "ready") return;
    if (inFlightDispatch.has(taskId)) return;
    inFlightDispatch.add(taskId);
    dispatchTask(rowToTask(row))
      .catch((e) =>
        process.stderr.write(`[DISPATCH ERROR] ${e.message}\n${e.stack}\n`),
      )
      .finally(() => inFlightDispatch.delete(taskId));
  }

  async function dispatchTask(task) {
    process.stderr.write(
      `[DISPATCH] Starting task ${task.id} agent=${task.agent}\n`,
    );

    if (getActiveSessionCount() >= maxConcurrentSessions) {
      process.stderr.write(`[DISPATCH] Session limit reached\n`);
      return;
    }

    const runtimeType = resolveRuntime(task);
    // For ACP, session key must use "opencode" (the ACP backend name), not the logical agent name
    const acpBackend = runtimeType === "acp" ? "opencode" : task.agent;
    const sessionKey = `agent:${acpBackend}:${runtimeType}:${crypto.randomUUID()}`;
    const cwd = resolveCwd(task);

    process.stderr.write(`[DISPATCH] ${runtimeType} spawn for ${task.id}\n`);

    try {
      if (runtimeType === "acp") {
        await dispatchAcp(task, sessionKey, cwd);
      } else {
        await dispatchSubagent(task, sessionKey);
      }
    } catch (e) {
      console.error(
        `[dispatch] Failed to dispatch task ${task.id}:`,
        e.message,
      );
      const now = Date.now();
      db.prepare(
        "UPDATE tasks SET status = 'error', error = @error, retries = retries + 1, updated_at = @updated_at WHERE id = @id",
      ).run({ id: task.id, error: e.message, updated_at: now });
      return;
    }

    // Status already set to 'dispatched' inside dispatchAcp/dispatchSubagent
  }

  // ---- Session event injection ----
  // Inject task completion directly into SumoDeus's Telegram session via acp.prompt
  async function notifyMainSession(task, status) {
    try {
      if (!api.runtime?.acp?.prompt) {
        process.stderr.write(
          `[NOTIFY-SESSION] api.runtime.acp.prompt not available\n`,
        );
        return;
      }

      const sessionKey =
        CONFIG.notifications?.sumodeusSessionKey ||
        "agent:main:telegram:direct:dhruv";
      const threadLink = task.threadId
        ? `https://discord.com/channels/1475480367166128354/${task.threadId}`
        : "";
      const commitHash = extractCommitHash(task.output || "");

      const icon =
        status === "done"
          ? "✅"
          : status === "error"
            ? "❌"
            : status === "blocked"
              ? "⚠️"
              : "ℹ️";
      const text = [
        `[Task Completion — RELAY TO DHRUV ON TELEGRAM]`,
        ``,
        `${icon} Task ${status}: "${task.title}"`,
        `ID: ${task.id.slice(0, 8)}`,
        commitHash ? `Commit: ${commitHash}` : null,
        task.error ? `Error: ${task.error.slice(0, 200)}` : null,
        threadLink ? `Thread: ${threadLink}` : null,
        ``,
        `ACTION REQUIRED: Use the message tool (action=send, channel=telegram) to notify Dhruv about this task completion. Summarize what was done and include the thread link if available. Do NOT just reply in the session — Dhruv won't see it unless you use the message tool.`,
      ]
        .filter(Boolean)
        .join("\n");

      await api.runtime.acp.prompt({
        sessionKey,
        text,
      });

      process.stderr.write(
        `[NOTIFY-SESSION] Prompted SumoDeus session (${status}) for task ${task.id.slice(0, 8)}\n`,
      );
    } catch (e) {
      process.stderr.write(`[NOTIFY-SESSION] Failed: ${e.message}\n`);
    }
  }

  async function notifyTelegram(task, status) {
    try {
      const { readFileSync } = require("node:fs");
      const cfg = JSON.parse(
        readFileSync(`${process.env.HOME}/.openclaw/openclaw.json`, "utf8"),
      );
      const botToken = cfg.channels?.telegram?.accounts?.default?.botToken;
      process.stderr.write(`[NOTIFY] botToken found: ${!!botToken}\n`);
      if (!botToken) return;
      const chatId = "569346031"; // Dhruv
      const icon =
        status === "review"
          ? "✅"
          : status === "error"
            ? "❌"
            : status === "blocked"
              ? "⚠️"
              : "ℹ️";
      const project =
        (task.projectId || "unknown").charAt(0).toUpperCase() +
        (task.projectId || "unknown").slice(1);
      const agent =
        (task.agent || "zeus").charAt(0).toUpperCase() +
        (task.agent || "zeus").slice(1);
      const threadLink = task.threadId
        ? `https://discord.com/channels/1475480367166128354/${task.threadId}`
        : null;
      process.stderr.write(`[NOTIFY] threadLink: ${threadLink}\n`);
      const lines = [
        `${icon} ${task.title}`,
        `Agent: ${agent}`,
        `Project: ${project}`,
      ];
      if (task.error && status === "error")
        lines.push(`Error: ${task.error.slice(0, 200)}`);
      if (task.error && status === "blocked")
        lines.push(`Warning: ${task.error.slice(0, 200)}`);
      if (threadLink) lines.push(`ACP: [Thread](${threadLink})`);
      const text = lines.join("\n");
      process.stderr.write(`[NOTIFY] Sending: ${text.slice(0, 100)}...\n`);
      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: text,
            parse_mode: "Markdown",
            disable_web_page_preview: true,
          }),
        },
      );
      const responseText = await response.text();
      process.stderr.write(
        `[NOTIFY] Telegram response: ${responseText.slice(0, 200)}\n`,
      );
    } catch (e) {
      process.stderr.write(
        `[NOTIFY] Telegram notification failed: ${e.message}\n`,
      );
    }
  }

  function resolveBotToken(accountId) {
    try {
      const { readFileSync } = require("node:fs");
      const cfg = JSON.parse(
        readFileSync(`${process.env.HOME}/.openclaw/openclaw.json`, "utf8"),
      );
      return cfg.channels?.discord?.accounts?.[accountId]?.token || null;
    } catch (_) {
      return null;
    }
  }

  function resolveAccountId(agent) {
    // Map logical agent name to Discord bot accountId
    const map = {
      zeus: "zeus",
      atum: "atum",
      ibis: "ibis",
      athena: "athena",
      hathor: "hathor",
      sphinx: "sphinx",
      osiris: "osiris",
      maat: "maat",
      sumodeus: "sumodeus",
    };
    return map[agent] || "sumodeus";
  }

  function resolveChannelId(projectId) {
    // Return the Discord channel for a project (parent channel for threads)
    if (projectId && PROJECT_CHANNELS[projectId])
      return PROJECT_CHANNELS[projectId];
    return null;
  }

  async function dispatchAcp(task, sessionKey, cwd) {
    process.stderr.write(
      `[DISPATCH.ACP] Spawning via spawnAcpDirect for ${task.id}\n`,
    );

    if (!api.runtime?.acp?.spawn) {
      throw new Error(
        "api.runtime.acp.spawn not available — OpenClaw fork required",
      );
    }

    const resolvedCwd = cwd || defaultCwd;
    const prompt = formatTaskPrompt(task);
    const channelId = resolveChannel(task);
    const accountId = resolveAccountId(task.agent);

    // Mark as dispatched
    const dispNow = Date.now();
    db.prepare(
      "UPDATE tasks SET status = 'dispatched', session_key = @sessionKey, run_id = NULL, updated_at = @updated_at WHERE id = @id",
    ).run({ id: task.id, sessionKey, updated_at: dispNow });
    onTaskChanged(task.id);

    let childSessionKey = sessionKey;
    let childRunId = "";
    try {
      // Single call — handles session creation, thread creation, binding, and delivery
      const result = await api.runtime.acp.spawn(
        {
          task: prompt,
          label: `${task.title.slice(0, 55)}-${task.id.slice(0, 8)}`,
          agentId: "opencode",
          cwd: resolvedCwd,
          thread: true,
        },
        {
          agentChannel: "discord",
          agentAccountId: accountId,
          agentTo: channelId ? `channel:${channelId}` : undefined,
        },
      );

      if (result?.status !== "accepted") {
        throw new Error(
          result?.error ||
            `acp spawn failed with status=${result?.status || "unknown"}`,
        );
      }

      childSessionKey = result?.childSessionKey || sessionKey;
      childRunId = typeof result?.runId === "string" ? result.runId.trim() : "";
      if (!childRunId) {
        throw new Error("acp spawn did not return runId");
      }

      process.stderr.write(
        `[DISPATCH.ACP] spawn accepted for ${task.id}, runId=${childRunId}, session=${childSessionKey}\n`,
      );

      // Look up the thread ID from the bindings file using childSessionKey.
      // spawnAcpDirect returns immediately after dispatching — give the binding
      // service a moment to flush the new entry to disk.
      let boundThreadId = null;
      try {
        const bindingsPath = `${process.env.HOME}/.openclaw/discord/thread-bindings.json`;
        const { readFileSync } = await import("node:fs");
        // Retry up to 5x with 500ms gap (binding flush may be async)
        for (let attempt = 0; attempt < 5; attempt++) {
          await new Promise((r) => setTimeout(r, 500));
          try {
            const bindingsData = JSON.parse(readFileSync(bindingsPath, "utf8"));
            const bindings = bindingsData.bindings || {};
            for (const binding of Object.values(bindings)) {
              if (binding.targetSessionKey === childSessionKey) {
                boundThreadId = String(binding.threadId);
                break;
              }
            }
            if (boundThreadId) break;
          } catch (_) {
            /* file not ready yet */
          }
        }
      } catch (e) {
        process.stderr.write(
          `[DISPATCH.ACP] Could not read thread binding: ${e.message}\n`,
        );
      }

      db.prepare(
        "UPDATE tasks SET session_key = @sessionKey, run_id = @runId, thread_id = @threadId, updated_at = @updated_at WHERE id = @id",
      ).run({
        id: task.id,
        sessionKey: childSessionKey,
        runId: childRunId,
        threadId: boundThreadId,
        updated_at: Date.now(),
      });

      if (boundThreadId) {
        process.stderr.write(
          `[DISPATCH.ACP] bound thread ${boundThreadId} for task ${task.id}\n`,
        );
      } else {
        // Hard fail — a null threadId means we lost the Discord thread.
        // Better to surface this immediately than silently proceed with no thread.
        process.stderr.write(
          `[DISPATCH.ACP] FATAL: no thread binding found for session ${childSessionKey} after 5 retries\n`,
        );
        const now = Date.now();
        db.prepare(
          "UPDATE tasks SET status = 'error', error = @error, retries = retries + 1, updated_at = @updated_at WHERE id = @id",
        ).run({
          id: task.id,
          error: `spawn succeeded but Discord thread binding not found for session ${childSessionKey} — check gateway logs`,
          updated_at: now,
        });
        onTaskChanged(task.id);
        return;
      }
    } catch (e) {
      process.stderr.write(
        `[DISPATCH.ACP] spawnAcpDirect failed: ${e.message}\n`,
      );
      const now = Date.now();
      db.prepare(
        "UPDATE tasks SET status = 'error', error = @error, retries = retries + 1, updated_at = @updated_at WHERE id = @id",
      ).run({
        id: task.id,
        error: `spawn failed: ${e.message}`,
        updated_at: now,
      });
      onTaskChanged(task.id);
      return;
    }

    if (!api.runtime?.subagent?.waitForRun) {
      const now = Date.now();
      db.prepare(
        "UPDATE tasks SET status = 'error', error = @error, retries = retries + 1, updated_at = @updated_at WHERE id = @id",
      ).run({
        id: task.id,
        error: "subagent.waitForRun not available",
        updated_at: now,
      });
      onTaskChanged(task.id);
      return;
    }

    let waitStatus = "timeout";
    let waitError = "";
    const timeoutMs = resolveTaskTimeoutMs(task);
    try {
      const wait = await api.runtime.subagent.waitForRun({
        runId: childRunId,
        timeoutMs,
      });
      waitStatus = wait?.status || "timeout";
      waitError = wait?.error || "";
      process.stderr.write(
        `[DISPATCH.ACP] waitForRun task=${task.id} runId=${childRunId} timeoutMs=${timeoutMs} status=${waitStatus}${waitError ? ` error=${waitError}` : ""}\n`,
      );
    } catch (e) {
      waitStatus = "error";
      waitError = e.message;
      process.stderr.write(`[DISPATCH.ACP] waitForRun failed: ${e.message}\n`);
    }

    if (waitStatus !== "ok") {
      const now = Date.now();
      const error =
        waitStatus === "timeout"
          ? "ACP run timed out while waiting for completion"
          : `ACP run failed${waitError ? `: ${waitError}` : ""}`;
      db.prepare(
        "UPDATE tasks SET status = 'error', error = @error, retries = retries + 1, updated_at = @updated_at WHERE id = @id",
      ).run({ id: task.id, error, updated_at: now });
      onTaskChanged(task.id);
      notifyMainSession({ ...task, error }, "error");
      // notifyTelegram({ ...task, error }, "error");
      return;
    }

    let text = "";
    try {
      if (api.runtime?.subagent?.getSessionMessages) {
        const sessionMessages = await api.runtime.subagent.getSessionMessages({
          sessionKey: childSessionKey,
          limit: 200,
        });
        text = extractOutputFromMessages(sessionMessages?.messages || []);
      }
    } catch (e) {
      process.stderr.write(
        `[DISPATCH.ACP] Could not get session messages: ${e.message}\n`,
      );
    }

    process.stderr.write(
      `[DISPATCH.ACP] completed for ${task.id}, output=${text.length} chars\n`,
    );

    // Mark review and run automated Maat review loop
    const reviewNow = Date.now();
    db.prepare(
      "UPDATE tasks SET status = 'review', output = @output, completed_at = NULL, updated_at = @updated_at WHERE id = @id",
    ).run({
      id: task.id,
      output: text.slice(0, 10000),
      updated_at: reviewNow,
    });

    // Post completion to Discord thread
    if (task.threadId) {
      const summary = text.slice(0, 1500);
      await postToThread(
        task.threadId,
        `✅ **Task completed**\n\n**Output:**\n${summary}${text.length > 1500 ? "..." : ""}`,
      );
    }

    onTaskChanged(task.id);
    // Re-read task from DB to get threadId (set during dispatch, not on in-memory object)
    const freshTask = rowToTask(getTask(task.id));
    process.stderr.write(
      `[NOTIFY] QA starting for ${task.id} threadId=${freshTask?.threadId}\n`,
    );
    if (resolveQaRequired(task)) {
      try {
        await runMaatReviewLoop(task.id);
      } catch (e) {
        const now = Date.now();
        db.prepare(
          "UPDATE tasks SET status = 'error', error = @error, retries = retries + 1, updated_at = @updated_at WHERE id = @id",
        ).run({
          id: task.id,
          error: `QA review loop failed: ${e.message}`,
          updated_at: now,
        });
        onTaskChanged(task.id);
        // notifyTelegram(rowToTask(getTask(task.id)) || task, "error");
      }
    } else {
      // QA disabled — auto-approve
      const now = Date.now();
      db.prepare(
        "UPDATE tasks SET status = 'done', completed_at = @completed_at, updated_at = @updated_at WHERE id = @id",
      ).run({ id: task.id, completed_at: now, updated_at: now });
      notifyMainSession(freshTask || task, "done");
      onTaskChanged(task.id);
      triggerDependents(task.id);
      process.stderr.write(
        `[QA] Skipped (qaRequired=false), auto-approved ${task.id}\n`,
      );
    }
  }

  // ---- DAG: auto-dispatch tasks whose dependencies are all done ----
  function triggerDependents(completedTaskId) {
    try {
      // Find tasks in 'ready' status whose depends_on list includes the completed task
      const candidates = db
        .prepare(
          `SELECT * FROM tasks WHERE status = 'pending'
           AND EXISTS (
             SELECT 1 FROM json_each(depends_on) d WHERE d.value = ?
           )`,
        )
        .all(completedTaskId)
        .map(rowToTask);

      for (const candidate of candidates) {
        // Check all of this task's dependencies are done
        const deps = candidate.dependsOn || [];
        if (deps.length === 0) continue;
        const placeholders = deps.map(() => "?").join(",");
        const doneCount = db
          .prepare(
            `SELECT COUNT(*) as c FROM tasks WHERE id IN (${placeholders}) AND status = 'done'`,
          )
          .get(...deps);

        if (doneCount && doneCount.c === deps.length) {
          process.stderr.write(
            `[DAG] All dependencies done — auto-dispatching ${candidate.id} (${candidate.title})\n`,
          );
          // Transition pending → ready, then dispatch
          db.prepare(
            "UPDATE tasks SET status = 'ready', updated_at = ? WHERE id = ?",
          ).run(Date.now(), candidate.id);
          const readyTask = { ...candidate, status: "ready" };
          onTaskChanged(candidate.id);
          dispatchTask(readyTask).catch((e) =>
            process.stderr.write(
              `[DAG] Dispatch failed for ${candidate.id}: ${e.message}\n`,
            ),
          );
        }
      }
    } catch (e) {
      process.stderr.write(`[DAG] triggerDependents error: ${e.message}\n`);
    }
  }

  async function dispatchSubagent(task, sessionKey) {
    if (!api.runtime?.subagent?.run) {
      throw new Error("api.runtime.subagent.run not available");
    }

    // Mark dispatched immediately
    const dispNow = Date.now();
    db.prepare(
      "UPDATE tasks SET session_key = @sessionKey, run_id = NULL, status = 'dispatched', updated_at = @updated_at WHERE id = @id",
    ).run({ id: task.id, sessionKey, updated_at: dispNow });
    onTaskChanged(task.id);
    process.stderr.write(
      `[DISPATCH.subagent] Task ${task.id} marked dispatched\n`,
    );

    // Create Discord thread for this task
    const threadId = await createDiscordThread(task);
    if (threadId) {
      task.threadId = threadId;
    }

    const prompt = formatTaskPrompt(task);

    // Run subagent and wait for completion
    const run = await api.runtime.subagent.run({
      sessionKey,
      message: prompt,
      idempotencyKey: crypto.randomUUID(),
      lane: "subagent",
    });

    const runId = typeof run?.runId === "string" ? run.runId.trim() : "";
    if (runId) {
      db.prepare(
        "UPDATE tasks SET run_id = @runId, updated_at = @updated_at WHERE id = @id",
      ).run({
        id: task.id,
        runId,
        updated_at: Date.now(),
      });
    }

    if (!api.runtime?.subagent?.waitForRun) {
      throw new Error("api.runtime.subagent.waitForRun not available");
    }

    if (runId) {
      const wait = await api.runtime.subagent.waitForRun({
        runId,
        timeoutMs: resolveTaskTimeoutMs(task),
      });
      const waitStatus = wait?.status || "timeout";
      if (waitStatus !== "ok") {
        const now = Date.now();
        const waitError = wait?.error ? `: ${wait.error}` : "";
        db.prepare(
          "UPDATE tasks SET status = 'error', error = @error, retries = retries + 1, updated_at = @updated_at WHERE id = @id",
        ).run({
          id: task.id,
          error: `subagent run failed (${waitStatus})${waitError}`,
          updated_at: now,
        });
        onTaskChanged(task.id);
        // notifyTelegram(rowToTask(getTask(task.id)) || task, "error");
        return;
      }
    }

    // Get output from session messages
    let output = "";
    try {
      const sessionMessages = await api.runtime.subagent.getSessionMessages({
        sessionKey,
        limit: 200,
      });
      output = extractOutputFromMessages(sessionMessages?.messages || []);
    } catch (e) {
      process.stderr.write(
        `[DISPATCH.subagent] Could not get messages: ${e.message}\n`,
      );
    }

    // Mark review and run automated Maat review loop
    const reviewNow = Date.now();
    db.prepare(
      "UPDATE tasks SET status = 'review', output = @output, completed_at = NULL, updated_at = @updated_at WHERE id = @id",
    ).run({
      id: task.id,
      output: output.slice(0, 10000),
      updated_at: reviewNow,
    });

    // Post completion to Discord thread
    if (task.threadId) {
      const summary = output.slice(0, 1500);
      await postToThread(
        task.threadId,
        `✅ **Task completed**\n\n**Output:**\n${summary}${output.length > 1500 ? "..." : ""}`,
      );
    }

    onTaskChanged(task.id);
    if (resolveQaRequired(task)) {
      try {
        await runMaatReviewLoop(task.id);
      } catch (e) {
        const now = Date.now();
        db.prepare(
          "UPDATE tasks SET status = 'error', error = @error, retries = retries + 1, updated_at = @updated_at WHERE id = @id",
        ).run({
          id: task.id,
          error: `QA review loop failed: ${e.message}`,
          updated_at: now,
        });
        onTaskChanged(task.id);
        // notifyTelegram(rowToTask(getTask(task.id)) || task, "error");
      }
    } else {
      const now = Date.now();
      db.prepare(
        "UPDATE tasks SET status = 'done', completed_at = @completed_at, updated_at = @updated_at WHERE id = @id",
      ).run({ id: task.id, completed_at: now, updated_at: now });
      notifyMainSession(task, "done");
      onTaskChanged(task.id);
      triggerDependents(task.id);
      process.stderr.write(
        `[QA] Skipped (qaRequired=false), auto-approved ${task.id}\n`,
      );
    }
  }

  function getAcpRuntime() {
    try {
      const key = Symbol.for("openclaw.acpRuntimeRegistryState");
      const state = globalThis[key];
      if (!state || !state.backendsById) return null;
      const backend = state.backendsById.get("acpx");
      return backend?.runtime || null;
    } catch (e) {
      return null;
    }
  }

  // Prepared statements
  // In-flight guard — prevents double-dispatch of the same task
  const inFlightDispatch = new Set();

  const stmts = {
    insert: db.prepare(`
      INSERT INTO tasks (id, title, description, agent, runtime, project_id, channel_id, cwd, model, thinking, depends_on, chain_id, status, manual_complete, timeout_ms, review_attempts, qa_required, created_at, updated_at)
      VALUES (@id, @title, @description, @agent, @runtime, @project_id, @channel_id, @cwd, @model, @thinking, @depends_on, @chain_id, @status, @manual_complete, @timeout_ms, @review_attempts, @qa_required, @created_at, @updated_at)
    `),
    getById: db.prepare("SELECT * FROM tasks WHERE id = ?"),
    deleteById: db.prepare("DELETE FROM tasks WHERE id = ?"),
    updateStatus: db.prepare(
      "UPDATE tasks SET status = @status, updated_at = @updated_at, completed_at = @completed_at WHERE id = @id",
    ),
    pendingWithAllDepsDone: db.prepare(`
      SELECT t.* FROM tasks t
      WHERE t.status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM json_each(t.depends_on) d
        WHERE d.value NOT IN (SELECT id FROM tasks WHERE status = 'done')
      )
    `),
    countByStatus: db.prepare(
      "SELECT status, COUNT(*) as count FROM tasks GROUP BY status",
    ),
    countByAgent: db.prepare(
      "SELECT agent, COUNT(*) as count FROM tasks GROUP BY agent",
    ),
    countByProject: db.prepare(
      "SELECT project_id, COUNT(*) as count FROM tasks WHERE project_id IS NOT NULL GROUP BY project_id",
    ),
    insertSchedule: db.prepare(`
      INSERT INTO schedules (id, title, description, agent, project_id, cwd, category, qa_required, cron, nl_expression, timeout_ms, enabled, last_run_at, next_run_at, created_at, updated_at)
      VALUES (@id, @title, @description, @agent, @project_id, @cwd, @category, @qa_required, @cron, @nl_expression, @timeout_ms, @enabled, @last_run_at, @next_run_at, @created_at, @updated_at)
    `),
    listSchedules: db.prepare(
      "SELECT * FROM schedules ORDER BY created_at DESC",
    ),
    getScheduleById: db.prepare("SELECT * FROM schedules WHERE id = ?"),
    updateScheduleById: db.prepare(
      "UPDATE schedules SET enabled = @enabled, updated_at = @updated_at, next_run_at = @next_run_at WHERE id = @id",
    ),
    deleteScheduleById: db.prepare("DELETE FROM schedules WHERE id = ?"),
    listDueSchedules: db.prepare(
      "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC",
    ),
    touchScheduleRun: db.prepare(
      "UPDATE schedules SET last_run_at = @last_run_at, next_run_at = @next_run_at, updated_at = @updated_at WHERE id = @id",
    ),
    listCommentsByTask: db.prepare(
      "SELECT * FROM comments WHERE task_id = ? ORDER BY created_at ASC",
    ),
    insertComment: db.prepare(
      "INSERT INTO comments (id, task_id, author, body, created_at) VALUES (@id, @task_id, @author, @body, @created_at)",
    ),
  };

  // ---- Core functions ----

  function getTask(id) {
    return stmts.getById.get(id);
  }

  function onTaskChanged(taskId) {
    const task = getTask(taskId);
    if (task) {
      broadcastTaskEvent(rowToTask(task));
    }

    // When a task becomes done, check for newly ready tasks
    if (task && task.status === "done") {
      const ready = stmts.pendingWithAllDepsDone.all();
      for (const t of ready) {
        if (t.id === taskId) continue;
        const now = Date.now();
        stmts.updateStatus.run({
          id: t.id,
          status: "ready",
          updated_at: now,
          completed_at: null,
        });
        // Recurse in case of chain reaction
        onTaskChanged(t.id);
      }
      return;
    }

    // When a task becomes ready, trigger dispatch via self-call
    if (task && task.status === "ready") {
      triggerDispatch(task.id);
    }
  }

  function buildListQuery(query) {
    const conditions = [];
    const params = {};

    if (query.status) {
      conditions.push("status = @status");
      params.status = query.status;
    }
    if (query.agent) {
      conditions.push("agent = @agent");
      params.agent = query.agent;
    }
    if (query.projectId) {
      conditions.push("project_id = @projectId");
      params.projectId = query.projectId;
    }
    if (query.chainId) {
      conditions.push("chain_id = @chainId");
      params.chainId = query.chainId;
    }

    let sql = "SELECT * FROM tasks";
    if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
    sql += " ORDER BY created_at DESC";

    if (query.limit) {
      sql += " LIMIT @limit";
      params.limit = parseInt(query.limit, 10);
    }

    return db.prepare(sql).all(params);
  }

  function getSchedule(id) {
    return stmts.getScheduleById.get(id);
  }

  function createTaskFromSchedule(scheduleRow) {
    const now = Date.now();
    const id = crypto.randomUUID();
    const taskRow = {
      id,
      title: scheduleRow.title,
      description: scheduleRow.description || null,
      agent: scheduleRow.agent,
      runtime: null,
      project_id: scheduleRow.project_id || null,
      channel_id: null,
      cwd: scheduleRow.cwd || null,
      model: null,
      thinking: null,
      depends_on: "[]",
      chain_id: null,
      status: "ready",
      manual_complete: 0,
      timeout_ms: normalizeTimeoutMs(
        scheduleRow.timeout_ms,
        defaultTaskTimeoutMs,
      ),
      review_attempts: 0,
      qa_required: scheduleRow.qa_required === 0 ? 0 : 1,
      created_at: now,
      updated_at: now,
    };

    stmts.insert.run(taskRow);
    const createdTask = rowToTask(getTask(id));
    if (createdTask) {
      broadcastTaskEvent(createdTask);
      triggerDispatch(createdTask.id);
    }

    return createdTask;
  }

  function handleListSchedules(_req, res) {
    const rows = stmts.listSchedules.all();
    sendJson(res, rows.map(rowToSchedule));
  }

  async function handleCreateSchedule(req, res) {
    const body = await parseBody(req);
    if (!body.title) {
      sendError(res, 400, "title is required");
      return;
    }

    const hasCronExpression =
      typeof body.cronExpression === "string" && body.cronExpression.trim();
    const parsedCron = parseNlExpressionToCron(body.nlExpression);
    const cronExpression = hasCronExpression
      ? body.cronExpression.trim()
      : parsedCron;

    if (!cronExpression) {
      sendError(
        res,
        400,
        "Could not parse NL expression. Please provide an explicit cron expression.",
      );
      return;
    }

    let nextRunAt;
    try {
      nextRunAt = getNextRunAt(cronExpression);
    } catch {
      sendError(res, 400, "Invalid cron expression");
      return;
    }

    const now = Date.now();
    const row = {
      id: crypto.randomUUID(),
      title: body.title,
      description: body.description || null,
      agent: body.agent || "zeus",
      project_id: body.projectId || null,
      cwd: body.cwd || null,
      category: body.category || null,
      qa_required: body.qaRequired === false ? 0 : 1,
      cron: cronExpression,
      nl_expression:
        typeof body.nlExpression === "string" && body.nlExpression.trim()
          ? body.nlExpression.trim()
          : null,
      timeout_ms: normalizeTimeoutMs(body.timeoutMs, defaultTaskTimeoutMs),
      enabled: body.enabled === false ? 0 : 1,
      last_run_at: null,
      next_run_at: nextRunAt,
      created_at: now,
      updated_at: now,
    };

    stmts.insertSchedule.run(row);
    sendJson(res, rowToSchedule(getSchedule(row.id)), 201);
  }

  async function handleUpdateSchedule(req, res, id) {
    const existing = getSchedule(id);
    if (!existing) {
      sendError(res, 404, "Schedule not found");
      return;
    }

    const body = await parseBody(req);
    if (typeof body.enabled !== "boolean") {
      sendError(res, 400, "enabled boolean is required");
      return;
    }

    const now = Date.now();
    let nextRunAt = existing.next_run_at;
    if (body.enabled) {
      try {
        nextRunAt = getNextRunAt(existing.cron, now);
      } catch {
        sendError(res, 400, "Invalid cron expression");
        return;
      }
    }

    stmts.updateScheduleById.run({
      id,
      enabled: body.enabled ? 1 : 0,
      updated_at: now,
      next_run_at: body.enabled ? nextRunAt : null,
    });
    sendJson(res, rowToSchedule(getSchedule(id)));
  }

  function handleDeleteSchedule(res, id) {
    const existing = getSchedule(id);
    if (!existing) {
      sendError(res, 404, "Schedule not found");
      return;
    }

    stmts.deleteScheduleById.run(id);
    sendJson(res, { ok: true });
  }

  async function summarizeProject(projectRow) {
    const project = db
      .prepare("SELECT id, name, repo, description FROM projects WHERE id = ?")
      .get(projectRow.id || projectRow);

    if (!project) {
      throw new Error("Project not found");
    }
    if (!project.repo) {
      throw new Error("Project does not have a linked repository");
    }

    const commits = db
      .prepare(
        `SELECT sha, message, author, date
         FROM project_commits
         WHERE project_id = ?
         ORDER BY date DESC, id DESC
         LIMIT 10`,
      )
      .all(project.id);

    const completedSince = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const completedTasks = db
      .prepare(
        `SELECT title, status
         FROM tasks
         WHERE project_id = ?
           AND status = 'done'
           AND completed_at IS NOT NULL
           AND completed_at >= ?
         ORDER BY completed_at DESC`,
      )
      .all(project.id, completedSince);

    const commitBullets =
      commits.length > 0
        ? commits
            .map(
              (c) =>
                `- ${c.sha} - ${c.message || "(no message)"} (${c.author || "unknown"}, ${c.date || "unknown date"})`,
            )
            .join("\n")
        : "- None";

    const taskBullets =
      completedTasks.length > 0
        ? completedTasks
            .map((t) => `- ${t.title || "(untitled)"} - ${t.status || "done"}`)
            .join("\n")
        : "- None";

    const prompt = `You are a project tracker. Given the recent commits and completed tasks for "${project.name}" (${project.description || "No description"}), generate a JSON response:

{
  "summary": "2-3 sentence progress summary referencing actual commit messages",
  "progress_pct": 0-100,
  "blockers": ["list of blockers if any, empty array if none"]
}

export * from "./types";
export * from "./db";
export * from "./config";
export * from "./dispatch";
export * from "./qa";
export * from "./notify";
export * from "./scheduler";

Recent commits:
${commitBullets}

Completed tasks (last 7 days):
${taskBullets}

Be specific — reference actual commit messages and features. Don't be vague.`;

    const llmResponse = await fetch("http://127.0.0.1:18789/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "lite",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
      }),
    });

    if (!llmResponse.ok) {
      const errText = await llmResponse.text();
      throw new Error(`LLM request failed: ${llmResponse.status} ${errText.slice(0, 300)}`);
    }

    const llmData = await llmResponse.json();
    const content = llmData?.choices?.[0]?.message?.content;
    const parsed = extractJsonObject(content);
    if (!parsed) {
      throw new Error("LLM response was not valid JSON");
    }

    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    if (!summary) {
      throw new Error("LLM response missing summary");
    }

    const rawProgress = Number(parsed.progress_pct);
    const progressPct = Number.isFinite(rawProgress)
      ? Math.max(0, Math.min(100, Math.round(rawProgress)))
      : 0;

    const blockers = Array.isArray(parsed.blockers)
      ? parsed.blockers
          .filter((item) => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
      : [];

    const insertResult = db
      .prepare(
        `INSERT INTO project_snapshots (project_id, summary, progress_pct, blockers, model)
         VALUES (?, ?, ?, ?, 'lite')`,
      )
      .run(project.id, summary, progressPct, JSON.stringify(blockers));

    const snapshotRow = db
      .prepare(
        `SELECT id, project_id, summary, progress_pct, blockers, generated_at, model
         FROM project_snapshots
         WHERE id = ?`,
      )
      .get(insertResult.lastInsertRowid);

    const snapshot = {
      id: snapshotRow.id,
      projectId: snapshotRow.project_id,
      summary: snapshotRow.summary,
      progressPct: snapshotRow.progress_pct,
      blockers: parseJsonArray(snapshotRow.blockers),
      generatedAt: snapshotRow.generated_at,
      model: snapshotRow.model,
    };

    broadcastSseEvent("project:snapshot", {
      projectId: project.id,
      snapshot,
    });

    return snapshot;
  }

  async function runProjectSummaryTick() {
    const projects = db
      .prepare("SELECT id FROM projects WHERE repo IS NOT NULL AND trim(repo) != ''")
      .all();

    for (const project of projects) {
      try {
        await summarizeProject(project);
      } catch (error) {
        process.stderr.write(
          `[PROJECT_SUMMARY] Failed for ${project.id}: ${error.message}\n`,
        );
      }
    }
  }

  function runScheduleTick() {
    const now = Date.now();
    const dueSchedules = stmts.listDueSchedules.all(now);

    for (const schedule of dueSchedules) {
      try {
        createTaskFromSchedule(schedule);
        const nextRunAt = getNextRunAt(schedule.cron, now);
        stmts.touchScheduleRun.run({
          id: schedule.id,
          last_run_at: now,
          next_run_at: nextRunAt,
          updated_at: now,
        });
      } catch (error) {
        process.stderr.write(
          `[SCHEDULER] Failed schedule ${schedule.id}: ${error.message}\n`,
        );
      }
    }
  }

  runScheduleTick();
  setInterval(runScheduleTick, 60_000);
  setInterval(() => {
    runProjectSummaryTick().catch((error) => {
      process.stderr.write(`[PROJECT_SUMMARY] Tick failed: ${error.message}\n`);
    });
  }, 6 * 60 * 60 * 1000);

  // ---- Route handlers ----

  async function handleCreate(req, res) {
    const body = await parseBody(req);

    // Request source logging
    const src =
      req.headers?.["x-source"] || req.headers?.["user-agent"] || "unknown";
    process.stderr.write(
      `[TASK-CREATE] agent=${body.agent || "?"} title="${(body.title || "").slice(0, 50)}" source=${src}\n`,
    );

    if (!body.title || !body.agent) {
      sendError(res, 400, "title and agent are required");
      return;
    }

    const now = Date.now();
    const id = crypto.randomUUID();
    const dependsOn = (body.dependsOn || []).filter(
      (id) => typeof id === "string" && id.trim().length > 0,
    );
    if (body.dependsOn && body.dependsOn.length !== dependsOn.length) {
      const bad = body.dependsOn.filter(
        (id) => typeof id !== "string" || id.trim().length === 0,
      );
      return res.status(400).json({
        error: `dependsOn contains invalid IDs: ${JSON.stringify(bad)}`,
      });
    }

    // Determine initial status: if no deps or all deps done → ready
    let status = "pending";
    if (dependsOn.length === 0) {
      status = "ready";
    } else {
      const placeholders = dependsOn.map(() => "?").join(",");
      const doneCount = db
        .prepare(
          `SELECT COUNT(*) as c FROM tasks WHERE id IN (${placeholders}) AND status = 'done'`,
        )
        .get(...dependsOn);
      if (doneCount && doneCount.c === dependsOn.length) {
        status = "ready";
      }
    }

    const row = {
      id,
      title: body.title,
      description: body.description || null,
      agent: body.agent,
      runtime: body.runtime || null,
      project_id: body.projectId || null,
      channel_id: body.channelId || null,
      cwd: body.cwd || null,
      model: body.model || null,
      thinking: body.thinking || null,
      depends_on: JSON.stringify(dependsOn),
      chain_id: body.chainId || null,
      status,
      manual_complete: body.manualComplete ? 1 : 0,
      timeout_ms: normalizeTimeoutMs(body.timeoutMs, defaultTaskTimeoutMs),
      review_attempts: 0,
      qa_required: body.qaRequired === false ? 0 : 1,
      created_at: now,
      updated_at: now,
    };

    stmts.insert.run(row);
    const created = rowToTask(getTask(id));

    sendJson(res, created, 201);
    broadcastTaskEvent(created);

    if (status === "ready") {
      triggerDispatch(created.id);
    }
  }

  function handleList(req, res) {
    const query = parseQuery(req.url);
    const rows = buildListQuery(query);
    sendJson(res, rows.map(rowToTask));
  }

  function handleGetOne(res, id) {
    const task = getTask(id);
    if (!task) {
      sendError(res, 404, "Task not found");
      return;
    }
    sendJson(res, rowToTask(task));
  }

  async function handleUpdate(req, res, id) {
    const existing = getTask(id);
    if (!existing) {
      sendError(res, 404, "Task not found");
      return;
    }

    const body = await parseBody(req);
    const now = Date.now();

    // Check status transition validity
    if (body.status && body.status !== existing.status) {
      if (!isValidTransition(existing.status, body.status)) {
        sendError(
          res,
          400,
          `Invalid status transition: ${existing.status} → ${body.status}`,
        );
        return;
      }
    }

    // Build dynamic UPDATE
    const updatableFields = {
      title: "title",
      description: "description",
      agent: "agent",
      runtime: "runtime",
      projectId: "project_id",
      channelId: "channel_id",
      cwd: "cwd",
      model: "model",
      thinking: "thinking",
      dependsOn: "depends_on",
      chainId: "chain_id",
      status: "status",
      manualComplete: "manual_complete",
      timeoutMs: "timeout_ms",
      sessionKey: "session_key",
      runId: "run_id",
      threadId: "thread_id",
      output: "output",
      retries: "retries",
      reviewAttempts: "review_attempts",
      error: "error",
    };

    const sets = ["updated_at = @updated_at"];
    const params = { id, updated_at: now };

    for (const [apiField, dbCol] of Object.entries(updatableFields)) {
      if (body[apiField] !== undefined) {
        let value = body[apiField];
        if (apiField === "dependsOn") {
          const clean = (value || []).filter(
            (id) => typeof id === "string" && id.trim().length > 0,
          );
          if (value && value.length !== clean.length) {
            const bad = value.filter(
              (id) => typeof id !== "string" || id.trim().length === 0,
            );
            return res.status(400).json({
              error: `dependsOn contains invalid IDs: ${JSON.stringify(bad)}`,
            });
          }
          value = JSON.stringify(clean);
        }
        if (apiField === "manualComplete") value = value ? 1 : 0;
        if (apiField === "timeoutMs") {
          value = normalizeTimeoutMs(value, defaultTaskTimeoutMs);
        }
        sets.push(`${dbCol} = @${dbCol}`);
        params[dbCol] = value;
      }
    }

    // Clear error when resetting to ready
    if (body.status === "ready") {
      sets.push("error = NULL");
      sets.push("retries = 0");
      sets.push("review_attempts = 0");
    }

    // Set completed_at when transitioning to done
    if (body.status === "done") {
      sets.push("completed_at = @completed_at");
      params.completed_at = now;
    }

    const sql = `UPDATE tasks SET ${sets.join(", ")} WHERE id = @id`;
    db.prepare(sql).run(params);

    const updated = getTask(id);

    // Trigger DAG resolver if status changed
    if (body.status && body.status !== existing.status) {
      // If manually reset to ready, clear any stale in-flight lock
      if (body.status === "ready") {
        inFlightDispatch.delete(id);
      }
      onTaskChanged(id);
    }

    sendJson(res, rowToTask(updated));
  }

  function handleDelete(res, id) {
    const existing = getTask(id);
    if (!existing) {
      sendError(res, 404, "Task not found");
      return;
    }

    if (!["pending", "done", "cancelled"].includes(existing.status)) {
      sendError(
        res,
        400,
        `Cannot delete task with status '${existing.status}'. Only pending, done, or cancelled tasks can be deleted.`,
      );
      return;
    }

    stmts.deleteById.run(id);
    sendJson(res, { deleted: true, id });
  }

  function handleStats(_req, res) {
    const byStatus = {};
    for (const row of stmts.countByStatus.all()) {
      byStatus[row.status] = row.count;
    }
    const byAgent = {};
    for (const row of stmts.countByAgent.all()) {
      byAgent[row.agent] = row.count;
    }
    const byProject = {};
    for (const row of stmts.countByProject.all()) {
      byProject[row.project_id] = row.count;
    }
    sendJson(res, { byStatus, byAgent, byProject });
  }

  function handleListComments(res, taskId) {
    const task = getTask(taskId);
    if (!task) {
      sendError(res, 404, "Task not found");
      return;
    }

    const rows = stmts.listCommentsByTask.all(taskId);
    sendJson(res, rows.map(rowToComment));
  }

  async function handleCreateComment(req, res, taskId) {
    const task = getTask(taskId);
    if (!task) {
      sendError(res, 404, "Task not found");
      return;
    }

    const body = await parseBody(req);
    const author = typeof body.author === "string" ? body.author.trim() : "";
    const commentBody = typeof body.body === "string" ? body.body.trim() : "";

    if (!author || !commentBody) {
      sendError(res, 400, "author and body are required");
      return;
    }

    const row = {
      id: crypto.randomUUID(),
      task_id: taskId,
      author,
      body: commentBody,
      created_at: Date.now(),
    };

    stmts.insertComment.run(row);
    sendJson(res, rowToComment(row), 201);
  }

  function handleHealth(_req, res) {
    const acpRuntime = getAcpRuntime();
    sendJson(res, {
      status: "ok",
      timestamp: Date.now(),
      activeSessions: getActiveSessionCount(),
      maxConcurrentSessions,
      acpRuntimeAvailable: !!acpRuntime,
      dbPath,
    });
  }

  function parseHeartbeatCreatedAtMs(createdAt) {
    if (typeof createdAt !== "string" || !createdAt.trim()) {
      return null;
    }
    const iso = `${createdAt.replace(" ", "T")}Z`;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  }

  function normalizeHeartbeatChecks(checks) {
    if (!Array.isArray(checks)) {
      return [];
    }

    return checks
      .map((check) => {
        if (!check || typeof check !== "object") {
          return null;
        }
        const type = typeof check.type === "string" ? check.type.trim() : "";
        if (!type) {
          return null;
        }
        return {
          type,
          result:
            typeof check.result === "string" && check.result.trim()
              ? check.result.trim()
              : null,
          detail:
            typeof check.detail === "string" && check.detail.trim()
              ? check.detail.trim()
              : null,
        };
      })
      .filter(Boolean);
  }

  async function handleCreateHeartbeat(req, res) {
    const body = await parseBody(req);
    const agentId =
      typeof body.agentId === "string" ? body.agentId.trim().toLowerCase() : "";
    const agentName =
      typeof body.agentName === "string" && body.agentName.trim()
        ? body.agentName.trim()
        : null;
    const status = typeof body.status === "string" ? body.status.trim() : "";
    const action =
      typeof body.action === "string" && body.action.trim()
        ? body.action.trim()
        : null;
    const detail =
      typeof body.detail === "string" && body.detail.trim()
        ? body.detail.trim()
        : null;
    const error =
      typeof body.error === "string" && body.error.trim() ? body.error.trim() : null;

    if (!agentId) {
      sendError(res, 400, "agentId is required");
      return;
    }

    if (!["success", "no_work", "error"].includes(status)) {
      sendError(res, 400, "status must be one of: success, no_work, error");
      return;
    }

    const checks = normalizeHeartbeatChecks(body.checks);

    const insertLog = db.prepare(`
      INSERT INTO heartbeat_logs (agent_id, agent_name, status, action, detail, error)
      VALUES (@agent_id, @agent_name, @status, @action, @detail, @error)
    `);
    const insertCheck = db.prepare(`
      INSERT INTO heartbeat_tasks (heartbeat_id, check_type, result, detail)
      VALUES (@heartbeat_id, @check_type, @result, @detail)
    `);
    const getCreated = db.prepare(
      "SELECT id, created_at FROM heartbeat_logs WHERE id = ?",
    );

    const created = db.transaction(() => {
      const result = insertLog.run({
        agent_id: agentId,
        agent_name: agentName,
        status,
        action,
        detail,
        error,
      });
      const heartbeatId = Number(result.lastInsertRowid);
      for (const check of checks) {
        insertCheck.run({
          heartbeat_id: heartbeatId,
          check_type: check.type,
          result: check.result,
          detail: check.detail,
        });
      }
      return getCreated.get(heartbeatId);
    })();

    sendJson(res, created || { id: null, created_at: null }, 201);
  }

  function handleListHeartbeats(req, res) {
    const query = parseQuery(req.url);
    const requestedLimit = Number.parseInt(query.limit, 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, 100))
      : 20;
    const agentFilter =
      typeof query.agent === "string" && query.agent.trim()
        ? query.agent.trim().toLowerCase()
        : null;

    const conditions = [];
    const params = { limit };
    if (agentFilter) {
      conditions.push("agent_id = @agent");
      params.agent = agentFilter;
    }

    let logsSql = "SELECT * FROM heartbeat_logs";
    if (conditions.length > 0) {
      logsSql += ` WHERE ${conditions.join(" AND ")}`;
    }
    logsSql += " ORDER BY id DESC LIMIT @limit";

    const logs = db.prepare(logsSql).all(params);
    if (logs.length === 0) {
      sendJson(res, []);
      return;
    }

    const placeholders = logs.map(() => "?").join(",");
    const checks = db
      .prepare(
        `SELECT * FROM heartbeat_tasks WHERE heartbeat_id IN (${placeholders}) ORDER BY id ASC`,
      )
      .all(...logs.map((log) => log.id));

    const checksByHeartbeatId = new Map();
    for (const check of checks) {
      const list = checksByHeartbeatId.get(check.heartbeat_id) || [];
      list.push({
        id: check.id,
        heartbeatId: check.heartbeat_id,
        type: check.check_type,
        result: check.result,
        detail: check.detail,
        createdAt: check.created_at,
      });
      checksByHeartbeatId.set(check.heartbeat_id, list);
    }

    sendJson(
      res,
      logs.map((log) => ({
        id: log.id,
        agentId: log.agent_id,
        agentName: log.agent_name,
        status: log.status,
        action: log.action,
        detail: log.detail,
        error: log.error,
        createdAt: log.created_at,
        checks: checksByHeartbeatId.get(log.id) || [],
      })),
    );
  }

  function handleHeartbeatsHealth(res) {
    const latestRows = db
      .prepare(
        `SELECT hl.id, hl.agent_id, hl.agent_name, hl.created_at
         FROM heartbeat_logs hl
         INNER JOIN (
           SELECT agent_id, MAX(id) AS max_id
           FROM heartbeat_logs
           GROUP BY agent_id
         ) latest ON latest.max_id = hl.id
         ORDER BY hl.agent_id ASC`,
      )
      .all();

    const knownAgentIds = new Set([
      ...Object.keys(AGENT_FALLBACK_CHANNELS || {}),
      ...Object.keys(CONFIG.agents || {}),
      ...latestRows.map((row) => row.agent_id),
    ]);

    const latestByAgent = new Map();
    for (const row of latestRows) {
      latestByAgent.set(row.agent_id, row);
    }

    const nowMs = Date.now();
    const agents = Array.from(knownAgentIds)
      .sort((a, b) => a.localeCompare(b))
      .map((agentId) => {
        const latest = latestByAgent.get(agentId);
        const lastHeartbeat = latest?.created_at || null;
        const createdAtMs = parseHeartbeatCreatedAtMs(lastHeartbeat);
        const minutesAgo =
          createdAtMs == null
            ? null
            : Math.max(0, Math.floor((nowMs - createdAtMs) / 60_000));

        let status = "DEAD";
        if (minutesAgo != null) {
          if (minutesAgo < 120) {
            status = "ALIVE";
          } else if (minutesAgo < 240) {
            status = "STALE";
          }
        }

        const configuredName = CONFIG.agents?.[agentId]?.name;
        const displayName =
          latest?.agent_name ||
          (typeof configuredName === "string" && configuredName.trim()
            ? configuredName.trim()
            : agentId);

        return {
          id: agentId,
          name: displayName,
          status,
          lastHeartbeat,
          minutesAgo,
        };
      });

    sendJson(res, { agents });
  }

  function listProjectsWithDetails() {
    const sql = `
      SELECT
        p.*,
        COALESCE(tc.task_count, 0) AS linked_tasks_count,
        s.id AS snapshot_id,
        s.summary AS snapshot_summary,
        s.progress_pct AS snapshot_progress_pct,
        s.blockers AS snapshot_blockers,
        s.generated_at AS snapshot_generated_at,
        s.model AS snapshot_model,
        c.sha AS commit_sha,
        c.message AS commit_message,
        c.author AS commit_author,
        c.date AS commit_date,
        c.branch AS commit_branch
      FROM projects p
      LEFT JOIN (
        SELECT project_id, COUNT(*) AS task_count
        FROM tasks
        GROUP BY project_id
      ) tc ON tc.project_id = p.id
      LEFT JOIN project_snapshots s ON s.id = (
        SELECT ps.id
        FROM project_snapshots ps
        WHERE ps.project_id = p.id
        ORDER BY ps.generated_at DESC, ps.id DESC
        LIMIT 1
      )
      LEFT JOIN project_commits c ON c.id = (
        SELECT pc.id
        FROM project_commits pc
        WHERE pc.project_id = p.id
        ORDER BY pc.date DESC, pc.id DESC
        LIMIT 1
      )
      ORDER BY p.priority ASC, p.updated_at DESC
    `;

    return db.prepare(sql).all();
  }

  function getProjectWithDetails(id) {
    const sql = `
      SELECT
        p.*,
        COALESCE(tc.task_count, 0) AS linked_tasks_count,
        s.id AS snapshot_id,
        s.summary AS snapshot_summary,
        s.progress_pct AS snapshot_progress_pct,
        s.blockers AS snapshot_blockers,
        s.generated_at AS snapshot_generated_at,
        s.model AS snapshot_model,
        c.sha AS commit_sha,
        c.message AS commit_message,
        c.author AS commit_author,
        c.date AS commit_date,
        c.branch AS commit_branch
      FROM projects p
      LEFT JOIN (
        SELECT project_id, COUNT(*) AS task_count
        FROM tasks
        GROUP BY project_id
      ) tc ON tc.project_id = p.id
      LEFT JOIN project_snapshots s ON s.id = (
        SELECT ps.id
        FROM project_snapshots ps
        WHERE ps.project_id = p.id
        ORDER BY ps.generated_at DESC, ps.id DESC
        LIMIT 1
      )
      LEFT JOIN project_commits c ON c.id = (
        SELECT pc.id
        FROM project_commits pc
        WHERE pc.project_id = p.id
        ORDER BY pc.date DESC, pc.id DESC
        LIMIT 1
      )
      WHERE p.id = ?
    `;

    return db.prepare(sql).get(id);
  }

  function handleListProjects(res) {
    const rows = listProjectsWithDetails();
    sendJson(res, rows.map(rowToProject));
  }

  function handleGetProject(res, id) {
    const row = getProjectWithDetails(id);
    if (!row) {
      sendError(res, 404, "Project not found");
      return;
    }

    const tasks = db
      .prepare(
        "SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC",
      )
      .all(id)
      .map(rowToTask);

    sendJson(res, {
      ...rowToProject(row),
      tasks,
    });
  }

  function handleGetProjectCommits(res, id) {
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(id);
    if (!project) {
      sendError(res, 404, "Project not found");
      return;
    }

    const rows = db
      .prepare(
        "SELECT * FROM project_commits WHERE project_id = ? ORDER BY date DESC, id DESC LIMIT 20",
      )
      .all(id);
    sendJson(res, rows.map(rowToProjectCommit));
  }

  async function handleUpdateProject(req, res, id) {
    const existing = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    if (!existing) {
      sendError(res, 404, "Project not found");
      return;
    }

    const body = await parseBody(req);
    const allowedFields = {
      priority: "priority",
      status: "status",
      description: "description",
      tags: "tags",
    };

    const setClauses = ["updated_at = datetime('now')"];
    const params = { id };

    for (const [apiField, dbField] of Object.entries(allowedFields)) {
      if (body[apiField] === undefined) {
        continue;
      }

      let value = body[apiField];
      if (apiField === "tags") {
        value =
          typeof value === "string"
            ? value
            : Array.isArray(value)
              ? JSON.stringify(value)
              : "[]";
      }

      setClauses.push(`${dbField} = @${dbField}`);
      params[dbField] = value;
    }

    if (setClauses.length === 1) {
      sendJson(res, rowToProject(getProjectWithDetails(id)));
      return;
    }

    db.prepare(
      `UPDATE projects SET ${setClauses.join(", ")} WHERE id = @id`,
    ).run(params);

    const updated = rowToProject(getProjectWithDetails(id));
    sendJson(res, updated);
    broadcastSseEvent("project:updated", { projectId: id, project: updated });
  }

  async function handleRefreshProjectCommits(res, id) {
    const project = db
      .prepare("SELECT id, repo, branch FROM projects WHERE id = ?")
      .get(id);

    if (!project) {
      sendError(res, 404, "Project not found");
      return;
    }

    if (!project.repo) {
      sendError(res, 400, "Project does not have a linked repository");
      return;
    }

    let commits;
    try {
      commits = await fetchRepoCommits(project.repo, 10);
    } catch (error) {
      sendError(res, 502, `GitHub refresh failed: ${error.message}`);
      return;
    }

    const insertCommit = db.prepare(`
      INSERT OR IGNORE INTO project_commits (project_id, sha, message, author, date, branch)
      VALUES (@project_id, @sha, @message, @author, @date, @branch)
    `);

    const newlyInserted = [];
    const insertMany = db.transaction((rows) => {
      for (const entry of rows) {
        const normalized = {
          project_id: id,
          sha: entry.sha,
          message: entry.commit?.message ?? null,
          author: entry.commit?.author?.name ?? entry.author?.login ?? null,
          date: entry.commit?.author?.date ?? null,
          branch: project.branch || "main",
        };

        const result = insertCommit.run(normalized);
        if (result.changes > 0) {
          newlyInserted.push({
            projectId: id,
            sha: normalized.sha,
            message: normalized.message,
            author: normalized.author,
            date: normalized.date,
            branch: normalized.branch,
          });
        }
      }
    });

    insertMany(commits);

    sendJson(res, { projectId: id, commits: newlyInserted });
    if (newlyInserted.length > 0) {
      broadcastSseEvent("project:commits", {
        projectId: id,
        commits: newlyInserted,
      });
    }
  }

  // ---- Dispatch runner endpoint (manual trigger / CLI use) ----

  api.registerHttpRoute({
    path: "/api/dispatch/run",
    auth: "plugin",
    handler: async (req, res) => {
      try {
        if (!requireApiKey(req, res)) return true;
        const query = parseQuery(req.url);
        const taskId = query.id;
        if (!taskId) {
          sendError(res, 400, "id required");
          return true;
        }

        const row = getTask(taskId);
        if (!row || row.status !== "ready") {
          sendJson(res, { skipped: true, status: row?.status || "not_found" });
          return true;
        }

        // Idempotency guard — prevent double-dispatch
        if (inFlightDispatch.has(taskId)) {
          sendJson(res, { skipped: true, reason: "already_dispatching" });
          return true;
        }
        inFlightDispatch.add(taskId);

        const task = rowToTask(row);

        // Run dispatch BEFORE sending response — keeps handler context alive for ensureSession
        try {
          await dispatchTask(task);
        } catch (e) {
          process.stderr.write(`[DISPATCH ERROR] ${e.message}\n${e.stack}\n`);
        } finally {
          inFlightDispatch.delete(taskId);
        }

        sendJson(res, {
          dispatched: true,
          id: taskId,
          status: rowToTask(getTask(taskId)).status,
        });
        return true;
      } catch (e) {
        sendError(res, 500, e.message);
        return true;
      }
    },
  });

  api.registerHttpRoute({
    path: "/api/projects",
    match: "prefix",
    auth: "plugin",
    handler: async (req, res) => {
      try {
        const pathname = req.url.split("?")[0];
        const parts = pathname.split("/").filter(Boolean);
        const segments = parts.slice(2);
        const method = req.method?.toUpperCase() || "GET";

        if (segments.length === 0) {
          if (method === "GET") {
            handleListProjects(res);
            return true;
          }
          sendError(res, 405, `Method ${method} not allowed on /api/projects`);
          return true;
        }

        if (segments.length === 1) {
          const id = segments[0];
          if (method === "GET") {
            handleGetProject(res, id);
            return true;
          }
          if (method === "PATCH") {
            if (!requireApiKey(req, res)) return true;
            await handleUpdateProject(req, res, id);
            return true;
          }
          sendError(
            res,
            405,
            `Method ${method} not allowed on /api/projects/:id`,
          );
          return true;
        }

        if (segments.length === 2 && segments[1] === "commits") {
          const id = segments[0];
          if (method === "GET") {
            handleGetProjectCommits(res, id);
            return true;
          }
          sendError(
            res,
            405,
            `Method ${method} not allowed on /api/projects/:id/commits`,
          );
          return true;
        }

        if (segments.length === 2 && segments[1] === "refresh") {
          const id = segments[0];
          if (method === "POST") {
            if (!requireApiKey(req, res)) return true;
            await handleRefreshProjectCommits(res, id);
            return true;
          }
          sendError(
            res,
            405,
            `Method ${method} not allowed on /api/projects/:id/refresh`,
          );
          return true;
        }

        if (segments.length === 2 && segments[1] === "summarize") {
          const id = segments[0];
          if (method === "POST") {
            if (!requireApiKey(req, res)) return true;
            const project = db
              .prepare("SELECT id, repo FROM projects WHERE id = ?")
              .get(id);
            if (!project) {
              sendError(res, 404, "Project not found");
              return true;
            }
            if (!project.repo) {
              sendError(res, 400, "Project does not have a linked repository");
              return true;
            }

            try {
              const snapshot = await summarizeProject({ id });
              sendJson(res, { projectId: id, snapshot });
            } catch (error) {
              sendError(res, 500, `Project summarize failed: ${error.message}`);
            }
            return true;
          }
          sendError(
            res,
            405,
            `Method ${method} not allowed on /api/projects/:id/summarize`,
          );
          return true;
        }

        sendError(res, 404, "Not found");
        return true;
      } catch (e) {
        sendError(res, 500, e.message || String(e));
        return true;
      }
    },
  });

  // ---- Test ACP dispatch endpoint (mirrors spike exactly) ----

  api.registerHttpRoute({
    path: "/api/dispatch/test-acp",
    auth: "plugin",
    handler: async (_req, res) => {
      try {
        const acpRuntime = getAcpRuntime();
        if (!acpRuntime) {
          sendError(res, 500, "no acp runtime");
          return true;
        }
        const { mkdirSync } = await import("node:fs");
        const query = parseQuery(_req.url);
        const testCwd = query.cwd || "/tmp/dispatch-test";
        mkdirSync(testCwd, { recursive: true });
        const sessionKey = `agent:opencode:acp:${crypto.randomUUID()}`;
        process.stderr.write(`[TEST-ACP] ensureSession key=${sessionKey}\n`);
        const handle = await acpRuntime.ensureSession({
          sessionKey,
          agent: "opencode",
          mode: "persistent",
          cwd: testCwd,
        });
        process.stderr.write(`[TEST-ACP] session ready, runTurn\n`);
        let text = "";
        for await (const ev of acpRuntime.runTurn({
          handle,
          text: "Reply DISPATCH_OK",
          mode: "prompt",
          requestId: crypto.randomUUID(),
        })) {
          if (ev.type === "text_delta") text += ev.text || "";
          if (ev.type === "done") break;
        }
        sendJson(res, { ok: true, text });
        return true;
      } catch (e) {
        sendError(res, 500, e.message);
        return true;
      }
    },
  });

  // ---- Dispatch health endpoint ----

  api.registerHttpRoute({
    path: "/api/dispatch/health",
    auth: "plugin",
    handler: (_req, res) => {
      try {
        handleHealth(_req, res);
        return true;
      } catch (e) {
        sendError(res, 500, e.message || String(e));
        return true;
      }
    },
  });

  api.registerHttpRoute({
    path: "/api/usage",
    auth: "plugin",
    handler: async (_req, res) => {
      try {
        const data = await fetch("http://127.0.0.1:3030/api/usage")
          .then((response) => response.json())
          .catch(() => null);
        sendJson(res, data ?? { error: "codexbar-server unavailable" });
        return true;
      } catch {
        sendJson(res, { error: "codexbar-server unavailable" });
        return true;
      }
    },
  });

  api.registerHttpRoute({
    path: "/api/heartbeats",
    match: "prefix",
    auth: "plugin",
    handler: async (req, res) => {
      try {
        const pathname = req.url.split("?")[0];
        const parts = pathname.split("/").filter(Boolean);
        const segments = parts.slice(2);
        const method = req.method?.toUpperCase() || "GET";

        if (segments.length === 0) {
          if (method === "GET") {
            handleListHeartbeats(req, res);
            return true;
          }
          if (method === "POST") {
            if (!requireApiKey(req, res)) return true;
            await handleCreateHeartbeat(req, res);
            return true;
          }
          sendError(res, 405, `Method ${method} not allowed on /api/heartbeats`);
          return true;
        }

        if (segments.length === 1 && segments[0] === "health") {
          if (method === "GET") {
            handleHeartbeatsHealth(res);
            return true;
          }
          sendError(
            res,
            405,
            `Method ${method} not allowed on /api/heartbeats/health`,
          );
          return true;
        }

        sendError(res, 404, "Not found");
        return true;
      } catch (e) {
        sendError(res, 500, e.message || String(e));
        return true;
      }
    },
  });

  // ---- Single prefix route: /api/schedules ----

  api.registerHttpRoute({
    path: "/api/schedules",
    match: "prefix",
    auth: "plugin",
    handler: async (req, res) => {
      try {
        const pathname = req.url.split("?")[0];
        const parts = pathname.split("/").filter(Boolean);
        const segments = parts.slice(2);
        const method = req.method?.toUpperCase() || "GET";

        if (segments.length === 0) {
          if (method === "GET") {
            handleListSchedules(req, res);
            return true;
          }
          if (method === "POST") {
            if (!requireApiKey(req, res)) return true;
            await handleCreateSchedule(req, res);
            return true;
          }
          sendError(res, 405, `Method ${method} not allowed on /api/schedules`);
          return true;
        }

        if (segments.length === 1) {
          const id = segments[0];
          if (method === "PATCH") {
            if (!requireApiKey(req, res)) return true;
            await handleUpdateSchedule(req, res, id);
            return true;
          }
          if (method === "DELETE") {
            if (!requireApiKey(req, res)) return true;
            handleDeleteSchedule(res, id);
            return true;
          }
          sendError(
            res,
            405,
            `Method ${method} not allowed on /api/schedules/:id`,
          );
          return true;
        }

        sendError(res, 404, "Not found");
        return true;
      } catch (e) {
        sendError(res, 500, e.message || String(e));
        return true;
      }
    },
  });

  // ---- Single prefix route: /api/tasks ----

  api.registerHttpRoute({
    path: "/api/tasks/events",
    auth: "plugin",
    handler: (req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      sseClients.add(res);

      const heartbeatInterval = setInterval(() => {
        try {
          res.write(": heartbeat\n\n");
        } catch {
          clearInterval(heartbeatInterval);
          sseClients.delete(res);
        }
      }, 30_000);

      req.on("close", () => {
        clearInterval(heartbeatInterval);
        sseClients.delete(res);
      });

      return false;
    },
  });

  // ---- API key guard for write operations ----
  const API_KEY = CONFIG.apiKey || null;
  function requireApiKey(req, res) {
    if (!API_KEY) return true; // no key configured = open
    const provided =
      req.headers?.["x-api-key"] ||
      new URL(req.url, "http://localhost").searchParams.get("key");
    if (provided === API_KEY) return true;
    sendError(res, 403, "Forbidden: invalid or missing API key");
    return false;
  }

  api.registerHttpRoute({
    path: "/api/tasks",
    match: "prefix",
    auth: "plugin",
    handler: async (req, res) => {
      try {
        const { segments } = parsePath(req.url);
        const method = req.method?.toUpperCase() || "GET";

        // /api/tasks/stats
        if (segments[0] === "stats" && method === "GET") {
          handleStats(req, res);
          return true;
        }

        // /api/tasks/:id/prompt
        if (
          segments.length === 2 &&
          segments[1] === "prompt" &&
          method === "POST"
        ) {
          if (!requireApiKey(req, res)) return true;
          const id = segments[0];
          const task = db
            .prepare("SELECT * FROM tasks WHERE id = @id")
            .get({ id });
          if (!task) {
            sendError(res, 404, "Task not found");
            return true;
          }
          if (!task.session_key) {
            sendError(res, 400, "Task has no ACP session");
            return true;
          }
          let body = "";
          for await (const chunk of req) body += chunk;
          const parsed = JSON.parse(body);
          const message = parsed.message;
          if (!message) {
            sendError(res, 400, "message is required");
            return true;
          }
          try {
            // Post orchestrator message to Discord thread (facade for visibility)
            if (task.thread_id) {
              try {
                const botToken = resolveBotToken("sumodeus");
                if (botToken) {
                  await fetch(
                    `https://discord.com/api/v10/channels/${task.thread_id}/messages`,
                    {
                      method: "POST",
                      headers: {
                        Authorization: `Bot ${botToken}`,
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify({ content: message }),
                    },
                  );
                }
              } catch (_) {
                /* best-effort */
              }
            }
            const accountId = resolveAccountId(task.agent);
            const result = await api.runtime.acp.prompt({
              sessionKey: task.session_key,
              text: message,
              channel: "discord",
              accountId,
              threadId: task.thread_id || undefined,
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, runId: result.runId }));
          } catch (e) {
            sendError(res, 500, e.message || String(e));
          }
          return true;
        }

        // /api/tasks/:id/comments
        if (segments.length === 2 && segments[1] === "comments") {
          const id = segments[0];
          if (method === "GET") {
            handleListComments(res, id);
            return true;
          }
          if (method === "POST") {
            if (!requireApiKey(req, res)) return true;
            await handleCreateComment(req, res, id);
            return true;
          }
          sendError(
            res,
            405,
            `Method ${method} not allowed on /api/tasks/:id/comments`,
          );
          return true;
        }

        // /api/tasks/:id/resume — resume a failed ACP session
        if (
          segments.length === 2 &&
          segments[1] === "resume" &&
          method === "POST"
        ) {
          if (!requireApiKey(req, res)) return true;
          const id = segments[0];
          const row = getTask(id);
          if (!row) {
            sendError(res, 404, "Task not found");
            return true;
          }
          const task = rowToTask(row);
          if (task.status !== "error") {
            sendError(res, 400, `Cannot resume task in status '${task.status}'. Must be in error state.`);
            return true;
          }
          if (!task.sessionKey) {
            sendError(res, 400, "Task has no session to resume");
            return true;
          }
          if (!api.runtime?.acp?.spawn) {
            sendError(res, 500, "acp.spawn not available");
            return true;
          }

          // Respond immediately, resume in background
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, message: "Resume triggered", taskId: task.id, sessionKey: task.sessionKey }));

          // Background: spawn with resumeSessionId
          (async () => {
            try {
              const resolvedCwd = task.cwd || resolveCwd(task);
              const accountId = resolveAccountId(task.agent);
              const channelId = resolveChannel(task);

              // Mark as in_progress
              const now = Date.now();
              db.prepare(
                "UPDATE tasks SET status = 'in_progress', error = NULL, updated_at = @updated_at WHERE id = @id",
              ).run({ id: task.id, updated_at: now });
              onTaskChanged(task.id);

              if (task.threadId) {
                await postToThread(task.threadId, "🔄 **Resuming session** — picking up where we left off...", "sumodeus").catch(() => {});
              }

              const result = await api.runtime.acp.spawn(
                {
                  task: "Continue where you left off. Your previous session was interrupted. Check git log and git status to see your progress, then complete the remaining work.",
                  label: `resume-${task.id.slice(0, 8)}`,
                  agentId: "opencode",
                  cwd: resolvedCwd,
                  resumeSessionId: task.sessionKey,
                  thread: false, // reuse existing thread
                },
                {
                  agentChannel: "discord",
                  agentAccountId: accountId,
                  agentTo: channelId ? `channel:${channelId}` : undefined,
                },
              );

              if (result?.status !== "accepted") {
                throw new Error(result?.error || `resume spawn failed with status=${result?.status || "unknown"}`);
              }

              const childRunId = typeof result?.runId === "string" ? result.runId.trim() : "";
              const childSessionKey = result?.childSessionKey || task.sessionKey;
              if (!childRunId) {
                throw new Error("resume spawn did not return runId");
              }

              process.stderr.write(
                `[RESUME] spawn accepted for ${task.id}, runId=${childRunId}, session=${childSessionKey}\n`,
              );

              db.prepare(
                "UPDATE tasks SET session_key = @sessionKey, run_id = @runId, updated_at = @updated_at WHERE id = @id",
              ).run({ id: task.id, sessionKey: childSessionKey, runId: childRunId, updated_at: Date.now() });

              // Wait for completion
              const wait = await api.runtime.subagent.waitForRun({
                runId: childRunId,
                timeoutMs: resolveTaskTimeoutMs(task),
              });
              const waitStatus = wait?.status || "timeout";
              if (waitStatus !== "ok") {
                const waitError = wait?.error ? `: ${wait.error}` : "";
                throw new Error(`resumed run failed (${waitStatus})${waitError}`);
              }

              // Get output
              let text = "";
              if (api.runtime?.subagent?.getSessionMessages) {
                const msgs = await api.runtime.subagent.getSessionMessages({
                  sessionKey: childSessionKey,
                  limit: 200,
                });
                text = extractOutputFromMessages(msgs?.messages || []);
              }

              // Mark review
              const reviewNow = Date.now();
              db.prepare(
                "UPDATE tasks SET status = 'review', output = @output, completed_at = NULL, updated_at = @updated_at WHERE id = @id",
              ).run({ id: task.id, output: text.slice(0, 10000), updated_at: reviewNow });

              if (task.threadId) {
                const summary = text.slice(0, 1500);
                await postToThread(task.threadId, `✅ **Resume completed**\n\n${summary}${text.length > 1500 ? "..." : ""}`);
              }
              onTaskChanged(task.id);

              // Run QA if required
              const freshTask = rowToTask(getTask(task.id));
              if (resolveQaRequired(freshTask || task)) {
                await runMaatReviewLoop(task.id);
              } else {
                const doneNow = Date.now();
                db.prepare(
                  "UPDATE tasks SET status = 'done', completed_at = @completed_at, updated_at = @updated_at WHERE id = @id",
                ).run({ id: task.id, completed_at: doneNow, updated_at: doneNow });
                notifyMainSession(freshTask || task, "done");
                onTaskChanged(task.id);
                triggerDependents(task.id);
              }
            } catch (e) {
              process.stderr.write(`[RESUME] failed for ${task.id}: ${e.message}\n`);
              const now = Date.now();
              db.prepare(
                "UPDATE tasks SET status = 'error', error = @error, retries = retries + 1, updated_at = @updated_at WHERE id = @id",
              ).run({ id: task.id, error: `Resume failed: ${e.message}`, updated_at: now });
              onTaskChanged(task.id);
            }
          })();
          return true;
        }

        // /api/tasks/:id/qa — manually trigger QA review
        if (
          segments.length === 2 &&
          segments[1] === "qa" &&
          method === "POST"
        ) {
          if (!requireApiKey(req, res)) return true;
          const id = segments[0];
          const row = getTask(id);
          if (!row) {
            sendError(res, 404, "Task not found");
            return true;
          }
          const task = rowToTask(row);
          // Task must be in a completable state (done with qaRequired false, or in_progress/review)
          const allowedStatuses = ["done", "in_progress", "review"];
          if (!allowedStatuses.includes(task.status)) {
            sendError(res, 400, `Cannot trigger QA for task in status '${task.status}'. Must be done, in_progress, or review.`);
            return true;
          }
          // Move to review status if not already there
          if (task.status !== "review") {
            const now = Date.now();
            db.prepare(
              "UPDATE tasks SET status = 'review', qa_required = 1, review_attempts = 0, completed_at = NULL, updated_at = @updated_at WHERE id = @id",
            ).run({ id: task.id, updated_at: now });
            onTaskChanged(task.id);
          }
          // Respond immediately, run QA in background
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, message: "QA review triggered", taskId: task.id }));
          // Fire QA loop in background
          runMaatReviewLoop(task.id).catch((e) => {
            const now = Date.now();
            db.prepare(
              "UPDATE tasks SET status = 'error', error = @error, retries = retries + 1, updated_at = @updated_at WHERE id = @id",
            ).run({
              id: task.id,
              error: `Manual QA review failed: ${e.message}`,
              updated_at: now,
            });
            onTaskChanged(task.id);
          });
          return true;
        }

        // /api/tasks/:id
        if (segments.length === 1) {
          const id = segments[0];
          if (method === "GET") {
            handleGetOne(res, id);
            return true;
          }
          if (method === "PATCH") {
            if (!requireApiKey(req, res)) return true;
            await handleUpdate(req, res, id);
            return true;
          }
          if (method === "DELETE") {
            if (!requireApiKey(req, res)) return true;
            handleDelete(res, id);
            return true;
          }
          sendError(res, 405, `Method ${method} not allowed on /api/tasks/:id`);
          return true;
        }

        // /api/tasks (collection)
        if (segments.length === 0) {
          if (method === "GET") {
            handleList(req, res);
            return true;
          }
          if (method === "POST") {
            if (!requireApiKey(req, res)) return true;
            await handleCreate(req, res);
            return true;
          }
          sendError(res, 405, `Method ${method} not allowed on /api/tasks`);
          return true;
        }

        sendError(res, 404, "Not found");
        return true;
      } catch (e) {
        sendError(res, 500, e.message || String(e));
        return true;
      }
    },
  });

  // ---- Startup reconciliation: recover threadId for dispatched tasks missing it ----
  // Runs once at plugin init. Handles any tasks that slipped through with null thread_id
  // (e.g., from a previous plugin version before the threadId fix).
  (async () => {
    try {
      await new Promise((r) => setTimeout(r, 2000)); // let gateway settle first
      const { readFileSync } = await import("node:fs");
      const bindingsPath = `${process.env.HOME}/.openclaw/discord/thread-bindings.json`;
      let bindings = {};
      try {
        bindings =
          JSON.parse(readFileSync(bindingsPath, "utf8")).bindings || {};
      } catch (_) {
        return; // no bindings file yet
      }

      // Build lookup: sessionKey → threadId
      const sessionToThread = {};
      for (const binding of Object.values(bindings)) {
        if (binding.targetSessionKey && binding.threadId) {
          sessionToThread[binding.targetSessionKey] = String(binding.threadId);
        }
      }

      // Find active tasks with null thread_id that have a session_key
      const orphaned = db
        .prepare(
          "SELECT id, session_key, title FROM tasks WHERE status IN ('dispatched', 'in_progress', 'blocked') AND thread_id IS NULL AND session_key IS NOT NULL",
        )
        .all();

      for (const task of orphaned) {
        const threadId = sessionToThread[task.session_key];
        if (threadId) {
          db.prepare(
            "UPDATE tasks SET thread_id = ?, updated_at = ? WHERE id = ?",
          ).run(threadId, Date.now(), task.id);
          process.stderr.write(
            `[DISPATCH] Reconciled threadId ${threadId} for task ${task.id} (${task.title})\n`,
          );
          onTaskChanged(task.id);
        } else {
          process.stderr.write(
            `[DISPATCH] WARNING: active task ${task.id} (${task.title}) has no thread binding — may be orphaned\n`,
          );
        }
      }
    } catch (e) {
      process.stderr.write(
        `[DISPATCH] Startup reconciliation error: ${e.message}\n`,
      );
    }
  })();

  // ---- Auto-resume tasks killed by gateway restart ----
  (async () => {
    try {
      // Wait for gateway + ACP runtime to fully settle
      await new Promise((r) => setTimeout(r, 8000));

      // Only resume tasks that were marked as errored in the last 60 seconds
      // (i.e. by THIS startup's stuck-task cleanup, not old stale errors)
      const cutoff = Date.now() - 60_000;
      const restartErrored = db
        .prepare(
          "SELECT * FROM tasks WHERE status = 'error' AND error = 'Gateway restart during execution' AND session_key IS NOT NULL AND updated_at > ?",
        )
        .all(cutoff);

      if (restartErrored.length === 0) return;

      process.stderr.write(
        `[AUTO-RESUME] Found ${restartErrored.length} task(s) interrupted by gateway restart\n`,
      );

      for (const row of restartErrored) {
        const task = rowToTask(row);
        process.stderr.write(
          `[AUTO-RESUME] Resuming task ${task.id} (${task.title})\n`,
        );

        try {
          const resolvedCwd = task.cwd || resolveCwd(task);
          const accountId = resolveAccountId(task.agent);
          const channelId = resolveChannel(task);

          // Mark as in_progress
          db.prepare(
            "UPDATE tasks SET status = 'in_progress', error = NULL, updated_at = @updated_at WHERE id = @id",
          ).run({ id: task.id, updated_at: Date.now() });
          onTaskChanged(task.id);

          if (task.threadId) {
            await postToThread(task.threadId, "🔄 **Auto-resuming** — gateway restarted, picking up where we left off...", "sumodeus").catch(() => {});
          }

          const result = await api.runtime.acp.spawn(
            {
              task: "Continue where you left off. Your previous session was interrupted by a gateway restart. Check git log and git status to see your progress, then complete the remaining work.",
              label: `auto-resume-${task.id.slice(0, 8)}`,
              agentId: "opencode",
              cwd: resolvedCwd,
              resumeSessionId: task.sessionKey,
              thread: false,
            },
            {
              agentChannel: "discord",
              agentAccountId: accountId,
              agentTo: channelId ? `channel:${channelId}` : undefined,
            },
          );

          if (result?.status !== "accepted") {
            throw new Error(result?.error || `resume spawn failed: ${result?.status || "unknown"}`);
          }

          const childRunId = typeof result?.runId === "string" ? result.runId.trim() : "";
          const childSessionKey = result?.childSessionKey || task.sessionKey;
          if (!childRunId) throw new Error("resume spawn did not return runId");

          process.stderr.write(
            `[AUTO-RESUME] spawn accepted for ${task.id}, runId=${childRunId}\n`,
          );

          db.prepare(
            "UPDATE tasks SET session_key = @sessionKey, run_id = @runId, updated_at = @updated_at WHERE id = @id",
          ).run({ id: task.id, sessionKey: childSessionKey, runId: childRunId, updated_at: Date.now() });

          // Wait for completion
          const wait = await api.runtime.subagent.waitForRun({
            runId: childRunId,
            timeoutMs: resolveTaskTimeoutMs(task),
          });
          const waitStatus = wait?.status || "timeout";
          if (waitStatus !== "ok") {
            const waitError = wait?.error ? `: ${wait.error}` : "";
            throw new Error(`resumed run failed (${waitStatus})${waitError}`);
          }

          // Get output
          let text = "";
          if (api.runtime?.subagent?.getSessionMessages) {
            const msgs = await api.runtime.subagent.getSessionMessages({
              sessionKey: childSessionKey,
              limit: 200,
            });
            text = extractOutputFromMessages(msgs?.messages || []);
          }

          // Mark review
          db.prepare(
            "UPDATE tasks SET status = 'review', output = @output, completed_at = NULL, updated_at = @updated_at WHERE id = @id",
          ).run({ id: task.id, output: text.slice(0, 10000), updated_at: Date.now() });

          if (task.threadId) {
            await postToThread(task.threadId, `✅ **Resume completed**\n\n${text.slice(0, 1500)}${text.length > 1500 ? "..." : ""}`);
          }
          onTaskChanged(task.id);

          // Run QA if required
          const freshTask = rowToTask(getTask(task.id));
          if (resolveQaRequired(freshTask || task)) {
            await runMaatReviewLoop(task.id);
          } else {
            const doneNow = Date.now();
            db.prepare(
              "UPDATE tasks SET status = 'done', completed_at = @completed_at, updated_at = @updated_at WHERE id = @id",
            ).run({ id: task.id, completed_at: doneNow, updated_at: doneNow });
            notifyMainSession(freshTask || task, "done");
            onTaskChanged(task.id);
            triggerDependents(task.id);
          }

          process.stderr.write(
            `[AUTO-RESUME] Task ${task.id} successfully resumed and completed\n`,
          );
        } catch (e) {
          process.stderr.write(
            `[AUTO-RESUME] Failed for task ${task.id}: ${e.message}\n`,
          );
          db.prepare(
            "UPDATE tasks SET status = 'error', error = @error, retries = retries + 1, updated_at = @updated_at WHERE id = @id",
          ).run({ id: task.id, error: `Auto-resume failed: ${e.message}`, updated_at: Date.now() });
          onTaskChanged(task.id);
        }
      }
    } catch (e) {
      process.stderr.write(
        `[AUTO-RESUME] Startup error: ${e.message}\n`,
      );
    }
  })();

  // ---- Completion hook (Phase 3 dispatch will populate session_key) ----

  api.on("subagent_ended", (event) => {
    const sessionKey = event.targetSessionKey;
    if (!sessionKey) return;

    // Find task by session_key and update status
    const task = db
      .prepare(
        "SELECT * FROM tasks WHERE session_key = ? AND status IN ('dispatched', 'in_progress')",
      )
      .get(sessionKey);

    if (task) {
      const now = Date.now();
      const outcome = event.outcome || event.reason || "unknown";
      const isSuccess = outcome === "completed" || outcome === "ok";

      if (isSuccess) {
        stmts.updateStatus.run({
          id: task.id,
          status: "review",
          updated_at: now,
          completed_at: null,
        });
      } else {
        db.prepare(
          "UPDATE tasks SET status = 'error', error = @error, retries = retries + 1, updated_at = @updated_at WHERE id = @id",
        ).run({
          id: task.id,
          error: event.error || outcome,
          updated_at: now,
        });
      }

      onTaskChanged(task.id);
    }
  });
}
