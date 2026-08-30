---
id: task/body-request-results-minimal/schema-own-contract-body
title: Schema-own Contract Body boundaries
state: done
priority: 0
needs: []
parent: task/body-request-results-minimal/make-every-body-json-boundary
supersedes: []
relates: []
note: Arc 2 Contract request, service evidence, forwarded receipts, and reconciliation lags now decode through strict owner-local Zod schemas; focused typecheck passed.
createdBy: aku/worker/3120a292
createdAt: 2026-08-29T09:44:32.540Z
updatedAt: 2026-08-29T09:52:16.471Z
---
Replace Contract request, live-result, service-evidence, and reference structural validators with strict owner-local Zod schemas while preserving public result semantics.