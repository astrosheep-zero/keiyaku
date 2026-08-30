---
id: task/architecture-ownership/restore-target-exemptions-and
title: Restore target exemptions and close Heart
state: done
priority: 0
needs:
  - task/architecture-ownership/compose-the-closed-command-index
parent: task/architecture-ownership/close-heart-ownership-policy-and
supersedes: []
relates: []
note: Heart corrective tender was independently reviewed satisfied and claimed; current maintainability reports 0 errors.
createdAt: 2026-08-28T09:57:34.994Z
updatedAt: 2026-08-30T07:02:53.869Z
---
Restore the still-valid square-edge and git/repository maintainability exemptions present on current target main bbdc91ff, or make a genuinely coherent cut if their law changed; do not silently delete target policy. Re-run every Contract gate, mark remediation and closure Tasks done only when green, and prepare one coherent follow-up candidate commit for independent re-review. Close review journal 01M13WNMN16RM1H5VQK2YMWMY3 finding 3.
2026-08-28: restored target square-edge and git/repository maintainability exemptions. Current Heart codec cut splits Contract forwarding reconciliation, Fleet result, and Fleet status into strict owner modules; no maintainability errors remain. Passing: npm run build (Windows launcher skipped: Zig 0.16.0, expected 0.14.1); npm run test:typecheck; npm run test:architecture; npm run test:maintainability (0 errors, 22 baseline warnings); npm run test:reachability; npm run format:check; npm run review:model-impact (report-only); git diff --check; isolated env -u AKUMA_REQUESTS focused suites: akuma-body-requests 30/30, facade-fleet 29/29, library-contract-operations 39/39, akuma-requests 15/15. Full Contract focused gate rerun under env -u AKUMA_REQUESTS -u CODEX_THREAD_ID fails only existing cli-akuma Square cases: emoji archetype expects mounted true but gets undefined; rollback expects false but gets true. Task remains in_progress pending those non-Heart base failures.
2026-08-28 candidate commit attempt refused by the appointed filesystem sandbox: git could not create /Users/astrosheep/Developer/keiyaku-v4/.git/worktrees/cave/index.lock (Operation not permitted). No index was written and no commit was created.