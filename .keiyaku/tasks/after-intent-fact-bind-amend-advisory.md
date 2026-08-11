---
id: task/after-intent-fact-bind-amend-advisory
title: after-intent-fact-bind-amend-advisory
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-04T12:01:57.721Z
updatedAt: 2026-08-07T11:29:07.420Z
---
Add optional after contract identity list to bind and amend. Fold it into effective body/state; reject self-reference only. It is advisory topology metadata: never gates bind/open/seal/renew/petition/review/claim/forfeit and never creates cycle detection or queue authority. Preserve exact identity bytes and add tests for bind/amend, self-reference refusal, and zero lifecycle gating. Update law/docs with act_203.