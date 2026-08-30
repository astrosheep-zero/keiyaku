---
id: task/prove-worldroot-at-every-raw-execution-boundary/package-root-library-world
title: Mint raw package-boundary World once and flow the capability
state: done
priority: 0
needs:
  - task/prove-worldroot-at-every-raw-execution-boundary/world-exact-proof-and
  - task/prove-worldroot-at-every-raw-execution-boundary/exhaustive-production-worldroot
parent: null
supersedes: []
relates: []
note: ""
createdBy: aku/worker/0d24a604
createdAt: 2026-08-29T09:44:30.778Z
updatedAt: 2026-08-29T12:59:57.295Z
---
At raw package-library and JS boundaries, mint exactly one canonical WorldRoot before effects. Keep constructor-held branded WorldRoot values as proof consumers; remove repeated capability reproofs.