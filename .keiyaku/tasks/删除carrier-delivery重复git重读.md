---
id: 删除carrier-delivery重复git重读
title: 删除carrier-delivery重复git重读
state: done
pri: 1
needs: []
parent: null
from: []
createdAt: 2026-08-06T17:12:41.659Z
updatedAt: 2026-08-07T04:47:55.671Z
creator: thekoc
---
Reduce synchronous Git process count without adding cache/state: resolve workspace HEAD and HEAD tree in one structured rev-parse call; reuse WorkspaceTree.tree as the candidate tree for stablePatchId instead of re-reading candidate^{tree}. Preserve dirty/private-index behavior and patch identity.