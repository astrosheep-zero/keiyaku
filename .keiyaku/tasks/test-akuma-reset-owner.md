---
id: task/test-akuma-reset-owner
title: Test Akuma reset owner
state: done
priority: 1
needs: []
parent: task/implement-akuma-owned-reset-arm
supersedes: []
relates: []
note: "Focused real-state tests pass: preview preservation, unverified-stop non-deletion, successful asleep/running teardown, foreign-byte preservation, and repeat nothing."
createdBy: aku/worker-2/015c1ba7
createdAt: 2026-08-19T11:30:45.593Z
updatedAt: 2026-08-19T11:37:41.616Z
---
Add real-state preview, stop failure, successful cleanup, preservation, and idempotent retry tests.