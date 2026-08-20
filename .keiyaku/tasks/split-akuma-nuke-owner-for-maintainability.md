---
id: task/split-akuma-nuke-owner-for-maintainability
title: Split Akuma nuke owner for maintainability
state: done
priority: 1
needs: []
parent: task/implement-akuma-owned-reset-arm
supersedes: []
relates: []
note: ""
createdBy: aku/worker-2/015c1ba7
createdAt: 2026-08-19T11:38:46.063Z
updatedAt: 2026-08-19T11:51:01.589Z
---
Move the cohesive Akuma reset inventory/stop/verify/remove implementation into src/akuma/nuke.ts because adding it to the existing lifecycle facade exceeds its 600-line owner exemption. Keep the package composition owner-local and do not change later arms.