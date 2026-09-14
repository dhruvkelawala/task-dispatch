import crypto from "node:crypto";
import { createBackgroundJobQueue } from "./background-jobs";
import { createDispatchRuntime } from "./dispatch-runtime";
import { createDiscordRuntime } from "./discord-runtime";
import { createHeartbeatRuntime } from "./heartbeat-runtime";
import { createLifecycleRuntime } from "./lifecycle-runtime";
import { createScheduleRuntime } from "./schedule-runtime";
import { createTaskApiRuntime } from "./task-api-runtime";
import { loadConfig, normalizeTimeoutMs } from "./config";
import { initDb, rowToTask, seedProjectsIfEmpty } from "./db";
// thread-messages helpers are used by extracted runtime modules
import { getNextRunAt, parseNlExpressionToCron } from "./scheduler";
import { runProjectSummaryTick as runProjectSummaryTickCore } from "./summarize";
import { parseQuery, sendError, sendJson } from "./routes/tasks";
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

function titleFromProjectId(projectId: string): string {
  return String(projectId || "project")
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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
const defaultAcpStartupCooldownMs = normalizeTimeoutMs(DEFAULTS.acpStartupCooldownMs, 60 * 1000);
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
  const agentChannel = task.agent ? AGENT_DEFAULT_CHANNELS[task.agent] : undefined;
  if (agentChannel) return agentChannel;
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

  function detectGatewayRuntimeState() {
    const currentStartedAt = Date.now();
    const currentPid = String(process.pid);
    const previousPidResult = db
      .prepare<{ value?: string }>("SELECT value FROM plugin_state WHERE key = ?")
      .get("gateway.pid");
    const previousStartedAtResult = db
      .prepare<{ value?: string }>("SELECT value FROM plugin_state WHERE key = ?")
      .get("gateway.started_at");
    const previousPid =
      typeof previousPidResult?.value === "string" && previousPidResult.value.trim()
        ? previousPidResult.value.trim()
        : null;
    const previousStartedAt =
      typeof previousStartedAtResult?.value === "string" && previousStartedAtResult.value.trim()
        ? Number.parseInt(previousStartedAtResult.value, 10)
        : null;
    db.prepare(
      `INSERT INTO plugin_state (key, value, updated_at)
       VALUES (@key, @value, @updated_at)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    ).run({
      key: "gateway.pid",
      value: currentPid,
      updated_at: currentStartedAt,
    });
    db.prepare(
      `INSERT INTO plugin_state (key, value, updated_at)
       VALUES (@key, @value, @updated_at)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    ).run({
      key: "gateway.started_at",
      value: String(currentStartedAt),
      updated_at: currentStartedAt,
    });
    return {
      currentPid,
      currentStartedAt,
      previousPid,
      previousStartedAt: Number.isFinite(previousStartedAt) ? previousStartedAt : null,
      isGatewayRestart: Boolean(previousPid && previousPid !== currentPid),
    };
  }

  const gatewayRuntimeState = detectGatewayRuntimeState();
  if (gatewayRuntimeState.isGatewayRestart) {
    process.stderr.write(
      `[STARTUP] Gateway restart detected (pid ${gatewayRuntimeState.previousPid} -> ${gatewayRuntimeState.currentPid})\n`,
    );
  }

  // ---- Phase 5: Restart resilience — log active tasks and recover only after
  // real gateway restarts. Plugin hot-reloads/config changes happen inside the
  // same gateway process, so they must not trigger ACP auto-resume.
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

  function resolveHarness(task: Partial<Task>): string {
    const agentConfig = task.agent ? CONFIG.agents?.[task.agent] : undefined;
    return agentConfig?.harness || "opencode";
  }

  const discordRuntime = createDiscordRuntime({
    config: CONFIG,
    openclawConfig: api.config as {
      channels?: { discord?: { accounts?: Record<string, { token?: string }> } };
    },
    defaultDiscordAccountId: DEFAULT_DISCORD_ACCOUNT_ID,
    resolveAccountId,
    resolveChannel,
    formatDiscordThreadUrl,
    recordTaskEvent,
    db,
    stderr: process.stderr,
  });
  const { createDiscordThread, postToThread, readThreadMessages, resolveBotToken } = discordRuntime;
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
    // Jobs are intentionally non-serial: a stale ACP resume must never block fresh dispatches.
    maxConcurrentJobs: 3,
    timeoutMs: (job) => {
      if (job.kind === "resume") return Math.min(defaultReviewTimeoutMs, 60_000);
      const task = rowToTask(getTask(job.taskId) as Record<string, unknown> | null | undefined);
      // Task timeout is the agent/thread-output timeout. The background worker
      // also needs room for startup cooldown, ACP session initialization, and
      // Discord thread binding before that timer begins.
      return resolveTaskTimeoutMs(task || {}) + defaultAcpStartupCooldownMs + 60_000;
    },
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
    acpStartupCooldownMs: defaultAcpStartupCooldownMs,
    defaultReviewTimeoutMs,
    maxConcurrentSessions,
    maxReviewCycles,
    defaultDiscordAccountId: DEFAULT_DISCORD_ACCOUNT_ID,
    resolveCwd,
    resolveRuntime,
    resolveHarness,
    resolveChannel,
    resolveTaskTimeoutMs,
    resolveQaRequired,
    resolveAccountId,
    createDiscordThread,
    postToThread,
    readThreadMessages,
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
    promptTaskSession,
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

  function queueGatewayRestartResumes(): void {
    if (!gatewayRuntimeState.isGatewayRestart) return;

    const now = Date.now();
    const interruptedRows = db
      .prepare<Record<string, unknown>>(
        "SELECT * FROM tasks WHERE status IN ('dispatched', 'in_progress') AND session_key IS NOT NULL",
      )
      .all();

    const candidates: Task[] = [];
    for (const row of interruptedRows) {
      const task = rowToTask(row);
      if (!task) continue;
      if (resolveRuntime(task) !== "acp") continue;

      const lastTouchedAt = task.updatedAt || task.createdAt || 0;
      // Skip tasks that were already stale before the previous gateway session
      // even started; they are not newly interrupted by the just-detected restart.
      if (
        gatewayRuntimeState.previousStartedAt &&
        Number.isFinite(gatewayRuntimeState.previousStartedAt) &&
        lastTouchedAt < gatewayRuntimeState.previousStartedAt
      ) {
        process.stderr.write(
          `[STARTUP] Skipping pre-restart task ${task.id} status=${task.status} lastTouchedAt=${lastTouchedAt}\n`,
        );
        continue;
      }
      const maxResumeAgeMs = resolveTaskTimeoutMs(task);
      if (now - lastTouchedAt > maxResumeAgeMs) {
        process.stderr.write(
          `[STARTUP] Skipping stale auto-resume for task ${task.id} status=${task.status} ageMs=${now - lastTouchedAt}\n`,
        );
        continue;
      }

      candidates.push(task);
    }

    if (candidates.length === 0) {
      process.stderr.write(
        "[STARTUP] No ACP tasks eligible for auto-resume after gateway restart\n",
      );
      return;
    }

    process.stderr.write(
      `[STARTUP] Queueing ${candidates.length} ACP task(s) for auto-resume after gateway restart\n`,
    );
    for (const task of candidates) {
      const queued = backgroundJobs.enqueue({ kind: "resume", taskId: task.id });
      recordTaskEvent(task.id, queued ? "task.resume_queued" : "task.resume_already_queued", {
        reason: "gateway_restart",
        priorStatus: task.status,
        previousGatewayPid: gatewayRuntimeState.previousPid,
        currentGatewayPid: gatewayRuntimeState.currentPid,
        sessionKey: task.sessionKey,
        threadId: task.threadId || null,
      });
      process.stderr.write(
        `[STARTUP] ${queued ? "Queued" : "Skipped"} auto-resume for task ${task.id} status=${task.status}\n`,
      );
    }
  }

  queueGatewayRestartResumes();

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
        backgroundJobs.drainOnce();

        sendJson(
          res,
          {
            queued,
            id: taskId,
            status: rowToTask(getTask(taskId))?.status || "unknown",
            queue: backgroundJobs.status(),
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

  api.registerHttpRoute({
    path: "/api/dispatch/queue",
    auth: "plugin",
    handler: async (req, res) => {
      try {
        if (!requireApiKey(req, res)) return true;
        sendJson(res, backgroundJobs.status());
        return true;
      } catch (e) {
        sendError(res, 500, e instanceof Error ? e.message : String(e));
        return true;
      }
    },
  });

  api.registerHttpRoute({
    path: "/api/dispatch/drain",
    auth: "plugin",
    handler: async (req, res) => {
      try {
        if (!requireApiKey(req, res)) return true;
        const query = parseQuery(req.url || "");
        const force = query.force === "true" || query.force === "1";
        if (force) {
          const result = backgroundJobs.forceDrain();
          sendJson(res, { ok: true, force: true, ...result, queue: backgroundJobs.status() });
        } else {
          backgroundJobs.drainOnce();
          sendJson(res, { ok: true, queue: backgroundJobs.status() });
        }
        return true;
      } catch (e) {
        sendError(res, 500, e instanceof Error ? e.message : String(e));
        return true;
      }
    },
  });

  api.registerHttpRoute({
    path: "/api/dispatch/cancel",
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
        const kind = query.kind || undefined;
        const cancelled = backgroundJobs.cancel(taskId, kind);
        if (cancelled) {
          // Reset the task back to ready so it can be re-dispatched
          const row = getTask(taskId);
          if (row && ["ready", "dispatched", "in_progress"].includes(row.status as string)) {
            db.prepare(
              "UPDATE tasks SET status = 'ready', error = 'Job cancelled via /api/dispatch/cancel', updated_at = @updated_at WHERE id = @id",
            ).run({ id: taskId, updated_at: Date.now() });
            recordTaskEvent(taskId, "dispatch.cancelled", { kind, via: "api" });
            onTaskChanged(taskId);
          }
          sendJson(res, { ok: true, cancelled: true, taskId, queue: backgroundJobs.status() });
        } else {
          sendJson(res, { ok: true, cancelled: false, taskId, reason: "not_found_in_queue" });
        }
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
    requireApiKey,
    sseClients,
    backgroundEnqueue: (kind, taskId) => backgroundJobs.enqueue({ kind, taskId }),
    defaultTaskTimeoutMs,
    promptTaskSession,
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
