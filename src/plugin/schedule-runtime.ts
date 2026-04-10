import crypto from "node:crypto";
import { normalizeTimeoutMs } from "./config";
import { rowToSchedule, rowToTask } from "./db";
import { parseBody, sendError, sendJson } from "./routes/tasks";
import type { PluginHttpRequest, PluginHttpResponse, Schedule, TaskStatus } from "./types";
import type { DatabaseLike } from "./runtime-types";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ScheduleRuntimeDeps = {
  db: DatabaseLike;
  defaultTaskTimeoutMs: number;
  getNextRunAt: (cron: string, fromTimestamp?: number) => number;
  parseNlExpressionToCron: (nlExpression: string) => string | null;
  getTask: (id: string) => Record<string, unknown> | null;
  onTaskChanged: (taskId: string) => void;
  triggerDispatch: (taskId: string) => void;
  stderr: Pick<typeof process.stderr, "write">;
};

export function createScheduleRuntime(deps: ScheduleRuntimeDeps) {
  const stmts = {
    insertSchedule: deps.db.prepare(
      `INSERT INTO schedules (id, title, description, agent, project_id, cwd, category, qa_required, cron, nl_expression, timeout_ms, enabled, last_run_at, next_run_at, created_at, updated_at)
       VALUES (@id, @title, @description, @agent, @project_id, @cwd, @category, @qa_required, @cron, @nl_expression, @timeout_ms, @enabled, @last_run_at, @next_run_at, @created_at, @updated_at)`,
    ),
    listSchedules: deps.db.prepare("SELECT * FROM schedules ORDER BY created_at DESC"),
    getScheduleById: deps.db.prepare("SELECT * FROM schedules WHERE id = ?"),
    updateScheduleById: deps.db.prepare(
      "UPDATE schedules SET enabled = @enabled, updated_at = @updated_at, next_run_at = @next_run_at WHERE id = @id",
    ),
    deleteScheduleById: deps.db.prepare("DELETE FROM schedules WHERE id = ?"),
  };

  function getSchedule(id: string): Schedule | null {
    return rowToSchedule(
      stmts.getScheduleById.get(id) as Record<string, unknown> | null | undefined,
    );
  }

  function createTaskFromSchedule(scheduleRow: Record<string, unknown>) {
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
      status: "ready" as TaskStatus,
      manual_complete: 0,
      timeout_ms: normalizeTimeoutMs(scheduleRow.timeout_ms, deps.defaultTaskTimeoutMs),
      review_attempts: 0,
      qa_required: scheduleRow.qa_required === 0 ? 0 : 1,
      created_at: now,
      updated_at: now,
    };

    deps.db
      .prepare(
        `INSERT INTO tasks (id, title, description, agent, runtime, project_id, channel_id, cwd, model, thinking, depends_on, chain_id, status, manual_complete, timeout_ms, thread_id, review_attempts, qa_required, created_at, updated_at)
       VALUES (@id, @title, @description, @agent, @runtime, @project_id, @channel_id, @cwd, @model, @thinking, @depends_on, @chain_id, @status, @manual_complete, @timeout_ms, NULL, @review_attempts, @qa_required, @created_at, @updated_at)`,
      )
      .run(taskRow);

    const createdTask = rowToTask(deps.getTask(id));
    if (createdTask) {
      deps.onTaskChanged(createdTask.id);
      deps.triggerDispatch(createdTask.id);
    }
    return createdTask;
  }

  function handleListSchedules(_req: PluginHttpRequest, res: PluginHttpResponse): void {
    const rows = stmts.listSchedules.all();
    sendJson(
      res,
      rows.map((row) => rowToSchedule(row as Record<string, unknown> | null | undefined)),
    );
  }

  async function handleCreateSchedule(
    req: PluginHttpRequest,
    res: PluginHttpResponse,
  ): Promise<void> {
    const body = await parseBody(req);
    if (!body.title) {
      sendError(res, 400, "title is required");
      return;
    }
    const cronExpression =
      typeof body.cronExpression === "string" && body.cronExpression.trim()
        ? body.cronExpression.trim()
        : typeof body.nlExpression === "string"
          ? deps.parseNlExpressionToCron(body.nlExpression)
          : null;
    if (!cronExpression) {
      sendError(res, 400, "cronExpression or supported nlExpression is required");
      return;
    }
    const now = Date.now();
    const scheduleRow = {
      id: crypto.randomUUID(),
      title: String(body.title),
      description: typeof body.description === "string" ? body.description : null,
      agent: typeof body.agent === "string" ? body.agent : "default",
      project_id: typeof body.projectId === "string" ? body.projectId : null,
      cwd: typeof body.cwd === "string" ? body.cwd : null,
      category: typeof body.category === "string" ? body.category : null,
      qa_required: body.qaRequired === false ? 0 : 1,
      cron: cronExpression,
      nl_expression: typeof body.nlExpression === "string" ? body.nlExpression : null,
      timeout_ms: normalizeTimeoutMs(body.timeoutMs, deps.defaultTaskTimeoutMs),
      enabled: body.enabled === false ? 0 : 1,
      last_run_at: null,
      next_run_at: deps.getNextRunAt(cronExpression, now),
      created_at: now,
      updated_at: now,
    };
    stmts.insertSchedule.run(scheduleRow);
    sendJson(res, rowToSchedule(scheduleRow as unknown as Record<string, unknown>), 201);
  }

  async function handleUpdateSchedule(
    req: PluginHttpRequest,
    res: PluginHttpResponse,
    id: string,
  ): Promise<void> {
    const existing = stmts.getScheduleById.get(id);
    if (!existing) {
      sendError(res, 404, "Schedule not found");
      return;
    }
    const body = await parseBody(req);
    if (body.enabled == null) {
      sendError(res, 400, "enabled is required");
      return;
    }
    const enabled = body.enabled ? 1 : 0;
    const updatedAt = Date.now();
    const nextRunAt = enabled
      ? deps.getNextRunAt(String((existing as Record<string, unknown>).cron || ""), updatedAt)
      : null;
    stmts.updateScheduleById.run({ id, enabled, updated_at: updatedAt, next_run_at: nextRunAt });
    sendJson(
      res,
      rowToSchedule(stmts.getScheduleById.get(id) as Record<string, unknown> | null | undefined),
    );
  }

  function handleDeleteSchedule(res: PluginHttpResponse, id: string): void {
    const existing = stmts.getScheduleById.get(id);
    if (!existing) {
      sendError(res, 404, "Schedule not found");
      return;
    }
    stmts.deleteScheduleById.run(id);
    sendJson(res, { deleted: true, id });
  }

  function runDueSchedules(): void {
    const dueRows = deps.db
      .prepare(
        "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC",
      )
      .all(Date.now());
    for (const row of dueRows) {
      try {
        const schedule = rowToSchedule(row as Record<string, unknown> | null | undefined);
        if (!schedule) continue;
        createTaskFromSchedule(row as Record<string, unknown>);
        deps.db
          .prepare(
            "UPDATE schedules SET last_run_at = @last_run_at, next_run_at = @next_run_at, updated_at = @updated_at WHERE id = @id",
          )
          .run({
            id: schedule.id,
            last_run_at: Date.now(),
            next_run_at: deps.getNextRunAt(schedule.cronExpression),
            updated_at: Date.now(),
          });
      } catch (error) {
        deps.stderr.write(`[SCHEDULE] Failed to run schedule: ${getErrorMessage(error)}\n`);
      }
    }
  }

  return {
    getSchedule,
    createTaskFromSchedule,
    handleListSchedules,
    handleCreateSchedule,
    handleUpdateSchedule,
    handleDeleteSchedule,
    runDueSchedules,
  };
}
