---
id: task/restore-plural-wait-shared-detail-budgeting
title: Restore plural wait shared detail budgeting
state: open
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-15T08:32:20.329Z
updatedAt: 2026-08-15T08:32:20.329Z
---
docs/public-akuma.md requires one shared 32-row ordinary-detail budget across plural wait results, but waitAkuma currently returns each unmodified Akuma status and the existing critical test fails even on main. Resolve the owner/data-flow mismatch rather than weakening the test; preserve per-Akuma pinned running tools and pending tells.