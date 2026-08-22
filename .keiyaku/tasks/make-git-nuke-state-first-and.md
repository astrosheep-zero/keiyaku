---
id: task/make-git-nuke-state-first-and
title: Make Git nuke state-first and recover owned residue
state: done
priority: 1
needs: []
parent: task/make-keiyaku-nuke-reset-converge
supersedes: []
relates: []
note: ""
createdAt: 2026-08-22T16:54:37.452Z
updatedAt: 2026-08-22T20:23:38.952Z
---
Faye ruling act/284 F3/F4 plus act/277: Git nuke must remove keiyaku-state first using expected-OID CAS before deleting regenerable topology; enumerate both legacy refs/heads/keiyaku-delivery|candidate and new refs/keiyaku/delivery|candidate during migration; preserve attached/foreign worktrees; recognize an unregistered path as removable Keiyaku residue only when its worktree admin points to this repository common dir; retain SQLite lock files and unknown/foreign bytes.