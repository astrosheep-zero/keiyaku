---
id: task/architecture-ownership/inject-one-per-drive-execution
title: Inject one per-drive execution channel into Library verbs
state: done
priority: 0
needs:
  - task/architecture-ownership/detach-heart-lifecycle-from
parent: task/architecture-ownership/reduce-request-execution-and
supersedes: []
relates: []
note: Captured execution context and real audit forwarding are implemented and verified by the Arc checks.
createdAt: 2026-08-28T03:35:26.188Z
updatedAt: 2026-08-28T13:57:14.057Z
---
Resolve local versus forwarded execution once per provider-drive caller context and supply that channel to the existing Contract, Fleet, and Task public verbs. Remove per-call process.env routing and avoid process-wide channel caching.
User added contract.audit to the default permission requirement. Current source has local KeiyakuHandle.audit but no Body Request action; the Contract is amended to ship a real owner-coded one-hop audit command, preserve Library and CLI semantics, and include it once in the canonical default allowed vocabulary. A dead permission string alone is forbidden.