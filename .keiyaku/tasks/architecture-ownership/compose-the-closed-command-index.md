---
id: task/architecture-ownership/compose-the-closed-command-index
title: Compose the closed command index completely
state: done
priority: 0
needs:
  - task/architecture-ownership/prove-every-owner-result-shape
parent: task/architecture-ownership/close-heart-ownership-policy-and
supersedes: []
relates: []
note: ""
createdAt: 2026-08-28T09:57:34.477Z
updatedAt: 2026-08-28T10:14:09.522Z
---
Every BodyRequestPump composition must install the complete closed command index required by the actions it can receive, including packaged CLI akuma.call. Missing or unknown action is malformed claim cleanup: no Heart mutation and no receipt, never a generic permission refusal. Close review journal 01M13WNMN16RM1H5VQK2YMWMY3 finding 2 and prove CLI exits without leaked Square sessions.
2026-08-28: malformed or unconfigured claims now return before Heart admission and emit no receipt; the packaged CLI call fixture supplies the full call-plus-Fleet command index and a permitted akuma.call capability. Evidence: npm run test:typecheck (pass); npm run test:architecture (pass); npm run build (pass, Windows launcher skipped because Zig 0.16.0 is not required 0.14.1); env -u CODEX_THREAD_ID timeout 120s node --test --test-name-pattern="packaged CLI call" --test-reporter=tap --import tsx tests/cli-akuma.test.ts (1 pass, 0 fail); timeout 120s node --test --test-reporter=spec --import tsx tests/akuma-body-requests.test.ts (30 pass, 0 fail).