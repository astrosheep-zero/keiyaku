---
id: 删除verification无读者运行时捕获链
title: 删除Verification无读者运行时捕获链
state: open
pri: 0
needs: []
parent: null
from: []
createdAt: 2026-08-06T18:10:24.179Z
updatedAt: 2026-08-06T18:10:24.179Z
creator: thekoc
---
按 docs/verification.md Runtime Contract：只保留 terminal code、timeout、spawn-error diagnostic、unknown-exit；固定五分钟，无公开 cancel/output/duration。
