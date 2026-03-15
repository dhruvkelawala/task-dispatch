import crypto from "node:crypto";
import { isValidTransition, rowToTask } from "../db";
import { normalizeTimeoutMs } from "../config";
import type { Task, TaskStatus } from "../types";

export function sendJson(res: any, payload: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload, null, 2));
}

export function sendError(res: any, status: number, message: string): void {
  sendJson(res, { error: message }, status);
}

export async function parseBody(req: any): Promise<Record<string, any>> {
  if (typeof req?.body === "object" && req.body !== null) return req.body;
  return await new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export async function handleCreateTask(
  req: any,
  res: any,
  ctx: {
    db: any;
    getTask: (id: string) => any;
    insert: any;
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
  const dependsOn = (body.dependsOn || []).filter(
    (depId: unknown) => typeof depId === "string" && depId.trim().length > 0,
  );

  let status: TaskStatus = "pending";
  if (dependsOn.length === 0) {
    status = "ready";
  } else {
    const placeholders = dependsOn.map(() => "?").join(",");
    const doneCount = ctx.db
      .prepare(`SELECT COUNT(*) as c FROM tasks WHERE id IN (${placeholders}) AND status = 'done'`)
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
    review_attempts: 0,
    qa_required: body.qaRequired === false ? 0 : 1,
    created_at: now,
    updated_at: now,
  };
  ctx.insert.run(row);
  const created = rowToTask(ctx.getTask(id));
  sendJson(res, created, 201);
  if (status === "ready") ctx.triggerDispatch(id);
}

export async function handleUpdateTask(
  req: any,
  res: any,
  id: string,
  ctx: { getTask: (id: string) => any; db: any; defaultTaskTimeoutMs: number },
): Promise<void> {
  const existing = ctx.getTask(id);
  if (!existing) {
    sendError(res, 404, "Task not found");
    return;
  }
  const body = await parseBody(req);
  const now = Date.now();

  if (body.status && body.status !== existing.status) {
    if (!isValidTransition(existing.status as TaskStatus, body.status as TaskStatus)) {
      sendError(res, 400, `Invalid status transition: ${existing.status} → ${body.status}`);
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
  const params: Record<string, any> = { id, updated_at: now };
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
  sendJson(res, rowToTask(updated));
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
