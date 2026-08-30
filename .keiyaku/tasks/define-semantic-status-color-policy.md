---
id: task/define-semantic-status-color-policy
title: Define semantic status color policy
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates:
  - task/add-honest-status-ages-and-semantic-color
note: Settled the text-only ANSI policy in docs/cli-output.md and implemented glyph-only alert/attention/recent/dim tones from existing Kanshi timestamps and states. No-color bytes remain exact; no JSON or persisted tone facts. Focused Kanshi tests, typecheck, architecture, formatting, maintainability, and diff hygiene pass.
createdAt: 2026-08-14T00:55:53.398Z
updatedAt: 2026-08-30T07:23:06.996Z
---
Square act_340 Part B. Before any Contract is bound, settle a human product mapping from status state and age thresholds to semantic tone. Decide at least Contract pending/review age, Akuma asleep age, errors, and recent activity. The current dim/alert renderer remains unchanged until that table is authoritative. Do not add color or urgency facts to JSON, journals, Heart, or Kanshi data; ANSI remains a text-only presentation aid.