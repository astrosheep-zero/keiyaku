---
id: candidate-pin-ref-reconcile-活petition-f2b7d1a6
title: candidate-pin-ref-reconcile-活petition-gc可达性
state: in_progress
pri: 1
needs:
  - reconcile-owner-open-建-renew-移-clai-3a031187
parent: null
from: []
createdAt: 2026-08-04T10:58:09.984Z
updatedAt: 2026-08-04T10:59:25.310Z
creator: thekoc
startedAt: 2026-08-04T10:59:25.310Z
---
Implement the Faye act_203 candidate retention correction. Reconcile maintains a deterministic conventional candidate pin ref for every live petition; the ref is transport hygiene only, never a fact, fold input, admission premise, or second authority. Claim/forfeit settlement deletes it. Reconcile must rebuild the pin idempotently from the petition fact after restart/null handoff. Add a GC reachability test proving candidate and parent closure remain reachable across failed reconcile until settlement. Do not add queue/seat numbering, candidate data to journal, predicted/realized duality, or persisted worktree/delivery-ref names. Update law/docs in the same coherent commit.
