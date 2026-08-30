---
id: task/architecture-ownership/repair-rebased-contract-guidance
title: Repair rebased Contract guidance import
state: done
priority: 0
needs: []
parent: task/architecture-ownership/restore-target-exemptions-and
supersedes: []
relates: []
note: "Evidence: node --import tsx --test tests/cli-selectors.test.ts (5/5); node --import tsx --test tests/settings.test.ts (15/15); npm run test:typecheck; npm run test:architecture (ok, 264 files); npm run build; git diff --check."
createdAt: 2026-08-28T12:07:07.980Z
updatedAt: 2026-08-28T12:10:17.849Z
---
In the Heart worktree rebased onto bbdc91ff, src/library/contract-handle.ts still imports renderContractGuidance from contract-worktree.js even though claimed Guidance ownership moved the export to contract-guidance.js. Change only the semantic rebase fallout, run the two reproducing tests plus typecheck/build, commit, deliver the exact new candidate, and report receipts. Do not audit or review.