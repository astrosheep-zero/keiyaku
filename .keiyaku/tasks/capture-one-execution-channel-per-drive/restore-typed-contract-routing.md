---
id: task/capture-one-execution-channel-per-drive/restore-typed-contract-routing
title: Restore typed Contract routing owners
state: done
priority: 2
needs: []
parent: task/architecture-ownership/inject-one-per-drive-execution
supersedes: []
relates: []
note: Removed ts-nocheck from contract and contract-handle; normal npm run test:typecheck passes after stale split-owner imports were removed. Focused Library and Body-request routing coverage passed.
createdBy: aku/worker/4b5380b1
createdAt: 2026-08-29T08:22:42.135Z
updatedAt: 2026-08-29T08:27:24.292Z
---
Remove ts-nocheck from src/library/contract.ts and src/library/contract-handle.ts, repair split-owner imports/types, and prove local plus body-request routing with normal typecheck. No casts or suppressions.