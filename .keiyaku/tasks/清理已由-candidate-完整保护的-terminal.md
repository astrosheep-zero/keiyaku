---
id: task/清理已由-candidate-完整保护的-terminal
title: 清理已由 candidate 完整保护的 terminal managed worktree
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-12T01:40:48.455Z
updatedAt: 2026-08-12T17:16:43.849Z
---
当 terminal managed worktree 仍呈现 base HEAD 加 dirty candidate bytes 时，若 Keiyaku 能证明其完整工作树内容与当前已 pin 的 tender/candidate snapshot 完全一致，则允许 cleanup 安全删除该 worktree 与临时 refs。证明失败、存在额外 staged/unstaged/untracked bytes、candidate 不可达或身份不一致时必须继续保留。覆盖 claim 后即时 cleanup、terminal reconcile、dirty here/managed 区分、untracked bytes、candidate pin custody 与 restart recovery；不得通过 reset 或改写用户 worktree 来制造可删除状态。