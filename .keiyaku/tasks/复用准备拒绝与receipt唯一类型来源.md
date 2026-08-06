---
id: 复用准备拒绝与receipt唯一类型来源
title: 复用准备拒绝与Receipt唯一类型来源
state: in_progress
pri: 1
needs: []
parent: null
from:
  - 审计剩余双权威重复门与隐含前提
createdAt: 2026-08-06T18:15:57.890Z
updatedAt: 2026-08-06T18:46:51.466Z
creator: thekoc
startedAt: 2026-08-06T18:46:51.466Z
---
删除 protocol 对 carrier preparation refusal 的手抄 union/强转，并让 package Receipt 直接复用 ProtocolReceipt；不改变公开结构。
