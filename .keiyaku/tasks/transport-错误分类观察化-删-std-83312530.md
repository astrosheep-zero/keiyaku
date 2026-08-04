---
id: transport-错误分类观察化-删-std-83312530
title: Transport 错误分类观察化：删 stderr 文本协议
state: open
pri: 1
needs: []
parent: null
from: []
notes:
  - actor: thekoc
    timestamp: 2026-08-04T06:59:47.699Z
    text: |
      验收通过（akuma worker-default/e0e2f762，commit 05dec88）：diff 仅五路径；transport 三态（repository.ts:11-14）+ stderr verbatim Buffer（:39-64）+ message 仅诊断（:80-86）；admission 无任何 stderr/文案分支（rg src/ 零命中，伪装文案仅测试 fixture :527）；观察归因 carrier-first（admission.ts:429-438/:486-496）；仅 update-ref --stdin --no-deref，无 batch-updates；四组新测试齐（:214/:229/:463/:523）；Act 193 同 commit 成文；38/38 tests + typecheck 绿。
      非阻塞卫生项：worktree 出现 untracked .pnpm-store/v11/index.db，建议入 .gitignore。
createdAt: 2026-08-04T06:03:38.409Z
updatedAt: 2026-08-04T06:59:47.699Z
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
