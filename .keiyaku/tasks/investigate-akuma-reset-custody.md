---
id: task/investigate-akuma-reset-custody
title: Investigate Akuma reset custody
state: done
priority: 1
needs: []
parent: task/implement-akuma-owned-reset-arm
supersedes: []
relates: []
note: "Mapped runtime ownership: run/<archetype>-<hex8> under Heart/leash custody, world-local Alias authority with one SQLite lock, and per-run leashes as the existing admission boundary. A nuke arm can retain every enumerated leash through removal; a new concurrent run is subsequent state under the Contract."
createdBy: aku/worker-2/015c1ba7
createdAt: 2026-08-19T11:30:44.132Z
updatedAt: 2026-08-19T11:31:47.983Z
---
Map existing run, Heart, leash, Alias, and lock ownership plus stop verification and failure semantics. Record findings before implementation.