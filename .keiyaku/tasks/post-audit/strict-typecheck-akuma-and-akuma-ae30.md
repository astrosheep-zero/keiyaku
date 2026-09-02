---
id: task/post-audit/strict-typecheck-akuma-and-akuma-ae30
title: Strict-typecheck Akuma and Akuma CLI tests
state: drop
priority: 2
needs: []
parent: task/migrate-remaining-historical
supersedes: []
relates: []
note: Superseded by smaller Akuma strict migration slices after repeated execution-host SIGKILL; no candidate landed.
createdAt: 2026-09-01T17:37:02.196Z
updatedAt: 2026-09-01T17:42:29.146Z
---
Migrate the Akuma/body/provider/request/public and Akuma CLI test cluster into strict coverage: tests/akuma-body-requests.test.ts, tests/akuma-body.test.ts, tests/akuma-heart.test.ts, tests/akuma-provider.test.ts, tests/akuma-public.test.ts, tests/akuma-requests.test.ts, tests/cli-akuma-msys.test.ts, tests/cli-akuma.test.ts, tests/dispatch-alias.test.ts, tests/kanshi.test.ts, tests/library-akuma-creation.test.ts, tests/observation.test.ts, and tests/windows-akuma-process.test.ts. Preserve behavior, use current public identity/result types, and remove obsolete fixture drift. Do not modify production code or the shared tsconfig in the worker; the coordinator will add the completed file list to the maintained strict subset after both parallel lanes finish.,