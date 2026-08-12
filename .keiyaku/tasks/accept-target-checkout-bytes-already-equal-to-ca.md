---
id: task/accept-target-checkout-bytes-already-equal-to-ca
title: Accept target checkout bytes already equal to candidate
state: drop
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: "Dropped after model review: same-path unstaged bytes carry index intent even when equal to the candidate, so the existing pre-publication refusal is intentional."
createdAt: 2026-08-12T04:46:56.791Z
updatedAt: 2026-08-12T04:57:28.112Z
---
Narrow Git ordinary targeted placement so a predecessor-to-candidate changed path is not refused merely because the target worktree differs from its index when the worktree bytes already equal the candidate result. Preserve unrelated staged/unstaged/untracked bytes, retain typed refusal for true overlapping worktree content, and make precheck, follow, and claimed-placement recovery share one provable shape. Update docs/git.md and focused real-Git tests in the same cut.