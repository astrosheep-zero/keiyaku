---
id: task/保持-npm-build-后全局-link-可执行
title: 保持 npm build 后全局 link 可执行
state: drop
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: Superseded by task/硬切-keiyaku-身份-common-dir-worktree-与测.
createdAt: 2026-08-08T18:39:56.140Z
updatedAt: 2026-08-12T08:40:34.579Z
---
当前 package bin 指向 build/src/cli/index.js；npm link 初始可执行，但 npm run build 由 tsc 重建后输出 mode 0644，导致 /opt/homebrew/bin/keiyaku-v4 permission denied。单独修正 build/install 边界并增加不依赖测试内 chmod 的回归证明。