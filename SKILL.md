# Task-Dispatch Plugin — Orchestrator Skill

Use this skill when creating, dispatching, retrying, or inspecting tasks via the `task-dispatch` plugin.

---

## API

- **Base**: `http://127.0.0.1:18789/api`
- **Writes**: require `X-Api-Key`
- **Reads (`GET`)**: may be open depending on your local plugin setup

Set the key with an environment variable instead of hardcoding it into prompts:

```bash
export DISPATCH_API_KEY="<your-task-dispatch-api-key>"
```

---

## Config-first setup

Projects, channels, agents, and notification routes should come from:

```text
~/.openclaw/data/task-dispatch-config.json
```

Use the repo example file as the starting point:

```bash
cp task-dispatch.config.example.json ~/.openclaw/data/task-dispatch-config.json
```

Do not assume any particular project name, Discord channel, Telegram user, or bot account exists.

Always inspect config first when operating in a new environment.

---

## Create a task

```bash
curl -s -X POST http://127.0.0.1:18789/api/tasks \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: ${DISPATCH_API_KEY}" \
  -d '{
    "title": "Task title (max 64 chars)",
    "agent": "builder",
    "projectId": "web-app",
    "description": "Full task prompt here",
    "dependsOn": []
  }'
```

If the environment uses a different default agent or project naming convention, read it from config and use that.

---

## Dispatch a task

```bash
curl -s -X POST "http://127.0.0.1:18789/api/dispatch/run?id=TASK_ID" \
  -H "X-Api-Key: ${DISPATCH_API_KEY}"
```

Only works when `status = ready`.

---

## DAG / dependent tasks

Tasks with `dependsOn: [id1, id2]` start as `pending` and auto-dispatch when all dependencies are `done`.

Verify after creation:

```bash
curl -s http://127.0.0.1:18789/api/tasks/TASK_ID | \
  python3 -c "import sys,json; print(json.load(sys.stdin).get('dependsOn'))"
```

When creating a DAG from shell scripts, create related tasks in a single execution flow so dependency IDs do not get lost.

---

## Reset a failed task

```bash
# reset status
curl -s -X PATCH http://127.0.0.1:18789/api/tasks/TASK_ID \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: ${DISPATCH_API_KEY}" \
  -d '{"status":"ready"}'

# dispatch again
curl -s -X POST "http://127.0.0.1:18789/api/dispatch/run?id=TASK_ID" \
  -H "X-Api-Key: ${DISPATCH_API_KEY}"
```

If your environment keeps external session metadata, clean that up using your own local runbook rather than assuming a repo-specific path.

---

## Project and agent discovery

Prefer asking the system what is configured rather than assuming values:

```bash
dispatch projects
dispatch doctor
```

Those two commands are the fastest way to answer:

- which projects exist
- which cwd values map to which project
- which channels are configured
- which agent IDs are expected locally

---

## Status checks

```bash
# non-done tasks
curl -s http://127.0.0.1:18789/api/tasks | python3 -c "
import sys, json
for t in json.load(sys.stdin):
    if t['status'] not in ('done', 'cancelled'):
        print(t['id'][:8], t['agent'], t['status'], t['title'][:40])
"
```

---

## Key rules

1. **Use an API key for writes**
2. **Do not hardcode personal project/channel/user info into tasks or prompts**
3. **Treat config as the source of truth for routing**
4. **After config changes, restart the gateway before dispatching new work**
5. **Prefer `dispatch projects` and `dispatch doctor` over guessing**

---

## Suggested operator loop

```bash
dispatch projects
dispatch doctor
dispatch create --interactive
dispatch inspect TASK_ID
dispatch logs TASK_ID
dispatch timeline TASK_ID
```

That sequence is usually enough for a human or agent operator to get oriented without relying on private tribal knowledge.
