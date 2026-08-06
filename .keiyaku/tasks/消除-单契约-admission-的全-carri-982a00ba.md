---
id: 消除-单契约-admission-的全-carri-982a00ba
title: 消除-单契约-admission-的全-carrier-树重建
state: open
pri: 0
needs: []
parent: null
from: []
createdAt: 2026-08-06T22:35:15.465Z
updatedAt: 2026-08-06T22:52:03.453Z
creator: thekoc
---
Faye act_362 makes this day-one law: targeted observation/admission is O(touched journal size + bounded ancestor depth), never O(world); full-world observation may be O(N). Keep one carrier ref and atomic carrier+target CAS. Use Git tree fanout/path spine privately; ban cache/current-state snapshot/second or per-contract refs/in-repo fact index. Acceptance must show single-contract amend object IO does not grow linearly with N.
