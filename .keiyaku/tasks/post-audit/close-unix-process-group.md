---
id: task/post-audit/close-unix-process-group
title: Close Unix process-group termination after leader exit
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-01T08:38:53.943Z
updatedAt: 2026-09-01T09:16:48.248Z
---
Fix the concrete detached Unix process-group leak in src/runtime/proc/termination.ts. Keep the guarantee bounded to the owned process group. SIGTERM must not end the grace period merely because the leader exited; probe the group and SIGKILL remaining members. Add regression fixtures for a leader that exits on TERM while a descendant ignores TERM, including inherited output pipes.