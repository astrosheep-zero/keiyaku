---
id: task/test-workflow-layering-and-dfa7
title: Test workflow layering and timing
state: done
priority: 1
needs: []
parent: task/test-suite-slimming-and-a161
supersedes: []
relates: []
note: Layering landed in package.json + test-entry/run-tests only. Release gates preserved. test:parallel stays sequential two-suite. Full npm test not re-run in this lane.
createdAt: 2026-09-02T12:22:07.434Z
updatedAt: 2026-09-02T13:05:41.784Z
---
Make development and release verification explicit without changing product semantics.

Inspect test-entry, run-tests, package scripts, and manifests. Add only lightweight phase/suite timing if needed for repeatable CI evidence. Design test:dev versus test:release behavior, keep existing command compatibility, and decide whether test:parallel should remain sequential, be renamed, or use a single runner invocation.

Acceptance: command execution graph is documented in the task result; any script change has focused verification and does not silently omit a release gate.
## Result (2026-09-02)

### Decisions
- `test:release` / `test:all` / bare `npm test`: identical release gate set as before (format:check, build, architecture, maintainability, reachability, then test:parallel).
- `test:dev`: typecheck + architecture + local suite only (no format/build/knip/integration). Honest cheaper loop; not a release substitute.
- `test:parallel`: keep two sequential runner invocations (local then integration), each with `--test-concurrency=8`. Do not rename; do not merge into one runner; do not claim cross-suite concurrency.

### Command execution graph
- `npm test` -> `scripts/test-entry.mjs`
  - no args | `--release` -> timed release phases (same gates as historical test:all)
  - `--dev` -> timed dev phases
  - other args -> `scripts/run-tests.mjs` (focused; `--runInBand` maps to `--test-concurrency=1`)
- `npm run test:all` / `npm run test:release` -> `scripts/test-entry.mjs --release`
- `npm run test:dev` -> `scripts/test-entry.mjs --dev`
- `npm run test:parallel` -> local suite (concurrency 8) && integration suite (concurrency 8)
- `npm run test:local` / `test:integration` / `test:focused` -> `scripts/run-tests.mjs` unchanged
- CI still uses `npm test` (release) plus separate e2e/typecheck/lint

### Timing
- Phase lines: `[test:release|test:dev] <phase> <ms> status=<n>`
- Suite lines: `[run-tests] suite=<name> files=<n> elapsed=<ms> status=<n>`

### Focused verification
- `npm run test:focused -- tests/run-tests.test.ts` -> pass, ~1.4s
- `npm test -- tests/run-tests.test.ts` -> pass, ~1.0s
- unknown suite still fail-closed; `--dev` rejects extra file args
- release smoke starts `format:check` with phase timing (full release not re-run here)