---
id: 统一-amend-保留-h2-的方言拒绝
title: 统一 amend 保留 H2 的方言拒绝
state: in_progress
pri: 1
needs: []
parent: null
from: []
createdAt: 2026-08-06T21:41:47.601Z
updatedAt: 2026-08-06T21:42:06.362Z
creator: thekoc
startedAt: 2026-08-06T21:42:06.362Z
---
依据 docs/document.md 的 Reserved Sections law，让 amendment operation 与 complete-document decoder 使用同一保留标题判定。当前 ## Add: Gates|Pipeline|After 被 amend 层当 extension 接受，渲染后才被 decoder 以 TypeError 拒绝，形成两个方言法官和错误阶段漂移。

把保留标题判定收束到 body 方言的单一 helper，所有 Add/Update/Remove extension target 在应用前拒绝保留名；不得复制字符串表、不得靠最终 re-decode 兜底、不得把它变成 lifecycle refusal。添加一组小而精准的 Add/Update/Remove 边界测试。
