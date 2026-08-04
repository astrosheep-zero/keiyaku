---
id: pipeline-as-data-声明关卡与claim
title: pipeline-as-data-声明关卡与claim
state: open
pri: 1
needs:
  - approval-patch-id-dismiss-stale-approvals
parent: null
from: []
createdAt: 2026-08-04T10:58:28.362Z
updatedAt: 2026-08-04T10:58:28.362Z
creator: thekoc
---
Make acceptance pipeline data-owned. Add effective body pipeline declarations with ordered gates and closed bindings: reviewed binds diff patch-id; verified binds candidate tree (later execution slice). Unspecified pipeline uses default reviewed(diff); explicit empty means no gates. Claim checks only currently declared gates, never hardcodes approval/verification semantics. Move the old approval gate out of kernel law and narrow verification-run prohibitions accordingly. Add tests for default, explicit empty, and declared gate behavior; no generic lifecycle runner or verb registry.
