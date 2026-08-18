---
id: task/expose-fleet-last-journal-and-last-activity-rece
title: Expose fleet last-journal and last-activity recency
state: open
priority: 0
needs: []
parent: null
supersedes: []
relates:
  - task/add-honest-status-ages-and-semantic-color
note: ""
createdAt: 2026-08-15T16:52:14.155Z
updatedAt: 2026-08-15T16:52:14.155Z
---
Give the flagship a fleet-level recency signal that answers when each Contract journal and Akuma activity timeline last moved. Keep this distinct from phase-start, gate-attestation, and life-state age in the related status-timestamps Task. Derive display ages at read time from existing authoritative timestamps; add no durable duration or second activity fact. First settle the exact public projection and Kanshi ownership in the owning root documents, then implement Contract and Akuma rows, text/JSON output, and focused tests without scanning full retained history per row.