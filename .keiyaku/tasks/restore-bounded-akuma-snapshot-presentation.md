---
id: task/restore-bounded-akuma-snapshot-presentation
title: Restore bounded Akuma snapshot presentation
state: done
priority: 0
needs: []
parent: null
supersedes:
  - task/显示-akuma-snapshot-省略计数
relates:
  - task/audit-akuma-activity-snapshot-against-v3
note: ""
createdAt: 2026-08-12T05:12:49.668Z
updatedAt: 2026-08-12T16:01:42.485Z
---
Implement the settled AI-facing Akuma snapshot cut. Select the last 3 settled semantic activity rows plus the newest 5 said/thought rows, union all running tools and pending tells, dedupe and retain sequence order. Represent hidden semantic intervals as ordered gaps; a one-row gap is closed by retaining that row, while gaps of 2+ render in place as ⋮ +N. Preserve persistence truncation as typed evidence and apply renderer-owned terminal-width wrapping plus display truncation. Correct history --last guidance to use AkuId rather than provider historyId. Bound plural wait with one aggregate detail budget while preserving each member's life/outcome and pinned facts. Update Akuma Heart/Public, CLI owner law, typed public shapes, pure selectors/renderers, and focused tests; do not add turn/body boundary rows or status retention-loss prose.