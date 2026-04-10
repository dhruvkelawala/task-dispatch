import type { PluginConfig, PluginHttpRequest, PluginHttpResponse } from "./types";
import type { DatabaseLike } from "./runtime-types";
import { parseBody, parseQuery, sendError, sendJson } from "./routes/tasks";

type HeartbeatLogRow = {
  id: number;
  agent_id: string;
  agent_name: string | null;
  status: string;
  action: string | null;
  detail: string | null;
  error: string | null;
  created_at: string;
};

type HeartbeatCheckRow = {
  id: number;
  heartbeat_id: number;
  check_type: string;
  result: string | null;
  detail: string | null;
  created_at: string;
};

type HeartbeatCheckPayload = {
  type: string;
  result: string | null;
  detail: string | null;
};

function parseHeartbeatCreatedAtMs(createdAt: string | null | undefined): number | null {
  if (typeof createdAt !== "string" || !createdAt.trim()) {
    return null;
  }
  const iso = `${createdAt.replace(" ", "T")}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeHeartbeatChecks(checks: unknown): HeartbeatCheckPayload[] {
  if (!Array.isArray(checks)) {
    return [];
  }

  return checks
    .map((check) => {
      if (!check || typeof check !== "object") {
        return null;
      }
      const candidate = check as Record<string, unknown>;
      const type = typeof candidate.type === "string" ? candidate.type.trim() : "";
      if (!type) {
        return null;
      }
      return {
        type,
        result:
          typeof candidate.result === "string" && candidate.result.trim()
            ? candidate.result.trim()
            : null,
        detail:
          typeof candidate.detail === "string" && candidate.detail.trim()
            ? candidate.detail.trim()
            : null,
      };
    })
    .filter((value): value is HeartbeatCheckPayload => value !== null);
}

export function createHeartbeatRuntime(deps: { db: DatabaseLike; config: PluginConfig }) {
  async function handleCreateHeartbeat(
    req: PluginHttpRequest,
    res: PluginHttpResponse,
  ): Promise<void> {
    const body = await parseBody(req);
    const agentId = typeof body.agentId === "string" ? body.agentId.trim().toLowerCase() : "";
    const agentName =
      typeof body.agentName === "string" && body.agentName.trim() ? body.agentName.trim() : null;
    const status = typeof body.status === "string" ? body.status.trim() : "";
    const action =
      typeof body.action === "string" && body.action.trim() ? body.action.trim() : null;
    const detail =
      typeof body.detail === "string" && body.detail.trim() ? body.detail.trim() : null;
    const error = typeof body.error === "string" && body.error.trim() ? body.error.trim() : null;

    if (!agentId) {
      sendError(res, 400, "agentId is required");
      return;
    }
    if (!["success", "no_work", "error"].includes(status)) {
      sendError(res, 400, "status must be one of: success, no_work, error");
      return;
    }

    const checks = normalizeHeartbeatChecks(body.checks);
    const insertLog = deps.db.prepare(
      `INSERT INTO heartbeat_logs (agent_id, agent_name, status, action, detail, error)
       VALUES (@agent_id, @agent_name, @status, @action, @detail, @error)`,
    );
    const insertCheck = deps.db.prepare(
      `INSERT INTO heartbeat_tasks (heartbeat_id, check_type, result, detail)
       VALUES (@heartbeat_id, @check_type, @result, @detail)`,
    );
    const getCreated = deps.db.prepare<{ id: number; created_at: string }>(
      "SELECT id, created_at FROM heartbeat_logs WHERE id = ?",
    );

    const transaction = deps.db.transaction?.(() => {
      const result = insertLog.run({
        agent_id: agentId,
        agent_name: agentName,
        status,
        action,
        detail,
        error,
      }) as { lastInsertRowid: number | bigint };
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
    });

    const created = transaction ? transaction() : null;
    sendJson(res, created || { id: null, created_at: null }, 201);
  }

  function handleListHeartbeats(req: PluginHttpRequest, res: PluginHttpResponse): void {
    const query = parseQuery(req.url || "");
    const requestedLimit = Number.parseInt(query.limit || "", 10);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 20;
    const agentFilter =
      typeof query.agent === "string" && query.agent.trim()
        ? query.agent.trim().toLowerCase()
        : null;

    const conditions: string[] = [];
    const params: Record<string, string | number> = { limit };
    if (agentFilter) {
      conditions.push("agent_id = @agent");
      params.agent = agentFilter;
    }

    let logsSql = "SELECT * FROM heartbeat_logs";
    if (conditions.length > 0) {
      logsSql += ` WHERE ${conditions.join(" AND ")}`;
    }
    logsSql += " ORDER BY id DESC LIMIT @limit";

    const logs = deps.db.prepare<HeartbeatLogRow>(logsSql).all(params);
    if (logs.length === 0) {
      sendJson(res, []);
      return;
    }

    const placeholders = logs.map(() => "?").join(",");
    const checks = deps.db
      .prepare<HeartbeatCheckRow>(
        `SELECT * FROM heartbeat_tasks WHERE heartbeat_id IN (${placeholders}) ORDER BY id ASC`,
      )
      .all(...logs.map((log) => log.id));

    const checksByHeartbeatId = new Map<number, HeartbeatCheckRow[]>();
    for (const check of checks) {
      const list = checksByHeartbeatId.get(check.heartbeat_id) || [];
      list.push(check);
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
        checks:
          checksByHeartbeatId.get(log.id)?.map((check) => ({
            id: check.id,
            heartbeatId: check.heartbeat_id,
            type: check.check_type,
            result: check.result,
            detail: check.detail,
            createdAt: check.created_at,
          })) || [],
      })),
    );
  }

  function handleHeartbeatsHealth(res: PluginHttpResponse): void {
    const latestRows = deps.db
      .prepare<HeartbeatLogRow>(
        `SELECT hl.id, hl.agent_id, hl.agent_name, hl.created_at, hl.status, hl.action, hl.detail, hl.error
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
      ...Object.keys(deps.config.agents || {}),
      ...latestRows.map((row) => row.agent_id),
    ]);

    const latestByAgent = new Map<string, HeartbeatLogRow>();
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
          createdAtMs == null ? null : Math.max(0, Math.floor((nowMs - createdAtMs) / 60_000));

        let status = "DEAD";
        if (minutesAgo != null) {
          if (minutesAgo < 120) status = "ALIVE";
          else if (minutesAgo < 240) status = "STALE";
        }

        const configuredName = deps.config.agents?.[agentId]?.name;
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

  return {
    handleCreateHeartbeat,
    handleListHeartbeats,
    handleHeartbeatsHealth,
  };
}
