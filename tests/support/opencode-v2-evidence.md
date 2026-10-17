# OpenCode v2 execution evidence

## Native producer

- Installed executable: `opencode v2.0.20`.
- Matching SDK: `@opencode/client@2.0.20`. The older
  `@opencode-ai/sdk` package's `/v2` export is not this major-version protocol.
- Producer revision: anomalyco/opencode tag `v2.0.20`,
  `84c9be93a56304a108f1a22df0c5d62c26d5b6ca`.
- A separately spawned local server's authenticated `/openapi.json` matched
  `/tmp/opencode-openapi.json`. Native readiness was confirmed with `/api/info`.
- Producer sources inspected at that revision: `packages/server/src/handlers/`
  session and event handlers; `packages/core/src/session/` session, execution,
  inbox, message-updater, projector, instruction-entry, instruction-state and
  model-request; `packages/schema/src/` event, session-event and agent;
  permission evaluation and config agent composition; native question, edit,
  write, shell, patch and file-diff producers; matching client generation and
  shared-event retirement.

The native probe confirmed durable inbox admission followed by exact inbox
consumption, assistant-step identity and execution termination. The terminal
event's native projected idle-message identity is the retained historical fork
boundary: native fork *before* that message includes the completed answer and
excludes later work. Forking before the assistant itself excludes the answer;
omitting the boundary copies current latest history instead. Neither is used.

The SDK event subscriber retires logically before its underlying connection
necessarily closes. A dedicated Undici dispatcher independently proves physical
connection retirement. Stream loss is not retried. Native effect stream-failure
payloads fail observation even though the SDK SSE parser can yield them.

## Live adapter evidence

All model executions explicitly requested
`opencode/deepseek-v4.1-flash-free`; no alternative model or provider was used.
The final SDK-based run recorded:

| Operation | Native evidence | Adapter result |
| --- | --- | --- |
| Fresh no-tools prompt | `ses_eb8d313b2ffeci4dbjBqLIHgsk`; confirmed model event | `answered`, exactly `OK` |
| Exact fork | before retained `msg_1472cf897001SCsmxBzaBITFlj` | child `ses_eb8d30544ffeTbn6lcLA8YnHDM` |
| Resume child | confirmed same model; prompt requested previous one-word answer | exactly `OK` |
| Append system instructions | native durable instruction context; confirmed same model | exactly `SYSTEM_OK` |
| Interrupt resumed source | native interrupt completed | `failed: OpenCode session interrupted` |

Every attempt's `closed` promise resolved. The live script exited naturally
with status 0. Full local evidence is
`/tmp/kei-opencode-sdk-live-evidence.json` (stderr counterpart empty).
The independent protocol probe is `/tmp/kei-opencode-native-v2-evidence.json`;
producer source extracts are under `/tmp/kei-opencode-v2-producer`.
Those files are diagnostic evidence, not a product runtime dependency.

## Capabilities and deliberate refusals

- Additional system instructions use the native instruction-entry facility.
  Its producer renders initial entries into the system transcript and announces
  later changes; native resume/fork retain this context.
- Per-Turn replacement of the native system prompt is not exposed. Native agent
  configuration is not silently substituted for this capability.
- The v2 session prompt does not expose native structured-answer schemas.
  Schema attempts fail explicitly rather than dropping their requirement.
- Effort is the requested model's native variant; effort without an explicit
  model refuses rather than selecting a configured default accidentally.
- Observed busy sessions refuse before submission. Consumed foreign input during
  an execution fails attribution rather than adopting another writer's answer.
- Historical coordinates that do not identify a successful native terminal
  boundary refuse fork rather than copying a nearby or latest history point.

Headless defaults were checked against the v2 agent and question producers.
External-directory and environment-file read asks are overridden by baseline
rules; question is denied before its native form wait. Caller action rules
replace the corresponding baseline action. The old doom-loop ask is not a v2
agent default. Native non-permission configuration passes through unchanged.

## Verification

Commands exercised:

```sh
npm run build
npm run test:typecheck
npm test -- --test-timeout=30000 tests/opencode-live-tell.test.ts tests/opencode-sse-custody.test.ts tests/akuma-provider.test.ts
npm test -- --test-timeout=30000 tests/architecture.test.ts tests/package-consumers.test.ts
```

These passed, including physical socket closure, cancelled subscription setup,
stream failure, exact answer correlation, native option refusal, completed tool
output and producer-verified patches, and Body stop/Heart-loss supervision during
unproven closure. Optional Square and Paseo observers are disabled in the Body
watchdog fixture; they are not provider custody.

Contract audit also ran both declared Verification blocks successfully in its
clean integration scratch. It observed target `main` one commit ahead, with a
placeable integration and no overlap with the adapter change.

Dependency changes use npm with an authoritative package lock. No `npm ci` was
run in the managed worktree. `npm install` replaced this worktree's shared
`node_modules` symlink with a local dependency directory; primary tracked files,
shared dependencies, global OpenCode config and the intern archetype were not
modified by this delivery. Review is reserved for the commissioning Holder.
