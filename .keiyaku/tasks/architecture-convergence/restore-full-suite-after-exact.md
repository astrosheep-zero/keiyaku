---
id: task/architecture-convergence/restore-full-suite-after-exact
title: Restore full suite after exact World proof
state: done
priority: 0
needs: []
parent: task/architecture-convergence/close-or-bind-residual
supersedes: []
relates: []
note: ""
createdAt: 2026-08-29T19:51:51.004Z
updatedAt: 2026-08-29T20:20:47.463Z
---
Systematically migrate every stale test fixture exposed by full npm test after exact WorldRoot proof: use canonical physical temporary World coordinates and provide the already-minted Body launch World capability in request harnesses. Do not relax World.prove, add casts, or change production behavior. Full npm test must pass.

Census, 2026-08-30 host npm test before fixture edits (27 test failures):
- tests/akuma-body.test.ts: one request-pump launch harness lacks the minted launch World; its child-id assertion is the symptom.
- tests/akuma-requests.test.ts: two akuma.call request-pump harnesses lack the minted launch World.
- tests/facade-fleet.test.ts: nineteen Fleet scenarios supply a noncanonical temporary root (/var alias); each reaches World.prove before its intended assertion.
- tests/square-edge-cleanup.test.ts: four launch-failure scenarios supply the same noncanonical temporary root.
- tests/windows-akuma-process.test.ts: one provider integration cannot bind 127.0.0.1 in this execution sandbox (EPERM), independent of fixture World proof.
No production failure was observed. Migrate the first four groups in test setup; retain the provider integration as an environment blocker if it remains after focused checks.