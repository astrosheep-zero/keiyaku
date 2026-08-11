---
id: task/架构-policy-支持中间匹配
title: 架构 policy 支持中间匹配
state: done
priority: 2
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-10T01:43:27.691Z
updatedAt: 2026-08-10T02:28:55.108Z
contractId: null
---
修复架构 policy 的路径匹配只支持精确匹配的问题，支持中间路径通配并保持 owner/allow 顺序与边界清晰；补充最小回归测试。