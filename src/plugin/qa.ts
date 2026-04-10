import type { Task } from "./types";

export function collectStringValues(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out);
    return;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    collectStringValues(child, out);
  }
}

export function extractOutputFromMessages(
  messages: Array<{ role?: string; content?: unknown }>,
): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;

    const direct = msg.content;
    if (typeof direct === "string" && direct.trim()) return direct;
    const strings: string[] = [];
    collectStringValues(direct, strings);
    if (strings.length > 0) return strings.join("\n");
  }
  return "";
}

export function extractCommitHash(text: string): string | null {
  if (typeof text !== "string" || !text.trim()) return null;

  const explicit = text.match(/commit(?:\s+hash)?\s*[:`\s]+([0-9a-f]{7,40})\b/i);
  if (explicit) return explicit[1] ?? null;

  const fallback = text.match(/\b[0-9a-f]{7,40}\b/i);
  return fallback ? (fallback[0] ?? null) : null;
}

export function truncateForPrompt(text: string, maxChars: number): string {
  if (typeof text !== "string") return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated]`;
}

export function parseMaatVerdict(text: string): {
  verdict: "approve" | "request_changes";
  summary: string;
} {
  const normalized = typeof text === "string" ? text : "";
  const verdictMatch = normalized.match(/^VERDICT:\s*(APPROVE|REQUEST_CHANGES)\s*$/im);
  const summaryMatch = normalized.match(/^SUMMARY:\s*(.+)$/im);
  const verdict = verdictMatch
    ? verdictMatch[1]?.toUpperCase() === "APPROVE"
      ? "approve"
      : "request_changes"
    : "request_changes";
  const summary = summaryMatch ? (summaryMatch[1] ?? "").trim() : "No summary provided.";
  return { verdict, summary };
}

export function buildQAReviewPrompt(
  task: Partial<Task>,
  resolveCwd: (task: Partial<Task>) => string | null,
): string {
  const output = truncateForPrompt(task.output || "", 2000);
  const commitHash = extractCommitHash(task.output || "");
  const cwd = task.cwd || resolveCwd(task);
  const project = task.projectId || "unknown";

  const taskData = JSON.stringify(
    {
      id: task.id,
      title: task.title,
      agent: task.agent,
      project,
      cwd,
      commitHash: commitHash || null,
      description: task.description || null,
      agentOutput: output || null,
    },
    null,
    2,
  );

  return [
    "You are a QA engineer. Your job: verify that the implementation meets the task requirements.",
    "",
    "## Task Data",
    "```json",
    taskData,
    "```",
    "",
    "## Verification Steps",
    `Run these commands IN ORDER. All commands must be run from the project directory: \`${cwd}\``,
    "",
    "```bash",
    `cd ${cwd}`,
    "git log --oneline -3",
    commitHash ? `git show ${commitHash} --stat` : "# no commit hash available — check git log",
    "npx tsc --noEmit 2>&1 | tail -20",
    "pnpm build 2>&1 | tail -20",
    "```",
    "",
    "## Decision Criteria",
    "- APPROVE if: tsc passes, build passes, changed files align with task description",
    "- REQUEST_CHANGES if: tsc errors, build errors, or implementation doesn't match requirements",
    "- Do NOT reject for pre-existing errors unrelated to this task",
    "",
    "## Response Format (MANDATORY — no other format accepted)",
    "Your ENTIRE response must end with exactly these two lines:",
    "",
    "VERDICT: APPROVE",
    "SUMMARY: <one sentence>",
    "",
    "or",
    "",
    "VERDICT: REQUEST_CHANGES",
    "SUMMARY: <one sentence explaining what specifically needs fixing>",
  ].join("\n");
}
