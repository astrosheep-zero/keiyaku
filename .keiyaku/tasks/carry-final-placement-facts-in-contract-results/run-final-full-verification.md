---
id: task/carry-final-placement-facts-in-contract-results/run-final-full-verification
title: Run final full verification
state: in_progress
priority: 2
needs:
  - task/carry-final-placement-facts-in-contract-results/complete-chapter-2-owner-docs
  - task/carry-final-placement-facts-in-contract-results/verify-renderer-and-output-contract-criteria
  - task/carry-final-placement-facts-in-contract-results/fix-cli-public-result-dependency-boundary
parent: task/carry-final-placement-facts-in-contract-results/chapter-2-final-completion-rendering
supersedes: []
relates: []
note: "After stale Verification aggregation fix: focused suites PASS (library-audit, library-verification, library-concurrency-placement, cli-render, cli-invoke: 77/77). npm run test:typecheck PASS; npm run build PASS; git diff --check PASS. npm test: architecture PASS, then FAIL only at test:maintainability because unrelated scripts/architecture/policy.ts exceeds max-lines (checker 1385 > 1350; wc -l current=1387, git show HEAD:file=1387). This Contract does not modify that owner; full verification remains open."
createdBy: aku/worker-2/01359dde
createdAt: 2026-08-19T04:24:08.482Z
updatedAt: 2026-08-19T11:33:58.408Z
---
Run the Contract-required full verification commands and record results.