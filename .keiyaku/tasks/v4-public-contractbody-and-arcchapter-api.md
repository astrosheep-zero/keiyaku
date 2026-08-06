---
id: v4-public-contractbody-and-arcchapter-api
title: v4 public ContractBody and ArcChapter API
state: in_progress
pri: 0
needs: []
parent: v4-architecture-correct-extensible-mvp
from: []
createdAt: 2026-08-06T01:52:34.179Z
updatedAt: 2026-08-06T01:52:48.314Z
creator: thekoc
startedAt: 2026-08-06T01:52:48.314Z
---
Implement docs/architecture.md package-root document law: ContractBody.parse/render/amend and ArcChapter.parse are the sole public document vocabulary. Keep body and markdown pure, replace no CLI imports in this slice, and add small exact round-trip/amend/arc boundary tests. Do not invent grammar beyond docs/cli.md.
