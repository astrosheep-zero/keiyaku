---
id: 实现region单快照观察与公开结果
title: 实现Region单快照观察与公开结果
state: in_progress
pri: 0
needs: []
parent: null
from: []
relatesTo:
  - 实现region闭合方言与精确相交
notes:
  - actor: thekoc
    timestamp: 2026-08-06T23:09:56.497Z
    text: "Authority boundary correction: public-api.md says Region is library-edge and explicitly requests no protocol document-body reader. Remove protocol documentsOperation/read/documents. Keep the required full-world Region observation at library edge by consuming one carrier observation of opaque accepted state/document bytes, then decode/intersect only in library. Full-world O(N) is legal here; do not push Region vocabulary into carrier/protocol or drop the documented report."
createdAt: 2026-08-06T15:50:42.395Z
updatedAt: 2026-08-06T23:09:56.497Z
creator: thekoc
startedAt: 2026-08-06T15:53:02.702Z
---
