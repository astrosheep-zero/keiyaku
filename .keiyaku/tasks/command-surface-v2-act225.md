---
id: task/command-surface-v2-act225
title: command-surface-v2-act225
state: drop
priority: 0
needs: []
parent: null
supersedes: []
relates: []
contractId: null
---
Act 225/229/230 authority cut. Docs now target bind/amend/deliver/review/abandon + status/audit/wait/reconcile, facts bind->bound->deliver->fulfilled | abandon->abandoned, task drop remains task-domain, and results expose facts/effects/lag including worktree/ref movement. Source migration remains intentionally untouched pending Faye's exact payload/CAS/required-set/amend-invalidation/wait/audit ruling. Atomic implementation surface: facts types+codec+fold+admission+repository; protocol run; reconcile; replace old open/seal/renew/petition/claim/forfeit owners/tests with bind/amend/deliver/review/abandon; rewrite CLI and task settlement; add focused codec/fold/admission/reconcile/CLI/dogfood tests. No aliases and no partial schema.

Act 242 implementation cut ready to start after authority docs and confirmed tree revision.

Schema and ownership now closed: ContractCoordinates + shared ContractBody in facts/types; bind = coordinates + body revision 0; amend = complete body replacement; after/pipeline/verification live in body; default required set [reviewed], declared verification adds verified; ReviewData and verification evidence fields are explicit; fulfilled carries only delivery ULID; deliver carries base; abandon intent carries reason/note and abandoned carries finalHead. File tree confirmed by Faye act_242: facts/gate.ts, read/{status,audit,wait}, five verb files only, cli split with invoke owner, task contract-blind. Delete old verb modules/fixtures/tests and all aliases. Worker must implement one atomic current-version cut and add focused tests.

Act 248 closes the verified writer gap. Deliver is the only verification writer; DeliverData has optional verification {result, summary?, evidence[]}; candidate is structurally the enclosing deliver candidate and is not repeated. verified gate reads current deliver verification.result === pass; no candidate OID recheck, no verification kind, no review mixing. Fail still lands deliver without fulfilled; rerun deliver may refresh. Docs now carry explicit ReviewData, verification record, and pipeline declaration tables. Worker may continue atomic cut.