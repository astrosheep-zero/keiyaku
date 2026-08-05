---
id: v4-status-audit-wait-read-surfaces
title: v4 status audit wait read surfaces
state: in_progress
pri: 1
needs: []
parent: null
from: []
createdAt: 2026-08-05T09:19:52.399Z
updatedAt: 2026-08-05T12:10:44.606Z
creator: thekoc
startedAt: 2026-08-05T09:20:22.986Z
---
Complete the settled read surfaces in src/core/read and CLI adapters: status is one folded read-only board with optional contract filtering and no caller-selected --fast mode; audit is journal history plus retained context and optional body diff, and when Verification has no current matching pass it executes and admits a separate verification fact through the normal writer path. Do not implement wait in v4 day1: its event source and predicate model are not settled; Akuma waiting remains in the outer keiyaku control plane. Keep read projections free of journal/ref/worktree mutations except the explicit audit Verification admission path, and add small exact tests for the settled behavior. Do not invent default-branch lag or Akuma projection observation.
