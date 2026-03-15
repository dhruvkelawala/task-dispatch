import { parseBody, sendError, sendJson } from "./tasks";
import { fetchRepoCommits, summarizeProject } from "../summarize";

function parseJsonArray(text: unknown): string[] {
  if (typeof text !== "string") return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function rowToProjectCommit(row: any) {
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

function rowToProject(row: any) {
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
    linkedTasksCount: Number(row.linked_tasks_count || 0),
    latestSnapshot: row.snapshot_id
      ? {
          id: row.snapshot_id,
          summary: row.snapshot_summary,
          progressPct: row.snapshot_progress_pct,
          blockers: parseJsonArray(row.snapshot_blockers),
          generatedAt: row.snapshot_generated_at,
          model: row.snapshot_model,
        }
      : null,
    lastCommit: row.commit_sha
      ? {
          sha: row.commit_sha,
          message: row.commit_message,
          author: row.commit_author,
          date: row.commit_date,
          branch: row.commit_branch,
        }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listProjectsWithDetails(db: any) {
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

function getProjectWithDetails(db: any, id: string) {
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

export function registerProjectRoutes(api: any, ctx: { db: any; sseClients: Set<any>; requireApiKey: (req: any, res: any) => boolean }): void {
  api.registerHttpRoute({
    path: "/api/projects",
    match: "prefix",
    auth: "plugin",
    handler: async (req: any, res: any) => {
      try {
        const pathname = (req.url || "").split("?")[0] || "";
        const parts = pathname.split("/").filter(Boolean);
        const segments = parts.slice(2);
        const method = req.method?.toUpperCase() || "GET";

        if (segments.length === 0) {
          if (method === "GET") {
            const rows = listProjectsWithDetails(ctx.db);
            sendJson(res, rows.map(rowToProject));
            return true;
          }
          sendError(res, 405, `Method ${method} not allowed on /api/projects`);
          return true;
        }

        if (segments.length === 1) {
          const id = segments[0];
          if (method === "GET") {
            const row = getProjectWithDetails(ctx.db, id);
            if (!row) {
              sendError(res, 404, "Project not found");
              return true;
            }

            const tasks = ctx.db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC").all(id);
            sendJson(res, {
              ...rowToProject(row),
              tasks,
            });
            return true;
          }
          if (method === "PATCH") {
            if (!ctx.requireApiKey(req, res)) return true;
            const existing = ctx.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
            if (!existing) {
              sendError(res, 404, "Project not found");
              return true;
            }

            const body = await parseBody(req);
            const allowedFields: Record<string, string> = {
              priority: "priority",
              status: "status",
              description: "description",
              tags: "tags",
            };

            const setClauses = ["updated_at = datetime('now')"];
            const params: Record<string, unknown> = { id };

            for (const [apiField, dbField] of Object.entries(allowedFields)) {
              if (body[apiField] === undefined) continue;
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

            if (setClauses.length > 1) {
              ctx.db.prepare(`UPDATE projects SET ${setClauses.join(", ")} WHERE id = @id`).run(params);
            }
            const updated = rowToProject(getProjectWithDetails(ctx.db, id));
            sendJson(res, updated);

            const payload = { projectId: id, project: updated };
            const frame = `event: project:updated\ndata: ${JSON.stringify(payload)}\n\n`;
            for (const client of ctx.sseClients) {
              try {
                client.write(frame);
              } catch {}
            }
            return true;
          }
          sendError(res, 405, `Method ${method} not allowed on /api/projects/:id`);
          return true;
        }

        if (segments.length === 2 && segments[1] === "commits") {
          const id = segments[0];
          if (method === "GET") {
            const project = ctx.db.prepare("SELECT id FROM projects WHERE id = ?").get(id);
            if (!project) {
              sendError(res, 404, "Project not found");
              return true;
            }
            const rows = ctx.db
              .prepare("SELECT * FROM project_commits WHERE project_id = ? ORDER BY date DESC, id DESC LIMIT 20")
              .all(id);
            sendJson(res, rows.map(rowToProjectCommit));
            return true;
          }
          sendError(res, 405, `Method ${method} not allowed on /api/projects/:id/commits`);
          return true;
        }

        if (segments.length === 2 && segments[1] === "refresh") {
          const id = segments[0];
          if (method === "POST") {
            if (!ctx.requireApiKey(req, res)) return true;
            const project = ctx.db.prepare("SELECT id, repo, branch FROM projects WHERE id = ?").get(id);
            if (!project) {
              sendError(res, 404, "Project not found");
              return true;
            }
            if (!project.repo) {
              sendError(res, 400, "Project does not have a linked repository");
              return true;
            }

            let commits: any[] = [];
            try {
              commits = await fetchRepoCommits(project.repo, 10);
            } catch (error: any) {
              sendError(res, 502, `GitHub refresh failed: ${error?.message || String(error)}`);
              return true;
            }

            const insertCommit = ctx.db.prepare(`
              INSERT OR IGNORE INTO project_commits (project_id, sha, message, author, date, branch)
              VALUES (@project_id, @sha, @message, @author, @date, @branch)
            `);

            const newlyInserted: any[] = [];
            const insertMany = ctx.db.transaction((rows: any[]) => {
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
              const payload = { projectId: id, commits: newlyInserted };
              const frame = `event: project:commits\ndata: ${JSON.stringify(payload)}\n\n`;
              for (const client of ctx.sseClients) {
                try {
                  client.write(frame);
                } catch {}
              }
            }
            return true;
          }
          sendError(res, 405, `Method ${method} not allowed on /api/projects/:id/refresh`);
          return true;
        }

        if (segments.length === 2 && segments[1] === "summarize") {
          const id = segments[0];
          if (method === "POST") {
            if (!ctx.requireApiKey(req, res)) return true;
            const project = ctx.db.prepare("SELECT id, repo FROM projects WHERE id = ?").get(id);
            if (!project) {
              sendError(res, 404, "Project not found");
              return true;
            }
            if (!project.repo) {
              sendError(res, 400, "Project does not have a linked repository");
              return true;
            }

            try {
              const snapshot = await summarizeProject(ctx.db, { id }, ctx.sseClients);
              sendJson(res, { projectId: id, snapshot });
            } catch (error: any) {
              sendError(res, 500, `Project summarize failed: ${error?.message || String(error)}`);
            }
            return true;
          }
          sendError(res, 405, `Method ${method} not allowed on /api/projects/:id/summarize`);
          return true;
        }

        sendError(res, 404, "Not found");
        return true;
      } catch (e: any) {
        sendError(res, 500, e?.message || String(e));
        return true;
      }
    },
  });
}
