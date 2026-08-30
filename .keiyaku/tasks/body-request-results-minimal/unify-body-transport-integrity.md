---
id: task/body-request-results-minimal/unify-body-transport-integrity
title: Unify Body transport integrity
state: done
priority: 0
needs:
  - task/body-request-results-minimal/schema-own-contract-body
  - task/body-request-results-minimal/schema-own-fleet-and-akuma-body
  - task/body-request-results-minimal/schema-own-task-body-boundaries
parent: task/body-request-results-minimal/make-every-body-json-boundary
supersedes: []
relates: []
note: "Shared requestBodyCommand wraps malformed owner-decoded live results and references as transport integrity: request Errors; Task and Fleet request-specific narrowing now preserve that prefix. Focused Body test passed."
createdBy: aku/worker/3120a292
createdAt: 2026-08-29T09:44:32.540Z
updatedAt: 2026-08-29T10:15:24.925Z
---
Apply shared request transport behavior to schema-owned owner codecs, including malformed live result and reference integrity errors and deletion of obsolete validators.