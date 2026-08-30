---
id: task/body-request-results-minimal/schema-own-fleet-and-akuma-body
title: Schema-own Fleet and Akuma Body boundaries
state: done
priority: 0
needs: []
parent: task/body-request-results-minimal/make-every-body-json-boundary
supersedes: []
relates: []
note: Arc 2 Fleet request, service, live-result, status, and Akuma call boundaries now use strict owner-local Zod schemas; focused typecheck passed.
createdBy: aku/worker/3120a292
createdAt: 2026-08-29T09:44:32.540Z
updatedAt: 2026-08-29T09:56:42.123Z
---
Replace Fleet and Akuma forwarded request/result/service/reference structural validators with strict owner-local Zod schemas and retain opaque Heart custody.