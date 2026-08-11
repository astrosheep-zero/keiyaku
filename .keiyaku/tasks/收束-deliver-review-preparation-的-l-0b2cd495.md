---
id: task/收束-deliver-review-preparation-的-l-0b2cd495
title: 收束 deliver review preparation 的 lifecycle 裁判
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-06T21:19:40.839Z
updatedAt: 2026-08-07T11:29:07.455Z
---
Superseded by docs/lifecycle.md, docs/document.md, docs/verification.md, docs/transport.md, and docs/public-api.md after Faye act_357. Erase lifecycle preflight. Each bounded attempt owns one decision observation; stamped document derivation is judged by the legal decide. Only after the state-only stage permits the attempt may carrier mechanically prepare candidate/patch/tree from coordinates in that same observation; final decide consumes the same observation. Review has no document derivation. Delete Verification attestation reuse/stale-skip and verifiedSubject null skip. Preserve bounded protocol redecision only for carrier movement; document-moved returns to caller. Add exact amend/deliver and abandon/reconcile race regressions.