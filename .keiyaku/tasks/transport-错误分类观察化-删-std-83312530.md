---
id: transport-错误分类观察化-删-std-83312530
title: Transport 错误分类观察化：删 stderr 文本协议
state: open
pri: 1
needs: []
parent: null
from: []
createdAt: 2026-08-04T06:03:38.409Z
updatedAt: 2026-08-04T06:10:07.460Z
creator: thekoc
contractId: transport-错误分类观察化-删-stderr-文本协议.01KZ5P9HZ40EWBBG0EZSSBX0AA
---
裁定（square #96）：transport 只分类进程结局（published / non-published / unknown），语义归因只来自失败后观察，stderr 是不透明诊断字节，永不匹配、永不分支。

实施：
- admission.ts::carrierRefRace 删除 /is at .* but expected/i 与 carrier-lock 文本匹配；函数退化为纯观察分类器（carrier 动→机械重建；carrier 未动∧target 动→typed ref-moved；都没动→原样 rethrow unrelated Git failure）。
- repository.ts::updateRefsAtomically 对上层呈 typed 三态，附诊断字节；上层不再解析原始 Git 错误。
- run.ts、verbs 无改动。
- 禁令入法典（同 commit）：错误文本不进语义判断；不使用 --batch-updates（实测部分发布，破坏全有或全无）。

验收：akuma 复核 + square 放行。排在 672d9b8d（slice 2）之前。
