---
id: task/删除carrier-delivery重复git重读
title: 删除carrier-delivery重复git重读
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
contractId: null
---
Reduce synchronous Git process count without adding cache/state: resolve workspace HEAD and HEAD tree in one structured rev-parse call; reuse WorkspaceTree.tree as the candidate tree for stablePatchId instead of re-reading candidate^{tree}. Preserve dirty/private-index behavior and patch identity.