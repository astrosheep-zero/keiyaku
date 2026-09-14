---
id: task/usability/honor-the-frozen-kill-permission-8a55
title: Honor the frozen kill permission on forwarded Akuma requests
state: done
priority: 1
needs: []
parent: task/usability/follow-up-on-the-pi-flash-d8e2
supersedes: []
relates: []
note: ""
createdAt: 2026-09-09T12:54:16.998Z
updatedAt: 2026-09-09T16:18:14.556Z
---
Confirmed defect, not a missing grant: in the trial, aku/pi-flash/77622d27 had akuma.kill in its frozen allowed set, but its forwarded kill request was refused as not-allowed: akuma.kill.

Root cause verified in both source and installed 4.5.18: src/akuma/fleet-request.ts fleetRequestProtocol().isPermitted handles wait and permissioned tell/tell-answer but omits the kill branch. src/akuma/allowed.ts already includes akuma.kill. Correct keyed admission so authorized forwarded kill reaches the existing owner, and unauthorized kill still refuses before effects. Do not relax other permissions, add another control path, or change stop/custody semantics.

Reproduction: fleetRequestProtocol('akuma.kill').isPermitted(['akuma.kill']) currently returns false. Side-effect-free failing test and frozen-permission/request evidence are in /private/tmp/keiyaku-pi-flash-ux.iAwdzr/repro-kill-permission.test.mjs and REPORT.md.

Add focused permitted/denied kill coverage at the descriptor/admission boundary and ensure wait/tell behavior remains unchanged. Include an existing owned test fixture for forwarded service behavior rather than killing unrelated real agents.

Read docs/akuma-allowed.md, akuma-requests.md, akuma-execution.md and public-akuma.md through the authority index. This repairs existing law; do not invent new durable law. Run focused request/control tests plus npm test, npm run test:typecheck, and npm run build.
Delivery evidence correction: independent reviewer recorded satisfied and independently passed npm test, but final delivery Verification was unsatisfied: direct Akuma birth test expected asleep, observed running. The Contract was configured with reviewed only (authoring error), so Keiyaku legitimately claimed and placed df33c3ad25355ab142dcb9dc205102f705370240 and settled this Task despite that result. Do not describe final delivery Verification as green. Full receipt: /private/tmp/keiyaku-pi-flash-ux.iAwdzr/evidence/kill-delivery.json. Failure cause remains unestablished; follow-up investigation is required. Other active usability Contracts will require verified as well as reviewed before placement.
Subsequent evidence: the permissions integration 06a28aa, which includes the unchanged landed kill repair df33c3a, passed all four final Verification declarations and exact-integration focused kill admission/service checks. This is new evidence for that integrated subject, not a rewrite of the earlier kill delivery unsatisfied result or proof of its cause.