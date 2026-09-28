---
id: task/usability/investigate-forwarded-delivery-03d3
title: "Investigate forwarded-delivery stale tender: AKUMA_REQUESTS path keeps old tender"
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: "RESOLVED 2026-09-28 under kei/forwarded-delivery-honors-7c15 (claimed, main 50864bbe9). Root cause (code-proven): a forwarded deliver --overwrite was silently DROPPED at the parent Body adapter. CLI parses it (src/cli/commands/contract.ts:210), forwards it in the payload (src/library/contract-handle.ts:283), the parent adapter decodes it (src/library/contract-operations.ts:228), but src/akuma-body.ts omitted it when constructing executeForwardedDeliver input, so src/library/contract-forwarding.ts:42 defaulted it back to false. With an active candidate and no current terminal Verification testimony, src/protocol/deliver.ts:478 then reused the old candidate with zero new facts even though worktree bytes changed; local execution passed overwrite directly and captured the replacement. Fix: passthrough restored at src/akuma-body.ts, both-arm pin through the real parent-Body port (externalRequestCommandsFor) in tests/contract-lifecycle.test.ts, law sentence in docs/akuma-requests.md (forwarded verbs carry flags verbatim). Sibling-drop audit clean (message/includeDirty/materializeConflict/showDiff/verdict/summary all survive transport). Honest boundary: this mechanism explains the original incident only if the worker used --overwrite (argv unrecoverable); the dropped flag was a real bug regardless. Full forwarding-path inventory and minimal reproduction recipe: verbatim probe note in git at 823054f96 (this file's prior note field)."
createdAt: 2026-09-28T10:58:59.956Z
updatedAt: 2026-09-28T11:48:23.942Z
---
Worker report (2026-09-28, render campaign): a delivery run inside an Akuma turn (AKUMA_REQUESTS env set, forwarded-request path) kept the OLD tender; re-running the same deliver locally with AKUMA_REQUESTS removed picked up the NEW tender. Suspected stale-tender bug in the forwarded-request path: request forwarding may reuse or replay an earlier request/tender instead of issuing a fresh one. Investigation only, read-only: locate the forwarding path (akuma requests transport, AKUMA_REQUESTS env composition at provider spawn, the CLI-side forwarding), establish the exact staleness mechanism with file:line evidence, reproduce cheaply if possible, and propose the fix direction. Do NOT alter main; any implementation fix needs its own settled Contract.