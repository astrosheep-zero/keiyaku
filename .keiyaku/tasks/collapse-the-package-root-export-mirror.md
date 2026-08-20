---
id: task/collapse-the-package-root-export-mirror
title: Collapse the package-root export mirror
state: done
priority: 1
needs: []
parent: task/审计项目架构边界-重复与-owner-错位
supersedes: []
relates: []
note: ""
createdAt: 2026-08-18T03:55:57.451Z
updatedAt: 2026-08-18T06:58:27.181Z
---
让 src/library/keiyaku.ts 继续作为唯一策展过的 Contract/Akuma package-root surface，src/index.ts 只组合该策展 surface 与 World/Settings owner exports，不再手工重复完整 value/type 清单。

保留 packaged consumer 对精确 runtime keys、public type 可编译和 internal type 不可导入的核心测试。不得用无边界 export star 暴露 library 内部模块。