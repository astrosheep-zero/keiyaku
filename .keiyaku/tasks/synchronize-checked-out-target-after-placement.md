---
id: task/synchronize-checked-out-target-after-placement
title: Synchronize checked-out target after placement
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-11T02:55:04.199Z
updatedAt: 2026-08-11T12:26:11.572Z
---
A successful claimed placement atomically advances the journal ref and target ref, but when the target branch is checked out its index/worktree remain at the predecessor. Git then shows the delivered patch as a staged inverse while Keiyaku reports no lag. Fix the physical owner/reconcile flow so success either leaves every checked-out target consistent with the advanced ref or returns an explicit typed physical failure/lag. Prove the checked-out-target path, a target checked out in another worktree, dirty-worktree refusal/preservation, and no false claimed-without-lag result.