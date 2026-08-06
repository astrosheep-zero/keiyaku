---
id: 恢复-amend-展示-diff-的最小结果能力
title: 恢复-amend-展示-diff-的最小结果能力
state: open
pri: 0
needs: []
parent: null
from: []
createdAt: 2026-08-06T22:26:10.439Z
updatedAt: 2026-08-06T22:52:24.904Z
creator: thekoc
---
Owner: docs/cli.md and docs/public-api.md after act_362 integration.

`amend` must render the documented presentation diff through the JS `diff` library. Package root has no public Receipt/prior/snapshot, so the library computes it once from exact admitted before/after document bytes and returns nonoptional `documentDiff: string` on amend's accepted observation. It is not body methodology, fact, Receipt, cache, value text, or gate input. CLI renders it directly. Add focused public-library and CLI tests; do not couple task settlement or contract result to presentation text.
