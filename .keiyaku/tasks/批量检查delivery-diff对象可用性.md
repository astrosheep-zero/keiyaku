---
id: 批量检查delivery-diff对象可用性
title: 批量检查Delivery-diff对象可用性
state: open
pri: 1
needs: []
parent: null
from: []
createdAt: 2026-08-06T17:24:52.543Z
updatedAt: 2026-08-06T17:25:02.625Z
creator: thekoc
---
Replace per-snapshot cat-file -e plus -t probes in readDeliveryDiff with one structured cat-file --batch-check for predecessor and candidate. Preserve null for missing/pruning races, TypeError for non-commit recorded objects, raw diff text, and no cache. Happy path should use one availability process plus one diff process.