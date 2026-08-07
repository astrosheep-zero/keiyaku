---
id: task/批量检查delivery-diff对象可用性
title: 批量检查Delivery-diff对象可用性
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
contractId: null
---
Replace per-snapshot cat-file -e plus -t probes in readDeliveryDiff with one structured cat-file --batch-check for predecessor and candidate. Preserve null for missing/pruning races, TypeError for non-commit recorded objects, raw diff text, and no cache. Happy path should use one availability process plus one diff process.