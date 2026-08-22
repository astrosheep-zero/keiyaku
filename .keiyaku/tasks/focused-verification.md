---
id: task/focused-verification
title: Focused verification
state: done
priority: 2
needs: []
parent: task/replace-worktree-hook-recovery-delay-with-explic
supersedes: []
relates: []
note: Passed timeout=4m node --import tsx scripts/run-tests.mjs tests/worktree-hooks.test.ts, npm run test:typecheck, and git diff --check.
createdBy: aku/worker-2/b0286eb4
createdAt: 2026-08-20T12:13:03.279Z
updatedAt: 2026-08-20T12:37:09.695Z
---
Run the focused worktree-hooks test and typecheck; capture hangs, EMFILE, and cleanup evidence.