---
id: task/实现region单快照观察与公开结果
title: 实现Region单快照观察与公开结果
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates:
  - task/实现region闭合方言与精确相交
note: ""
createdAt: 2026-08-07T04:48:13.855Z
updatedAt: 2026-08-07T11:29:07.449Z
---
Authority boundary correction: public-api.md says Region is library-edge and explicitly requests no protocol document-body reader. Remove protocol documentsOperation/read/documents. Keep the required full-world Region observation at library edge by consuming one carrier observation of opaque accepted state/document bytes, then decode/intersect only in library. Full-world O(N) is legal here; do not push Region vocabulary into carrier/protocol or drop the documented report.

Correction from Square act 349/#186: retain protocol/read/documents.ts. It is the ruled internal primitive: one observeCarrier snapshot, fold/filter nonterminal contracts, return only {contract, documentBytes}; library removes self and decodes Region, never imports carrier. The previous note proposing removal was based on stale owner-doc wording. Docs/public-api.md and transport.md have now been corrected to the later ruling.