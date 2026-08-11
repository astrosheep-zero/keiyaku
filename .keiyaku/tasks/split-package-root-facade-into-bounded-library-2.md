---
id: task/split-package-root-facade-into-bounded-library-2
title: Split package-root facade into bounded library owners
state: drop
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: Duplicate created during task setup; canonical task is task/split-package-root-facade-into-bounded-library-o.
createdAt: 2026-08-11T02:06:07.101Z
updatedAt: 2026-08-11T02:06:55.917Z
---
Implement the approved act_175 composition shape. Make src/library composition-only; split keiyaku.ts into facade, contract, repo, summon, fleet, and address owners without changing behavior. Update docs/public-api.md and docs/README.md. No orchestration directory, no new authority, no Akuma behavior in Repo.