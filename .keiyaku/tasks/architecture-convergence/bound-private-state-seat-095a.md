---
id: task/architecture-convergence/bound-private-state-seat-095a
title: Bound private-state seat acquisition and speculative preparation
state: done
priority: 2
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-02T12:54:40.942Z
updatedAt: 2026-09-02T20:54:13.525Z
---
Implement Faye ruling act/1254 for the private-state publication seat. Keep one seat per private root and keep fresh observation -> decision -> admission plus ref movement in one custody. Move only eligible preparation outside custody when its observed inputs are declared and revalidated inside custody; stale artifacts follow existing publication-failure/re-observation semantics. Add a bounded default acquisition timeout with caller override and AbortSignal support; timeout is typed Git contention projected through existing retry results and never breaks or deadlines a held seat. Detect same-process/async-context reentry by lock path and raise invariant violation immediately. Update docs/lifecycle.md and docs/git.md (and docs/public-results.md only if retry reasons are enumerated). Scope implementation to src/git/private-state-seat.ts and protocol/run.ts, deliver.ts, review.ts plus focused tests; do not shard or make the seat reentrant, add a new public result kind, deadline held callbacks, or refactor amend/placement/reintegrate/dispatch/settlement/nuke callers. Acceptance: slow external preparation no longer blocks unrelated admission; stale preparation is rejected without partial write; acquisition timeout is bounded and typed; reentry fails immediately; long held callback completes; existing contention tests remain green.