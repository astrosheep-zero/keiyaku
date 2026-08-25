---
id: task/make-nuke-tolerate-legacy-akuma
title: Make nuke tolerate legacy Akuma schemas
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-24T07:42:25.543Z
updatedAt: 2026-08-24T08:20:23.456Z
---
Nuke must reset Keiyaku-owned data in an existing World even when an old Akuma Heart schema is present. The current reset path aborts with `Akuma heart schema version must be 20`, so one stale or legacy runtime entry prevents cleanup of unrelated owner state. Preserve the current nuke scope, confirmation, safety, and unknown-byte preservation laws.

Investigate the Akuma reset owner and schema gate. Make reset classify or clean legacy/unsupported recognized Akuma entries without opening them through the current Heart reader, while retaining any bytes that cannot be proved Keiyaku-owned. Add regression coverage for a World containing an older Heart schema and verify that nuke continues through independent owners and remains retryable. Do not add schema migration, alter live Akuma runtime semantics, broaden reset scope, or delete repository source, refs, settings, namespace configuration, or unknown bytes.