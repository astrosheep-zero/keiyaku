---
id: task/replace-readiness-polling-with-an-event-channel
title: Replace readiness polling with an event channel
state: open
priority: 1
needs: []
parent: task/stabilize-runtime-process-test-synchronization
supersedes: []
relates: []
note: ""
createdBy: aku/worker-2/3ad6a87d
createdAt: 2026-08-20T12:13:16.261Z
updatedAt: 2026-08-20T13:07:46.088Z
---
Make fake descendants announce readiness through a caller-owned event channel and preserve real child processes.

Investigation direction recorded 2026-08-20: first reuse the existing stdio pipe and ChildProcess events already owned by src/runtime/proc/run.ts and src/runtime/proc/stdio.ts. Prefer a descendant stdout ready byte consumed through a data event; use the existing child/owned-process exit or close Promise as the termination observation where it actually proves the asserted tree boundary. Do not add TCP or Unix listeners, PID-file polling, process.kill(pid, 0), /proc probes, fixed polling timers, or a second runtime abstraction. This is an investigation constraint, not permission to change production runtime. The expert must distinguish whether inherited stdout close proves descendant termination or merely pipe closure.