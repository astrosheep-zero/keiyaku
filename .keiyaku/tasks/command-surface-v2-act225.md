---
id: command-surface-v2-act225
title: command-surface-v2-act225
state: in_progress
pri: 0
needs: []
parent: null
from: []
notes:
  - actor: thekoc
    timestamp: 2026-08-04T15:57:20.752Z
    text: |
      Act 225/229/230 authority cut. Docs now target bind/amend/deliver/review/abandon + status/audit/wait/reconcile, facts bind->bound->deliver->fulfilled | abandon->abandoned, task drop remains task-domain, and results expose facts/effects/lag including worktree/ref movement. Source migration remains intentionally untouched pending Faye's exact payload/CAS/required-set/amend-invalidation/wait/audit ruling. Atomic implementation surface: facts types+codec+fold+admission+repository; protocol run; reconcile; replace old open/seal/renew/petition/claim/forfeit owners/tests with bind/amend/deliver/review/abandon; rewrite CLI and task settlement; add focused codec/fold/admission/reconcile/CLI/dogfood tests. No aliases and no partial schema.
createdAt: 2026-08-04T15:31:53.304Z
updatedAt: 2026-08-04T15:57:20.752Z
creator: thekoc
startedAt: 2026-08-04T15:31:53.845Z
---
