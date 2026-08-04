---
id: approval-patch-id-dismiss-stale-approvals
title: approval-patch-id-dismiss-stale-approvals
state: open
pri: 1
needs: []
parent: null
from: []
relatesTo:
  - approve-review-纯-owner-测试
createdAt: 2026-08-04T10:58:09.734Z
updatedAt: 2026-08-04T10:58:09.734Z
creator: thekoc
---
Replace approval reviewedHead coordinate validity with reviewedPatchId content identity (git patch-id --stable of squashed delivery diff). Pure rebase with unchanged content keeps approval valid. Renew/amend/new petition no longer clear approval; changes-requested and terminal settlement still clear. Add dismissStaleApprovals (default false): when enabled, mismatched current patch-id refuses; when false, audit exposes flat approval/current patch-id facts without WARNING/ATTENTION prose. Keep actor and journal authority boundaries; update law/docs with act_203.
