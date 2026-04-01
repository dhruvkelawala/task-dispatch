# task-dispatch

<div align="center">

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/runtime-Bun-111827)](https://bun.sh)
[![SQLite](https://img.shields.io/badge/state-SQLite-003B57?logo=sqlite&logoColor=white)](https://sqlite.org)
[![Discord](https://img.shields.io/badge/chat-Discord-5865F2?logo=discord&logoColor=white)](https://discord.com)
[![ACP](https://img.shields.io/badge/runtime-ACP-22c55e)](#how-it-works)

**A dispatch-native task router for coding agents.**

Create tasks, route them to agents, bind them to Discord threads, track lifecycle, retry safely, inspect logs/timelines, and keep the human in the loop.

</div>

---

## What this is

`task-dispatch` is two things:

1. a **plugin/runtime layer** that stores task state, dispatches ACP runs, binds sessions to Discord threads, manages QA/review flow, and exposes HTTP endpoints
2. a **CLI** (`dispatch`) that makes the system pleasant to operate from terminal or agents

It is built for workflows like:
- “send this to Zeus in the right project channel”
- “reuse the same thread for the follow-up task”
- “show me what failed and what to do next”
- “retry this task without QA”
- “show me the event timeline for this task”

---

## Why it exists

Vanilla agent spawning is too easy to fumble:
- wrong project
- wrong cwd
- wrong Discord channel
- no thread continuity
- no operator-friendly status surface
- no real history/logs/timelines

`task-dispatch` adds the missing orchestration layer.

---

## Highlights

### Dispatch-native workflow
- create tasks with project-aware routing
- reuse or create Discord threads automatically
- bind ACP sessions to the right thread
- inspect task/session/thread state from one CLI

### Better operator ergonomics
- `dispatch projects`
- `dispatch doctor`
- `dispatch inspect`
- `dispatch explain`
- `dispatch watch`
- `dispatch recent-errors`
- `dispatch active`

### Safe reruns and follow-ups
- `dispatch retry <id>`
- `dispatch create --from <id>`
- `dispatch create --interactive`
- cwd → project inference
- fuzzy project suggestions
- thread reuse options

### Rich task visibility
- task history
- per-task event log
- timeline view
- plain-English failure explanations
- live board for active tasks + recent errors

### QA / review support
- optional QA flow
- reviewer/runtime model pinning
- retry with or without QA
- review lifecycle surfaced in logs/timeline

### Tested
- CLI helper tests
- dry-run process tests
- task event schema checks
- event-log ordering tests
- delete cleanup tests

---

## CLI at a glance

```bash
dispatch projects
dispatch doctor

dispatch create -t "Fix login bug" -p visaroy -c bug -d "Fix redirect loop"
dispatch create --from abc12345 -t "Follow-up task" --reuse-thread --dry-run
dispatch create --interactive

dispatch active --project go-hevy
dispatch watch --project go-hevy
dispatch recent-errors --project go-hevy

dispatch inspect abc12345
dispatch explain abc12345
dispatch logs abc12345
dispatch timeline abc12345

dispatch retry abc12345 --no-qa --reuse-thread
dispatch prompt abc12345 "Add better error handling"
```

### Major CLI commands

| Command | Purpose |
|---|---|
| `dispatch create` | Create and route a task |
| `dispatch create --from <id>` | Seed a new task from an old one |
| `dispatch create --interactive` | Guided task creation |
| `dispatch list` | Filtered task list |
| `dispatch active` | Live active tasks |
| `dispatch watch` | Live board: active + recent errors |
| `dispatch history` | Done / error / blocked history |
| `dispatch recent-errors` | Recent failures with next steps |
| `dispatch inspect` | Human-friendly task summary |
| `dispatch explain` | Plain-English diagnosis |
| `dispatch logs` | Recent event log entries |
| `dispatch timeline` | Full event timeline |
| `dispatch retry` | Fresh rerun from a prior task |
| `dispatch prompt` | Follow-up into an existing session/thread |
| `dispatch doctor` | Config/cwd/plugin health check |

---

## How it works

```text
operator / agent
      ↓
  dispatch CLI
      ↓
 task-dispatch plugin
      ↓
 SQLite task state + task events
      ↓
 ACP runtime spawn / resume / prompt
      ↓
 Discord thread binding + updates
```

### Core ideas

- a **task** is the durable unit of work
- a **thread** is the human-visible conversation surface in Discord
- a **session** is the underlying ACP runtime context
- the plugin keeps those linked so follow-ups and retries stay coherent

---

## Discord thread model

This repo is heavily optimized around Discord-thread-first coding workflows.

### Supports
- creating a fresh thread for a new task
- reusing an existing thread
- binding resumed sessions back into the thread
- prompting an existing task session from the CLI
- printing/opening thread URLs from CLI
- logging thread-related events in task timelines

### Why this matters
Without this layer, agents easily post into the wrong project channel, lose thread continuity, or force operators to manually reconstruct context.

---

## Event log & timeline

Every important transition can be surfaced as task events, including things like:
- task creation
- status changes
- prompts
- thread creation / thread reuse notification
- QA start / QA verdict
- resume triggers

Use:

```bash
dispatch logs <task-id>
dispatch timeline <task-id>
```

This is the backbone for debugging weird routing, retry, and review behavior.

---

## Project-aware routing

Projects are loaded from live config, not stale hardcoded maps.

That enables:
- `dispatch projects`
- better wrong-project errors
- fuzzy suggestions (`goheavy` → `go-hevy`)
- cwd → project inference
- correct channel/cwd defaults during create

---

## Retry, resume, and follow-up flows

### Retry
Use when you want a **fresh** rerun:

```bash
dispatch retry <task-id>
dispatch retry <task-id> --no-qa
dispatch retry <task-id> --reuse-thread
```

### Resume
Use when you want to continue the **same interrupted session**:

```bash
dispatch resume <task-id>
```

### Prompt
Use when the task/session is still alive and you want to continue in-thread:

```bash
dispatch prompt <task-id> "Keep going, but fix the tests first"
```

---

## Human + AI operator friendly

This tool is designed to work well for both:

### Humans
- readable status summaries
- thread URLs
- live board
- interactive create flow
- safer retries

### Agents (OpenClaw / Codex / Claude Code / etc.)
- deterministic CLI surface
- dry-run path for safe planning
- JSON-capable backend
- strong project/cwd guardrails
- event/timeline introspection for debugging

In other words: it’s not just an internal plugin — it’s an **operator interface**.

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

# create task
curl -X POST http://localhost:18789/api/tasks \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: ..." \
  -d '{"title":"Fix bug","agent":"zeus","projectId":"visaroy"}'

# task event log
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
bun test tests/
```

### Typecheck
```bash
bun run typecheck
```

### Install CLI locally
```bash
bun run build:cli
bun run install:cli
```

---

## Repo structure

```text
src/cli/           dispatch CLI
src/plugin/        plugin runtime, HTTP routes, QA, notify, scheduler, DB
tests/             bun test suite
SKILL.md           OpenClaw skill usage guide
```

---

## Current strengths

This repo is especially strong at:
- dispatching coding tasks into the right place
- preserving thread continuity
- making retries less painful
- surfacing task state for humans and agents
- preventing the kind of dumb routing mistakes that cost hours

---

## Roadmap ideas

Good next additions:
- richer event taxonomy
- prettier `watch` board / TUI mode
- more interactive project selection UX
- stronger route/integration tests around reused-thread dispatches
- more backend error classification

---

## License

Private/internal for now.
