---
id: task/architecture-ownership/make-holderless-settlement
title: Make holderless settlement strictly zero effect
state: done
priority: 1
needs: []
parent: task/architecture-ownership/reduce-request-execution-and
supersedes: []
relates: []
note: "Production-path correction ready for coordinator audit: Git terminal reconciliation now reports the genuinely retained managed worktree as worktree unchanged before cleanup; Settlement consumes that existing Git effect only after held-holder applicability. E2E tests cover clean install and malformed-context repair on the actual managed worktree, with missing/released/mismatched/superseded zero-effect retained. Verification: focused (17), typecheck, architecture, reachability, format, build passed; maintainability reproduces only existing src/cli/square-edge.ts and src/git/repository.ts line-limit errors. audit --include-dirty was blocked before candidate creation: git add --all could not write the shared Git object database while indexing .agents/skills/architect-judgment/SKILL.md (Operation not permitted). Coordinator audit needed before Deliverer reruns deliver."
createdAt: 2026-08-28T03:35:26.188Z
updatedAt: 2026-08-28T07:08:29.118Z
---
Observe the Git TaskHolder before establishing a Task World. A claimed Contract with no current held association must return without creating marker bytes or entering Task storage.