---
id: task/approval-patch-id-dismiss-stale-approvals
title: approval-patch-id-dismiss-stale-approvals
state: drop
priority: 1
needs: []
parent: null
supersedes: []
relates:
  - task/approve-review-纯-owner-测试
note: ""
createdAt: 2026-08-05T08:48:16.280Z
updatedAt: 2026-08-07T11:29:07.421Z
---
Replace approval reviewedHead coordinate validity with reviewedPatchId content identity (git patch-id --stable of squashed delivery diff). Pure rebase with unchanged content keeps approval valid. Renew/amend/new petition no longer clear approval; changes-requested and terminal settlement still clear. Add dismissStaleApprovals (default false): when enabled, mismatched current patch-id refuses; when false, audit exposes flat approval/current patch-id facts without WARNING/ATTENTION prose. Keep actor and journal authority boundaries; update law/docs with act_203.