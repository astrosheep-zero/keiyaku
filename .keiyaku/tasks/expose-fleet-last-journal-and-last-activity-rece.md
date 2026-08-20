---
id: task/expose-fleet-last-journal-and-last-activity-rece
title: Expose fleet last-journal and last-activity recency
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates:
  - task/add-honest-status-ages-and-semantic-color
note: Candidate ready for coordinator commit. Cold Contract and stranded Akuma compact-text assertions independently retain their phase/activity/journal, target/behind, and resume facts. Exact aperture-hierarchy test and focused recency suite pass; typecheck, build, architecture, reachability, and diff --check pass. No review or delivery was run.
createdAt: 2026-08-15T16:52:14.155Z
updatedAt: 2026-08-20T04:42:05.469Z
---
Give the flagship a fleet-level recency signal that answers when each Contract journal and Akuma activity timeline last moved. Keep this distinct from phase-start, gate-attestation, and life-state age in the related status-timestamps Task. Derive display ages at read time from existing authoritative timestamps; add no durable duration or second activity fact. First settle the exact public projection and Kanshi ownership in the owning root documents, then implement Contract and Akuma rows, text/JSON output, and focused tests without scanning full retained history per row.