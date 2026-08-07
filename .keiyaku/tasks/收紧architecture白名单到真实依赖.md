---
id: task/收紧architecture白名单到真实依赖
title: 收紧architecture白名单到真实依赖
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-07T04:48:30.320Z
updatedAt: 2026-08-07T11:29:07.457Z
contractId: null
---
按最终 import 图删除 scripts/architecture/policy.ts 已无生产读者的模块和符号许可，使 guard 只允许当前真实边界。