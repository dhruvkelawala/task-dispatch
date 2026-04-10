import type { PluginApi } from "./types";
import type { DatabaseLike } from "./runtime-types";
import type { DbRow } from "./db";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createLifecycleRuntime(deps: {
  api: PluginApi;
  db: DatabaseLike;
  runDueSchedules: () => void;
  onTaskChanged: (taskId: string) => void;
  stderr: Pick<typeof process.stderr, "write">;
}) {
  function runScheduleTick(): void {
    deps.runDueSchedules();
  }

  async function reconcileMissingThreadIds(): Promise<void> {
    try {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const { readFileSync } = await import("node:fs");
      const bindingsPath = `${process.env.HOME}/.openclaw/discord/thread-bindings.json`;
      let bindings: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(readFileSync(bindingsPath, "utf8")) as {
          bindings?: Record<string, unknown>;
        };
        bindings = parsed.bindings || {};
      } catch {
        return;
      }

      const sessionToThread: Record<string, string> = {};
      for (const binding of Object.values(bindings)) {
        if (!binding || typeof binding !== "object") continue;
        const candidate = binding as Record<string, unknown>;
        const targetSessionKey = candidate.targetSessionKey;
        const threadId = candidate.threadId;
        if (typeof targetSessionKey === "string" && typeof threadId === "string") {
          sessionToThread[targetSessionKey] = threadId;
        }
      }

      const orphaned = deps.db
        .prepare<DbRow>(
          "SELECT id, session_key, title FROM tasks WHERE status IN ('dispatched', 'in_progress', 'blocked') AND thread_id IS NULL AND session_key IS NOT NULL",
        )
        .all();

      for (const task of orphaned) {
        const row = task as Record<string, unknown>;
        const taskId = typeof row.id === "string" ? row.id : null;
        const sessionKey = typeof row.session_key === "string" ? row.session_key : null;
        if (!taskId || !sessionKey) continue;
        const threadId = sessionToThread[sessionKey];
        if (threadId) {
          deps.db
            .prepare("UPDATE tasks SET thread_id = ?, updated_at = ? WHERE id = ?")
            .run(threadId, Date.now(), taskId);
          deps.stderr.write(
            `[DISPATCH] Reconciled threadId ${threadId} for task ${taskId} (${String(row.title || "")})\n`,
          );
          deps.onTaskChanged(taskId);
        } else {
          deps.stderr.write(
            `[DISPATCH] WARNING: active task ${taskId} (${String(row.title || "")}) has no thread binding — may be orphaned\n`,
          );
        }
      }
    } catch (error) {
      deps.stderr.write(`[DISPATCH] Startup reconciliation error: ${getErrorMessage(error)}\n`);
    }
  }

  function registerCompletionHook(): void {
    deps.api.on("subagent_ended", (event) => {
      const sessionKey = (event as { targetSessionKey?: string }).targetSessionKey;
      if (!sessionKey) return;
      const task = deps.db
        .prepare<DbRow>(
          "SELECT * FROM tasks WHERE session_key = ? AND status IN ('dispatched', 'in_progress')",
        )
        .get(sessionKey);

      if (!task) return;
      const row = task as Record<string, unknown>;
      const taskId = typeof row.id === "string" ? row.id : null;
      if (!taskId) return;

      const outcome =
        (event as { outcome?: string; reason?: string }).outcome ||
        (event as { outcome?: string; reason?: string }).reason ||
        "unknown";
      const isSuccess = outcome === "completed" || outcome === "ok";
      if (isSuccess) {
        deps.db
          .prepare(
            "UPDATE tasks SET status = 'review', updated_at = @updated_at, completed_at = NULL WHERE id = @id",
          )
          .run({ id: taskId, updated_at: Date.now() });
      } else {
        deps.db
          .prepare(
            "UPDATE tasks SET status = 'error', error = @error, retries = retries + 1, updated_at = @updated_at WHERE id = @id",
          )
          .run({
            id: taskId,
            error: (event as { error?: string }).error || outcome,
            updated_at: Date.now(),
          });
      }
      deps.onTaskChanged(taskId);
    });
  }

  return {
    runScheduleTick,
    reconcileMissingThreadIds,
    registerCompletionHook,
  };
}
