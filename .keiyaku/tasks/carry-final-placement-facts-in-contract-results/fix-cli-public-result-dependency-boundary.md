---
id: task/carry-final-placement-facts-in-contract-results/fix-cli-public-result-dependency-boundary
title: Fix CLI public-result dependency boundary
state: done
priority: 1
needs: []
parent: task/carry-final-placement-facts-in-contract-results/chapter-2-final-completion-rendering
supersedes: []
relates: []
note: CLI now uses package-root Delivery["completion"]; focused renderer tests, typecheck, and diff check passed.
createdBy: aku/worker-2/01359dde
createdAt: 2026-08-19T04:32:38.950Z
updatedAt: 2026-08-19T04:34:18.138Z
---
Remove the CLI result adapter dependency on protocol completion types while preserving the public completion value.