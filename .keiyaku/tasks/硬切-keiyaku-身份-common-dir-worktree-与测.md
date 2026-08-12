---
id: task/硬切-keiyaku-身份-common-dir-worktree-与测
title: 硬切 Keiyaku 身份、common-dir worktree 与测试边界
state: done
priority: 1
needs: []
parent: null
supersedes:
  - task/恢复-v3-worktree-路径并生成短别名
  - task/保持-npm-build-后全局-link-可执行
relates: []
note: ""
createdAt: 2026-08-12T08:40:20.434Z
updatedAt: 2026-08-12T09:28:00.254Z
---
按 docs/public-api.md、docs/task.md、docs/cli.md、docs/cli-output.md、docs/git.md 与 docs/git-reconciliation.md：统一 npm 包和 bin 为 Keiyaku 4.0.0；managed worktree 派生为 <git-common-dir>/keiyaku/wt/<contract-physical-name> 并迁移现存 registered worktrees；将长 dogfood 收束为 packaged CLI E2E；按语义拆分 library-verbs 测试以改善文件级并行。无旧名称或旧路径兼容层，不重写历史事实。