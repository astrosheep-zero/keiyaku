---
id: task/workflow-regressions/restore-tell-delivery-state-to
title: Restore Tell delivery state to its timeline row
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-30T11:01:24.184Z
updatedAt: 2026-08-30T12:42:00.581Z
---
Regression introduced by 5c3139a1 under kei/make-body-request-results-minimal-and-schema-own: tell text now prints a separate `tell pursuing body=N` or held/told receipt after removing post-action observation. Restore the standing semantic from 2ca636d3 without re-expanding the public result: Tell delivery state has one text carrier on its corresponding timeline row; held/pursuing add no separate wake receipt; failure may add one loud delivery-failure fact. Update focused tests so they prevent this regression.