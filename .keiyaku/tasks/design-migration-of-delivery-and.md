---
id: task/design-migration-of-delivery-and
title: Design migration of delivery and candidate refs out of refs/heads
state: done
priority: 1
needs: []
parent: task/reconcile-custody-and-cleanup
supersedes: []
relates: []
note: Implemented the refs/keiyaku delivery and candidate namespace migration. Runtime writes only canonical roots; per-Contract reconcile observes both pairs, blocks all writes on any divergent collision, and otherwise migrates both pairs in one atomic update-ref transaction. Legacy targets remain rejected and nuke covers both generations. Owner docs, public text/forwarding projections, and focused regressions updated; independent Akuma re-review clean.
createdAt: 2026-08-22T15:36:03.581Z
updatedAt: 2026-08-30T07:44:44.078Z
---
Define the destination namespace, ownership predicates, discovery rules, compatibility window, migration transaction, recovery, tests, and owner-document law for moving Keiyaku delivery and candidate refs out of refs/heads. Preserve object reachability, custody semantics, target rejection, worktree recovery, nuke behavior, and compatibility with existing local refs. Do not migrate by bulk deletion or ad hoc rename.

Faye ruling act/277: destination is one owner root `refs/keiyaku/`, with separate `refs/keiyaku/delivery/<contractPhysicalName>` and `refs/keiyaku/candidate/<contractPhysicalName>` leaves. Keep delivery and candidate separate because their custody proofs differ. Preserve one `isKeiyakuOwnedRef` predicate over state, new leaves, and legacy `refs/heads/keiyaku-*` during a bounded transition. Runtime creates or updates only new leaves; reconcile atomically verifies the legacy OID, creates or updates the new leaf, and deletes the legacy leaf in one update-ref transaction. No dual-write, migration marker, migrate command, bulk legacy deletion, or second inventory. Legacy orphan refs are not touched by this migration; nuke enumerates both new and legacy roots. Transition ends when legacy roots are empty, then the legacy read arm can be hard-cut. Owner law homes: docs/git.md for namespace, target, and custodian law; docs/git-reconciliation.md for legacy repair and custody convergence.
