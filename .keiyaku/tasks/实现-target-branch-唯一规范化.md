---
id: 实现-target-branch-唯一规范化
title: 实现-target-branch-唯一规范化
state: open
pri: 0
needs: []
parent: null
from: []
createdAt: 2026-08-06T22:52:04.101Z
updatedAt: 2026-08-06T22:52:24.205Z
creator: thekoc
---
Owner: act_362 integrated into docs/public-api.md and docs/transport.md before implementation.

At the library boundary, a target not starting `refs/` must validate as a Git branch name and become `refs/heads/<input>`; a full target must be `refs/heads/...`. Reject invalid targets and Keiyaku-owned namespaces as typed `invalid-target`. Persist only the canonical full ref. No DWIM tags/remotes/notes and no current-branch coupling. Replace the current `for-each-ref` byte-equality trap; prove `target: "main"`, canonical full input, invalid grammar, owned namespace, missing branch, and target CAS use the same canonical coordinate.
