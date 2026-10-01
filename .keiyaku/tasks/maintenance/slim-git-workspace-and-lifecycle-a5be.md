---
id: task/maintenance/slim-git-workspace-and-lifecycle-a5be
title: Slim Git, workspace, and lifecycle fixtures
state: done
priority: 2
needs: []
parent: task/maintenance/repository-wide-simplification-adad
supersedes: []
relates: []
note: ""
createdAt: 2026-09-29T13:38:26.583Z
updatedAt: 2026-09-29T15:29:45.661Z
---
Reduce repeated repository, candidate, delivery, target-placement, protocol-bind, and forwarding-result fixture construction. Remove confirmed dead test Git helpers and table-drive repeated rejection cases without dropping any case. Preserve Git custody, workspace, lifecycle, and public-result boundaries.