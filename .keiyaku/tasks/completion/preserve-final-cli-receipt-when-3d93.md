---
id: task/completion/preserve-final-cli-receipt-when-3d93
title: Preserve final CLI receipt when the executing worktree is retired
state: open
priority: 2
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-07T11:06:06.231Z
updatedAt: 2026-09-07T11:06:06.231Z
---
Observed after accepted Recovery review: command launched from .keiyaku/wt/namek/build/src/cli/index.js with -C namek admitted satisfied review, placed integration6ba1abafeb45e0448d8e96c475b38c0770b3a3db and claimed the Contract, then exited3 with Cannot find module namek/build/src/index.js imported from namek/build/src/cli/runtime.js because terminal cleanup retired its own executable tree. /tmp/namek-final-review.json is empty. Stable root CLI independently confirmed claimed and satisfied reviewed gate; no retry was performed. Investigate deferred import/receipt ownership after self-retirement, add deterministic end-to-end reproduction using worktree-local executable, and preserve committed result/receipt without reopening terminal Contract or masking failure. This is a separate follow-up, not an unfinished Recovery gate. Coordinate with current unrelated Pi/provider edits; do not reset them.