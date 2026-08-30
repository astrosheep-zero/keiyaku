---
id: task/architecture-ownership/own-provider-resources-before
title: Own provider resources before asynchronous admission
state: done
priority: 0
needs: []
parent: task/architecture-ownership/reduce-request-execution-and
supersedes: []
relates: []
note: ""
createdAt: 2026-08-28T03:35:26.188Z
updatedAt: 2026-08-28T13:04:11.632Z
---
Return one provider-run custody handle before adapter-owned resources can exist. Give every setup, cancellation, completion, and forced-disposal path one closure proof, then delete the AbortSignal late-disposal side protocol.