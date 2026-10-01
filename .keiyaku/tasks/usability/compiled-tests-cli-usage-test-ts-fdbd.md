---
id: task/usability/compiled-tests-cli-usage-test-ts-fdbd
title: Compiled tests/cli-usage.test.ts hangs on main
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates:
  - task/usability/investigate-inconsistent-full-6096
note: "Originally reproduced a compiled tests/cli-usage.test.ts hang caused by registering child close/error settlement after a blocked-write delay. RESOLVED 2026-09-28 by kei/full-suite-fixture-honesty-1060 (main 8df7efd23): listeners now register before the wait and builtCli uses the .test-build/src -> build/src seam. Reverified 2026-09-29 on main e6e982148: the compiled cli-usage file passed inside npm test. The current deterministic compiled-doc failure is in cli-render.test.ts and is tracked by the repository-wide maintenance campaign, not this closed hang."
createdAt: 2026-09-27T00:39:45.643Z
updatedAt: 2026-09-29T13:17:04.540Z
---
