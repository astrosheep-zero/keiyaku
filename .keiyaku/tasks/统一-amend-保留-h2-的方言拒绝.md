---
id: 统一-amend-保留-h2-的方言拒绝
title: 统一 amend 保留 H2 的方言拒绝
state: in_progress
pri: 1
needs: []
parent: null
from: []
createdAt: 2026-08-06T21:41:47.601Z
updatedAt: 2026-08-06T21:54:12.207Z
creator: thekoc
startedAt: 2026-08-06T21:42:06.362Z
---
依据 docs/document.md Reserved Sections law，收束 complete-document decoder 与 amendment Add 的保留标题判定。可构造缺陷是 Add: Gates|Pipeline|After 被 amend 当 extension 创建，随后 final decoder 才拒绝；合法 ContractBody 不可能已有这些 extension，因此 Update/Remove/Replace/Append 的 unknown-extension 拒绝不是第二可接受路径，不加幽灵门。

保留标题名单只在 body shape owner 定义一次，decoder 与 Add creation 复用。一个参数化精准测试覆盖三个保留名；不新增 error code、lifecycle refusal、parser abstraction 或针对不可构造 reserved extension 的夹具。
