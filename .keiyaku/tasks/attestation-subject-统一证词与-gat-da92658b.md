---
id: task/attestation-subject-统一证词与-gat-da92658b
title: Attestation subject 统一证词与 gate 新鲜度
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
contractId: null
---
落实 Square 裁决 #175。先把 attestation、subject 与 currentSubject 的现行法写入 model/lifecycle/verification owner docs，再硬切持久化模型与实现。

验收：review 与 verification 两个生产者只产一种 attestation fact；gate 只比较 current subject 并读取 verdict；旧 review/verification facts、字段、state arrays、freshness predicates 与 refusal kinds 零残留。新增精准回归：review 后 amend Objective/Criteria 会使 reviewed 失效；与 Verification 无关的正文修改不使 verified 失效。按 current-version-only 政策不保留兼容或迁移路径。