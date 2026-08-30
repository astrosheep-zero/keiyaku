---
id: task/body-request-results-minimal/schema-own-task-body-boundaries
title: Schema-own Task Body boundaries
state: done
priority: 0
needs: []
parent: task/body-request-results-minimal/make-every-body-json-boundary
supersedes: []
relates: []
note: Task Body request, live result, service evidence, and reference now share strict owner-local schemas; malformed live result coverage passed.
createdBy: aku/worker/3120a292
createdAt: 2026-08-29T09:44:32.540Z
updatedAt: 2026-08-29T10:14:42.739Z
---
Replace Task forwarded request/result/service/reference structural validators with strict owner-local Zod schemas without migrating Task authority codecs.