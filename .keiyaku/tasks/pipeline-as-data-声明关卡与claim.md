---
id: task/pipeline-as-data-声明关卡与claim
title: pipeline-as-data-声明关卡与claim
state: drop
priority: 1
needs:
  - task/approval-patch-id-dismiss-stale-approvals
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-05T08:48:15.951Z
updatedAt: 2026-08-07T11:29:07.425Z
---
Make acceptance pipeline data-owned. Add effective body pipeline declarations with ordered gates and closed bindings: reviewed binds diff patch-id; verified binds candidate tree (later execution slice). Unspecified pipeline uses default reviewed(diff); explicit empty means no gates. Claim checks only currently declared gates, never hardcodes approval/verification semantics. Move the old approval gate out of kernel law and narrow verification-run prohibitions accordingly. Add tests for default, explicit empty, and declared gate behavior; no generic lifecycle runner or verb registry.