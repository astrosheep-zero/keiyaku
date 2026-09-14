---
id: task/harden-pr3-execution-failure-52fb
title: Harden PR3 execution failure semantics and CLI receipts
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-05T16:31:31.542Z
updatedAt: 2026-09-05T17:35:57.439Z
---
Repair the two blocking PR #3 review findings: reject untyped errno-like programming errors as execution stops, and preserve post-admission failure category in local CLI text and JSON. Compare full verification against base and head, then deliver the candidate on the branch.