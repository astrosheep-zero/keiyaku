---
id: task/architecture-convergence/delete-residual-private-boundary
title: Delete residual private boundary mirrors
state: done
priority: 0
needs: []
parent: task/architecture-convergence/close-or-bind-residual
supersedes: []
relates: []
note: ""
createdAt: 2026-08-29T19:36:05.322Z
updatedAt: 2026-08-29T21:05:55.569Z
---
Remove only the five census-proven private redundancies: Contract-handle re-export mirror, unused reconciliation effect decoder, unused aggregate Task schemas, test-only requestForwardedContract wrapper, and dead small exports. Preserve package-root types, command-owned runtime decoding, direct results, typed failures, and all behavior; update architecture policy/tests mechanically and prove no references remain.

Delivery evidence (2026-08-30): focused tests/akuma-body-requests.test.ts passed (36/36); npm run test:typecheck, npm run build, npm run test:architecture, and npm run test:reachability passed. The declared npm test reached test:parallel but failed on host-level EPERM/canonical-world/process-listen failures outside this patch; no changed-surface failure was reported.

Review follow-up (2026-08-30): contract-handle now exports only KeiyakuHandle and seatForKeiyaku. Direct consumers are contract.ts (KeiyakuHandle) and akuma-creation.ts (seatForKeiyaku). npm run test:typecheck, npm run test:architecture, npm run test:reachability, and git diff --check pass.