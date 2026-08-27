---
id: task/reconcile-target-checkout
title: Reconcile target checkout refusal without conflating worktree conflicts
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: "Investigation complete (aku/worker-2/7b68bf60, 2026-08-27): target checkout refusal comes from main registered checkout in prepareTargetPlacement/ordinaryPrecheck; Contract worktree git add only changes its own index and cannot affect main. Existing docs/git.md and docs/git-reconciliation.md already require typed checkout-not-followable for staged/conflict/untracked caller bytes and forbid reconciliation retry/overwrite before publication. No new public behavior or implementation is authorized. Current blocker facts: main checkout paths docs/cli-output.md and docs/public-results.md are caller-owned dirty changes; leave them untouched. Do not conflate with spawnpoint UU conflict."
createdAt: 2026-08-27T13:10:52.353Z
updatedAt: 2026-08-27T13:16:19.943Z
---
Placement can be blocked by checkout-not-followable on the caller-owned target worktree (currently main, with docs/cli-output.md and docs/public-results.md). This is distinct from an unmerged Contract worktree. Record exact target checkout facts and determine the smallest authority-grounded recovery/reconcile behavior: do not ask the coordinator to stage or overwrite unrelated caller changes, and do not treat staging the Contract worktree as a fix for the target checkout refusal. Inspect docs/git.md, docs/git-reconciliation.md, docs/lifecycle.md, and current placement/reconcile code. If public behavior is not settled by owner law, stop with the precise authority gap; otherwise implement focused behavior/tests and update the owning document in the same slice.