---
id: task/post-audit/strict-typecheck-public-contract-f2c1
title: Strict-typecheck public Contract facade tests
state: done
priority: 2
needs: []
parent: task/migrate-remaining-historical
supersedes: []
relates: []
note: ""
createdAt: 2026-09-01T16:52:23.722Z
updatedAt: 2026-09-01T17:28:24.204Z
---
Bring tests/library-contract-operations.test.ts, tests/public-library.test.ts, and tests/facade-contract.test.ts into the maintained strict subset. Replace historical direct KeiyakuHandle.id access with current public state/observation identity, update stale export-list assertions to the current documented package facade where necessary, and adapt result/fixture typing without changing production behavior. Keep one public type authority, remove obsolete casts and fields, and do not touch unrelated historical tests or architecture baselines. Verify focused facade behavior tests and the strict typecheck.