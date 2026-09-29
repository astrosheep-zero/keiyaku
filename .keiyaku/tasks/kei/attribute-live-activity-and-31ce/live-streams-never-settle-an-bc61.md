---
id: task/kei/attribute-live-activity-and-31ce/live-streams-never-settle-an-bc61
title: Live streams never settle an active tool row
state: done
priority: 2
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdBy: aku/pi-flash/ac66b472
createdAt: 2026-09-15T18:28:06.578Z
updatedAt: 2026-09-28T16:48:48.032Z
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
2026-09-29 architecture investigation: current live streams print settled tools only, so the old active-row wording is stale. Confirmed shared call/wait/ask defect: active A at seq6, completed B at seq7 renders, then A completion projects back to seq6 and mutableSequences appends A after B. Silently suppressing A would lose its result and does not fulfill settlement visibility. Settled design: project a completed tool at its retained completion fact sequence and time, retain duration from its start, use that one projection consistently for status/history/live companion/reported changes, and remove tool-specific mutable replay tracking. Update the obsolete start-anchor history test and record the conceptual ordering in the public timeline owner document. Tell admission semantics remain unchanged.