---
id: task/reduce-repository-code-by-at
title: Reduce repository code by at least 5,000 net lines
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-31T17:07:52.092Z
updatedAt: 2026-09-01T06:00:33.444Z
---
Baseline: main 46ea841dc55aa5f4c32e248fbec7ae0eeb5099cf contains 93,116 physical lines across tracked src/, scripts/, and tests/ files with extensions ts, tsx, js, mjs, or c. Final acceptance reruns the identical tracked-file command and requires at most 88,116 lines, a net reduction of at least 5,000 after every replacement and added test is counted. Reduction must come from deleting redundant implementation, duplicate product paths, low-value or implementation-coupled tests, and avoidable structure. Preserve current owner law and observable product behavior, including one public happy path and each concrete custody, lifecycle, recovery, refusal, or concurrency invariant. Formatting compression, minification, merged statements, excluded-file tricks, generated artifacts, weakened gates, or deleting the last assertion for a product invariant do not count. Deliver the work through bounded independently reviewable kei Contracts; close this Task only after all accepted Contracts land and the final baseline comparison passes.