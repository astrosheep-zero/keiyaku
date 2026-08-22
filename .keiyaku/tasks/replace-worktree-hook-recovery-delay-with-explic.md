---
id: task/replace-worktree-hook-recovery-delay-with-explic
title: Replace worktree hook recovery delay with explicit sequencing
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: Contract candidate verified and ready for tender.
createdBy: aku/worker-2/b0286eb4
createdAt: 2026-08-20T12:13:03.279Z
updatedAt: 2026-08-20T12:37:09.971Z
---
Investigate and repair the worktree hook recovery test so interleaving is driven by explicit synchronization, bounded failure, and reliable cleanup. Preserve hook ordering, retry, and recovery assertions within the Contract Region.Observed candidate facts: the prior file-poll helper was removed, but the candidate still leaves an unused watcher-based helper and uses a timer only as a bounded startup deadline. Investigation must account for EMFILE risk from descriptor-heavy readiness mechanisms and hangs if the release signal is not cleaned up.Verification facts: baseline candidate focused run emitted four dots then hung in the killed-caller test; the FIFO/stream cleanup path stranded the run. EMFILE was identified as the descriptor exhaustion risk of readiness polling/pipe-heavy coordination (no EMFILE reproduced after removing polling). Unix and TCP sockets were denied EPERM in this sandbox, so the final explicit handshake uses process signals and deferred promises with bounded startup failure.