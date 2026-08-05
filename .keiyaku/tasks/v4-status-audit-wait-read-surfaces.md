---
id: v4-status-audit-wait-read-surfaces
title: v4 status audit wait read surfaces
state: open
pri: 1
needs: []
parent: null
from: []
createdAt: 2026-08-05T09:19:52.399Z
updatedAt: 2026-08-05T09:20:05.630Z
creator: thekoc
---
Complete the current-law read surfaces in src/core/read and the CLI adapters: status is one folded board with bounded live lag behavior, audit is journal history plus retained context and optional body diff, and wait uses a fixed typed identity set with --any/--all and deadline semantics. Keep reads side-effect free, do not persist observations, and add small exact tests for filtering, timeout 0 snapshots, and identity membership. Do not alter journal facts or verb admission.
