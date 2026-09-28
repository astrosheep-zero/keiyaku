---
id: task/kei/attribute-live-activity-and-31ce/live-streams-never-settle-an-bc61
title: Live streams never settle an active tool row
state: open
priority: 2
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdBy: aku/pi-flash/ac66b472
createdAt: 2026-09-15T18:28:06.578Z
updatedAt: 2026-09-15T18:28:06.578Z
---
Follow-up from kei/attribute-live-activity-and-31ce (attribution and call output). Pre-existing
projection/stream settlement gap, deliberately not fixed there, because fixing it would
re-emit an already streamed row and break the current no-replay rule.

Reproduction
- An Akuma whose provider reports a tool call that later settles ok: the row streams once as
  active in the live call/wait stream and never re-renders as settled, while the final
  snapshot (history or JSON receipt) shows the settled row. It reproduces under the old
  entry-count delta and the current sequence delta, so it is not an artifact of the
  streaming rewrite.

Cause
- projectToolEvent (src/akuma/projection.ts, completed-tool branch, around lines 375-387)
  replaces the started tool row in place and reuses the started row sequence (and its
  timestamp), dropping the completion fact own sequence. Stream delta tracking keys on row
  sequence, so the settled form is never seen as a new row.

Direction (not decided here)
- Track the emitted (sequence, rendered form) pairs and re-emit a row only when its rendered
  form changes, or drive streams from the fact ledger. Any fix must not duplicate unchanged
  rows and must keep one settlement row per fact.