# task-dispatch ACP Current State & Runbook

**Last updated:** 2026-05-09  
**Status:** Working — ACP Discord delivery fixed via fork `api.runtime.acp.prompt()`  
**OpenClaw version:** Fork `v2026.5.7` (branch `fork/v2026.5.7-acp`)  
**Scope:** task-dispatch plugin + OpenClaw ACP plugin-runtime fork

---

## 1. Current state

The task-dispatch ACP flow is working end-to-end:

1. task-dispatch creates a task
2. plugin initializes ACP session via `getAcpSessionManager().initializeSession()`
3. plugin binds a Discord child thread via `getSessionBindingService().bind()`
4. plugin sends the task prompt via `api.runtime.acp.prompt()` (gateway delivery path)
5. OpenClaw gateway runs the ACP turn AND delivers output to the bound Discord thread
6. task-dispatch polls the Discord thread for output
7. task output is captured and stored

### What works

| Area | Status | Notes |
|---|---|---|
| ACP session init | Works | via `getAcpSessionManager().initializeSession()` |
| Discord child thread binding | Works | via `getSessionBindingService().bind()` |
| ACP prompt with delivery | Works | via `api.runtime.acp.prompt()` (fork) |
| Discord output capture | Works | polls thread for bot messages |
| QA / review loop | Works | Nemesis review after task output |
| First task after restart | Works | waits 60s once before first ACP spawn |
| Separate ACP personas | Works | Zeus uses `zeus-opencode`, Nemesis uses `nemesis-opencode` |
| Gateway restart resume | Works | auto-resumes ACP tasks after gateway PID change |

### 2026-05-09 updates (latest)

1. **Fixed ACP Discord delivery** — the core issue since the SDK migration:
   - **Root cause**: task-dispatch was calling `AcpSessionManager.runTurn()` directly, which runs the ACP backend but does NOT deliver output to Discord. Only the gateway's `agent` method pipeline handles both execution AND delivery.
   - **Fix**: Switched `startAcpPromptTurn` to use `api.runtime.acp.prompt()` from the OpenClaw fork, which calls `callGateway({ method: "agent", deliver: true, channel, threadId })` — the same path native ACP spawn uses.
   - **Evidence**: Manual ACP threads (created via Discord) worked because inbound Discord messages enter the gateway's `acp_dispatch` pipeline which includes delivery. task-dispatch-created threads were empty because `runTurn()` bypasses that pipeline.

2. **Updated OpenClaw fork to v2026.5.7**:
   - Branch: `fork/v2026.5.7-acp` based on upstream tag `v2026.5.7`
   - Cherry-picked 3 ACP plugin-runtime patches (same patchset as before)
   - Resolved merge conflicts in `types-core.ts`, `index.ts`, `index.test.ts`
   - Both task-dispatch `node_modules/openclaw` and global `/opt/homebrew/lib/node_modules/openclaw` symlinked to the fork

3. **Fixed plugin loading for v2026.5.7**:
   - Added `activation.onStartup: true` to `openclaw.plugin.json` (required by new plugin discovery)
   - Added `openclaw.extensions` metadata to `package.json`
   - Added `plugins.allowAcpSpawn: true` and `plugins.bundledDiscovery: "compat"` to `openclaw.json`
   - Added explicit `plugins.load.paths` entry for task-dispatch

4. **Removed unsafe workarounds**:
   - Removed manual `onEvent` streamed-output capture and posting (was a temporary workaround)
   - Removed `execFile("openclaw", ["gateway", "call", "agent", ...])` CLI shelling (ugly intermediate fix)
   - No ACP session-file fallback — hard error if no Discord output

5. **Added diagnostics** (`[TD-DIAG]` prefix):
   - SDK package path and version
   - ACP initialization result (runtime, handle, meta, backendSessionId)
   - Binding result (conversationId, parentConversationId, metadata)
   - Thread message count immediately after bind

6. **Other fixes in this changeset**:
   - Binding failure is now fatal (prevents orphaned tasks without Discord threads)
   - Child-thread bind payload includes `parentConversationId` for proper Discord channel targeting
   - Background job `drainOnce()` is awaitable again while preserving concurrency/timeout
   - Timeout buffer adds ACP startup cooldown to dispatch timeout budget

---

## 2. Architecture

```text
task-dispatch plugin
  1. getAcpSessionManager().initializeSession(cfg, sessionKey, agent, cwd)
  2. getSessionBindingService().bind({ targetSessionKey, conversation: { channel: "discord", ... }, placement: "child" })
  3. api.runtime.acp.prompt({ sessionKey, text, channel: "discord", accountId, threadId })
     └── internally calls callGateway({ method: "agent", deliver: true, ... })
         └── gateway agent handler:
             a. resolves ACP session
             b. calls acpManager.runTurn() with onEvent callback
             c. accumulates visible text
             d. calls deliverAgentCommandResult() → Discord thread
  4. task-dispatch polls Discord thread for output
  5. stores output, marks task done
```

### Why `runTurn()` alone doesn't work

`AcpSessionManager.runTurn()` is the low-level ACP execution primitive. It:
- Runs the AI backend
- Generates output events internally
- Does NOT deliver output to any channel

Channel delivery requires the full gateway agent pipeline (`src/agents/agent-command.ts`):
- Calls `runTurn()` with an `onEvent` callback
- Accumulates visible text via `visibleTextAccumulator`
- Calls `deliverAgentCommandResult()` to push output to the bound channel

Native ACP spawn (`src/agents/acp-spawn.ts`) uses `callGateway({ method: "agent", deliver: true })` — which enters this pipeline. The fork's `api.runtime.acp.prompt()` does the same thing.

### Important design decisions

- ACP session init and binding are still done by task-dispatch (not via `acp.spawn`)
- The initial prompt goes through `api.runtime.acp.prompt()` for delivery
- task-dispatch records the thread ID from the binding response
- Binding failure is fatal — no silent orphaned tasks
- No ACP session-file fallback — output must come from Discord thread polling

---

## 3. Required local conditions

### OpenClaw fork

Fork branch: `fork/v2026.5.7-acp` in `openclaw-fork/`

Carries the ACP plugin runtime patch:
- `feat(plugins): add api.runtime.acp.spawn() and acp.prompt() for plugin ACP dispatch`
- `test(plugins): cover ACP runtime gate`
- `plugins: address ACP runtime review feedback`

Related upstream references:
- PR: `https://github.com/openclaw/openclaw/pull/63176`
- Issue: `https://github.com/openclaw/openclaw/issues/65022` (closed — upstream rejected, said to use `getAcpSessionManager`)

### Symlinks

Both must point to the fork build:
```
~/.openclaw/extensions/task-dispatch/node_modules/openclaw → /Volumes/SumoDeus NVMe/openclaw/openclaw-fork
/opt/homebrew/lib/node_modules/openclaw → /Volumes/SumoDeus NVMe/openclaw/openclaw-fork
```

### openclaw.json requirements

```json5
{
  plugins: {
    allowAcpSpawn: true,          // gates api.runtime.acp.spawn/prompt
    bundledDiscovery: "compat",   // legacy provider discovery
    load: {
      paths: ["/Users/sumo-deus/.openclaw/extensions/task-dispatch"]
    },
    entries: {
      "task-dispatch": { enabled: true }
    }
  }
}
```

### Zeus Discord config

- Zeus must have native commands disabled
- Zeus must be allowed in the task-dispatch parent channel
- `messages.groupChat.visibleReplies: "automatic"` for visible Discord replies

### acpx timeout

- `plugins.acpx.config.timeoutSeconds: 900` (default 120 is too short)

### Plugin manifest

`openclaw.plugin.json` must include:
```json
{
  "activation": { "onStartup": true }
}
```

`package.json` must include:
```json
{
  "openclaw": {
    "extensions": ["./index.mjs"]
  }
}
```

---

## 4. Startup policy

After a gateway restart, Discord's full ACP child-thread binding path is not immediately ready.

Policy: wait **60 seconds once** after restart before the first ACP spawn. After that, ACP dispatches normally.

The dispatch timeout budget adds `acpStartupCooldownMs + 60_000` on top of the task timeout to account for this.

---

## 5. Output and UX cleanup

### Plugin-side cleanup

- No duplicate completion post in ACP threads
- Sanitized lines stripped from stored output:
  - `⚙️ ... session active ...`
  - `cwd: ...`
  - `Background task done: ...`

### Smoke test prompt guidance

For smoke tests, use strict prompts to prevent agents from exploring:
```
DO NOT use any tools. DO NOT read files. DO NOT explore anything.
Simply reply with this exact text and nothing else: <EXPECTED_OUTPUT>
```

---

## 6. Verification runbook

### A. Verify OpenClaw fork

```bash
cd /Volumes/SumoDeus\ NVMe/openclaw/openclaw-fork
git log --oneline -5  # should show 3 ACP patches on v2026.5.7
pnpm build
```

### B. Verify task-dispatch plugin

```bash
cd ~/.openclaw/extensions/task-dispatch
pnpm exec tsc --noEmit
pnpm build
bun test tests/
```

### C. End-to-end verify

1. Restart gateway: `openclaw gateway restart`
2. Wait for startup (check `openclaw gateway call health --json`)
3. Create a smoke task:
   ```bash
   build/dispatch create -p visaroy -a zeus --no-qa --timeout 120000 \
     -t "Smoke test" \
     -d "DO NOT use any tools. Simply reply: SMOKE_OK"
   ```
4. Follow: `build/dispatch follow <id>`
5. Confirm:
   - Discord ACP child thread created
   - Agent output visible in thread
   - Task status `done`
   - Output matches expected text

### D. Verify symlinks

```bash
ls -l ~/.openclaw/extensions/task-dispatch/node_modules/openclaw
ls -l /opt/homebrew/lib/node_modules/openclaw
openclaw --version  # should show fork version
```

---

## 7. Troubleshooting checklist

1. **Task stays `ready` forever?** Check if task-dispatch plugin is loaded: `openclaw gateway call health --json | grep task-dispatch`
2. **Plugin not loading?** Check `activation.onStartup` in `openclaw.plugin.json` and `openclaw.extensions` in `package.json`
3. **Discord thread empty?** Check if `api.runtime.acp.prompt()` is available — requires fork with `allowAcpSpawn: true`
4. **`Cannot find module 'ajv'` in logs?** Non-fatal — comes from bundled config validation. Does not block ACP delivery.
5. **Agent explores instead of replying?** Use stricter prompt (see smoke test guidance)
6. **Timeout on first task after restart?** Normal — 60s startup cooldown. Increase `--timeout`.
7. **`runTurn` completes but no Discord output?** Using wrong code path — must go through `api.runtime.acp.prompt()`, not direct `runTurn()`
8. **Binding fails?** Check Zeus Discord permissions: `VIEW_CHANNEL`, `SEND_MESSAGES`, `CREATE_PUBLIC_THREADS`, `SEND_MESSAGES_IN_THREADS`
9. **acpx timeout / empty apply_patch?** Increase `plugins.acpx.config.timeoutSeconds`

---

## 8. Related references

- OpenClaw fork: `/Volumes/SumoDeus NVMe/openclaw/openclaw-fork` (branch `fork/v2026.5.7-acp`)
- OpenClaw PR: `https://github.com/openclaw/openclaw/pull/63176`
- OpenClaw issue: `https://github.com/openclaw/openclaw/issues/65022`
- Fork update skill: `~/.agents/skills/openclaw-fork-update/SKILL.md`
- task-dispatch plugin: `~/.openclaw/extensions/task-dispatch`
