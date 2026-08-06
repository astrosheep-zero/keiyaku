---
id: 删除protocol自产上下文的幽灵防御门
title: 删除protocol自产上下文的幽灵防御门
state: open
pri: 1
needs: []
parent: null
from:
  - 审计剩余双权威重复门与隐含前提
createdAt: 2026-08-06T18:15:58.250Z
updatedAt: 2026-08-06T18:15:58.250Z
creator: thekoc
---
证明 runProtocol 仅由内部 typed builder 调用后，删除对 attempts/contracts 的 JS 外部输入式重验；保留 receipt 主体识别、offer allocation 与 unknown recovery 真正需要的内部不变量。
