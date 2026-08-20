---
id: task/collapse-nuke-to-confirmed-owner-local-deletion
title: Collapse nuke to confirmed owner-local deletion
state: in_progress
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdBy: aku/worker-2/015c1ba7
createdAt: 2026-08-19T13:29:42.152Z
updatedAt: 2026-08-19T17:42:16.940Z
---
Arc 5 Nuke correction is implemented and remains in progress pending coordinator acceptance. Akuma now requires a regular existing Heart or Leash marker before treating a legal-looking run directory as Keiyaku-owned; markerless foreign custody is preserved. The Akuma owner enumerates once, retains each leash from stop verification through Alias/direct runtime deletion, and releases it afterward. Unknown bytes inside recognized Akuma directories remain; request transport remains untouched. Failed Nuke maps to exit 2. Alias, Place, and Task cleanup releases existing lock handles but leaves lock paths as harmless coordination residue because the primitive cannot prove post-release pathname identity. Focused Nuke, typecheck, build, architecture, reachability, and diff-check pass. npm test remains blocked only by src/akuma/body.ts 759/750 maintainability baseline.
