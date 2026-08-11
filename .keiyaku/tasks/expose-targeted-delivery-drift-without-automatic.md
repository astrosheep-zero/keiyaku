---
id: task/expose-targeted-delivery-drift-without-automatic
title: Expose targeted delivery drift without automatic realignment
state: drop
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: "Superseded by Faye act_205: implement GitHub-style up-to-date policy plus squash integration, not drift-only visibility."
createdAt: 2026-08-11T07:36:45.853Z
updatedAt: 2026-08-11T08:07:58.649Z
---
Implement Faye act_195 without changing the fast-forward-only delivery model. Expand candidate-not-based-on-target with observed target and candidate mechanical facts; expose bounded target ancestry in audit and exact status while keeping the bare board bounded; add an end-to-end real git rebase -> stable patch-id -> reviewed testimony remains current test. Update docs/git.md, docs/public-api.md, and docs/cli.md in the same coherent change. Preserve zero-side-effect refusal, agent-owned rebase/merge/reset, old delivery ref/pin reachability until a new delivery is admitted, and no new alignment verb.