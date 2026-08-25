---
id: task/maintainability-exemption-audit/synthesize-exemption-rulings
title: Synthesize exemption rulings with Faye
state: done
priority: 0
needs: []
parent: task/maintainability-exemption-audit/audit-every-maintainability
supersedes: []
relates: []
note: ""
createdAt: 2026-08-24T00:52:59.989Z
updatedAt: 2026-08-24T01:53:11.374Z
---
Final audit ruling

Current inventory is 32 owner entries containing 26 file caps and 12 named-function caps, for 38 threshold controls.

All 12 files currently above 500 effective lines must be reorganized below 500. Each has a concrete ownership boundary; none earns a permanent oversized-file exemption:

1. scripts/architecture/policy.ts: keep one composed policy authority, move zone declarations into domain-owned policy fragments.
2. scripts/architecture/engine.ts: separate TypeScript source analysis from policy and graph diagnostics through the parsed source value.
3. src/git/reconcile.ts: move terminal seal, recovery, cleanup, and ref-custody reconciliation behind one operation called inside the existing per-Contract lock.
4. src/akuma/body-turn.ts: move Body lifetime observation and control supervision out of Turn drive custody.
5. src/akuma/request-serve.ts: separate admitted request execution and upstream dispatch from the live filesystem pump and predecessor recovery.
6. src/akuma/akuma.ts: separate the addressed Akuma handle and controls from product birth, list, and call composition.
7. src/library/contract.ts: separate shared delivery/review execution and bind adaptation from the addressed Contract handle.
8. src/cli/invoke.ts: move command-family adaptation to existing commands owners while retaining one cwd, Repo, World, Settings, and stdin orchestration edge.
9. src/akuma/projection.ts: separate complete Heart-to-ledger folding from bounded snapshot/history aperture selection.
10. src/cli/parse.ts: move help composition out of argv grammar and scanning.
11. src/cli/render/akuma.ts: separate activity/snapshot presentation from command receipts, exit codes, and JSON projection.
12. src/cli/render/contract.ts: move Contract history rendering out of mutation receipt rendering.

Live advisory-band file caps remain for provider.ts, request-wire.ts, task-invoke.ts, render/kanshi.ts, hooks.ts, integration.ts, observe.ts, repository.ts, target-placement.ts, kanshi/read.ts, library/fleet.ts, task/operations.ts, and workspace-place.ts. They suppress the maintained warning band from 401 through 500; line count alone does not justify splitting them. Re-cap target-placement.ts and render/kanshi.ts to the minimum legal 501. First remove duplicated local/forwarded mutation construction from task-invoke.ts; delete its file cap if the resulting effective count is at most 400.

Delete the stale deliver.ts file cap because the file is 368 effective lines.

Named-function caps:
- Delete stale bindKeiyaku (43), prepareDelivery (72), and renderRefusalFacts (77). This removes the entire deliver and refusal owner entries once their stale file/function controls are gone.
- Remove invokeParsed (84) when command-family adaptation moves out and the function naturally returns below 80.
- Retain projectTurns (85), observeKanshi (82), batchObjectReader (87), observeClaudeQuery (96), driveClaude (92), startCodex (84), OpenCode drive (97), and drivePi (98). These are one-pass fold, one observation epoch, one batch channel lifecycle, or one provider-native session lifecycle. Do not split or extract helpers merely to satisfy 80.

Add stale-exemption validation after structural refactoring: a file cap is stale at no more than 400 effective lines; a named function cap is stale at no more than 80. The check measures current source and does not add tolerance or headroom policy.

Implementation order

1. Delete currently stale controls and add measured stale validation.
2. Split architecture policy/engine and CLI parse/invoke boundaries.
3. Split pure projections and renderers.
4. Split Contract facade adaptation.
5. Split Git terminal reconciliation without changing lock scope.
6. Split Akuma supervision, request execution, addressed handle, and aperture selection without changing Heart admission or provider custody order.
7. Re-measure, remove every obsolete exemption, run maintainability, typecheck, architecture, full tests, and build.
