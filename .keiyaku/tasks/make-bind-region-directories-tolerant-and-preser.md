---
id: task/make-bind-region-directories-tolerant-and-preser
title: Make bind Region directories tolerant and preserve failed drafts
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-15T05:27:22.014Z
updatedAt: 2026-08-15T05:27:22.014Z
---
Bind authoring must accept a Region directory written with a trailing slash and normalize it to the repository's supported path pattern without rejecting an otherwise valid Contract. Any bind admission failure after reading the complete stdin document must preserve the exact submitted Markdown as a recoverable draft, with a clear path or receipt for the caller; failed bind must not create a partial Contract or silently discard the draft. Add focused tests for trailing-slash Region input, malformed input preservation, and no partial lifecycle effects.