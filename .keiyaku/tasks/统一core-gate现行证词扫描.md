---
id: 统一core-gate现行证词扫描
title: 统一core-gate现行证词扫描
state: open
pri: 0
needs: []
parent: null
from: []
createdAt: 2026-08-06T17:21:10.937Z
updatedAt: 2026-08-06T17:21:35.195Z
creator: thekoc
---
gateSatisfied and gatesSatisfied must share one newest-first current-subject adjudication implementation while gatesSatisfied stays O(attestations + gates), not every(gateSatisfied). Preserve latest same-subject override, stale-subject skipping, opaque gates, and fold/placement semantics.