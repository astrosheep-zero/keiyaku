---
id: 冻结contractstate为bind证明后的-5c1eb3a4
title: 冻结ContractState为bind证明后的全字段模型
state: open
pri: 0
needs: []
parent: null
from: []
createdAt: 2026-08-06T18:10:23.267Z
updatedAt: 2026-08-06T18:10:23.267Z
creator: thekoc
---
按 docs/model.md Folded State：缺失只由 ContractObservation.state:null 表示；ContractState coordinates/terms 必须非空，删除所有不可达防御分支与测试构造。
