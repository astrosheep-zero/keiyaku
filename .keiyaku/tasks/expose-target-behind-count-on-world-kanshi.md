---
id: task/expose-target-behind-count-on-world-kanshi
title: Expose target behind count on world Kanshi
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: "Already fulfilled on main by commit 28b490a1: Git-owned ContractTargetLag counts HEAD..target observation, Kanshi renders behind N/unknown alongside drift, with focused tests."
createdAt: 2026-08-15T01:09:08.157Z
updatedAt: 2026-08-19T09:04:09.269Z
---
Investigate and, once the product rule is settled, expose the target ref and numeric commit distance for Contracts on the world Kanshi/status board. Preserve the existing boolean drift observation and verify the count against the Git owner. v3 evidence: docs/keiyaku-v3/product/command-output.md:312. The v4 audit found only boolean drift in docs/public-api.md:214, docs/public-results.md:352, and src/cli/render/kanshi.ts:112. Do not add implementation or change the public law until the owner shape is confirmed.