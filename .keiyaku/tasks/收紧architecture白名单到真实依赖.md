---
id: 收紧architecture白名单到真实依赖
title: 收紧architecture白名单到真实依赖
state: done
pri: 1
needs: []
parent: null
from:
  - 审计剩余双权威重复门与隐含前提
createdAt: 2026-08-06T18:15:58.564Z
updatedAt: 2026-08-07T04:48:30.218Z
creator: thekoc
---
按最终 import 图删除 scripts/architecture/policy.ts 已无生产读者的模块和符号许可，使 guard 只允许当前真实边界。
