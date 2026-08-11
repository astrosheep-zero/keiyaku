---
id: task/split-package-root-facade-into-bounded-library-o
title: Split package-root facade into bounded library owners
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-11T02:05:40.689Z
updatedAt: 2026-08-11T03:03:48.636Z
contractId: null
---
Implement the approved act_175 composition shape. Make src/library composition-only; split keiyaku.ts into facade, contract, repo, summon, fleet, and address owners without changing behavior. Update docs/public-api.md and docs/README.md. No orchestration directory, no new authority, no Akuma behavior in Repo.