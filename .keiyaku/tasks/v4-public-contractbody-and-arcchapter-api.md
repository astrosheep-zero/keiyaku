---
id: v4-public-contractbody-and-arcchapter-api
title: v4 public ContractBody and ArcChapter API
state: drop
pri: 0
needs: []
parent: v4-architecture-correct-extensible-mvp
from: []
notes:
  - actor: thekoc
    timestamp: 2026-08-06T02:11:55.040Z
    text: "Superseded by Acts 325-327: public parse/amend/ArcChapter.parse are no longer public and construction returns to Keiyaku.bind/of."
createdAt: 2026-08-06T01:52:34.179Z
updatedAt: 2026-08-06T02:11:55.040Z
creator: thekoc
---
Implement docs/architecture.md package-root document law: ContractBody.parse/render/amend and ArcChapter.parse are the sole public document vocabulary. Keep body and markdown pure, replace no CLI imports in this slice, and add small exact round-trip/amend/arc boundary tests. Do not invent grammar beyond docs/cli.md.
