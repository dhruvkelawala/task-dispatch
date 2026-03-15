#!/usr/bin/env bun

import { readFileSync } from "node:fs";

const defaultBase = "http://localhost:18789";
const defaultApiKey = "24b1b4e5472806f373c62c49cfe119d6";

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

const projectCwd: Record<string, string> = {
  visaroy: "/Users/sumo-deus/.openclaw/workspace/visaroy/visaroy-app",
  mc: "/Users/sumo-deus/.openclaw/workspace/mission-control-v3",
  "mission-control": "/Users/sumo-deus/.openclaw/workspace/mission-control-v3",
  forayy: "/Users/sumo-deus/.openclaw/workspace/forayy",
  "task-dispatch": "/Users/sumo-deus/.openclaw/extensions/task-dispatch",
};

const projectId: Record<string, string> = {
  visaroy: "visaroy",
  mc: "mission-control",
  "mission-control": "mission-control",
  forayy: "forayy",
  "task-dispatch": "task-dispatch",
};

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
    timeoutMs: 1800000,
  };

  let title = "";
  let desc = "";

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
        if (projectCwd[p]) payload.cwd = projectCwd[p];
        payload.projectId = projectId[p] || p;
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
      case "--model":
        i += 1;
        payload.model = args[i] || "";
        break;
      case "--thinking":
        i += 1;
        payload.thinking = args[i] || "";
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

  payload.title = title;
  if (desc) payload.description = desc;

  const { data, status } = await doReq("POST", "/api/tasks", payload);
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  const result = JSON.parse(data) as Record<string, unknown>;
  process.stdout.write(`✅ Created task ${short(String(result.id || ""))}\n`);
  prettyPrint(data);
}

async function cmdList(): Promise<void> {
  const { data, status } = await doReq("GET", "/api/tasks", null);
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  const tasks = JSON.parse(data) as Array<Record<string, unknown>>;
  if (tasks.length === 0) {
    process.stdout.write("No tasks.\n");
    return;
  }

  const rows = tasks.map((t) => ({
    id: short(String(t.id || "")),
    status: statusLabel(String(t.status || "")),
    agent: String(t.agent || ""),
    title: truncate(String(t.title || ""), 50),
    created: formatTime(t.created_at),
  }));

  const widths = {
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
    agent: Math.max(5, ...rows.map((r) => r.agent.length)),
    title: Math.max(5, ...rows.map((r) => r.title.length)),
  };

  process.stdout.write(
    `${pad("ID", widths.id)}  ${pad("STATUS", widths.status)}  ${pad("AGENT", widths.agent)}  ${pad("TITLE", widths.title)}  CREATED\n`,
  );
  for (const row of rows) {
    process.stdout.write(
      `${pad(row.id, widths.id)}  ${pad(row.status, widths.status)}  ${pad(row.agent, widths.agent)}  ${pad(row.title, widths.title)}  ${row.created}\n`,
    );
  }
}

async function cmdGet(id: string): Promise<void> {
  if (!id) fail("Usage: dispatch get <task-id>");
  const { data, status } = await doReq("GET", `/api/tasks/${id}`, null);
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
  const { data, status } = await doReq("POST", `/api/tasks/${id}/prompt`, { message });
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  process.stdout.write(`✅ Prompt sent to task ${short(id)}\n`);
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
  const { data, status } = await doReq("PATCH", `/api/tasks/${id}`, payload);
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  process.stdout.write(`✅ Updated task ${short(id)}\n`);
}

async function cmdDelete(id: string): Promise<void> {
  if (!id) fail("Usage: dispatch delete <task-id>");
  const { data, status } = await doReq("DELETE", `/api/tasks/${id}`, null);
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  process.stdout.write(`🗑️  Deleted task ${short(id)}\n`);
}

async function cmdStats(): Promise<void> {
  const { data, status } = await doReq("GET", "/api/tasks/stats", null);
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  prettyPrint(data);
}

async function cmdHealth(): Promise<void> {
  const { data, status } = await doReq("GET", "/api/dispatch/health", null);
  if (status >= 400) fail(`HTTP ${status}: ${data}`);
  process.stdout.write("✅ Plugin healthy\n");
  prettyPrint(data);
}

function printUsage(): void {
  process.stdout.write(`dispatch — Task Dispatch CLI

COMMANDS:
  create, c    Create a new task
  list, ls     List all tasks
  get <id>     Get task details
  prompt <id>  Send follow-up to existing task session
  update <id>  Update task status
  delete <id>  Delete a task
  stats        Show task statistics
  health       Check plugin health

CREATE FLAGS:
  -t, --title       Task title (required)
  -d, --desc        Task description
  -f, --file        Read description from file
  -a, --agent       Agent: zeus (default), atum
  -p, --project     Project: visaroy, mc, forayy (auto-sets cwd)
  -c, --category    Category: bug, feat, chore, design
  --cwd             Override working directory
  --timeout         Timeout in ms (default 1800000 = 30min)
  --no-qa           Skip Maat code review
  --model           Override model
  --thinking        Thinking level

PROMPT:
  dispatch prompt <id> "message"
  dispatch prompt <id> -f message.md

ENVIRONMENT:
  DISPATCH_URL       Base URL (default: http://localhost:18789)
  DISPATCH_API_KEY   API key

EXAMPLES:
  dispatch create -t "Fix bug" -p visaroy -c bug -d "Fix the login flow"
  dispatch create -t "Add feature" -p mc -d "Build usage dashboard" --no-qa
  dispatch list
  dispatch prompt abc123 "Add error handling to the API route"
  dispatch get abc123
  dispatch update abc123 --status blocked --error "Needs clarification"
`);
}

async function cmdHeartbeat(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub === "log") {
    const flags: Record<string, string> = {};
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i];
      if (arg.startsWith("--") && i + 1 < argv.length) {
        flags[arg.slice(2)] = argv[++i];
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
    const limit = argv.includes("--limit") ? argv[argv.indexOf("--limit") + 1] : "20";
    const qs = new URLSearchParams();
    if (agent) qs.set("agent", agent);
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
      await cmdList();
      break;
    case "get":
    case "show":
    case "g":
      await cmdGet(argv[1] || "");
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
    case "stats":
    case "s":
      await cmdStats();
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
