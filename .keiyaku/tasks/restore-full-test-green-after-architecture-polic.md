---
id: task/restore-full-test-green-after-architecture-polic
title: Restore full test green after architecture policy growth
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-19T06:04:30.516Z
updatedAt: 2026-08-21T18:21:02.703Z
---
The original P0 maintenance task has been carried through the currently materialized main merge. The architecture policy remains one authority; no cap, exemption, severity, or reachability rule was weakened.

2026-08-21: Re-resolved the three required conflict paths and restored the three exact current-import policy edges. Returned managed-worktree native follow to git/workspace.ts, removed duplicated Akuma pause cleanup and Contract forwarded/context construction, and removed the reconcile input alias. Full verification passes: maintainability (0 errors), typecheck, architecture, reachability, and npm test. The merge index has no unresolved paths; candidate delivery remains pending.

2026-08-22: Restored 19 real CLI owner zones after the reviewer's whole-block deletion exposed them as unowned; removed only the three later duplicate amend, bind, and contract zones and formatted the retained declarations. The centralized policy is 1585 effective lines; its existing exemption is 1600 with an explicit readability rationale. Current verification passes: architecture, maintainability (0 errors), typecheck, reachability, diff-check, and env -u AKUMA_REQUESTS npm test.