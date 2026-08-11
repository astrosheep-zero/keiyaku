---
id: task/删除carrier-delivery重复git重读
title: 删除carrier-delivery重复git重读
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-07T04:47:55.777Z
updatedAt: 2026-08-07T11:29:07.446Z
---
Reduce synchronous Git process count without adding cache/state: resolve workspace HEAD and HEAD tree in one structured rev-parse call; reuse WorkspaceTree.tree as the candidate tree for stablePatchId instead of re-reading candidate^{tree}. Preserve dirty/private-index behavior and patch identity.