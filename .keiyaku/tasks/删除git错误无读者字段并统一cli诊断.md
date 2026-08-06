---
id: 删除git错误无读者字段并统一cli诊断
title: 删除Git错误无读者字段并统一CLI诊断
state: in_progress
pri: 1
needs: []
parent: null
from:
  - 审计剩余双权威重复门与隐含前提
createdAt: 2026-08-06T18:19:19.177Z
updatedAt: 2026-08-06T18:46:51.984Z
creator: thekoc
startedAt: 2026-08-06T18:46:51.984Z
---
GitPlumbingError 的 signal/code 无生产读者，command 只有测试读者；CLI 两处复制 errorBytes。收缩错误到 transport 判断真正读取的状态与一个诊断字符串，并让 CLI 复用唯一诊断函数，不改变 typed retry/CAS。
