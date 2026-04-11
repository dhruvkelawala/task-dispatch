import crypto from "node:crypto";
import { isValidTransition, rowToTask } from "../db";
import { normalizeTimeoutMs } from "../config";
import type { Task, TaskStatus } from "../types";
import type {
  DatabaseLike,
  HttpRequestLike,
  HttpResponseLike,
  JsonObject,
  PreparedStatementLike,
} from "../runtime-types";

export function sendJson(res: HttpResponseLike, payload: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload, null, 2));
}

export function sendError(res: HttpResponseLike, status: number, message: string): void {
  sendJson(res, { error: message }, status);
}

export async function parseBody(req: HttpRequestLike): Promise<JsonObject> {
  if (typeof req.body === "object" && req.body !== null) {
    return req.body as JsonObject;
  }
  if (!req.on) {
    return {};
  }
  const on = req.on.bind(req);
  return await new Promise<JsonObject>((resolve, reject) => {
    let body = "";
    on("data", (chunk: unknown) => {
      body += typeof chunk === "string" ? chunk : String(chunk);
    });
    on("end", () => {
      if (!body) return resolve({});
      try {
        const parsed = JSON.parse(body);
        if (typeof parsed !== "object" || parsed === null) {
          reject(new Error("JSON body must be an object"));
          return;
        }
        resolve(parsed as JsonObject);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    on("error", reject);
  });
}

export async function handleCreateTask(
  req: HttpRequestLike,
  res: HttpResponseLike,
  ctx: {
    db: DatabaseLike;
    getTask: (id: string) => unknown;
    insert: PreparedStatementLike;
    defaultTaskTimeoutMs: number;
    triggerDispatch: (taskId: string) => void;
  },
): Promise<void> {
  const body = await parseBody(req);
  if (!body.title || !body.agent) {
    sendError(res, 400, "title and agent are required");
    return;
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const dependsOn = (Array.isArray(body.dependsOn) ? body.dependsOn : []).filter(
    (depId: unknown) => typeof depId === "string" && depId.trim().length > 0,
  );

  let status: TaskStatus = "pending";
  if (dependsOn.length === 0) {
    status = "ready";
  } else {
    const placeholders = dependsOn.map(() => "?").join(",");
    const doneCount = ctx.db
      .prepare<{ c: number }>(
        `SELECT COUNT(*) as c FROM tasks WHERE id IN (${placeholders}) AND status = 'done'`,
      )
      .get(...dependsOn);
    if (doneCount && doneCount.c === dependsOn.length) status = "ready";
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
    timeout_ms: normalizeTimeoutMs(body.timeoutMs, ctx.defaultTaskTimeoutMs),
    thread_id:
      typeof body.threadId === "string" && body.threadId.trim().length > 0
        ? body.threadId.trim()
        : null,
    review_attempts: 0,
    qa_required: body.qaRequired === false ? 0 : 1,
    created_at: now,
    updated_at: now,
  };
  ctx.insert.run(row);
  const created = rowToTask(ctx.getTask(id) as Record<string, unknown> | null | undefined);
  sendJson(res, created, 201);
  if (status === "ready") ctx.triggerDispatch(id);
}

export async function handleUpdateTask(
  req: HttpRequestLike,
  res: HttpResponseLike,
  id: string,
  ctx: {
    getTask: (id: string) => unknown;
    db: DatabaseLike;
    defaultTaskTimeoutMs: number;
  },
): Promise<void> {
  const existing = ctx.getTask(id);
  if (!existing) {
    sendError(res, 404, "Task not found");
    return;
  }
  const body = await parseBody(req);
  const now = Date.now();

  const existingRow = existing as Record<string, unknown>;

  if (body.status && body.status !== existingRow.status) {
    if (!isValidTransition(existingRow.status as TaskStatus, body.status as TaskStatus)) {
      sendError(res, 400, `Invalid status transition: ${existingRow.status} → ${body.status}`);
      return;
    }
  }

  const updatableFields: Record<string, string> = {
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
  const params: Record<string, unknown> = { id, updated_at: now };
  for (const [apiField, dbCol] of Object.entries(updatableFields)) {
    if (body[apiField] !== undefined) {
      let value: unknown = body[apiField];
      if (apiField === "dependsOn") {
        const input = Array.isArray(value) ? value : [];
        const clean = input.filter(
          (depId: unknown) => typeof depId === "string" && depId.trim().length > 0,
        );
        value = JSON.stringify(clean);
      }
      if (apiField === "manualComplete") value = value ? 1 : 0;
      if (apiField === "timeoutMs") {
        value = normalizeTimeoutMs(value, ctx.defaultTaskTimeoutMs);
      }
      sets.push(`${dbCol} = @${dbCol}`);
      params[dbCol] = value;
    }
  }

  if (body.status === "ready") {
    sets.push("error = NULL");
    sets.push("retries = 0");
    sets.push("review_attempts = 0");
  }
  if (body.status === "done") {
    sets.push("completed_at = @completed_at");
    params.completed_at = now;
  }

  const sql = `UPDATE tasks SET ${sets.join(", ")} WHERE id = @id`;
  ctx.db.prepare(sql).run(params);
  const updated = ctx.getTask(id);
  sendJson(res, rowToTask(updated as Record<string, unknown> | null | undefined));
}

export function parsePath(url: string): { segments: string[] } {
  const pathname = url.split("?")[0] || "";
  const parts = pathname.split("/").filter(Boolean);
  return { segments: parts.slice(2) };
}

export function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf("?");
  if (idx === -1) return {};
  const params: Record<string, string> = {};
  const search = new URLSearchParams(url.slice(idx));
  for (const [k, v] of search) params[k] = v;
  return params;
}

export function _assertTaskShape(task: Task | null): boolean {
  return Boolean(task?.id && task?.title);
}
