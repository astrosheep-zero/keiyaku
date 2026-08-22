---
id: task/collapse-nuke-to-confirmed-owner-local-deletion
title: Collapse nuke to confirmed owner-local deletion
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdBy: aku/worker-2/015c1ba7
createdAt: 2026-08-19T13:29:42.152Z
updatedAt: 2026-08-20T13:59:10.904Z
---
Arc 5 Nuke correction is implemented and remains in progress pending coordinator acceptance. Akuma now requires a regular existing Heart or Leash marker before treating a legal-looking run directory as Keiyaku-owned; markerless foreign custody is preserved. The Akuma owner enumerates once, retains each leash from stop verification through Alias/direct runtime deletion, and releases it afterward. Unknown bytes inside recognized Akuma directories remain; request transport remains untouched. Failed Nuke maps to exit 2. Alias, Place, and Task cleanup releases existing lock handles but leaves lock paths as harmless coordination residue because the primitive cannot prove post-release pathname identity. Focused Nuke, typecheck, build, architecture, reachability, and diff-check pass. npm test remains blocked only by src/akuma/body.ts 759/750 maintainability baseline.
Repair: kept the acquired contract-worktree.sqlite lock held across managed custody observation, worktree removal, appointments, Place authority, and Keiyaku ref cleanup; released it in finally. No scanners or normal-cleanup semantics added.
Verification: focused nuke, Git reconciliation, and settlement tests pass; typecheck and build pass. Candidate re-delivery follows.
Final verification: tests/nuke.test.ts passed 11/11; npm run test:typecheck passed; npm run build passed. The lock remains held for the complete Git cleanup arm and closes in finally; nukeHereAppointments reuses the held owner-local lock to avoid reacquisition deadlock.
