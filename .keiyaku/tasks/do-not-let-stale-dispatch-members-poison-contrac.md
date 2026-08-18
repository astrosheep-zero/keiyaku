---
id: task/do-not-let-stale-dispatch-members-poison-contrac
title: Define cross-world Contract Akuma selector semantics
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-16T04:39:45.992Z
updatedAt: 2026-08-16T12:57:08.065Z
---
Observed reproduction: the scout was created with '-C /Users/astrosheep/Developer/keiyaku --repo /Users/astrosheep/Developer/keiyaku-v4 call fast --contract kei/use-reusable-local-places-for-managed-worktrees'. Its Heart remains born and readable in the v3 world at /Users/astrosheep/Developer/keiyaku/.keiyaku/akuma/run/fast-f9aae4df. The v4 Dispatch authority correctly retains only AkuId, ContractId, and dispatchedAt. Later, 'keiyaku -C /Users/astrosheep/Developer/keiyaku-v4 wait kei/use-reusable-local-places-for-managed-worktrees --all --timeout 5m' expands that repository Dispatch but looks for every selected Aku in the v4 WorldRoot, producing 'Akuma aku/fast/f9aae4df is not born'. No cleanup occurred. Settle one coherent product model for the explicitly separate '-C' Akuma world, '--repo' Dispatch authority, and Contract worker selectors: the command must not promise repository-wide Contract aggregation when the facts cannot locate a worker's world. Preserve strict errors for an explicitly addressed missing Aku and keep Dispatch as the sole association authority. Update the relevant public/CLI/Dispatch/Akuma owner law and add a cross-world regression plus an ordinary same-world aggregate regression.