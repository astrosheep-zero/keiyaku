---
id: task/maintenance/close-typescript-test-coverage-431b
title: Close TypeScript test coverage and fixture debt
state: done
priority: 1
needs: []
parent: task/maintenance/repository-wide-simplification-adad
supersedes: []
relates: []
note: ""
createdAt: 2026-09-29T13:38:26.583Z
updatedAt: 2026-09-29T16:11:13.665Z
---
Make `tsconfig.tests.json` cover every current TypeScript test, remove its stale path, and resolve the real strict-type errors revealed by the census without weakening production types, casting away evidence, or excluding files. Keep the test compile boundary truthful as files move during the campaign.