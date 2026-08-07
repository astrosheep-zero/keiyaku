---
id: 实现-target-branch-唯一规范化
title: 封闭 target canonicalization 行为矩阵
state: open
pri: 0
needs: []
parent: null
from: []
createdAt: 2026-08-06T22:52:04.101Z
updatedAt: 2026-08-07T04:59:50.941Z
creator: thekoc
---
依据 docs/public-api.md 与 docs/transport.md，证明 library 输入、persisted coordinate 与 target CAS 使用同一个 canonical refs/heads/* 坐标。

现状：normalizeTargetBranch 已实现短名规范化、Git branch-name 校验、非 heads ref 与 Keiyaku-owned namespace 拒绝；不要为了任务重写已正确的实现。当前缺口是行为证据，以及 owner docs 尚未说明合法但不存在的目标分支应产生哪一种公开结果。

完成条件：

- 先在 owner docs 明确 missing target branch 的公开结果；在此之前不得由测试或实现自行立法。
- 精准行为测试证明 target: "main" 与 target: "refs/heads/main" 持久化同一坐标。
- 测试覆盖 invalid branch grammar、非 refs/heads full ref、Keiyaku-owned namespace、missing target branch，以及最终 target CAS 继续使用已持久化的 canonical coordinate。
- 测试只观察 public result、journal coordinate 与 ref consequence，不断言 Git 调用次数或私有 helper 形状。
- 仅在反例证明当前实现错误时修改实现；不增加 DWIM、当前分支推断、target registry 或第二次规范化。
