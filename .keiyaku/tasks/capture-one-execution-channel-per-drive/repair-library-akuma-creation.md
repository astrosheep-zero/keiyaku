---
id: task/capture-one-execution-channel-per-drive/repair-library-akuma-creation
title: Repair Library Akuma creation routing regression
state: done
priority: 0
needs: []
parent: task/architecture-ownership/inject-one-per-drive-execution
supersedes: []
relates: []
note: Unrelated ProviderAttempt fixture migration completed in ae33d32f; full tests/library-akuma-creation.test.ts passes 10/10.
createdBy: aku/worker/4b5380b1
createdAt: 2026-08-28T15:07:40.535Z
updatedAt: 2026-08-28T15:12:33.770Z
---
Reproduce the failing tests/library-akuma-creation.test.ts case verbosely. Determine whether the captured execution-channel Arc caused it; repair only an Arc-caused regression, rerun the focused file and Arc verification, or retain an exact unrelated-failure report without changing unrelated code.