---
id: task/design-keiyaku-nuke-as-an-explicit-world-teardow
title: Design keiyaku nuke as an explicit world teardown
state: open
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-15T03:09:43.989Z
updatedAt: 2026-08-15T03:09:43.989Z
---
Define and implement an explicit `keiyaku nuke` capability for intentionally removing Keiyaku-managed state. This is a destructive product operation, so owner law must first settle its exact coordinate and inventory: Contract journal/refs, managed worktrees, Task authority and namespace, Akuma Hearts, Alias and Dispatch data, reconciliation residue, and any resources that must explicitly remain outside scope.

The operation must expose a complete preflight and typed result, refuse ambiguous or foreign custody, avoid one pillar silently deleting another pillar's unrelated/global resources, and define interruption/retry/recovery behavior without inventing a second inventory authority. Decide the explicit confirmation surface and whether recovery is possible before implementation. Use the unfinished v3 nuke task only as evidence, not as authority.