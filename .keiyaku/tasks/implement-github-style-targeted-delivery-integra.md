---
id: task/implement-github-style-targeted-delivery-integra
title: Implement GitHub-style targeted delivery integration
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-11T08:08:14.636Z
updatedAt: 2026-08-11T19:51:06.964Z
---
Implement Faye act_205 and the final act_209 settings correction as one persisted hard cut. Separate tenderSnapshot from the integration candidate; add GitHub-named git.requireBranchesToBeUpToDate policy default false; implement squash integration on Git >=2.38 without touching agent worktrees; run verification and CAS against integration bytes; repair ChangeId to integration predecessor -> integration tree; add typed policy/conflict/unsupported/target-moved results; split tender delivery ref and integration pin custody; update terminal cleanup, exact status/audit drift, owner laws, codecs, fixtures, tests, and Git format 3 -> 4 with no compatibility decoder. CLI reads repo settings and has no per-deliver policy flag; library accepts the pure explicit boolean.
