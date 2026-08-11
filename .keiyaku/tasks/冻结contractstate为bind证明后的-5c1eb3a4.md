---
id: task/冻结contractstate为bind证明后的-5c1eb3a4
title: 冻结ContractState为bind证明后的全字段模型
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-06T18:27:00.146Z
updatedAt: 2026-08-07T11:29:07.444Z
---
按 docs/model.md Folded State：缺失只由 ContractObservation.state:null 表示；ContractState coordinates/terms 必须非空，删除所有不可达防御分支与测试构造。