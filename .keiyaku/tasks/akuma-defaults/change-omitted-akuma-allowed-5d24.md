---
id: task/akuma-defaults/change-omitted-akuma-allowed-5d24
title: Change omitted Akuma allowed defaults
state: done
priority: 2
needs: []
parent: null
supersedes: []
relates: []
note: Implemented default Akuma action baseline excluding contract.review; preserved historical Soul decoding; updated owner law, CLI help, skill guidance, and tests. npm test, npm run test:typecheck, and npm run build pass.
createdAt: 2026-09-19T10:11:40.089Z
updatedAt: 2026-09-19T10:21:26.023Z
---
Set future Akuma births that omit allowed to akuma.*, task.*, contract.audit, and contract.deliver, excluding contract.review. Preserve historical Souls whose old records omitted an explicit frozen set. Update owner law, CLI guidance, and focused tests; run focused and repository verification.