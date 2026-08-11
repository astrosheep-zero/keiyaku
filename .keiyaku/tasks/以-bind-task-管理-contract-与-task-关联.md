---
id: task/以-bind-task-管理-contract-与-task-关联
title: 以 bind --task 管理 Contract 与 Task 关联
state: drop
priority: 2
needs: []
parent: null
supersedes: []
relates: []
note: Superseded by the approved high-level facade hard-cut slices; retain no stale semantics.
createdAt: 2026-08-10T01:47:53.505Z
updatedAt: 2026-08-11T02:05:05.108Z
contractId: null
---
ContractId 保存在 Task 只是底层实现字段；用户实际入口改为 bind --task，Task CLI 删除 --contract 输入。明确 bind 如何绑定既有 Task、Task 视图如何投影关联，并同步 owner 文档、解析、库边界与测试。