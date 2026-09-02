---
id: task/post-audit/strict-typecheck-akuma-public-7486
title: Strict-typecheck Akuma public and provider tests
state: done
priority: 2
needs: []
parent: task/migrate-remaining-historical
supersedes: []
relates: []
note: ""
createdAt: 2026-09-01T17:42:42.144Z
updatedAt: 2026-09-01T18:29:54.925Z
---
Bring tests/akuma-public.test.ts and tests/akuma-provider.test.ts into the maintained strict subset. Update historical Akuma public/provider fixtures and result-union assertions to current public types without changing production behavior, compiler strictness, or unrelated tests. Keep the shared tsconfig addition limited to these two files and verify focused behavior tests plus npm run test:typecheck.