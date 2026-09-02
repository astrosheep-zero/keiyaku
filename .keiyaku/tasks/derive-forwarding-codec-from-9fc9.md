---
id: task/derive-forwarding-codec-from-9fc9
title: Derive Forwarding codec from explicit owner results
state: done
priority: 3
needs:
  - task/preserve-accepted-mutation-lags-dea5
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-02T04:42:35.359Z
updatedAt: 2026-09-02T10:10:45.052Z
---
Implement Faye P3 item 8 only after P1-A: reduce duplication in src/library/contract-forwarding-result.ts by deriving forwarding validation from explicit owner result shapes established by mutation finality work. Preserve strict decoding of untrusted forwarded input, refusal/retry/delivery/audit/verification/placement/cleanup/reconciliation variants, and public result compatibility. No second authority or transport receipt; no law changes. Add focused codec regressions and run typecheck/build/architecture.