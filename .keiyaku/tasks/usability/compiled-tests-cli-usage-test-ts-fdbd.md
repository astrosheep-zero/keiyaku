---
id: task/usability/compiled-tests-cli-usage-test-ts-fdbd
title: Compiled tests/cli-usage.test.ts hangs on main
state: open
priority: 1
needs: []
parent: null
supersedes: []
relates:
  - task/usability/investigate-inconsistent-full-6096
note: node scripts/run-tests.mjs --compiled tests/cli-usage.test.ts hangs indefinitely (zero output, timeout kill exit 124 at 120s/240s). Reproduced identically on pre-merge main 8d3da7880 and merged main 0cde1b6a5. Source mode (test:focused) passes. Compiled cli-usage passed on the wip/akuma-surface-cleanup lineage, so the hang entered via one of the 6 CLI keis 996fd87f9..8d3da7880 (close-mark-vocabulary, overlap-receipts, idempotent-verification, receipt-hygiene, uniform-cli-refusals, pipe-safe-cli-receipts). cli-usage is in TEST_MANIFESTS, so the release sweep (npm test) likely hangs on it too — distinct from the timing flakes in investigate-inconsistent-full-6096.
createdAt: 2026-09-27T00:39:45.643Z
updatedAt: 2026-09-27T00:39:45.643Z
---
