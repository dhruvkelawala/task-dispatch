# Task-Dispatch Plugin — Orchestrator Skill

Use this skill when creating, dispatching, resetting, or managing tasks via the task-dispatch plugin.

---

## API

- **Base**: `http://127.0.0.1:18789/api`
- **API Key (all writes)**: `X-Api-Key: 24b1b4e5472806f373c62c49cfe119d6`
- **Reads (GET)**: no key required

---

## Create a Task

```bash
curl -s -X POST http://127.0.0.1:18789/api/tasks \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: 24b1b4e5472806f373c62c49cfe119d6" \
  -d '{
    "title": "Task title (max 64 chars)",
    "agent": "zeus",
    "projectId": "mission-control",
    "description": "Full task prompt here",
    "dependsOn": []
  }'
```

**Always create all DAG-linked tasks in a single exec session** — shell variables don't persist across sessions, which leads to `dependsOn: ['']` (empty strings). The plugin now rejects empty strings with 400.

---

## Dispatch a Task

```bash
curl -s -X POST "http://127.0.0.1:18789/api/dispatch/run?id=TASK_ID" \
  -H "X-Api-Key: 24b1b4e5472806f373c62c49cfe119d6"
```

Only works when `status = ready`.

---

## DAG (Dependent Tasks)

Tasks with `dependsOn: [id1, id2]` start as `pending` and auto-dispatch when all deps are `done`. No manual trigger needed.

Verify after creation:
```bash
curl -s http://127.0.0.1:18789/api/tasks/TASK_ID | python3 -c "import sys,json; print(json.load(sys.stdin).get('dependsOn'))"
```

---

## Reset a Failed Task

```bash
# 1. Clear stale session label
python3 -c "
import json
path = '/Volumes/SumoDeus NVMe/openclaw/agents/opencode/sessions/sessions.json'
with open(path) as f: d = json.load(f)
for k in list(d.keys()):
    if 'TASK_TITLE_SUBSTRING' in d[k].get('label',''): del d[k]
with open(path, 'w') as f: json.dump(d, f, indent=2)
"

# 2. Reset status
curl -s -X PATCH http://127.0.0.1:18789/api/tasks/TASK_ID \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: 24b1b4e5472806f373c62c49cfe119d6" \
  -d '{"status":"ready"}'

# 3. Dispatch
curl -s -X POST "http://127.0.0.1:18789/api/dispatch/run?id=TASK_ID" \
  -H "X-Api-Key: 24b1b4e5472806f373c62c49cfe119d6"
```

---

## Task Prompt Template

Every task description must include:

```
## API Key (if task hits the plugin)
All POST/PATCH/DELETE to http://127.0.0.1:18789 require:
Header: X-Api-Key: 24b1b4e5472806f373c62c49cfe119d6
Never use agent: "ibis" in tests — use agent: "test-agent"
```

---

## Project Config

File: `~/.openclaw/data/task-dispatch-config.json`

| projectId | cwd | Discord channel |
|-----------|-----|-----------------|
| `mission-control` | `workspace/mission-control-v3` | `#mission-control` |
| `visaroy` | `workspace/visaroy/visaroy-app` | `#visaroy` |
| `forayy` | `workspace/forayy` | `#forayy` |
| `argentx` | `workspace/argent-x-multichain` | `#argentx` |

**⚠️ After ANY config change: restart gateway BEFORE dispatching.**

---

## Status Check

```bash
# Non-done tasks
curl -s http://127.0.0.1:18789/api/tasks | python3 -c "
import sys,json
for t in json.load(sys.stdin):
    if t['status'] not in ('done','cancelled'):
        print(t['id'][:8], t['agent'], t['status'], t['title'][:40])
"
```

---

## Key Rules

1. **API key on every write** — no exceptions
2. **Never `agent: "ibis"` in tests** — spawns real sessions → infinite loop
3. **All DAG tasks in one exec session** — prevent empty-string dependsOn
4. **Config change → gateway restart → THEN dispatch**
5. **No gateway restart without Dhruv's approval** when sessions are running
6. **After restart**: clear stale labels + reset error tasks manually

---

## Full Runbook

`/Users/sumo-deus/.openclaw/workspace/docs/task-dispatch-orchestrator.md`
