#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";

const defaultBase = "http://localhost:18789";
const defaultApiKey = "24b1b4e5472806f373c62c49cfe119d6";
const discordGuildId = "1475480367166128354";
const configPath = `${process.env.HOME || "/Users/sumo-deus"}/.openclaw/data/task-dispatch-config.json`;

type DispatchConfig = {
  projects?: Record<string, { cwd?: string; channel?: string; defaultAgent?: string }>;
  agents?: Record<string, { runtime?: string; model?: string }>;
  defaults?: { defaultCwd?: string; taskTimeoutMs?: number; reviewTimeoutMs?: number };
};

type ProjectEntry = {
  key: string;
  cwd: string;
  channel: string;
  defaultAgent: string;
};

function base(): string {
  return process.env.DISPATCH_URL || defaultBase;
}

function apiKey(): string {
  return process.env.DISPATCH_API_KEY || defaultApiKey;
}

async function doReq(method: string, path: string, body: unknown): Promise<{ data: string; status: number }> {
  const headers: Record<string, string> = {
    "X-Api-Key": apiKey(),
  };
  if (body != null) headers["Content-Type"] = "application/json";
  const resp = await fetch(`${base()}${path}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { data: await resp.text(), status: resp.status };
}

function loadConfig(): DispatchConfig {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as DispatchConfig;
  } catch (err) {
    fail(`Failed to read dispatch config at ${configPath}: ${(err as Error).message}`);
  }
}

const config = loadConfig();

function projectEntries(): ProjectEntry[] {
  return Object.entries(config.projects || {}).map(([key, value]) => ({
    key,
    cwd: value.cwd || "-",
    channel: value.channel || "-",
    defaultAgent: value.defaultAgent || "zeus",
  }));
}

function projectAliasMap(): Record<string, string> {
  const entries = projectEntries();
  const aliases: Record<string, string> = {};
  for (const entry of entries) {
    aliases[entry.key] = entry.key;
  }
  if (aliases["mission-control"]) aliases.mc = "mission-control";
  if (aliases["0xready"]) aliases.oxr = "0xready";
  if (aliases["argentx"]) aliases.multichain = "argentx";
  return aliases;
}

const projectAliases = projectAliasMap();

function availableProjectsText(): string {
  const entries = projectEntries();
  if (entries.length === 0) return "(no projects configured)";
  return entries
    .map((entry) => `- ${entry.key} → ${entry.cwd}${entry.channel !== "-" ? ` | channel ${entry.channel}` : ""}`)
    .join("\n");
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

function suggestProjects(input: string): string[] {
  const normalized = (input || "").trim().toLowerCase();
  return projectEntries()
    .map((entry) => ({ key: entry.key, score: levenshtein(normalized, entry.key.toLowerCase()) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .map((entry) => entry.key);
}

function resolveProject(input: string): ProjectEntry | null {
  const normalized = (input || "").trim();
  if (!normalized) return null;
  const canonical = projectAliases[normalized] || normalized;
  const match = projectEntries().find((entry) => entry.key === canonical);
  return match || null;
}

async function fetchTasks(): Promise<Array<Record<string, unknown>>> {
  const { data, status } = await doReq("GET", "/api/tasks", null);
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  return JSON.parse(data) as Array<Record<string, unknown>>;
}

async function fetchTaskEvents(id: string, order: "asc" | "desc" = "desc", limit = 100): Promise<Array<Record<string, unknown>>> {
  const resolvedId = await resolveTaskId(id);
  const qs = new URLSearchParams({ order, limit: String(limit) });
  const { data, status } = await doReq("GET", `/api/tasks/${resolvedId}/events?${qs.toString()}`, null);
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  return JSON.parse(data) as Array<Record<string, unknown>>;
}

async function resolveTaskId(input: string): Promise<string> {
  const id = (input || "").trim();
  if (!id) fail("Task ID is required");
  if (id.length > 8) return id;
  const tasks = await fetchTasks();
  const matches = tasks.filter((task) => String(task.id || "").startsWith(id));
  if (matches.length === 1) return String(matches[0]?.id || id);
  if (matches.length > 1) {
    fail(
      `Ambiguous short task ID \"${id}\". Matches:\n${matches
        .map((task) => `- ${String(task.id || "")}  ${String(task.title || "")}`)
        .join("\n")}`,
    );
  }
  return id;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function short(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 3)}...`;
}

function formatTime(v: unknown): string {
  if (v && typeof v === "object") {
    const maybe = v as Record<string, unknown>;
    if ("updated_at" in maybe) return formatTime(maybe.updated_at);
    if ("updatedAt" in maybe) return formatTime(maybe.updatedAt);
  }
  if (typeof v === "number") {
    const ms = v > 1e12 ? v : v * 1000;
    return new Date(ms).toLocaleString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "short",
      hour12: false,
    }).replace(",", "");
  }
  if (typeof v === "string") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "short",
        hour12: false,
      }).replace(",", "");
    }
    return v;
  }
  return "-";
}

function prettyPrint(data: string): void {
  try {
    const parsed = JSON.parse(data);
    process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
  } catch {
    process.stdout.write(`${data}\n`);
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function formatThreadUrl(threadId: string): string {
  return `https://discord.com/channels/${discordGuildId}/${threadId}`;
}

function cwdMatchesProject(cwd: string, project: ProjectEntry | null): boolean {
  if (!cwd || !project || project.cwd === "-") return true;
  return cwd === project.cwd;
}

function parseArgs(argv: string[]): Record<string, string | boolean | string[]> {
  const parsed: Record<string, string | boolean | string[]> = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] || "";
    if (!arg.startsWith("--")) {
      (parsed._ as string[]).push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    i += 1;
  }
  return parsed;
}

function statusLabel(status: string): string {
  switch (status) {
    case "done":
      return "✅ done";
    case "error":
      return "❌ error";
    case "blocked":
      return "🚫 blocked";
    case "in_progress":
      return "🔄 in_progress";
    case "dispatched":
      return "📤 dispatched";
    case "ready":
      return "⏳ ready";
    case "review":
      return "👀 review";
    default:
      return status;
  }
}

async function cmdCreate(args: string[]): Promise<void> {
  const payload: Record<string, unknown> = {
    agent: "zeus",
    qaRequired: true,
    timeoutMs: Number(config.defaults?.taskTimeoutMs || 1800000),
  };

  let title = "";
  let desc = "";
  let selectedProject: ProjectEntry | null = null;
  let dryRun = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    switch (arg) {
      case "-t":
      case "--title":
        i += 1;
        title = args[i] || "";
        break;
      case "-d":
      case "--desc":
      case "--description":
        i += 1;
        desc = args[i] || "";
        break;
      case "-a":
      case "--agent":
        i += 1;
        payload.agent = args[i] || "zeus";
        break;
      case "-p":
      case "--project": {
        i += 1;
        const p = args[i] || "";
        const resolved = resolveProject(p);
        if (!resolved) {
          const suggestions = suggestProjects(p);
          fail(
            `Unknown project: ${p}\n${suggestions.length ? `Did you mean: ${suggestions.join(", ")}?\n\n` : "\n"}Available projects:\n${availableProjectsText()}\n\nTip: run \`dispatch projects\` to inspect configured projects.`,
          );
        }
        selectedProject = resolved;
        payload.cwd = resolved.cwd !== "-" ? resolved.cwd : undefined;
        payload.projectId = resolved.key;
        if (resolved.defaultAgent) payload.agent = resolved.defaultAgent;
        break;
      }
      case "-c":
      case "--category":
        i += 1;
        payload.category = args[i] || "";
        break;
      case "--cwd":
        i += 1;
        payload.cwd = args[i] || "";
        break;
      case "--timeout": {
        i += 1;
        let ms = Number(args[i] || "0");
        if (ms < 10000) ms *= 1000;
        payload.timeoutMs = ms;
        break;
      }
      case "--no-qa":
        payload.qaRequired = false;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--model":
        i += 1;
        payload.model = args[i] || "";
        break;
      case "--thinking":
        i += 1;
        payload.thinking = args[i] || "";
        break;
      case "-T":
      case "--thread":
        i += 1;
        if (!(args[i] || "").trim()) fail("--thread requires a Discord thread ID");
        payload.threadId = (args[i] || "").trim();
        break;
      case "-f":
      case "--file":
        i += 1;
        try {
          desc = readFileSync(args[i] || "", "utf8");
        } catch (err) {
          fail(`Error reading file: ${(err as Error).message}`);
        }
        break;
      case "--depends-on":
      case "--after": {
        i += 1;
        const depIds = (args[i] || "").split(",").map((s) => s.trim()).filter(Boolean);
        if (depIds.length === 0) fail("--depends-on requires at least one task ID");
        const existing = (payload.dependsOn as string[] | undefined) || [];
        payload.dependsOn = [...existing, ...depIds];
        break;
      }
      default:
        if (!title) title = arg;
        else if (!desc) desc = arg;
    }
  }

  if (!title) {
    fail(
      "Usage: dispatch create -t \"title\" -d \"description\" -p project [-a agent] [-c category] [--no-qa] [--timeout ms]",
    );
  }

  if (!payload.projectId) {
    fail(
      "Error: --project (-p) is required. Tasks without a project land in the wrong channel.\n\n" +
      `Available projects:\n${availableProjectsText()}\n\n` +
      "Tip: run `dispatch projects` to inspect configured projects.",
    );
  }

  payload.title = title;
  if (desc) payload.description = desc;

  if (typeof payload.cwd === "string" && !cwdMatchesProject(String(payload.cwd), selectedProject)) {
    fail(
      `CWD/project mismatch.\nSelected project: ${selectedProject?.key || "-"}\nProject cwd: ${selectedProject?.cwd || "-"}\nProvided cwd: ${String(payload.cwd)}\n\nUse the matching project or override intentionally with the correct project key.`,
    );
  }

  if (dryRun) {
    process.stdout.write("DRY RUN — no task created\n");
    process.stdout.write(`Project: ${String(payload.projectId || "-")}\n`);
    process.stdout.write(`CWD: ${String(payload.cwd || "-")}\n`);
    process.stdout.write(`Agent: ${String(payload.agent || "-")}\n`);
    process.stdout.write(`QA: ${payload.qaRequired ? "on" : "off"}\n`);
    process.stdout.write(`TimeoutMs: ${String(payload.timeoutMs || "-")}\n`);
    return;
  }

  const { data, status } = await doReq("POST", "/api/tasks", payload);
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  const result = JSON.parse(data) as Record<string, unknown>;
  process.stdout.write(`✅ Created task ${short(String(result.id || ""))}\n`);
  if (payload.projectId) process.stdout.write(`Project: ${String(payload.projectId)}\n`);
  if (payload.cwd) process.stdout.write(`CWD: ${String(payload.cwd)}\n`);
  if (payload.agent) process.stdout.write(`Agent: ${String(payload.agent)}\n`);
  prettyPrint(data);
}

async function cmdList(args: string[] = []): Promise<void> {
  const parsed = parseArgs(args);
  const qs = new URLSearchParams();
  if (typeof parsed.status === "string") qs.set("status", parsed.status);
  if (typeof parsed.project === "string") {
    const resolved = resolveProject(parsed.project);
    qs.set("projectId", resolved?.key || parsed.project);
  }
  const { data, status } = await doReq("GET", `/api/tasks${qs.toString() ? `?${qs.toString()}` : ""}`, null);
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  const tasks = JSON.parse(data) as Array<Record<string, unknown>>;
  if (tasks.length === 0) {
    process.stdout.write("No tasks.\n");
    return;
  }

  const rows = tasks.map((t) => {
    const deps = Array.isArray(t.depends_on)
      ? t.depends_on
      : typeof t.depends_on === "string"
        ? JSON.parse(t.depends_on || "[]")
        : Array.isArray(t.dependsOn)
          ? t.dependsOn
          : [];
    return {
      id: short(String(t.id || "")),
      status: statusLabel(String(t.status || "")),
      agent: String(t.agent || ""),
      project: String(t.projectId || t.project_id || "-"),
      title: truncate(String(t.title || ""), 50),
      deps: deps.length > 0 ? deps.map((d: string) => short(d)).join(",") : "",
      created: formatTime(t.createdAt || t.created_at),
      updated: formatTime(t.updatedAt || t.updated_at),
    };
  });

  const widths = {
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
    agent: Math.max(5, ...rows.map((r) => r.agent.length)),
    project: Math.max(7, ...rows.map((r) => r.project.length)),
    title: Math.max(5, ...rows.map((r) => r.title.length)),
    deps: Math.max(4, ...rows.map((r) => r.deps.length)),
  };

  const showDeps = rows.some((r) => r.deps.length > 0);

  const header = showDeps
    ? `${pad("ID", widths.id)}  ${pad("STATUS", widths.status)}  ${pad("AGENT", widths.agent)}  ${pad("PROJECT", widths.project)}  ${pad("DEPS", widths.deps)}  ${pad("TITLE", widths.title)}  UPDATED\n`
    : `${pad("ID", widths.id)}  ${pad("STATUS", widths.status)}  ${pad("AGENT", widths.agent)}  ${pad("PROJECT", widths.project)}  ${pad("TITLE", widths.title)}  UPDATED\n`;
  process.stdout.write(header);

  for (const row of rows) {
    const line = showDeps
      ? `${pad(row.id, widths.id)}  ${pad(row.status, widths.status)}  ${pad(row.agent, widths.agent)}  ${pad(row.project, widths.project)}  ${pad(row.deps, widths.deps)}  ${pad(row.title, widths.title)}  ${row.updated}\n`
      : `${pad(row.id, widths.id)}  ${pad(row.status, widths.status)}  ${pad(row.agent, widths.agent)}  ${pad(row.project, widths.project)}  ${pad(row.title, widths.title)}  ${row.updated}\n`;
    process.stdout.write(line);
  }
}

async function cmdGet(id: string): Promise<void> {
  if (!id) fail("Usage: dispatch get <task-id>");
  const resolvedId = await resolveTaskId(id);
  const { data, status } = await doReq("GET", `/api/tasks/${resolvedId}`, null);
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  prettyPrint(data);
}

async function cmdPrompt(args: string[]): Promise<void> {
  const id = args[0];
  if (!id || args.length < 2) {
    fail("Usage: dispatch prompt <task-id> \"message\"\n       dispatch prompt <task-id> -f message.md");
  }
  let message = "";
  if (args[1] === "-f" && args[2]) {
    try {
      message = readFileSync(args[2], "utf8");
    } catch (err) {
      fail(`Error reading file: ${(err as Error).message}`);
    }
  } else {
    message = args.slice(1).join(" ");
  }
  const resolvedId = await resolveTaskId(id);
  const { data, status } = await doReq("POST", `/api/tasks/${resolvedId}/prompt`, { message });
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  let runId = "";
  let threadId = "";
  let threadUrl = "";
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    runId = typeof parsed.runId === "string" ? parsed.runId : "";
    threadId = typeof parsed.threadId === "string" ? parsed.threadId : "";
    threadUrl = typeof parsed.threadUrl === "string"
      ? parsed.threadUrl
      : threadId
        ? `https://discord.com/channels/${discordGuildId}/${threadId}`
        : "";
  } catch {
    // Keep backward compatibility with non-JSON responses.
  }
  process.stdout.write(`✅ Prompt sent to task ${short(resolvedId)}\n`);
  if (runId) process.stdout.write(`Run ID: ${runId}\n`);
  if (threadUrl) process.stdout.write(`Thread: ${threadUrl}\n`);
  prettyPrint(data);
}

async function cmdUpdate(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) fail("Usage: dispatch update <task-id> --status <status> [--error \"reason\"]");
  const payload: Record<string, unknown> = {};
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--status" || args[i] === "-s") {
      i += 1;
      payload.status = args[i] || "";
    } else if (args[i] === "--error" || args[i] === "-e") {
      i += 1;
      payload.error = args[i] || "";
    }
  }
  const resolvedId = await resolveTaskId(id);
  const { data, status } = await doReq("PATCH", `/api/tasks/${resolvedId}`, payload);
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  process.stdout.write(`✅ Updated task ${short(resolvedId)}\n`);
}

async function cmdDelete(id: string): Promise<void> {
  if (!id) fail("Usage: dispatch delete <task-id>");
  const resolvedId = await resolveTaskId(id);
  const { data, status } = await doReq("DELETE", `/api/tasks/${resolvedId}`, null);
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  process.stdout.write(`🗑️  Deleted task ${short(resolvedId)}\n`);
}

async function cmdStats(): Promise<void> {
  const { data, status } = await doReq("GET", "/api/tasks/stats", null);
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  prettyPrint(data);
}

async function cmdHistory(args: string[] = []): Promise<void> {
  const parsed = parseArgs(args);
  const qs = new URLSearchParams();
  if (typeof parsed.project === "string") {
    const resolved = resolveProject(parsed.project);
    qs.set("projectId", resolved?.key || parsed.project);
  }
  if (typeof parsed.status === "string") qs.set("status", parsed.status);
  const { data, status } = await doReq("GET", `/api/tasks${qs.toString() ? `?${qs.toString()}` : ""}`, null);
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  const tasks = (JSON.parse(data) as Array<Record<string, unknown>>)
    .filter((task) => ["done", "error", "blocked"].includes(String(task.status || "")))
    .sort((a, b) => Number(b.updatedAt || b.updated_at || 0) - Number(a.updatedAt || a.updated_at || 0));
  if (tasks.length === 0) {
    process.stdout.write("No historical tasks found.\n");
    return;
  }
  for (const task of tasks.slice(0, Number(parsed.limit || 20))) {
    const threadId = String(task.threadId || task.thread_id || "");
    process.stdout.write(`${short(String(task.id || ""))}  ${statusLabel(String(task.status || ""))}  ${String(task.projectId || task.project_id || "-")}  ${String(task.title || "")}\n`);
    process.stdout.write(`  updated: ${formatTime(task.updatedAt || task.updated_at)} | agent: ${String(task.agent || "-")}\n`);
    if (threadId) process.stdout.write(`  thread: ${formatThreadUrl(threadId)}\n`);
    if (task.error) process.stdout.write(`  error: ${truncate(String(task.error), 220)}\n`);
  }
}

async function cmdActive(args: string[] = []): Promise<void> {
  const parsed = parseArgs(args);
  const tasks = await fetchTasks();
  const active = tasks
    .filter((task) => ["ready", "dispatched", "in_progress", "review"].includes(String(task.status || "")))
    .filter((task) => (typeof parsed.project === "string" ? String(task.projectId || task.project_id || "") === (resolveProject(parsed.project)?.key || parsed.project) : true))
    .sort((a, b) => Number(b.updatedAt || b.updated_at || 0) - Number(a.updatedAt || a.updated_at || 0));
  if (active.length === 0) {
    process.stdout.write("No active tasks.\n");
    return;
  }
  for (const task of active) {
    process.stdout.write(`${short(String(task.id || ""))}  ${statusLabel(String(task.status || ""))}  ${String(task.projectId || task.project_id || "-")}  ${String(task.title || "")}\n`);
    process.stdout.write(`  updated: ${formatTime(task.updatedAt || task.updated_at)} | agent: ${String(task.agent || "-")}\n`);
    if (task.threadId || task.thread_id) process.stdout.write(`  thread: ${formatThreadUrl(String(task.threadId || task.thread_id))}\n`);
  }
}

async function cmdRecentErrors(args: string[] = []): Promise<void> {
  const parsed = parseArgs(args);
  const tasks = await fetchTasks();
  const errors = tasks
    .filter((task) => ["error", "blocked"].includes(String(task.status || "")))
    .filter((task) => (typeof parsed.project === "string" ? String(task.projectId || task.project_id || "") === (resolveProject(parsed.project)?.key || parsed.project) : true))
    .sort((a, b) => Number(b.updatedAt || b.updated_at || 0) - Number(a.updatedAt || a.updated_at || 0))
    .slice(0, Number(parsed.limit || 10));
  if (errors.length === 0) {
    process.stdout.write("No recent errors.\n");
    return;
  }
  for (const task of errors) {
    process.stdout.write(`${short(String(task.id || ""))}  ${statusLabel(String(task.status || ""))}  ${String(task.projectId || task.project_id || "-")}  ${String(task.title || "")}\n`);
    process.stdout.write(`  error: ${truncate(String(task.error || ""), 220)}\n`);
  }
}

async function cmdLogs(id: string): Promise<void> {
  const events = await fetchTaskEvents(id, "desc", 50);
  if (events.length === 0) {
    process.stdout.write("No task events found.\n");
    return;
  }
  for (const event of events) {
    process.stdout.write(`[${formatTime(event.createdAt || event.created_at)}] ${String(event.eventType || event.event_type)}\n`);
    if (event.payload) process.stdout.write(`  ${JSON.stringify(event.payload)}\n`);
  }
}

async function cmdTimeline(id: string): Promise<void> {
  const events = await fetchTaskEvents(id, "asc", 100);
  if (events.length === 0) {
    process.stdout.write("No task events found.\n");
    return;
  }
  for (const event of events) {
    const payload = (event.payload || {}) as Record<string, unknown>;
    const bits = [
      payload.status ? `status=${String(payload.status)}` : "",
      payload.threadId ? `thread=${String(payload.threadId)}` : "",
      payload.runId ? `run=${String(payload.runId)}` : "",
      payload.model ? `model=${String(payload.model)}` : "",
      payload.summary ? `summary=${String(payload.summary)}` : "",
    ].filter(Boolean);
    process.stdout.write(`[${formatTime(event.createdAt || event.created_at)}] ${String(event.eventType || event.event_type)}${bits.length ? ` — ${bits.join(" | ")}` : ""}\n`);
  }
}

async function cmdResume(id: string): Promise<void> {
  if (!id) fail("Usage: dispatch resume <task-id>");
  const resolvedId = await resolveTaskId(id);
  const { data, status } = await doReq("POST", `/api/tasks/${resolvedId}/resume`, {});
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  process.stdout.write(`🔄 Resume triggered for task ${short(resolvedId)}\n`);
  prettyPrint(data);
}

async function cmdOpen(id: string): Promise<void> {
  const resolvedId = await resolveTaskId(id);
  const { data, status } = await doReq("GET", `/api/tasks/${resolvedId}`, null);
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  const task = JSON.parse(data) as Record<string, unknown>;
  const threadId = String(task.threadId || "");
  if (!threadId) fail(`Task ${resolvedId} has no Discord thread.`);
  process.stdout.write(`${formatThreadUrl(threadId)}\n`);
}

async function cmdDoctor(): Promise<void> {
  process.stdout.write("dispatch doctor\n\n");
  process.stdout.write(`Config: ${existsSync(configPath) ? "ok" : "missing"} (${configPath})\n`);
  process.stdout.write(`Projects configured: ${projectEntries().length}\n`);
  for (const project of projectEntries()) {
    const cwdOk = project.cwd === "-" ? "n/a" : existsSync(project.cwd) ? "ok" : "missing";
    process.stdout.write(`- ${project.key}: cwd=${cwdOk} channel=${project.channel} agent=${project.defaultAgent}\n`);
  }
  const { data, status } = await doReq("GET", "/api/dispatch/health", null);
  if (status >= 400) fail(`Health check failed (${status}): ${data}`);
  process.stdout.write("Plugin health: ok\n");
  const tasks = await fetchTasks();
  const recentErrors = tasks.filter((task) => String(task.status || "") === "error").slice(0, 3);
  if (recentErrors.length > 0) {
    process.stdout.write("Recent errors:\n");
    for (const task of recentErrors) {
      process.stdout.write(`- ${short(String(task.id || ""))}: ${truncate(String(task.error || ""), 180)}\n`);
    }
  }
}

async function cmdFollow(id: string): Promise<void> {
  const resolvedId = await resolveTaskId(id);
  process.stdout.write(`Following task ${resolvedId}. Press Ctrl+C to stop.\n`);
  let lastSignature = "";
  for (;;) {
    const { data, status } = await doReq("GET", `/api/tasks/${resolvedId}`, null);
    if (status >= 400) fail(`HTTP ${status}: ${data}`);
    const task = JSON.parse(data) as Record<string, unknown>;
    const signature = `${String(task.status || "")}:${String(task.updatedAt || task.updated_at || "")}:${String(task.error || "")}`;
    if (signature !== lastSignature) {
      process.stdout.write(`[${formatTime(task.updatedAt || task.updated_at)}] ${String(task.status || "")}\n`);
      if (task.error) process.stdout.write(`error: ${String(task.error)}\n`);
      const threadId = String(task.threadId || "");
      if (threadId) process.stdout.write(`thread: ${formatThreadUrl(threadId)}\n`);
      lastSignature = signature;
    }
    if (["done", "error", "blocked"].includes(String(task.status || ""))) break;
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
}

async function cmdExplain(id: string): Promise<void> {
  const resolvedId = await resolveTaskId(id);
  const { data, status } = await doReq("GET", `/api/tasks/${resolvedId}`, null);
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  const task = JSON.parse(data) as Record<string, unknown>;
  process.stdout.write(`Task ${short(String(task.id || ""))} is \"${String(task.title || "")}.\"\n`);
  process.stdout.write(`It belongs to project ${String(task.projectId || "unknown")} and runs as ${String(task.agent || "unknown")}.\n`);
  process.stdout.write(`Current status: ${String(task.status || "unknown")}.\n`);
  if (task.threadId) process.stdout.write(`Discord thread: ${formatThreadUrl(String(task.threadId))}\n`);
  if (task.error) {
    process.stdout.write(`Failure reason: ${String(task.error)}\n`);
    process.stdout.write("Next step: use dispatch retry <id> if you want a fresh rerun, or fix the underlying plugin/runtime issue first if the error is systemic.\n");
  }
}

async function cmdRetry(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) fail("Usage: dispatch retry <task-id> [--no-qa] [--reuse-thread|--fresh-thread]");
  const resolvedId = await resolveTaskId(id);
  const { data, status } = await doReq("GET", `/api/tasks/${resolvedId}`, null);
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  const task = JSON.parse(data) as Record<string, unknown>;
  const parsed = parseArgs(args.slice(1));
  const reuseThread = Boolean(parsed["reuse-thread"]);
  const payload: Record<string, unknown> = {
    title: task.title,
    description: task.description,
    agent: task.agent || "zeus",
    projectId: task.projectId || null,
    cwd: task.cwd || null,
    timeoutMs: task.timeoutMs || config.defaults?.taskTimeoutMs || 1800000,
    qaRequired: parsed["no-qa"] ? false : task.qaRequired !== false,
    model: task.model || null,
    thinking: task.thinking || null,
    threadId: reuseThread ? (task.threadId || null) : null,
  };
  const create = await doReq("POST", "/api/tasks", payload);
  if (create.status >= 400) fail(`HTTP ${create.status}: ${create.data}`);
  const newTask = JSON.parse(create.data) as Record<string, unknown>;
  process.stdout.write(`Retried ${short(resolvedId)} -> ${short(String(newTask.id || ""))}\n`);
  prettyPrint(create.data);
}

async function cmdQa(id: string): Promise<void> {
  if (!id) fail("Usage: dispatch qa <task-id>");
  const resolvedId = await resolveTaskId(id);
  const { data, status } = await doReq("POST", `/api/tasks/${resolvedId}/qa`, {});
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  process.stdout.write(`🔍 QA review triggered for task ${short(resolvedId)}\n`);
  prettyPrint(data);
}

async function cmdHealth(): Promise<void> {
  const { data, status } = await doReq("GET", "/api/dispatch/health", null);
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  process.stdout.write("✅ Plugin healthy\n");
  prettyPrint(data);
}

async function cmdProjects(): Promise<void> {
  const entries = projectEntries();
  if (entries.length === 0) {
    process.stdout.write(`No projects configured in ${configPath}\n`);
    return;
  }

  const rows = entries.map((entry) => ({
    project: entry.key,
    agent: entry.defaultAgent,
    cwd: entry.cwd,
    channel: entry.channel,
  }));

  const widths = {
    project: Math.max("PROJECT".length, ...rows.map((r) => r.project.length)),
    agent: Math.max("AGENT".length, ...rows.map((r) => r.agent.length)),
    cwd: Math.max("CWD".length, ...rows.map((r) => r.cwd.length)),
    channel: Math.max("CHANNEL".length, ...rows.map((r) => r.channel.length)),
  };

  process.stdout.write(
    `${pad("PROJECT", widths.project)}  ${pad("AGENT", widths.agent)}  ${pad("CHANNEL", widths.channel)}  CWD\n`,
  );
  for (const row of rows) {
    process.stdout.write(
      `${pad(row.project, widths.project)}  ${pad(row.agent, widths.agent)}  ${pad(row.channel, widths.channel)}  ${row.cwd}\n`,
    );
  }
}

async function cmdInspect(id: string): Promise<void> {
  const resolvedId = await resolveTaskId(id);
  const { data, status } = await doReq("GET", `/api/tasks/${resolvedId}`, null);
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  const task = JSON.parse(data) as Record<string, unknown>;
  process.stdout.write(`Task: ${String(task.title || "") }\n`);
  process.stdout.write(`ID: ${String(task.id || "")}\n`);
  process.stdout.write(`Status: ${String(task.status || "")}\n`);
  process.stdout.write(`Project: ${String(task.projectId || "-")}\n`);
  process.stdout.write(`Agent: ${String(task.agent || "-")}\n`);
  process.stdout.write(`CWD: ${String(task.cwd || "-")}\n`);
  process.stdout.write(`Session: ${String(task.sessionKey || "-")}\n`);
  process.stdout.write(`Run: ${String(task.runId || "-")}\n`);
  const threadId = String(task.threadId || "");
  process.stdout.write(`Thread: ${threadId ? formatThreadUrl(threadId) : "-"}\n`);
  if (task.error) process.stdout.write(`Error: ${String(task.error)}\n`);
}

function printUsage(): void {
  process.stdout.write(`dispatch — Task Dispatch CLI

COMMANDS:
  create, c        Create a new task
  list, ls         List tasks (supports --project / --status)
  active           Show live tasks in ready/dispatched/in_progress/review
  history          Show completed/failed/blocked task history
  recent-errors    Show recent error/blocked tasks
  get <id>         Get task details (short IDs supported)
  inspect <id>     Human-friendly task summary with thread/session links
  explain <id>     Plain-English task summary + suggested next step
  logs <id>        Show recent task event log entries
  timeline <id>    Show task events oldest → newest
  open <id>        Print Discord thread URL for a task
  follow <id>      Poll a task until it finishes
  retry <id>       Create a fresh task from an existing one
  prompt <id>      Send follow-up to existing task session
  update <id>      Update task status
  delete <id>      Delete a task
  resume <id>      Resume a failed task's ACP session
  qa <id>          Manually trigger QA review (Nemesis) on a task
  stats            Show task statistics
  projects         List configured projects, channels, cwd, agents
  doctor           Validate config/cwd/plugin health
  health           Check plugin health

CREATE FLAGS:
  -t, --title       Task title (required)
  -d, --desc        Task description
  -f, --file        Read description from file
  -a, --agent       Agent: zeus (default), atum
  -p, --project     Project key from config (run dispatch projects)
  -c, --category    Category: bug, feat, chore, design
  --depends-on      Comma-separated task IDs this task depends on (DAG)
                    Alias: --after. Task stays waiting until deps complete.
                    Can be repeated: --depends-on id1 --depends-on id2
  -T, --thread      Reuse an existing Discord thread ID
  --cwd             Override working directory
  --timeout         Timeout in ms (defaults to config value)
  --no-qa           Skip Maat code review
  --dry-run         Show resolved project/cwd/agent and exit
  --model           Override model
  --thinking        Thinking level

RETRY FLAGS:
  --no-qa           Retry with QA disabled
  --reuse-thread    Reuse the previous Discord thread
  --fresh-thread    Force a fresh thread (default behavior)

PROMPT:
  dispatch prompt <id> "message"
  dispatch prompt <id> -f message.md

ENVIRONMENT:
  DISPATCH_URL       Base URL (default: http://localhost:18789)
  DISPATCH_API_KEY   API key

EXAMPLES:
  dispatch projects
  dispatch doctor
  dispatch create -t "Fix bug" -p visaroy -c bug -d "Fix the login flow"
  dispatch create -t "Add feature" -p mission-control -d "Build usage dashboard" --no-qa
  dispatch create -t "Task B" -p 0xready --depends-on abc12345 -f desc.md
  dispatch create -t "Task C" -p go-hevy --after abc12345,def67890 --dry-run
  dispatch create -t "Continue thread" -p task-dispatch -T 1488561798167793894 -d "Follow-up work"
  dispatch active --project go-hevy
  dispatch recent-errors --project go-hevy
  dispatch list --project go-hevy --status error
  dispatch history --project go-hevy
  dispatch inspect abc123
  dispatch explain abc123
  dispatch logs abc123
  dispatch timeline abc123
  dispatch open abc123
  dispatch follow abc123
  dispatch retry abc123 --no-qa --reuse-thread
  dispatch prompt abc123 "Add error handling to the API route"
  dispatch update abc123 --status blocked --error "Needs clarification"
`);
}

async function cmdHeartbeat(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub === "log") {
    const flags: Record<string, string> = {};
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i];
      if (typeof arg === "string" && arg.startsWith("--") && i + 1 < argv.length) {
        const next = argv[++i];
        if (typeof next === "string") {
          flags[arg.slice(2)] = next;
        }
      }
    }
    const body = {
      agentId: flags.agent || process.env.HEARTBEAT_AGENT_ID || "unknown",
      agentName: flags.name || process.env.HEARTBEAT_AGENT_NAME || "unknown",
      status: flags.status || process.env.HEARTBEAT_STATUS || "no_work",
      action: flags.action || process.env.HEARTBEAT_ACTION || "HEARTBEAT_OK",
      detail: flags.detail || process.env.HEARTBEAT_DETAIL || "",
      error: flags.error || process.env.HEARTBEAT_ERROR || undefined,
    };
    const { data, status } = await doReq("POST", "/api/heartbeats", body);
    if (status >= 400) fail(`Heartbeat log failed (${status}): ${data}`);
    process.stdout.write(`✅ Heartbeat logged\n`);
    prettyPrint(data);
  } else if (sub === "list" || sub === "ls" || !sub) {
    const agent = argv[1] === "--agent" ? argv[2] : undefined;
    const limitIdx = argv.indexOf("--limit");
    const limitArg = limitIdx !== -1 ? argv[limitIdx + 1] : undefined;
    const limit = typeof limitArg === "string" ? limitArg : "20";
    const qs = new URLSearchParams();
    if (typeof agent === "string") qs.set("agent", agent);
    qs.set("limit", limit);
    const { data, status } = await doReq("GET", `/api/heartbeats?${qs}`, null);
    if (status >= 400) fail(`Heartbeat list failed (${status}): ${data}`);
    prettyPrint(data);
  } else if (sub === "health") {
    const { data, status } = await doReq("GET", "/api/heartbeats/health", null);
    if (status >= 400) fail(`Heartbeat health failed (${status}): ${data}`);
    prettyPrint(data);
  } else {
    process.stderr.write(`Unknown heartbeat subcommand: ${sub}\n`);
    process.stderr.write(`Usage: dispatch heartbeat [log|list|health]\n`);
    process.stderr.write(`  log   --agent ID --name NAME --status STATUS --action ACTION --detail TEXT --error TEXT\n`);
    process.stderr.write(`  list  [--agent ID] [--limit N]\n`);
    process.stderr.write(`  health\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length < 1) {
    printUsage();
    process.exit(1);
  }
  const cmd = argv[0];
  switch (cmd) {
    case "create":
    case "new":
    case "c":
      await cmdCreate(argv.slice(1));
      break;
    case "list":
    case "ls":
    case "l":
      await cmdList(argv.slice(1));
      break;
    case "active":
      await cmdActive(argv.slice(1));
      break;
    case "history":
      await cmdHistory(argv.slice(1));
      break;
    case "recent-errors":
      await cmdRecentErrors(argv.slice(1));
      break;
    case "get":
    case "show":
    case "g":
      await cmdGet(argv[1] || "");
      break;
    case "inspect":
    case "i":
      await cmdInspect(argv[1] || "");
      break;
    case "explain":
      await cmdExplain(argv[1] || "");
      break;
    case "logs":
      await cmdLogs(argv[1] || "");
      break;
    case "timeline":
      await cmdTimeline(argv[1] || "");
      break;
    case "open":
    case "o":
      await cmdOpen(argv[1] || "");
      break;
    case "follow":
    case "f":
      await cmdFollow(argv[1] || "");
      break;
    case "retry":
      await cmdRetry(argv.slice(1));
      break;
    case "prompt":
    case "send":
    case "p":
      await cmdPrompt(argv.slice(1));
      break;
    case "update":
    case "u":
      await cmdUpdate(argv.slice(1));
      break;
    case "delete":
    case "rm":
    case "d":
      await cmdDelete(argv[1] || "");
      break;
    case "resume":
    case "r":
      await cmdResume(argv[1] || "");
      break;
    case "qa":
    case "review":
      await cmdQa(argv[1] || "");
      break;
    case "stats":
    case "s":
      await cmdStats();
      break;
    case "projects":
    case "project":
      await cmdProjects();
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "health":
    case "h":
      await cmdHealth();
      break;
    case "heartbeat":
    case "hb":
      await cmdHeartbeat(argv.slice(1));
      break;
    case "help":
    case "--help":
    case "-h":
      printUsage();
      break;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => fail(`Error: ${(err as Error).message}`));
