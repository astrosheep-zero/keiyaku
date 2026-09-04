---
id: task/git-and-process-performance-9c6e
title: Git and process performance investigation
state: done
priority: 2
needs: []
parent: task/test-suite-slimming-and-a161
supersedes: []
relates: []
note: "Read-only investigation complete. No source change justified. Evidence: heavy Git/worktree suites measured; cross-call caches rejected by call-scoped observation law; batching contract-worktree ls-files is a follow-up candidate requiring its own Contract and benchmark."
createdAt: 2026-09-02T12:22:07.434Z
updatedAt: 2026-09-02T13:06:31.669Z
---
Investigate the measured Git/worktree/process cost in library-contract-operations, git-delivery, cli-invoke, kanshi, and library-verification.

Measure repeated rev-parse, ls-files, worktree, process spawn, and SQLite activity. Propose or implement only optimizations that preserve call-scoped observation, custody, concurrency, and recovery semantics from docs/git.md, docs/git-reconciliation.md, docs/verification.md, and docs/lifecycle.md. RAM-disk runs may be used as a comparison, never as a correctness dependency.

Acceptance: benchmark evidence compares the chosen change with baseline; no cross-call cache or second authority is introduced.