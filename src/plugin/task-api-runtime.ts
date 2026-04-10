import crypto from "node:crypto";
import { rowToComment, rowToTaskEvent, type DbRow } from "./db";
import {
  handleCreateTask,
  handleUpdateTask,
  parseBody,
  parsePath,
  parseQuery,
  sendError,
  sendJson,
} from "./routes/tasks";
import type { PluginApi, PluginHttpRequest, PluginHttpResponse, Task, TaskStatus } from "./types";
import type { DatabaseLike, SseClientLike } from "./runtime-types";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type TaskApiRuntimeDeps = {
  api: PluginApi;
  db: DatabaseLike;
  dbPath: string;
  maxConcurrentSessions: number;
  getActiveSessionCount: () => number;
  getTask: (id: string) => Record<string, unknown> | null;
  rowToTask: (row: DbRow) => Task | null;
  recordTaskEvent: (
    taskId: string,
    eventType: string,
    payload?: Record<string, unknown> | null,
  ) => void;
  onTaskChanged: (taskId: string) => void;
  triggerDispatch: (taskId: string) => void;
  requireApiKey: (req: PluginHttpRequest, res: PluginHttpResponse) => boolean;
  sseClients: Set<SseClientLike>;
  backgroundEnqueue: (kind: "dispatch" | "resume" | "qa", taskId: string) => boolean;
  defaultTaskTimeoutMs: number;
  handleCreateReview: (req: PluginHttpRequest, res: PluginHttpResponse) => Promise<void>;
  stderr: Pick<typeof process.stderr, "write">;
  stmts: {
    insert: unknown;
    getById: unknown;
    deleteTaskEventsByTaskId: { run(id: string): void };
    deleteCommentsByTaskId: { run(id: string): void };
    deleteById: { run(id: string): void };
    countByStatus: { all(): Array<{ status: string; count: number }> };
    countByAgent: { all(): Array<{ agent: string; count: number }> };
    countByProject: { all(): Array<{ project_id: string; count: number }> };
    listCommentsByTask: { all(taskId: string): DbRow[] };
    insertComment: { run(row: Record<string, unknown>): void };
  };
};

export function createTaskApiRuntime(deps: TaskApiRuntimeDeps) {
  function handleList(req: PluginHttpRequest, res: PluginHttpResponse): void {
    const query = parseQuery(req.url || "");
    const conditions: string[] = [];
    const params: Record<string, string | number> = {};
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
      params.limit = Number.parseInt(query.limit, 10);
    }
    const rows = deps.db.prepare<DbRow>(sql).all(params);
    sendJson(
      res,
      rows.map((row) => deps.rowToTask(row)),
    );
  }

  function handleGetOne(res: PluginHttpResponse, id: string): void {
    const task = deps.getTask(id);
    if (!task) {
      sendError(res, 404, "Task not found");
      return;
    }
    sendJson(res, deps.rowToTask(task));
  }

  function handleGetEvents(req: PluginHttpRequest, res: PluginHttpResponse, id: string): void {
    const task = deps.getTask(id);
    if (!task) {
      sendError(res, 404, "Task not found");
      return;
    }
    const query = parseQuery(req.url || "");
    const limit = Math.max(1, Math.min(Number.parseInt(query.limit || "100", 10) || 100, 500));
    const order = String(query.order || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    const rows = deps.db
      .prepare<DbRow>(
        `SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ${order} LIMIT ?`,
      )
      .all(id, limit);
    sendJson(
      res,
      rows.map((row) => rowToTaskEvent(row)),
    );
  }

  async function handleUpdate(
    req: PluginHttpRequest,
    res: PluginHttpResponse,
    id: string,
  ): Promise<void> {
    await handleUpdateTask(req, res, id, {
      getTask: deps.getTask,
      db: deps.db,
      defaultTaskTimeoutMs: deps.defaultTaskTimeoutMs,
    });
    const updated = deps.rowToTask(deps.getTask(id));
    if (updated?.status === "ready") {
      deps.onTaskChanged(id);
    }
  }

  function handleDelete(res: PluginHttpResponse, id: string): void {
    const existing = deps.getTask(id) as Record<string, unknown> | null;
    if (!existing) {
      sendError(res, 404, "Task not found");
      return;
    }
    const status = existing.status as TaskStatus;
    if (!["pending", "done", "cancelled"].includes(status)) {
      sendError(
        res,
        400,
        `Cannot delete task with status '${status}'. Only pending, done, or cancelled tasks can be deleted.`,
      );
      return;
    }
    deps.stmts.deleteTaskEventsByTaskId.run(id);
    deps.stmts.deleteCommentsByTaskId.run(id);
    deps.stmts.deleteById.run(id);
    sendJson(res, { deleted: true, id });
  }

  function handleStats(_req: PluginHttpRequest, res: PluginHttpResponse): void {
    const byStatus: Record<string, number> = {};
    for (const row of deps.stmts.countByStatus.all()) byStatus[row.status] = row.count;
    const byAgent: Record<string, number> = {};
    for (const row of deps.stmts.countByAgent.all()) byAgent[row.agent] = row.count;
    const byProject: Record<string, number> = {};
    for (const row of deps.stmts.countByProject.all()) byProject[row.project_id] = row.count;
    sendJson(res, { byStatus, byAgent, byProject });
  }

  function handleListComments(res: PluginHttpResponse, taskId: string): void {
    const task = deps.getTask(taskId);
    if (!task) {
      sendError(res, 404, "Task not found");
      return;
    }
    sendJson(
      res,
      deps.stmts.listCommentsByTask.all(taskId).map((row) => rowToComment(row)),
    );
  }

  async function handleCreateComment(
    req: PluginHttpRequest,
    res: PluginHttpResponse,
    taskId: string,
  ): Promise<void> {
    const task = deps.getTask(taskId);
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
    deps.stmts.insertComment.run(row);
    sendJson(res, rowToComment(row), 201);
  }

  function handleHealth(_req: PluginHttpRequest, res: PluginHttpResponse): void {
    sendJson(res, {
      status: "ok",
      timestamp: Date.now(),
      activeSessions: deps.getActiveSessionCount(),
      maxConcurrentSessions: deps.maxConcurrentSessions,
      acpRuntimeAvailable: Boolean(deps.api.runtime?.acp),
      dbPath: deps.dbPath,
    });
  }

  function requireApiKey(req: PluginHttpRequest, res: PluginHttpResponse): boolean {
    return deps.requireApiKey(req, res);
  }

  function registerTaskRoutes(): void {
    deps.api.registerHttpRoute({
      path: "/api/tasks/events",
      auth: "plugin",
      handler: (req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (!res.write) return false;
        deps.sseClients.add(res as unknown as SseClientLike);
        const heartbeatInterval = setInterval(() => {
          try {
            res.write?.(": heartbeat\n\n");
          } catch {
            clearInterval(heartbeatInterval);
            deps.sseClients.delete(res as unknown as SseClientLike);
          }
        }, 30_000);
        req.on("close", () => {
          clearInterval(heartbeatInterval);
          deps.sseClients.delete(res as unknown as SseClientLike);
        });
        return false;
      },
    });

    deps.api.registerHttpRoute({
      path: "/api/tasks/review",
      auth: "plugin",
      handler: async (req, res) => {
        const method = req.method?.toUpperCase() || "GET";
        if (method !== "POST") {
          sendError(res, 405, `Method ${method} not allowed on /api/tasks/review`);
          return true;
        }
        if (!requireApiKey(req, res)) return true;
        try {
          await deps.handleCreateReview(req, res);
        } catch (error) {
          sendError(res, 500, getErrorMessage(error));
        }
        return true;
      },
    });

    deps.api.registerHttpRoute({
      path: "/api/tasks",
      match: "prefix",
      auth: "plugin",
      handler: async (req, res) => {
        try {
          const { segments } = parsePath(req.url || "");
          const method = req.method?.toUpperCase() || "GET";

          if (segments[0] === "stats" && method === "GET") {
            handleStats(req, res);
            return true;
          }

          if (segments.length === 2 && segments[1] === "events" && method === "GET") {
            handleGetEvents(req, res, segments[0]!);
            return true;
          }

          if (segments.length === 2 && segments[1] === "comments") {
            const id = segments[0]!;
            if (method === "GET") {
              handleListComments(res, id);
              return true;
            }
            if (method === "POST") {
              if (!requireApiKey(req, res)) return true;
              await handleCreateComment(req, res, id);
              return true;
            }
            sendError(res, 405, `Method ${method} not allowed on /api/tasks/:id/comments`);
            return true;
          }

          if (segments.length === 2 && segments[1] === "resume" && method === "POST") {
            if (!requireApiKey(req, res)) return true;
            const id = segments[0]!;
            const task = deps.rowToTask(deps.getTask(id));
            if (!task) {
              sendError(res, 404, "Task not found");
              return true;
            }
            if (task.status !== "error") {
              sendError(
                res,
                400,
                `Cannot resume task in status '${task.status}'. Must be in error state.`,
              );
              return true;
            }
            if (!task.sessionKey) {
              sendError(res, 400, "Task has no session to resume");
              return true;
            }
            if (!deps.api.runtime?.acp?.spawn) {
              sendError(res, 500, "acp.spawn not available");
              return true;
            }
            const queued = deps.backgroundEnqueue("resume", task.id);
            res.writeHead(queued ? 202 : 200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: true,
                queued,
                message: queued ? "Resume queued" : "Resume already queued",
                taskId: task.id,
                sessionKey: task.sessionKey,
              }),
            );
            return true;
          }

          if (segments.length === 2 && segments[1] === "qa" && method === "POST") {
            if (!requireApiKey(req, res)) return true;
            const id = segments[0]!;
            const task = deps.rowToTask(deps.getTask(id));
            if (!task) {
              sendError(res, 404, "Task not found");
              return true;
            }
            if (!["done", "in_progress", "review"].includes(task.status)) {
              sendError(
                res,
                400,
                `Cannot trigger QA for task in status '${task.status}'. Must be done, in_progress, or review.`,
              );
              return true;
            }
            if (task.status !== "review") {
              deps.db
                .prepare(
                  "UPDATE tasks SET status = 'review', qa_required = 1, review_attempts = 0, completed_at = NULL, updated_at = @updated_at WHERE id = @id",
                )
                .run({ id: task.id, updated_at: Date.now() });
              deps.onTaskChanged(task.id);
            }
            const queued = deps.backgroundEnqueue("qa", task.id);
            res.writeHead(queued ? 202 : 200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: true,
                queued,
                message: queued ? "QA review queued" : "QA review already queued",
                taskId: task.id,
              }),
            );
            return true;
          }

          if (segments.length === 1) {
            const id = segments[0]!;
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

          if (segments.length === 0) {
            if (method === "GET") {
              handleList(req, res);
              return true;
            }
            if (method === "POST") {
              if (!requireApiKey(req, res)) return true;
              await handleCreateTask(req, res, {
                db: deps.db,
                getTask: deps.getTask,
                insert: deps.stmts.insert as never,
                defaultTaskTimeoutMs: deps.defaultTaskTimeoutMs,
                triggerDispatch: deps.triggerDispatch,
              });
              return true;
            }
            sendError(res, 405, `Method ${method} not allowed on /api/tasks`);
            return true;
          }

          sendError(res, 404, "Not found");
          return true;
        } catch (error) {
          sendError(res, 500, getErrorMessage(error));
          return true;
        }
      },
    });
  }

  return {
    registerTaskRoutes,
    handleHealth,
  };
}
