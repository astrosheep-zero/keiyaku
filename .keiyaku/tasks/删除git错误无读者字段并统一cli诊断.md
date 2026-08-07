---
id: 删除git错误无读者字段并统一cli诊断
title: 删除Git错误无读者字段并统一CLI诊断
state: drop
pri: 1
needs: []
parent: null
from:
  - 审计剩余双权威重复门与隐含前提
notes:
  - actor: thekoc
    timestamp: 2026-08-07T05:00:25.166Z
    text: 任务证据已过时：pid/status 仍参与 unknown/non-published 分类，旧 errorBytes 重复已不存在。仅剩无读者 stderr 存储可在下次修改 repository 时直接删除，不为它新增统一诊断机制或独立任务。
createdAt: 2026-08-06T18:19:19.177Z
updatedAt: 2026-08-07T05:00:25.166Z
creator: thekoc
---
GitPlumbingError 的 signal/code 无生产读者，command 只有测试读者；CLI 两处复制 errorBytes。收缩错误到 transport 判断真正读取的状态与一个诊断字符串，并让 CLI 复用唯一诊断函数，不改变 typed retry/CAS。
