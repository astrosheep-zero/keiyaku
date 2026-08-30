---
id: task/architecture-convergence/close-provider-custody-proof
title: Close Provider custody proof holes
state: done
priority: 0
needs: []
parent: task/architecture-convergence/close-post-refactor-defects-by
supersedes: []
relates: []
note: Pi aggregate closure and custody sealing implemented; Provider/body tests, architecture, typecheck, and full npm test pass.
createdAt: 2026-08-30T08:18:20.372Z
updatedAt: 2026-08-30T09:26:14.135Z
---
Collapse Pi retirement to one complete disposal proof and seal AttemptCustody after establishment. Preserve concurrent unhandled-rejection changes. Faye PUBLIC.square act/919.