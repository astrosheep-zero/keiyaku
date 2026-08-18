---
id: task/make-maintainability-gates-reward-readable-struc
title: Make maintainability gates reward readable structure
state: done
priority: 1
needs: []
parent: task/审计项目架构边界-重复与-owner-错位
supersedes: []
relates: []
note: Made max-len and max-lines advisory, removed hard line-count promotion, and removed the config-copy assertion.
createdAt: 2026-08-18T03:33:12.842Z
updatedAt: 2026-08-18T03:51:35.638Z
---
保留 src/scripts 的 120-column max-len、complexity、max-depth、max-lines-per-function 和 max-params。移除 check-maintainability 对文件总行数的 hard promotion，使 max-lines 只提供 advisory signal；不得靠合并声明、语句或压缩自然换行来过 gate。

本切片只改 gate 机制及其直接 checker tests，不混入 657 个既存 max-len 违规的全仓机械迁移，也不改产品 owner 文档。验收关注 severity projection 和命令退出语义，而不是再次复述 ESLint 配置常量。