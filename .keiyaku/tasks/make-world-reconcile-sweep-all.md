---
id: task/make-world-reconcile-sweep-all
title: Make world reconcile sweep all releasable custody
state: done
priority: 1
needs: []
parent: task/reconcile-custody-and-cleanup
supersedes: []
relates: []
note: ""
createdAt: 2026-08-22T15:36:03.581Z
updatedAt: 2026-08-22T19:25:11.642Z
---
Determine why global reconcile removes only a small fraction of delivery/candidate refs. Inventory the discovery boundary, terminal-state eligibility, sealed-byte and external-custodian proofs, missing-journal/orphan refs, retained worktrees, candidate pins, and settlement coupling. Define complete reporting and safe cleanup/retry semantics so every releasable ref is eventually handled without deleting protected or undiscoverable custody.
Faye ruling act/282:
The retention principle is correct, but target custody proof by tip equality is wrong. For claimed targeted Contracts, freeze the current target tip T and prove the recorded current integration commit is reachable from T (`git merge-base --is-ancestor integration T`); atomically verify target is still T while deleting the owned ref. Target movement after a claimed placement is normal and does not by itself destroy custody. A delivery ref may transfer custody through the claimed integration only when the integration preserves the exact tender tree. Retain abandoned or never-claimed tender sole custody, unequal tender/integration trees, and force-pushed or rebased targets where integration is no longer reachable. Do not use age, TTL, bulk deletion, foreign refs, or a second inventory. Residual refs are retained custody, not orphan/dangling refs; reconcile should mechanically classify them after this predicate correction.

Faye ruling act/286: the 9 residual refs previously labeled abandoned/unclaimed/other are all claimed. The label is a classifier fall-through, not a phase. They must be explicitly typed as claimed-targetless, target-ref-missing, or leaf-mismatch (currentIntegration unreadability is authority corruption); leaf-mismatch converges before custody classification. Claimed targetless and target-deleted have no target custodian and retain sole custody. Do not delete based on the wrong label; exact Contract state remains the phase authority.

Faye ruling act/288: the 125 retained refs are user-expected retained evidence, not debris. `claimed` completes workflow but never authorizes evidence disposal. Keiyaku never converts sole custody into unavailability; release an owned ref only when the exact bytes it guards remain reachable through a surviving custodian. The 112 claimed ancestor+unequal-tree delivery refs preserve the reviewed tender subject when the landed integration tree differs; they are not needed merely for Delivery.diff(), but deleting them would leave the recorded reviewed bytes nowhere. The 4 non-ancestor delivery refs preserve evidence across target history rewrite/movement. Claimed targetless/target-deleted refs retain without a target custodian; leaf-mismatch first converges then reapplies the same rule. Do not project evidence into a second store, add warnings, TTL/count/phase exceptions, or a retain-after-claim setting. Existing Git custody law already owns this invariant; implementation work remains limited to act/282 containment and act/286 explicit classification.
