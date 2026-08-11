---
id: task/提升-akuma-cli-动词与-history-last-response
title: 恢复 Akuma activity snapshot 与根 CLI 动词
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-09T07:55:29.142Z
updatedAt: 2026-08-09T10:21:45.646Z
---
实现 kei/restore-akuma-activity-observations-and-root-verbs：恢复 typed tool lifecycle 与共享 ActivitySnapshot；status/wait 只读当前观察，history 独占 retained turns，history --last 返回最后 answered response；projection 动词提升到根 CLI。实现由 Codex 本地完成，不派 Akuma。