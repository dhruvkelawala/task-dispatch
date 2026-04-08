# task-dispatch

<div align="center">

<img src="assets/logo.png" alt="task-dispatch" width="320" />

<br />

**Dispatch tasks to coding agents. Track everything.**

An [OpenClaw](https://github.com/openclaw/openclaw) plugin + CLI for orchestrating coding agents via [ACP](https://github.com/openclaw/openclaw/pull/63176) with Discord thread delivery, durable task state, and automated QA.

<br />

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/runtime-Bun-111827?logo=bun&logoColor=white)](https://bun.sh)
[![SQLite](https://img.shields.io/badge/state-SQLite-003B57?logo=sqlite&logoColor=white)](https://sqlite.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

</div>

---

## The problem

Spawning a coding agent is one line. Getting it to land in the **right project**, with the **right working directory**, inside a **Discord thread** you can actually follow, with **retry/resume** when it fails, and a **timeline** so you can debug what happened — that's where things fall apart.

`task-dispatch` is the orchestration layer between "do this task" and "an agent did the work, here's the thread."

## How it works

```
Operator / main agent
        │
        ▼
  dispatch CLI / HTTP API
        │
        ▼
  ┌─────────────────────────┐
  │   task-dispatch plugin   │
  │                         │
  │  SQLite state + events  │
  │  Project routing        │
  │  ACP spawn / prompt     │
  │  Discord thread mgmt    │
  │  QA pipeline            │
  └─────────────────────────┘
        │
        ▼
  Coding agent (OpenCode / Codex / Claude Code)
  runs in ACP session, posts to Discord thread
```

**Core model:**
- A **task** is the durable unit of work (survives crashes, retries, agent restarts)
- A **session** is the ACP runtime underneath (stateful agent conversation)
- A **thread** is the human-visible surface (Discord thread where the agent works)

task-dispatch keeps these three tied together so retries, follow-ups, and QA loops stay coherent.

## Features

**Routing** — Tasks are dispatched to the right project, agent, working directory, and Discord channel based on config. Supports project aliases, fuzzy matching, and per-project defaults.

**Thread management** — Creates new Discord threads per task, or reuses existing ones for continuity. Thread → session → task relationships are tracked.

**Durable state** — SQLite-backed task records with a full event log. Every state transition, dispatch, prompt, QA verdict, and failure is recorded with timestamps.

**Retry / Resume / Prompt** — Fresh reruns, same-session resumes, and follow-up prompts into live sessions. All three are first-class operations.

**QA pipeline** — Optional automated review after task completion. Configurable reviewer agent, max review cycles, and auto-reject on repeated failures.

**Background job queue** — Long-running dispatches run in a managed background queue with concurrency limits, so the HTTP API stays responsive.

**CLI + HTTP API** — Everything is accessible both ways. The CLI is designed for humans and agents alike.

## Quick start

### 1. Install

```bash
git clone https://github.com/dhruvkelawala/task-dispatch.git
cd task-dispatch
bun install
bun run build
```

### 2. Configure

```bash
cp task-dispatch.config.example.json ~/.openclaw/data/task-dispatch-config.json
```

Edit the config to match your setup — projects, agents, Discord channels, API key. See [Configuration](#configuration) below.

### 3. Register as an OpenClaw plugin

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "task-dispatch": {
        "path": "/path/to/task-dispatch",
        "config": {
          "dbPath": "~/.openclaw/data/task-dispatch.db"
        }
      }
    }
  }
}
```

### 4. Install the CLI

```bash
bun run build:cli
bun run install:cli
```

### 5. Verify

```bash
dispatch doctor    # checks config, plugin health, connectivity
dispatch projects  # lists configured projects
```

## CLI reference

### Task lifecycle

```bash
# Create and dispatch
dispatch create -t "Fix login redirect bug" -p web-app -c bug
dispatch create -t "Add dark mode" -p web-app -d "Implement dark mode toggle in settings"
dispatch create --interactive           # guided creation
dispatch create --from abc123 -t "Follow-up"  # seed from previous task

# Monitor
dispatch list                           # all tasks
dispatch active                         # currently running
dispatch active --project web-app       # filtered by project
dispatch watch                          # live board (auto-refreshes)
dispatch recent-errors                  # recent failures

# Inspect
dispatch inspect abc123                 # human-readable summary
dispatch explain abc123                 # plain-English diagnosis
dispatch logs abc123                    # recent events
dispatch timeline abc123                # full lifecycle

# Continue
dispatch prompt abc123 "Fix the tests too"   # follow-up in same session
dispatch retry abc123                        # fresh rerun
dispatch retry abc123 --reuse-thread         # fresh run, same thread
dispatch resume abc123                       # continue interrupted session
```

### System

```bash
dispatch projects          # list configured projects
dispatch doctor            # health check
dispatch health            # plugin API health
dispatch heartbeat list    # recent heartbeat logs
dispatch heartbeat health  # agent liveness (ALIVE/STALE/DEAD)
```

## Configuration

The config file lives at `~/.openclaw/data/task-dispatch-config.json`. Start from the [example](task-dispatch.config.example.json).

### Projects

```json
{
  "projects": {
    "web-app": {
      "name": "Web App",
      "repo": "org/web-app",
      "cwd": "~/workspace/web-app",
      "channel": "345678901234567890",
      "defaultAgent": "builder",
      "aliases": ["web", "frontend"]
    }
  }
}
```

Each project defines where agents should work (`cwd`), where threads appear (`channel`), and which agent handles it by default.

### Agents

```json
{
  "agents": {
    "builder": {
      "runtime": "acp",
      "accountId": "builder-bot",
      "channel": "234567890123456789"
    },
    "reviewer": {
      "runtime": "subagent",
      "accountId": "default"
    }
  }
}
```

Agents can use `acp` (spawns a full ACP session — OpenCode, Codex, Claude Code) or `subagent` (in-process).

### Discord

```json
{
  "channels": {
    "discord": {
      "guildId": "123456789012345678",
      "accounts": {
        "builder-bot": { "token": "<bot-token>" }
      }
    }
  }
}
```

Each agent can post as a different Discord bot, keeping identities clean.

## HTTP API

Base: `http://localhost:18789/api`

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/tasks` | List tasks (supports `?status=`, `?project=`) |
| `POST` | `/tasks` | Create + dispatch a task |
| `GET` | `/tasks/:id` | Get task details |
| `GET` | `/tasks/:id/events` | Task event log |
| `POST` | `/tasks/:id/prompt` | Send follow-up prompt |
| `GET` | `/health` | Plugin health check |
| `GET` | `/projects` | List configured projects |

All write endpoints require `X-Api-Key` header matching the configured `apiKey`.

## Task states

```
ready → dispatched → in_progress → review → done
                                      ↓
                                   rejected → in_progress (retry, max 3 cycles)
                                      ↓
                                   blocked (after max cycles)

Any state → failed (on error)
Any state → cancelled (manual)
```

## Event log

Every meaningful transition is recorded:

- `task.created`, `task.dispatched`, `task.completed`
- `thread.created`, `thread.reused`
- `session.spawned`, `session.prompted`, `session.resumed`
- `qa.started`, `qa.passed`, `qa.rejected`
- `task.failed`, `task.retried`

```bash
dispatch timeline abc123
```

This is the single biggest quality-of-life feature — when something goes wrong, you can trace exactly what happened and when.

## Development

```bash
bun run build        # compile plugin + CLI
bun run test         # run test suite
bun run typecheck    # tsc --noEmit
bun run build:cli    # build CLI binary
bun run install:cli  # install to ~/.local/bin/dispatch
```

### Repo structure

```
src/
  plugin/          # OpenClaw plugin runtime, HTTP routes, DB, QA, scheduler
  cli/             # dispatch CLI
tests/             # Bun test suite
SKILL.md           # OpenClaw skill guide (how agents use task-dispatch)
```

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) with plugin support
- [Bun](https://bun.sh) runtime
- Discord bot token(s) for thread creation
- ACP-capable agent backend (OpenCode, Codex, Claude Code, etc.)

## License

[MIT](LICENSE)
