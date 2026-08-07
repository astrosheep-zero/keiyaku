---
id: task/build-the-narrow-src-runtime-proc-bound-e4815530
title: "Build the narrow src/runtime/proc boundary specified in docs/architecture.md: synchronous spawn, bounded stdout/stderr, POSIX process-group timeout/cancel termination, Windows Job Object with taskkill fallback, typed outcomes, and focused cross-platform-safe tests. Do not add Verification fields, cache, leases, or detached runner."
state: drop
priority: 0
needs: []
parent: task/v4-verification-runtime-and-producer
supersedes: []
relates: []
contractId: null
---
Old task required a Windows Job Object boundary unavailable without a new native addon; replaced by the documented portable process contract.