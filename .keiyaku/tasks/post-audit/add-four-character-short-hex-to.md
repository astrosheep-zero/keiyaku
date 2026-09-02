---
id: task/post-audit/add-four-character-short-hex-to
title: Add four-character short hex to new Task IDs
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-01T08:38:53.943Z
updatedAt: 2026-09-01T09:57:26.881Z
---
Keep logical Task IDs human-readable while appending a four-character short hex by default. Decide and test collision behavior, namespace parsing, display, and physical path safety. Existing IDs remain readable; new allocation must use the new form.