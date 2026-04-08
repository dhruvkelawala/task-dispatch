# task-dispatch

<div align="center">

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/runtime-Bun-111827)](https://bun.sh)
[![SQLite](https://img.shields.io/badge/state-SQLite-003B57?logo=sqlite&logoColor=white)](https://sqlite.org)
[![Discord](https://img.shields.io/badge/chat-Discord-5865F2?logo=discord&logoColor=white)](https://discord.com)
[![ACP](https://img.shields.io/badge/runtime-ACP-22c55e)](#how-it-works)

**Dispatch tasks, not chaos.**

`task-dispatch` is a plugin + CLI for sending coding work to the right agent, in the right project, in the right Discord thread, with enough state and history that you can actually debug what happened later.

</div>

---

## Why this exists

Spawning coding agents is easy.

Spawning them into the **correct project**, with the **correct cwd**, with **thread continuity**, with **retry/resume support**, and with a **human-usable audit trail** is where the pain starts.

`task-dispatch` is the missing orchestration layer.

It is especially handy for workflows like:

- a main agent or operator working from Telegram
- coding agents like OpenCode, Codex, or Claude Code doing the actual implementation work
- Discord threads acting as the visible work surface
- ACP sessions providing the runtime behind the scenes

In short: this repo exists because “just spawn an agent” turns into “where did that agent go?” way too fast.

---

## What it is

`task-dispatch` is two things:

1. a **plugin/runtime layer** that stores task state, dispatches ACP runs, manages thread binding, handles follow-up prompts, supports retry/resume/QA flows, and exposes HTTP endpoints
2. a **CLI** (`dispatch`) that makes the whole thing pleasant to operate from a terminal, by a human, or by another agent

---

## Highlights

### 🧭 Project-aware routing
- route tasks to the right project/channel/cwd
- infer project from cwd when possible
- fuzzy-match project names when the operator gets close but not quite right

### 🧵 Discord-thread-first workflows
- create a new thread for a task
- reuse an existing thread when you want continuity
- keep task → session → thread relationships tied together
- prompt the same task session later without losing context

### 🧱 Durable task state
- SQLite-backed task records
- per-task event log
- timeline view for debugging
- readable status + failure summaries

### 🔁 Safe retries and follow-ups
- fresh reruns
- same-session resume flows
- follow-up prompts into existing ACP sessions
- optional QA/review loops

### 🧑‍💻 Friendly to both humans and agents
- readable CLI output
- dry-run paths
- inspect/explain/logs/timeline surfaces
- automation-friendly command structure

---

## A quick vibe check

If you’ve ever said any of these, this repo is for you:

- “Wait, why did the builder agent land in the wrong channel?”
- “Can we reuse the same thread instead of creating six more?”
- “What failed?”
- “Can I retry that without losing the trail?”
- “Can the main agent dispatch coding work without me hand-holding every step?”

---

## CLI at a glance

```bash
dispatch projects
dispatch doctor

dispatch create -t "Fix login bug" -p web-app -c bug -d "Fix redirect loop"
dispatch create --from abc12345 -t "Follow-up task" --reuse-thread --dry-run
dispatch create --interactive

dispatch active --project web-app
dispatch watch --project web-app
dispatch recent-errors --project web-app

dispatch inspect abc12345
dispatch explain abc12345
dispatch logs abc12345
dispatch timeline abc12345

dispatch retry abc12345 --no-qa --reuse-thread
dispatch prompt abc12345 "Keep going, but fix the tests first"
dispatch resume abc12345
```

### Major commands

| Command | What it does |
|---|---|
| `dispatch create` | Create and route a task |
| `dispatch create --from <id>` | Seed a new task from an old one |
| `dispatch create --interactive` | Guided task creation |
| `dispatch list` | Show tasks with filters |
| `dispatch active` | Show active tasks |
| `dispatch watch` | Live board for active tasks + recent errors |
| `dispatch history` | Browse completed/failed work |
| `dispatch inspect` | Human-friendly task summary |
| `dispatch explain` | Plain-English diagnosis |
| `dispatch logs` | Recent task events |
| `dispatch timeline` | Full lifecycle timeline |
| `dispatch retry` | Fresh rerun from an earlier task |
| `dispatch resume` | Continue the interrupted session |
| `dispatch prompt` | Continue the existing session/thread |
| `dispatch doctor` | Check config/cwd/plugin health |

---

## Configuration

Projects, agents, channels, and notifications are all config-driven.

Start from the example file:

```bash
cp task-dispatch.config.example.json ~/.openclaw/data/task-dispatch-config.json
```

You will usually customize:

- `projects.<id>.cwd` — working directory
- `projects.<id>.channel` — Discord parent channel for new threads
- `projects.<id>.defaultAgent` — default agent for that project
- `projects.<id>.aliases` — optional short names humans/agents can use in the CLI
- `agents.<id>.runtime` — `acp` or `subagent`
- `agents.<id>.accountId` — Discord account to post/bind as
- `agents.<id>.channel` — fallback channel when a task is not project-scoped
- `channels.discord.guildId` or `channels.discord.threadUrlTemplate` — thread URL generation
- `notifications.operatorSessionKey` — optional operator notification session

There are no required hardcoded project names, personal Discord IDs, or personal routes in the repo anymore.

---

## How it works

```text
operator / main agent
        ↓
   dispatch CLI
        ↓
 task-dispatch plugin
        ↓
 SQLite task state + event log
        ↓
 ACP spawn / prompt / resume flows
        ↓
 Discord threads + session binding
```

### Core ideas

- a **task** is the durable unit of work
- a **thread** is the human-visible conversation surface
- a **session** is the ACP runtime context underneath
- `task-dispatch` keeps those tied together so retries, prompts, and resumes stay coherent

---

## Retry, resume, and follow-up flows

### Retry
Use retry when you want a **fresh** rerun:

```bash
dispatch retry <task-id>
dispatch retry <task-id> --no-qa
dispatch retry <task-id> --reuse-thread
```

### Resume
Use resume when you want to continue the **same interrupted session**:

```bash
dispatch resume <task-id>
```

### Prompt
Use prompt when the session is still alive and you want to continue in-thread:

```bash
dispatch prompt <task-id> "Keep going, but fix the tests first"
```

---

## Event log and timeline

Every meaningful task transition can be recorded as an event, including:

- task creation
- dispatch start
- thread creation or thread reuse
- prompts
- QA start / verdict
- resume triggers
- failure transitions

Useful commands:

```bash
dispatch logs <task-id>
dispatch timeline <task-id>
dispatch explain <task-id>
```

This is one of the biggest quality-of-life wins in the repo: when something weird happens, you can usually answer **what happened**, **when**, and **why** without archaeology.

---

## HTTP API

Base:

```text
http://localhost:18789/api
```

Examples:

```bash
# list tasks
curl http://localhost:18789/api/tasks

# create a task
curl -X POST http://localhost:18789/api/tasks \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: ..." \
  -d '{"title":"Fix bug","agent":"builder","projectId":"web-app"}'

# fetch task events
curl http://localhost:18789/api/tasks/<id>/events
```

---

## Development

### Build

```bash
bun run build
```

### Test

```bash
bun run test
```

### Typecheck

```bash
bun run typecheck
```

### Install the CLI locally

```bash
bun run build:cli
bun run install:cli
```

---

## Repo structure

```text
src/cli/           dispatch CLI
src/plugin/        plugin runtime, HTTP routes, QA, notify, scheduler, DB
tests/             Bun test suite
SKILL.md           OpenClaw skill usage guide
```

---

## Current strengths

This repo is especially good at:

- dispatching coding work into the right place
- preserving thread continuity
- making retries less painful
- surfacing task state for humans and agents
- preventing the kind of dumb routing mistakes that cost hours

---

## Roadmap ideas

Good next additions:

- prettier watch/TUI mode
- richer event taxonomy
- stronger route/integration tests
- more backend error classification
- better project selection UX

---

## Status

This repo is now public, but it is still intentionally opinionated.

It is built for real-world agent orchestration, not for looking like a generic “AI task manager” demo.

That is a feature, not a bug.

---

## License

No license has been added yet. Until that changes, treat the code as source-available for reading, not automatically licensed for reuse.
