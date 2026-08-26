---
id: task/read-a-specific-akuma-outcome-by
title: Read a specific Akuma outcome by ID
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-25T12:19:23.971Z
updatedAt: 2026-08-26T05:00:58.667Z
---
Add a public history selector that retrieves one exact Akuma answer/failed outcome by its durable ID. Preserve current --last behavior as the short-preview fallback. Define the ID source, validation, output shape, and missing-ID refusal in the owning CLI/public-results law, then cover the full answer retrieval path and the Square preview command.