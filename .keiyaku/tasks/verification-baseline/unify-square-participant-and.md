---
id: task/verification-baseline/unify-square-participant-and
title: Unify Square participant and listener name grammar with AkuId
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: Square 0.3.32 is locked; the Square-edge integration was independently reviewed satisfied, claimed, and is on main at 21abf400.
createdAt: 2026-08-28T11:43:10.567Z
updatedAt: 2026-08-30T07:02:57.076Z
---
Preserve Keiyaku's legacy invalid_name no-op fallback, while making the intended Square dependency accept every canonical AkuId used as a listener target, including RGI emoji archetypes. The Square upstream grammar and release own the change; Keiyaku's emoji listener test remains the integration acceptance. This baseline item is independent of the Heart candidate.
Square owner Contract kei/accept-canonical-akuid-names-in-square-listening was independently reviewed and claimed in /Users/astrosheep/Developer/square. It advances package metadata to 0.3.32, preserves legacy fallback compatibility, and proves emoji plus combining-mark AkuId listen/list/ignore. Publication and Keiyaku dependency adoption remain.