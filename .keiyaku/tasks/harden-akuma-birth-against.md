---
id: task/harden-akuma-birth-against
title: Harden Akuma birth against SQLite lock contention
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-24T04:23:41.255Z
updatedAt: 2026-08-24T05:48:56.625Z
---
Audit and repair Akuma birth under SQLite lock contention. Establish the owner-law for Heart lock retry and birth timeout, retry busy Heart reads/writes during birth within the existing budget, preserve typed birth failure evidence, and connect detached Body exit to the parent publication path so a child rejection cannot silently become a 30-second call-timeout. Audit every SQLite lock acquisition in v4 and record which paths already retry, which intentionally fail fast, and which need typed recovery. Include wait --all unobserved-member completion regression coverage in the same lifecycle audit.