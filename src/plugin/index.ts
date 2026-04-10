import { createRequire } from "node:module";
import crypto from "node:crypto";
import { createBackgroundJobQueue } from "./background-jobs";
import { createDispatchRuntime } from "./dispatch-runtime";
import { createDiscordRuntime } from "./discord-runtime";
import { createHeartbeatRuntime } from "./heartbeat-runtime";
import { createLifecycleRuntime } from "./lifecycle-runtime";
import { createReviewRuntime } from "./review-runtime";
import { createScheduleRuntime } from "./schedule-runtime";
import { createTaskApiRuntime } from "./task-api-runtime";
import { loadConfig, normalizeTimeoutMs } from "./config";
import { initDb, rowToTask, seedProjectsIfEmpty } from "./db";
import {
  buildReviewTaskDescription,
  buildReviewTaskTitle,
  planReviewRequest,
  resolveProjectIdForRepo,
  resolveReviewRange,
  REVIEW_DEBOUNCE_WINDOW_MS,
} from "./review";
// thread-messages helpers are used by extracted runtime modules
import { getNextRunAt, parseNlExpressionToCron } from "./scheduler";
import { runProjectSummaryTick as runProjectSummaryTickCore } from "./summarize";
import { parseBody, parseQuery, sendError, sendJson } from "./routes/tasks";
import { registerProjectRoutes } from "./routes/projects";
import type {
  PluginApi,
  PluginConfig,
  PluginHttpRequest,
  PluginHttpResponse,
  Task,
  TaskStatus,
} from "./types";
import type { SseClientLike } from "./runtime-types";

type TaskRow = Record<string, unknown> & {
  id: string;
  status: TaskStatus;
  agent: string;
  updated_at?: number;
};

const require = createRequire(import.meta.url);

function titleFromProjectId(projectId: string): string {
  return String(projectId || "project")
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveReviewAgentId(
  config: PluginConfig,
  projectId: string,
  fallbackAgent: string,
): string {
  const projectAgent = config.projects?.[projectId]?.reviewAgent;
  if (projectAgent) return projectAgent;
  if (config.agents?.nemesis) return "nemesis";
  return fallbackAgent;
}

function formatDiscordThreadUrl(threadId: string | null | undefined): string | null {
  if (typeof threadId !== "string" || !threadId.trim()) {
    return null;
  }
  const template = CONFIG.channels?.discord?.threadUrlTemplate?.trim();
  if (template) {
    return template.replaceAll("{threadId}", threadId.trim());
  }
  const guildId = CONFIG.channels?.discord?.guildId?.trim();
  if (guildId) {
    return `https://discord.com/channels/${guildId}/${threadId.trim()}`;
  }
  return null;
}

const CONFIG = loadConfig();
const HOME = process.env.HOME || "";

// Build maps from config
const PROJECT_CHANNELS: Record<string, string> = {};
const PROJECT_CWD: Record<string, string> = {};
const PROJECT_DEFAULT_AGENTS: Record<string, string> = {};
if (CONFIG.projects) {
  for (const [key, val] of Object.entries(CONFIG.projects)) {
    if (val.channel) PROJECT_CHANNELS[key] = val.channel;
    if (val.cwd) PROJECT_CWD[key] = val.cwd;
    if (val.defaultAgent) PROJECT_DEFAULT_AGENTS[key] = val.defaultAgent;
  }
}

const AGENT_DEFAULT_CHANNELS: Record<string, string> = {};
const AGENT_RUNTIME: Record<string, string> = {};
const AGENT_ACCOUNT_IDS: Record<string, string> = {};
if (CONFIG.agents) {
  for (const [key, val] of Object.entries(CONFIG.agents)) {
    if (val.runtime) AGENT_RUNTIME[key] = val.runtime;
    if (val.channel) AGENT_DEFAULT_CHANNELS[key] = val.channel;
    if (val.accountId) AGENT_ACCOUNT_IDS[key] = val.accountId;
  }
}

const DEFAULT_AGENT =
  CONFIG.defaults?.defaultAgent || Object.keys(CONFIG.agents || {})[0] || "default";
const DEFAULT_DISCORD_ACCOUNT_ID =
  CONFIG.notifications?.defaultDiscordAccountId ||
  AGENT_ACCOUNT_IDS[DEFAULT_AGENT] ||
  DEFAULT_AGENT ||
  "default";
const OPERATOR_LABEL = CONFIG.notifications?.operatorLabel || "operator";
const DEFAULTS = CONFIG.defaults ?? {};

const maxConcurrentSessions = DEFAULTS.maxConcurrentSessions || 6;
const defaultCwd = DEFAULTS.defaultCwd || `${HOME}/.openclaw/workspace`;
const defaultTaskTimeoutMs = normalizeTimeoutMs(DEFAULTS.taskTimeoutMs, 10 * 60_000);
const defaultReviewTimeoutMs = normalizeTimeoutMs(DEFAULTS.reviewTimeoutMs, 3 * 60_000);
const maxReviewCycles = Number.isFinite(DEFAULTS.maxReviewCycles)
  ? Math.max(1, Math.floor(DEFAULTS.maxReviewCycles ?? 3))
  : 3;
// qaRequired is per-task (default true). Check via resolveQaRequired(task)
function resolveQaRequired(task: Partial<Task>): boolean {
  if (typeof task.qaRequired === "boolean") return task.qaRequired;
  return true; // default: QA is required
}

function resolveTaskTimeoutMs(task: Partial<Task>): number {
  return normalizeTimeoutMs(task?.timeoutMs, defaultTaskTimeoutMs);
}

function resolveChannel(task: Partial<Task>): string | null {
  if (task.channelId) return task.channelId;
  if (task.projectId && PROJECT_CHANNELS[task.projectId]) {
    return PROJECT_CHANNELS[task.projectId] ?? null;
  }
  if (task.agent && AGENT_DEFAULT_CHANNELS[task.agent]) {
    return AGENT_DEFAULT_CHANNELS[task.agent] ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default function setup(api: PluginApi) {
  const config: PluginConfig = api.config || {};
  const dbPath = config.dbPath || `${process.env.HOME}/.openclaw/data/task-dispatch.db`;

  const db = initDb(dbPath);
  seedProjectsIfEmpty(db);

  // ---- Phase 5: Restart resilience — log stuck tasks (don't mark as error) ----
  // Previously this marked all dispatched/in_progress/blocked tasks as 'error'
  // on every plugin startup, causing false "Gateway restart" errors even when
  // the gateway didn't actually restart (e.g., plugin hot-reload, config change).
  // Now we just log them — if the ACP session is truly dead, the task timeout
  // will catch it. If it's still alive, it'll complete normally.
  const stuckTasks = db
    .prepare("SELECT * FROM tasks WHERE status IN ('dispatched', 'in_progress', 'blocked')")
    .all() as TaskRow[];
  if (stuckTasks.length > 0) {
    process.stderr.write(
      `[STARTUP] Found ${stuckTasks.length} active tasks (leaving as-is, timeout will catch dead sessions)\n`,
    );
    for (const row of stuckTasks) {
      process.stderr.write(`[STARTUP]   ${row.id} status=${row.status} agent=${row.agent}\n`);
    }
  }

  // ---- Session Pool (inside setup for closure access) ----
  const sessionPool = new Map();
  const sseClients = new Set<SseClientLike>();
  const reviewTimers = new Map();

  function getActiveSessionCount(): number {
    return sessionPool.size;
  }

  function broadcastTaskEvent(task: Task | null): void {
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

  function broadcastSseEvent(type: string, payload: Record<string, unknown> = {}): void {
    if (sseClients.size === 0) {
      return;
    }

    const eventPayload = JSON.stringify({
      type,
      timestamp: Date.now(),
      ...payload,
    });
    const packets = [`data: ${eventPayload}\n\n`, `event: ${type}\ndata: ${eventPayload}\n\n`];

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

  function resolveCwd(task: Partial<Task>): string | null {
    // Do NOT realpath — the NVMe path has a space which breaks acpx subprocess spawn
    return task.cwd || (task.projectId && PROJECT_CWD[task.projectId]) || null;
  }

  function resolveRuntime(task: Partial<Task>): string {
    if (task.runtime) return task.runtime;
    return (task.agent ? AGENT_RUNTIME[task.agent] : undefined) || "subagent";
  }

  const discordRuntime = createDiscordRuntime({
    config: CONFIG,
    defaultDiscordAccountId: DEFAULT_DISCORD_ACCOUNT_ID,
    resolveAccountId,
    resolveChannel,
    formatDiscordThreadUrl,
    recordTaskEvent,
    db,
    stderr: process.stderr,
  });
  const { createDiscordThread, postToThread, resolveBotToken } = discordRuntime;
  function resolveAccountId(agent: string): string {
    return AGENT_ACCOUNT_IDS[agent] || agent || DEFAULT_DISCORD_ACCOUNT_ID;
  }

  function getAcpRuntime() {
    try {
      const key = Symbol.for("openclaw.acpRuntimeRegistryState");
      const state = (globalThis as Record<PropertyKey, unknown>)[key] as
        | { backendsById?: Map<string, { runtime?: unknown }> }
        | undefined;
      if (!state || !state.backendsById) return null;
      const backend = state.backendsById.get("acpx");
      return backend?.runtime || null;
    } catch {
      return null;
    }
  }

  // Prepared statements
  const backgroundJobs = createBackgroundJobQueue({
    // Keep background work on a startup-owned worker so plugin-auth HTTP routes
    // do not leak their empty runtime scopes into api.runtime.subagent helpers.
    runJob: async (job) => {
      switch (job.kind) {
        case "dispatch": {
          const row = getTask(job.taskId);
          if (!row || row.status !== "ready") return;
          const task = rowToTask(row);
          if (!task) return;
          await dispatchTask(task);
          return;
        }
        case "resume": {
          await resumeTask(job.taskId);
          return;
        }
        case "qa": {
          await runQueuedQaReview(job.taskId);
          return;
        }
        default:
          process.stderr.write(`[QUEUE] unknown job kind ${job.kind} for ${job.taskId}\n`);
      }
    },
    log: (message) => process.stderr.write(`${message}\n`),
  });

  const dispatchRuntime = createDispatchRuntime({
    api,
    config: CONFIG,
    db,
    defaultCwd,
    defaultReviewTimeoutMs,
    maxConcurrentSessions,
    maxReviewCycles,
    defaultDiscordAccountId: DEFAULT_DISCORD_ACCOUNT_ID,
    resolveCwd,
    resolveRuntime,
    resolveChannel,
    resolveTaskTimeoutMs,
    resolveQaRequired,
    resolveAccountId,
    createDiscordThread,
    postToThread,
    getActiveSessionCount,
    getTask: (id) => rowToTask(getTask(id) as Record<string, unknown> | null | undefined),
    onTaskChanged,
    recordTaskEvent,
    triggerDependents: (taskId) => triggerDependents(taskId),
    notifyMainSession: (task, status) => notifyMainSession(task, status),
    formatDiscordThreadUrl,
    operatorLabel: OPERATOR_LABEL,
    rowToTask,
    backgroundEnqueue: (taskId) => backgroundJobs.enqueue({ kind: "dispatch", taskId }),
    stderr: process.stderr,
  });
  const {
    triggerDispatch,
    dispatchTask,
    resumeTask,
    runQueuedQaReview,
    notifyMainSession,
    triggerDependents,
  } = dispatchRuntime;

  const stmts = {
    insert: db.prepare(`
      INSERT INTO tasks (id, title, description, agent, runtime, project_id, channel_id, cwd, model, thinking, depends_on, chain_id, status, manual_complete, timeout_ms, thread_id, review_attempts, qa_required, created_at, updated_at)
      VALUES (@id, @title, @description, @agent, @runtime, @project_id, @channel_id, @cwd, @model, @thinking, @depends_on, @chain_id, @status, @manual_complete, @timeout_ms, @thread_id, @review_attempts, @qa_required, @created_at, @updated_at)
    `),
    getById: db.prepare("SELECT * FROM tasks WHERE id = ?"),
    deleteTaskEventsByTaskId: db.prepare("DELETE FROM task_events WHERE task_id = ?"),
    deleteCommentsByTaskId: db.prepare("DELETE FROM comments WHERE task_id = ?"),
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
    countByStatus: db.prepare("SELECT status, COUNT(*) as count FROM tasks GROUP BY status"),
    countByAgent: db.prepare("SELECT agent, COUNT(*) as count FROM tasks GROUP BY agent"),
    countByProject: db.prepare(
      "SELECT project_id, COUNT(*) as count FROM tasks WHERE project_id IS NOT NULL GROUP BY project_id",
    ),
    insertSchedule: db.prepare(`
      INSERT INTO schedules (id, title, description, agent, project_id, cwd, category, qa_required, cron, nl_expression, timeout_ms, enabled, last_run_at, next_run_at, created_at, updated_at)
      VALUES (@id, @title, @description, @agent, @project_id, @cwd, @category, @qa_required, @cron, @nl_expression, @timeout_ms, @enabled, @last_run_at, @next_run_at, @created_at, @updated_at)
    `),
    listSchedules: db.prepare("SELECT * FROM schedules ORDER BY created_at DESC"),
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
    getReviewStateByRepo: db.prepare("SELECT * FROM review_state WHERE repo = ?"),
    getReviewStateByActiveTaskId: db.prepare("SELECT * FROM review_state WHERE active_task_id = ?"),
    upsertReviewState: db.prepare(`
      INSERT INTO review_state (
        repo,
        last_reviewed_sha,
        last_review_at,
        pending_from_sha,
        pending_to_sha,
        pending_task_id,
        pending_updated_at,
        active_from_sha,
        active_to_sha,
        active_task_id
      ) VALUES (
        @repo,
        @last_reviewed_sha,
        @last_review_at,
        @pending_from_sha,
        @pending_to_sha,
        @pending_task_id,
        @pending_updated_at,
        @active_from_sha,
        @active_to_sha,
        @active_task_id
      )
      ON CONFLICT(repo) DO UPDATE SET
        last_reviewed_sha = excluded.last_reviewed_sha,
        last_review_at = excluded.last_review_at,
        pending_from_sha = excluded.pending_from_sha,
        pending_to_sha = excluded.pending_to_sha,
        pending_task_id = excluded.pending_task_id,
        pending_updated_at = excluded.pending_updated_at,
        active_from_sha = excluded.active_from_sha,
        active_to_sha = excluded.active_to_sha,
        active_task_id = excluded.active_task_id
    `),
    getReviewDeliveryByKey: db.prepare("SELECT * FROM review_deliveries WHERE delivery_key = ?"),
    getReviewDeliveryByRepoSha: db.prepare(
      "SELECT * FROM review_deliveries WHERE repo = ? AND sha = ? ORDER BY accepted_at DESC LIMIT 1",
    ),
    upsertReviewDelivery: db.prepare(`
      INSERT INTO review_deliveries (
        delivery_key,
        repo,
        sha,
        task_id,
        status,
        accepted_at
      ) VALUES (
        @delivery_key,
        @repo,
        @sha,
        @task_id,
        @status,
        @accepted_at
      )
      ON CONFLICT(delivery_key) DO UPDATE SET
        repo = excluded.repo,
        sha = excluded.sha,
        task_id = excluded.task_id,
        status = excluded.status,
        accepted_at = excluded.accepted_at
    `),
  };

  // ---- Core functions ----

  function getTask(id: string): Record<string, unknown> | null {
    return (stmts.getById.get(id) as Record<string, unknown> | undefined) || null;
  }

  function recordTaskEvent(
    taskId: string,
    eventType: string,
    payload: Record<string, unknown> | null = null,
  ) {
    try {
      db.prepare(
        "INSERT INTO task_events (task_id, event_type, payload, created_at) VALUES (@task_id, @event_type, @payload, @created_at)",
      ).run({
        task_id: taskId,
        event_type: eventType,
        payload: payload == null ? null : JSON.stringify(payload),
        created_at: Date.now(),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[TASK_EVENTS] Failed to record ${eventType} for ${taskId}: ${msg}\n`);
    }
  }

  function createTaskRecord(
    body: Record<string, unknown>,
    options: {
      id?: string;
      forceStatus?: TaskStatus;
      autoDispatchReady?: boolean;
      eventPayload?: Record<string, unknown>;
    } = {},
  ): Task {
    const now = Date.now();
    const id = options.id || crypto.randomUUID();
    const dependsOn = (Array.isArray(body.dependsOn) ? body.dependsOn : []).filter(
      (value: unknown) => typeof value === "string" && value.trim().length > 0,
    ) as string[];

    let status = options.forceStatus || "pending";
    if (!options.forceStatus) {
      if (dependsOn.length === 0) {
        status = "ready";
      } else {
        const placeholders = dependsOn.map(() => "?").join(",");
        const doneCount = db
          .prepare(
            `SELECT COUNT(*) as c FROM tasks WHERE id IN (${placeholders}) AND status = 'done'`,
          )
          .get(...dependsOn);
        if (doneCount && (doneCount as { c: number }).c === dependsOn.length) {
          status = "ready";
        }
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
      thread_id:
        typeof body.threadId === "string" && body.threadId.trim() ? body.threadId.trim() : null,
      review_attempts: 0,
      qa_required: body.qaRequired === false ? 0 : 1,
      created_at: now,
      updated_at: now,
    };

    stmts.insert.run(row);
    const created = rowToTask(getTask(id));
    if (!created) {
      throw new Error(`Failed to load task after insert: ${id}`);
    }
    recordTaskEvent(id, "task.created", {
      status,
      projectId: row.project_id,
      agent: row.agent,
      cwd: row.cwd,
      qaRequired: row.qa_required !== 0,
      threadId: row.thread_id,
      ...options.eventPayload,
    });
    broadcastTaskEvent(created);

    if (options.autoDispatchReady !== false && status === "ready") {
      triggerDispatch(created.id);
    }

    return created;
  }

  // GitHub App config for issue writing (loaded from env or .env)
  const githubAppId = process.env.GITHUB_APP_ID || "";
  const githubAppPrivateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH || "";
  const githubAppConfig =
    githubAppId && githubAppPrivateKeyPath
      ? { appId: githubAppId, privateKeyPath: githubAppPrivateKeyPath }
      : undefined;

  // Installation ID lookup — stored in review_deliveries from webhook payloads
  function getInstallationIdForRepo(repo: string): number | null {
    const row = db
      .prepare<{ installation_id?: number }>(
        "SELECT installation_id FROM review_deliveries WHERE repo = ? AND installation_id IS NOT NULL ORDER BY accepted_at DESC LIMIT 1",
      )
      .get(repo);
    return row?.installation_id ?? null;
  }

  const reviewRuntime = createReviewRuntime({
    config: CONFIG,
    defaultAgent: DEFAULT_AGENT,
    defaultCwd,
    reviewTimers,
    githubApp: githubAppConfig,
    getInstallationIdForRepo,
    db: db as unknown as Parameters<typeof createReviewRuntime>[0]["db"],
    stmts: stmts as unknown as Parameters<typeof createReviewRuntime>[0]["stmts"],
    loadTask: (id) => rowToTask(getTask(id)),
    createTaskRecord,
    recordTaskEvent,
    onTaskChanged,
    resolveReviewAgentId,
    stderr: process.stderr,
  });
  const {
    getReviewState,
    getReviewDelivery,
    getReviewDeliveryForRepoSha,
    saveReviewState,
    saveReviewDelivery,
    extractReviewRangeFromTask,
    updateReviewTaskWindow,
    createPendingReviewTask,
    armReviewTimer,
    finalizeReviewTask,
  } = reviewRuntime;

  function onTaskChanged(taskId: string) {
    const task = getTask(taskId);
    let normalized = null;
    if (task) {
      normalized = rowToTask(task);
      broadcastTaskEvent(normalized);
      recordTaskEvent(taskId, `task.${task.status}`, {
        status: normalized?.status || task.status,
        error: normalized?.error || null,
        runId: normalized?.runId || null,
        sessionKey: normalized?.sessionKey || null,
        threadId: normalized?.threadId || null,
        updatedAt: normalized?.updatedAt || task.updated_at || Date.now(),
      });
    }

    if (normalized && ["done", "error", "cancelled"].includes(normalized.status)) {
      void finalizeReviewTask(normalized);
    }

    // When a task becomes done, check for newly ready tasks
    if (task && task.status === "done") {
      const ready = stmts.pendingWithAllDepsDone.all() as Array<{ id: string }>;
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
        onTaskChanged(String(t.id));
      }
      return;
    }

    // When a task becomes ready, trigger dispatch via self-call
    if (task && task.status === "ready") {
      triggerDispatch(String(task.id));
    }
  }

  // buildListQuery is now in task-api-runtime.ts

  const scheduleRuntime = createScheduleRuntime({
    db,
    defaultTaskTimeoutMs,
    getNextRunAt,
    parseNlExpressionToCron,
    getTask,
    onTaskChanged,
    triggerDispatch,
    stderr: process.stderr,
  });
  const {
    handleListSchedules,
    handleCreateSchedule,
    handleUpdateSchedule,
    handleDeleteSchedule,
    runDueSchedules,
  } = scheduleRuntime;

  async function runProjectSummaryTick() {
    return await runProjectSummaryTickCore(db, sseClients);
  }

  const runScheduleTick = () => runDueSchedules();

  runScheduleTick();
  setInterval(runScheduleTick, 60_000);
  const requireApiKey = (req: PluginHttpRequest, res: PluginHttpResponse) => {
    const apiKey = CONFIG.apiKey || null;
    if (!apiKey) return true;
    const provided =
      req.headers?.["x-api-key"] ||
      new URL(req.url || "", "http://localhost").searchParams.get("key");
    if (provided === apiKey) return true;
    sendError(res, 403, "Forbidden: invalid or missing API key");
    return false;
  };
  const backgroundJobWorker = setInterval(() => {
    void backgroundJobs.drainOnce();
  }, 100);
  backgroundJobWorker.unref?.();
  for (const row of db
    .prepare<{ repo: string }>(
      "SELECT repo FROM review_state WHERE pending_task_id IS NOT NULL AND pending_updated_at IS NOT NULL",
    )
    .all()) {
    if (row?.repo) {
      armReviewTimer(String(row.repo));
    }
  }
  setInterval(
    () => {
      runProjectSummaryTick().catch((error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[PROJECT_SUMMARY] Tick failed: ${msg}\n`);
      });
    },
    6 * 60 * 60 * 1000,
  );

  // ---- Route handlers ----

  // handleCreate is now in task-api-runtime.ts

  async function handleCreateReview(req: PluginHttpRequest, res: PluginHttpResponse) {
    const body = await parseBody(req);
    const repo = typeof body.repo === "string" ? body.repo.trim() : "";
    const sha = typeof body.sha === "string" ? body.sha.trim() : "";
    const deliveryKey = typeof body.deliveryKey === "string" ? body.deliveryKey.trim() : "";
    if (!repo || !sha || !deliveryKey) {
      sendError(res, 400, "repo, sha, and deliveryKey are required");
      return;
    }

    const projectId = resolveProjectIdForRepo(CONFIG, repo);
    if (!projectId) {
      sendError(res, 400, `No configured project mapping for repo '${repo}'`);
      return;
    }
    const project = CONFIG.projects?.[projectId] || {};
    if (!project.cwd) {
      sendError(res, 400, `Project '${projectId}' is missing cwd in task-dispatch config`);
      return;
    }

    const existingDelivery = getReviewDelivery(deliveryKey);
    const existingRepoShaDelivery = getReviewDeliveryForRepoSha(repo, sha);
    const reviewState = getReviewState(repo);
    const reviewRequest = body as typeof body & {
      repo: string;
      sha: string;
      deliveryKey: string;
      beforeSha?: string;
      branch?: string;
      pusher?: string;
      compareUrl?: string;
      installationId?: number;
    };
    const { fromSha, toSha } = resolveReviewRange(reviewState, reviewRequest);
    const requestPlan = planReviewRequest({
      state: reviewState,
      fromSha,
      toSha,
      duplicateDelivery: Boolean(existingDelivery || existingRepoShaDelivery),
    });
    if (requestPlan.status === "duplicate") {
      const duplicateDelivery = existingDelivery || existingRepoShaDelivery;
      const existingRange = extractReviewRangeFromTask(duplicateDelivery?.task_id ?? null);
      sendJson(res, {
        taskId: duplicateDelivery?.task_id || null,
        status: requestPlan.status,
        debounceWindowMs: REVIEW_DEBOUNCE_WINDOW_MS,
        reviewRange: `${existingRange?.fromSha || requestPlan.pendingFromSha}..${existingRange?.toSha || requestPlan.pendingToSha}`,
      });
      return;
    }
    const now = Date.now();
    let taskId = reviewState.pending_task_id;
    let responseStatus = requestPlan.status;
    const reviewAgent = resolveReviewAgentId(
      CONFIG,
      projectId,
      project.defaultAgent || DEFAULT_AGENT,
    );

    if (requestPlan.status === "queued_after_active_review") {
      const pendingFromSha = requestPlan.pendingFromSha;
      if (!taskId) {
        const created = createPendingReviewTask(reviewRequest, projectId, pendingFromSha, toSha);
        taskId = created.id;
      } else {
        updateReviewTaskWindow(taskId!, {
          title: buildReviewTaskTitle(repo, toSha),
          description: buildReviewTaskDescription({
            repo,
            projectId,
            fromSha: pendingFromSha,
            toSha,
            branch: reviewRequest.branch,
            pusher: reviewRequest.pusher,
            compareUrl: reviewRequest.compareUrl,
          }),
          projectId,
          cwd: project.cwd,
          agent: reviewAgent,
        });
      }
      saveReviewState({
        ...reviewState,
        repo,
        pending_from_sha: pendingFromSha,
        pending_to_sha: requestPlan.pendingToSha,
        pending_task_id: taskId,
        pending_updated_at: now,
      });
    } else if (requestPlan.status === "debounced") {
      const pendingFromSha = requestPlan.pendingFromSha;
      updateReviewTaskWindow(taskId!, {
        title: buildReviewTaskTitle(repo, toSha),
        description: buildReviewTaskDescription({
          repo,
          projectId,
          fromSha: pendingFromSha,
          toSha,
          branch: reviewRequest.branch,
          pusher: reviewRequest.pusher,
          compareUrl: reviewRequest.compareUrl,
        }),
        projectId,
        cwd: project.cwd,
        agent: reviewAgent,
      });
      saveReviewState({
        ...reviewState,
        repo,
        pending_from_sha: pendingFromSha,
        pending_to_sha: requestPlan.pendingToSha,
        pending_task_id: taskId,
        pending_updated_at: now,
      });
    } else {
      const created = createPendingReviewTask(reviewRequest, projectId, fromSha, toSha);
      taskId = created.id;
      saveReviewState({
        ...reviewState,
        repo,
        pending_from_sha: fromSha,
        pending_to_sha: toSha,
        pending_task_id: taskId,
        pending_updated_at: now,
      });
    }

    const installationId =
      typeof reviewRequest.installationId === "number" ? reviewRequest.installationId : null;
    saveReviewDelivery({
      delivery_key: deliveryKey,
      repo,
      sha,
      task_id: taskId,
      status: responseStatus,
      accepted_at: now,
      installation_id: installationId,
    });
    if (taskId) {
      recordTaskEvent(taskId, "review.request.accepted", {
        repo,
        deliveryKey,
        status: responseStatus,
        reviewRange: `${getReviewState(repo).pending_from_sha || getReviewState(repo).active_from_sha || fromSha}..${getReviewState(repo).pending_to_sha || getReviewState(repo).active_to_sha || toSha}`,
      });
    }
    armReviewTimer(repo);

    const nextState = getReviewState(repo);
    sendJson(res, {
      taskId,
      status: responseStatus,
      debounceWindowMs: REVIEW_DEBOUNCE_WINDOW_MS,
      reviewRange: `${nextState.pending_from_sha || nextState.active_from_sha || requestPlan.pendingFromSha}..${nextState.pending_to_sha || nextState.active_to_sha || requestPlan.pendingToSha}`,
    });
  }

  // Task API handlers are now in task-api-runtime.ts

  const heartbeatRuntime = createHeartbeatRuntime({ db, config: CONFIG });
  const { handleCreateHeartbeat, handleListHeartbeats, handleHeartbeatsHealth } = heartbeatRuntime;

  // ---- Dispatch runner endpoint (manual trigger / CLI use) ----

  api.registerHttpRoute({
    path: "/api/dispatch/run",
    auth: "plugin",
    handler: async (req, res) => {
      try {
        if (!requireApiKey(req, res)) return true;
        const query = parseQuery(req.url || "");
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

        const queued = backgroundJobs.enqueue({ kind: "dispatch", taskId });

        sendJson(
          res,
          {
            queued,
            id: taskId,
            status: rowToTask(getTask(taskId))?.status || "unknown",
            ...(queued ? {} : { reason: "already_dispatching" }),
          },
          queued ? 202 : 200,
        );
        return true;
      } catch (e) {
        sendError(res, 500, e instanceof Error ? e.message : String(e));
        return true;
      }
    },
  });

  registerProjectRoutes(api, { db, sseClients, requireApiKey } as Parameters<
    typeof registerProjectRoutes
  >[1]);

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
        const query = parseQuery(_req.url || "");
        const testCwd = query.cwd || "/tmp/dispatch-test";
        mkdirSync(testCwd, { recursive: true });
        const sessionKey = `agent:opencode:acp:${crypto.randomUUID()}`;
        process.stderr.write(`[TEST-ACP] ensureSession key=${sessionKey}\n`);
        const handle = await (
          acpRuntime as { ensureSession: (params: Record<string, unknown>) => Promise<unknown> }
        ).ensureSession({
          sessionKey,
          agent: "opencode",
          mode: "persistent",
          cwd: testCwd,
        });
        process.stderr.write(`[TEST-ACP] session ready, runTurn\n`);
        let text = "";
        for await (const ev of (
          acpRuntime as {
            runTurn: (
              params: Record<string, unknown>,
            ) => AsyncIterable<{ type: string; text?: string }>;
          }
        ).runTurn({
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
        sendError(res, 500, e instanceof Error ? e.message : String(e));
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
        taskApiRuntime.handleHealth(_req, res);
        return true;
      } catch (e: unknown) {
        sendError(res, 500, e instanceof Error ? e.message : String(e));
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

  const taskApiRuntime = createTaskApiRuntime({
    api,
    db,
    dbPath,
    maxConcurrentSessions,
    getActiveSessionCount,
    getTask,
    rowToTask,
    recordTaskEvent,
    onTaskChanged,
    triggerDispatch,
    resolveAccountId,
    formatDiscordThreadUrl,
    resolveBotToken,
    requireApiKey,
    sseClients,
    backgroundEnqueue: (kind, taskId) => backgroundJobs.enqueue({ kind, taskId }),
    defaultTaskTimeoutMs,
    handleCreateReview,
    stderr: process.stderr,
    stmts: {
      insert: stmts.insert,
      getById: stmts.getById,
      deleteTaskEventsByTaskId: stmts.deleteTaskEventsByTaskId as { run(id: string): void },
      deleteCommentsByTaskId: stmts.deleteCommentsByTaskId as { run(id: string): void },
      deleteById: stmts.deleteById as { run(id: string): void },
      countByStatus: stmts.countByStatus as unknown as {
        all(): Array<{ status: string; count: number }>;
      },
      countByAgent: stmts.countByAgent as unknown as {
        all(): Array<{ agent: string; count: number }>;
      },
      countByProject: stmts.countByProject as unknown as {
        all(): Array<{ project_id: string; count: number }>;
      },
      listCommentsByTask: stmts.listCommentsByTask as unknown as {
        all(taskId: string): Array<Record<string, unknown> | null | undefined>;
      },
      insertComment: stmts.insertComment as { run(row: Record<string, unknown>): void },
    },
  });
  const { registerTaskRoutes } = taskApiRuntime;

  api.registerHttpRoute({
    path: "/api/heartbeats",
    match: "prefix",
    auth: "plugin",
    handler: async (req, res) => {
      try {
        const pathname = (req.url || "").split("?")[0] || "";
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
          sendError(res, 405, `Method ${method} not allowed on /api/heartbeats/health`);
          return true;
        }

        sendError(res, 404, "Not found");
        return true;
      } catch (e) {
        sendError(res, 500, e instanceof Error ? e.message : String(e));
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
        const pathname = (req.url || "").split("?")[0] || "";
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
          const id = segments[0]!;
          if (method === "PATCH") {
            if (!requireApiKey(req, res)) return true;
            await handleUpdateSchedule(req, res, id);
            return true;
          }
          if (method === "DELETE") {
            if (!requireApiKey(req, res)) return true;
            handleDeleteSchedule(res, id!);
            return true;
          }
          sendError(res, 405, `Method ${method} not allowed on /api/schedules/:id`);
          return true;
        }

        sendError(res, 404, "Not found");
        return true;
      } catch (e: unknown) {
        sendError(res, 500, e instanceof Error ? e.message : String(e));
        return true;
      }
    },
  });

  registerTaskRoutes();

  const lifecycleRuntime = createLifecycleRuntime({
    api,
    db,
    runDueSchedules,
    onTaskChanged,
    stderr: process.stderr,
  });
  lifecycleRuntime.registerCompletionHook();
  void lifecycleRuntime.reconcileMissingThreadIds();
}
