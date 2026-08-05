---
id: build-the-narrow-src-runtime-proc-bound-e4815530
title: "Build the narrow src/runtime/proc boundary specified in docs/architecture.md: synchronous spawn, bounded stdout/stderr, POSIX process-group timeout/cancel termination, Windows Job Object with taskkill fallback, typed outcomes, and focused cross-platform-safe tests. Do not add Verification fields, cache, leases, or detached runner."
state: drop
pri: 0
needs: []
parent: v4-verification-runtime-and-producer
from: []
notes:
  - actor: thekoc
    timestamp: 2026-08-05T11:00:36.517Z
    text: Old task required a Windows Job Object boundary unavailable without a new native addon; replaced by the documented portable process contract.
createdAt: 2026-08-05T10:25:10.087Z
updatedAt: 2026-08-05T11:00:36.517Z
creator: thekoc
---
