---
id: task/v4-public-contractbody-and-arcchapter-api
title: v4 public ContractBody and ArcChapter API
state: drop
priority: 0
needs: []
parent: task/v4-architecture-correct-extensible-mvp
supersedes: []
relates: []
contractId: null
---
Implement docs/architecture.md package-root document law: ContractBody.parse/render/amend and ArcChapter.parse are the sole public document vocabulary. Keep body and markdown pure, replace no CLI imports in this slice, and add small exact round-trip/amend/arc boundary tests. Do not invent grammar beyond docs/cli.md.

Superseded by Acts 325-327: public parse/amend/ArcChapter.parse are no longer public and construction returns to Keiyaku.bind/of.