---
id: task/own-body-read-projections-with
title: Own Body read projections with schemas
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates:
  - task/body-request-results-minimal/share-body-schema-exactness
note: "Deleted the recursive exactness utility and its drift fixtures. Akuma status/timeline and Task rows now derive from owner-local strict schemas; local and forwarded Fleet consume those owners. Focused Fleet and Task tests, typecheck, build, architecture, maintainability (0 errors), and reachability passed. Full npm test reached the sandbox-only loopback listen EPERM in the Pi/OpenAI integration. Correction: Contract Body forwarding serializes direct caller-facing delivery, review, and audit results through their strict owner schemas, with no Forwarded* receipt wrapper or late handle unwrapping. Durable service references remain recovery-only. The generic command boundary now carries only an ephemeral opaque owner-coded domain failure beside a voided receipt; Contract reconstructs typed KeiyakuRefused/KeiyakuRetry while Heart retains only void evidence. Focused Body-request proof passed (34/34); current typecheck, build, architecture, and reachability gates passed."
createdBy: aku/worker/3120a292
createdAt: 2026-08-29T15:19:52.050Z
updatedAt: 2026-08-29T18:32:07.495Z
---
