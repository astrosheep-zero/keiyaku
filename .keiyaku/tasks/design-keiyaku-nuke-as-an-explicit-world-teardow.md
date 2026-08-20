---
id: task/design-keiyaku-nuke-as-an-explicit-world-teardow
title: Design explicit Keiyaku-owned data reset
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: "Arc 1 candidate complete under Faye acts/159 and /162: nuke is zero-path package composition with owner-local typed zero/nothing preview/reset stubs, literal pre-effect confirmation refusal, public types, and CLI parse/help/refusal projection. No destructive effects exist. Focused, full behavioral, typecheck, build, architecture, reachability, and diff checks pass. npm test is blocked at the pre-existing maintainability policy line-limit failure: the checker reports scripts/architecture/policy.ts at 1399 vs 1350 (1401 physical lines; HEAD was 1387). Await coordinator acceptance before Arc 2."
createdAt: 2026-08-15T03:09:43.989Z
updatedAt: 2026-08-20T05:48:42.541Z
---
Define and implement an explicit `keiyaku nuke` capability for intentionally removing Keiyaku-managed state. This is a destructive product operation, so owner law must first settle its exact coordinate and inventory: Contract journal/refs, managed worktrees, Task authority and namespace, Akuma Hearts, Alias and Dispatch data, reconciliation residue, and any resources that must explicitly remain outside scope.

The operation must expose a complete preflight and typed result, refuse ambiguous or foreign custody, avoid one pillar silently deleting another pillar's unrelated/global resources, and define interruption/retry/recovery behavior without inventing a second inventory authority. Decide the explicit confirmation surface and whether recovery is possible before implementation. Use the unfinished v3 nuke task only as evidence, not as authority.Arc 1 active in kei/add-explicit-world-teardown: settling owner law, public package types, and nuke CLI parse/help only; destructive owner effects are explicitly deferred.