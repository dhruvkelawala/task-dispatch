# Legacy BadVibes post-merge reviewer removal

Removed from this worktree on 2026-09-14. No commit, push, deployment, gateway restart, or runtime credential/state migration was performed.

## Reference inspection and boundary

Inspected references across source, tests, package scripts, configuration examples, README, SKILL.md, docs, the plugin manifest, and the tracked `index.mjs.bak`. Traced webhook intake through repository mapping, debounce state, task creation, completion, cursor advancement, and issue delivery before deleting it. The GitHub App helper and local `.env` loader had only legacy consumers. `createTaskRecord` in the plugin entry point also served only this subsystem; ordinary task creation remains in `routes/tasks.ts`.

Nemesis task QA is a separate flow in `dispatch-runtime.ts` and `qa.ts`. Its review status and task review attempts are not legacy state. The project GitHub commit refresh/summary integration is also unrelated and remains.

## Exact removed surface

| Surface | Removal |
| --- | --- |
| Webhook bridge | `src/bridge/index.ts`, including the HTTP server, `POST /github/webhook`, signature verification, ping handling, push normalization, repository allowlist and forwarding. |
| Bridge helpers | `src/github-webhook.ts`, including payload/config types, `verifyGitHubSignature`, `normalizeGitHubPushWebhook`, `isGitHubPingEvent`, `buildTaskDispatchReviewForwardRequest`, `forwardGitHubReview`, and `isRepoAllowedForBridge`. |
| Intake | Dedicated `POST /api/tasks/review` registration and `handleCreateReview` dependency in `task-api-runtime.ts`; the intake handler and its wiring in `index.ts`. The remaining generic task prefix returns 405 for POST to that path, with no review creation. |
| Review policy | `src/plugin/review.ts`: repo mapping, SHA range planning, task title/prompt generation, debounce constants/setter, state transitions, completion policy, and structured post-merge summary parser/types. |
| Review runtime | `src/plugin/review-runtime.ts`: pending/active review creation, window updates, debounce timers, restart rearming, deduplication, completion/retry handling, cursor advancement, issue writing and thread summaries. Removed its setup, statements, timer map, installation lookup and task completion hook from `index.ts`. |
| Entry-point helpers | Legacy-only `createTaskRecord`, `resolveReviewAgentId`, `loadLocalEnvOverrides`, and the now-unused `createRequire` import/declaration. |
| Legacy ACP handling | `review:` chain-prefix special case, post-merge JSON validator, special poll limit and `review.output_invalid` handling from `dispatch-runtime.ts`. Normal ACP output polling remains at its existing limit of 20. |
| Issue writer | `src/plugin/review-issues.ts`: finding fingerprints, labels, titles/bodies, severity filtering, duplicate planning, dry-run and live issue operations. |
| GitHub App auth | `src/plugin/github-app-auth.ts`: JWT signing/private-key loading, installation tokens, fingerprint issue search, issue creation and comments. |
| Database | Creation of `review_state` and `review_deliveries`, the installation-ID column migration, their prepared queries/upserts, and their in-memory fallback tables/operations. |
| Configuration | `defaults.reviewDebounceMs`, `defaults.reviewThreadPollTimeoutMs`, `defaults.reviewThreadPollLimit`, and `projects.*.reviewAgent`. The timeout setting was already unused by the dispatcher. |
| Environment | Deleted the wholly bridge-specific `.env.example`: `GITHUB_WEBHOOK_SECRET`, `TASK_DISPATCH_URL`, `TASK_DISPATCH_API_KEY`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, and the commented `REVIEW_DEBOUNCE_MS` example. Removed the bridge's `GITHUB_REVIEW_BRIDGE_PORT` and `OPENCLAW_API_KEY` fallback reads with its source. No actual secrets were changed. |
| Scripts | Removed package script `bridge` (`bun run src/bridge/index.ts`). Build, CLI and verification scripts remain. No separate scripts directory existed. |
| Tests | Deleted `tests/github-webhook.test.ts`, `tests/review.test.ts`, `tests/review-runtime.test.ts`, `tests/review-issues.test.ts`, and the incomplete post-merge JSON dispatch test. Converted shared chronological-output and framing fixtures to generic task output, preserving their coverage. |
| Docs | Deleted `docs/badvibes-claude-test.md`, `docs/badvibes-codex-test.md`, and the misspelled `docs/badvives-codex-test-2.md` push-test notes. Kept the ACP status document and README QA documentation. |

`review_state` held repo, last reviewed SHA/time, pending range/task/time and active range/task. `review_deliveries` held delivery key, repo/SHA, task, status, acceptance time and installation ID. Existing databases are not dropped, rewritten or migrated by this change; old tables and historical tasks can remain inert data. No legacy timers or issue-writing hooks remain to process them.

Removed event producers include `review.request.accepted`, `review.activated`, `review.cursor_advanced_empty_output`, `review.issues_written`, `review.issues_failed`, `review.cursor_advanced`, `review.max_retries_exceeded`, `review.cursor_not_advanced`, and `review.output_invalid`. Generic task status events, including `task.review`, remain.

## Preserved behavior

- Task `review` status, legal transitions, `reviewAttempts` / `review_attempts`, their migration and API update/reset behavior, and `qaRequired` / `qa_required`.
- `POST /api/tasks/:id/qa`, CLI QA, queued QA work, Nemesis subagent selection/model, verdict parsing, approval, fix requests, attempt limits and blocking.
- QA settings `reviewTimeoutMs` and `maxReviewCycles`; agent configuration including Nemesis; generic API-key authentication.
- Normal task creation/update/delete, dependencies, task chains, dispatch, resume/restart recovery, Discord thread output/delivery, SSE/events/comments, schedules, heartbeats, projects, GitHub commit refresh/summaries, health and usage routes.
- `index.mjs` remains the existing symlink to `build/plugin.mjs`; `index.mjs.bak` contains no legacy post-merge subsystem and was left untouched. Dependency manifests/lockfiles are unchanged except removal of the bridge script.

The full formatter also normalized pre-existing layout in `src/plugin/routes/projects.ts` and `tests/cli-commands.integration.test.ts`, plus formatting within already changed files. These changes are mechanical and preserve behavior.

## Regression and verification

Added `tests/legacy-badvibes-removal.test.ts` before any implementation removal. Initial `bun test tests/legacy-badvibes-removal.test.ts` exited 1: **2 passed, 2 failed**, specifically because `/api/tasks/review` was registered and all six legacy module paths existed. The task-prefix POST rejection and QA preservation checks already passed. After removal, the same file passed all four tests.

Additional coverage verifies fresh database initialization omits both legacy tables and Nemesis QA still runs with the configured model, approves tasks, records review attempts, and blocks at the attempt limit. Shared multi-message output coverage now parses generic JSON without importing the retired summary parser.

Environment preparation: `bun install --frozen-lockfile` installed the existing locked dependencies. This checkout lacked the host OpenClaw SDK, causing the first typecheck to report missing SDK imports. Added only an ignored, worktree-local `node_modules/openclaw` symlink to `/opt/homebrew/lib/node_modules/openclaw` (version `2026.6.11`), matching the repository's documented host-SDK setup. No global installation or runtime configuration was changed. Verification therefore requires that compatible host SDK in addition to the locked dependencies.

| Final command | Result |
| --- | --- |
| `bun run format:check` | PASS, all 37 source/test files formatted. |
| `bun run lint` | PASS, 0 errors, 4 pre-existing unused-symbol warnings. |
| `bun run typecheck` | PASS. |
| `bun run test` | PASS, 63 tests across 15 files, 157 assertions, 0 failures. |
| `bun run build` | PASS: plugin bundle and compiled CLI. |
| `git diff --check` | PASS. |

The four existing lint warnings are `existsSync` in `tests/public-config.test.ts`, and `titleFromProjectId`, `broadcastSseEvent`, and the destructured `resolveBotToken` in `src/plugin/index.ts`. They are outside the removal scope. The newly unused legacy `require` declaration was removed.

Final reference audit found no legacy identifiers/routes/configuration in active source or remaining operational docs. Historical names occur only in this removal record and regression assertions. Tests use test databases, mock runtimes and a local test API; no live reviewer, GitHub write, or Nemesis session was invoked.

## Review-ready gate

- Contract: `/Users/sumo-deus/.codex/skills/review-ready/contract.md` (bundled default; no repository override found).
- Changed seam: legacy HTTP intake, module surface, persistence initialization and ACP post-merge specialization.
- Trace: retired POST falls through to the generic task handler and returns 405; task QA POST still queues `qa`, whose worker invokes Nemesis and preserves approval/attempt-limit behavior.
- Four tests: caller-knowledge — no legacy dependency remains for task API callers; deletion — legacy complexity disappears instead of moving into QA; ownership — task QA remains in its existing modules; test-surface — registered routes, responses, schema initialization and injected subagent runtime are exercised. Module absence is asserted explicitly as requested.
- Simplification pass: removed legacy-only task construction, environment loading, auth setup, imports, state queries and special output validation; introduced no replacement subsystem or compatibility wrapper.
- Verification: all commands above passed; changed scope and reference boundaries reviewed after green tests.
- Exceptions: none. Existing lint warnings and formatter-only changes are recorded above.
