---
id: task/task-cli-observation-facts-and-selection
title: Task CLI observation facts and selection
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: "Delivery observation: plural task show reads one board and relation projection, renders requested details in input order, and JSON returns the ordered array; any missing or invalid requested ID refuses the entire invocation with no partial success. Compact rows share one board observation and expose typed objective facts."
createdAt: 2026-08-20T10:48:06.792Z
updatedAt: 2026-08-20T12:25:03.295Z
---
Implement Faye's Task CLI product ruling: keep ready's lifecycle meaning, make ready/ls/query rows carry objective facts needed to shortlist work, expose the query grammar and truncation recovery commands, allow one show invocation to inspect a shortlist, and use a bounded whole-word slug for newly created TaskIds without rewriting existing coordinates. Preserve Task as an independent Markdown product. Do not add value scoring, stale thresholds, default filtering, folding, aliases, a scheduler, or automatic choices for the caller.