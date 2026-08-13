---
id: task/压缩-terminal-seal-不可变-commit-元数据
title: 压缩 terminal seal 不可变 commit 元数据读取
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates:
  - task/压缩-deliver-review-生产-git-进程拓扑
note: 让 terminal cleanup 在一次 Git decode channel 中解析 start/tender/integration 的 tree 与 parent，供前后 sealed-byte proof 和 custody 复用；保留 fresh workspace capture、destroy hook 前后证明和所有原子 ref 裁决。
createdAt: 2026-08-13T02:13:16.157Z
updatedAt: 2026-08-13T02:53:18.496Z
---
