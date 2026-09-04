---
id: task/test-suite-slimming-and-a161
title: Test suite slimming and performance
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: Both Keiyaku deliveries claimed on main; trim, workflow layering, Git performance investigation, and final regression evidence recorded. Full release remains environment-blocked by integration listen EPERM.
createdAt: 2026-09-02T12:22:07.434Z
updatedAt: 2026-09-02T13:14:51.316Z
---
Reduce the cost of the repository test workflow without weakening user-visible lifecycle, custody, Git, or CLI invariants.

Evidence to use: npm test currently spends about 207s in integration; the heaviest files are library-contract-operations, git-delivery, cli-invoke, kanshi, library-verification, facade-fleet, and plugin-types.

Delivery is complete only when the child tasks have concrete diffs, focused verification, and a before/after timing report. Do not add cross-call Git caches or delete tests by coverage count.