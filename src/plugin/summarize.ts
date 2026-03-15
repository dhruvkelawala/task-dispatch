import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execCb);

export function safeJsonParse(text: string): any {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function extractJsonObject(text: string): any {
  if (typeof text !== "string") return null;

  const direct = safeJsonParse(text.trim());
  if (direct && typeof direct === "object") return direct;

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch && fencedMatch[1]) {
    const parsed = safeJsonParse(fencedMatch[1].trim());
    if (parsed && typeof parsed === "object") return parsed;
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const parsed = safeJsonParse(text.slice(start, end + 1).trim());
    if (parsed && typeof parsed === "object") return parsed;
  }

  return null;
}

export async function fetchRepoCommits(repo: string, perPage = 10): Promise<any[]> {
  const cmd = `gh api repos/${repo}/commits?per_page=${perPage}`;
  const { stdout } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 2 });
  const parsed = safeJsonParse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error("GitHub API response was not an array");
  }
  return parsed;
}

function parseJsonArray(text: unknown): string[] {
  if (typeof text !== "string") return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export async function summarizeProject(db: any, projectRow: any, sseClients: Set<any>): Promise<any> {
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
            (c: any) =>
              `- ${c.sha} - ${c.message || "(no message)"} (${c.author || "unknown"}, ${c.date || "unknown date"})`,
          )
          .join("\n")
      : "- None";

  const taskBullets =
    completedTasks.length > 0
      ? completedTasks.map((t: any) => `- ${t.title || "(untitled)"} - ${t.status || "done"}`).join("\n")
      : "- None";

  const prompt = `You are a project tracker. Given the recent commits and completed tasks for "${project.name}" (${project.description || "No description"}), generate a JSON response:

{
  "summary": "2-3 sentence progress summary referencing actual commit messages",
  "progress_pct": 0-100,
  "blockers": ["list of blockers if any, empty array if none"]
}

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
        .filter((item: unknown) => typeof item === "string")
        .map((item: string) => item.trim())
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

  const payload = { projectId: project.id, snapshot };
  const frame = `event: project:snapshot\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(frame);
    } catch {}
  }

  return snapshot;
}

export async function runProjectSummaryTick(db: any, sseClients: Set<any>): Promise<void> {
  const projects = db.prepare("SELECT id FROM projects WHERE repo IS NOT NULL AND trim(repo) != ''").all();

  for (const project of projects) {
    try {
      await summarizeProject(db, project, sseClients);
    } catch (error: any) {
      process.stderr.write(`[PROJECT_SUMMARY] Failed for ${project.id}: ${error?.message || String(error)}\n`);
    }
  }
}
