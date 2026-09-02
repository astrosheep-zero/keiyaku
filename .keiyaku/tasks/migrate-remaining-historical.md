---
id: task/migrate-remaining-historical
title: Migrate remaining historical test and script types to strict coverage
state: done
priority: 2
needs: []
parent: null
supersedes: []
relates: []
note: All historical test TypeScript surfaces are now covered by the strict gate or transitively typechecked through included test imports. The gate has 84 direct test entries; three support modules are imported dependencies. npm run test:typecheck passes. Remaining product/test behavior baselines are separate and intentionally not hidden by this migration.
createdAt: 2026-09-01T12:11:31.680Z
updatedAt: 2026-09-02T00:34:33.561Z
---
Bring the remaining historical tests into strict static coverage incrementally. Current evidence: 85 test files are outside the maintained strict subset, 54 currently report errors, with 1368 TypeScript diagnostics. Preserve product behavior and simplify obsolete fixtures/types as they are migrated. Keep one typecheck authority and one lint path; do not weaken the current maintained gate and do not add compatibility or parallel schema machinery. Measure each slice with focused tests and source/tool typechecks. This Task is separate from kei/make-ci-and-typecheck-gates-truthful, whose current Contract intentionally covers only the maintained semantic subset.