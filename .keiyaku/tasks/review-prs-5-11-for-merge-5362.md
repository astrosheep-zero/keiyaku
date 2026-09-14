---
id: task/review-prs-5-11-for-merge-5362
title: "Review PRs #5-#11 for merge readiness and stacked integration"
state: done
priority: 2
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-09T10:13:22.867Z
updatedAt: 2026-09-09T10:37:01.028Z
---
# PR5-PR11 merge-readiness review

## Recommendation

All seven reviewed heads have no confirmed PR-introduced correctness blocker.
Recommend landing the fixes and optimizations, preserving the dependency order:

- PR5 and PR6: independent; merge-ready.
- PR8 -> PR9: merge-ready Git cursor/pipeline stack.
- PR7 -> PR10 -> PR11: merge-ready Heart stack.

This is a code-review recommendation, not a claim of clean full local
verification. Before landing the Heart stack, restore the cancelled PR7 full
verification check or obtain equivalent current combined-stack CI evidence.
Retarget dependent PRs as their bases land and verify their resulting diffs/CI.
Preserve ancestry or explicitly rebase stacked branches when using squash.
No GitHub merge, review submission, branch push, source edit, dependency install,
or change to existing user files was performed.

## Reviewed identities

| PR | Exact head | Declared base |
| --- | --- | --- |
| 5 | 42659a940b226ac70136d1d8cbcf9f3b330ee22d | main |
| 6 | 5d0db78ca0ed0d39f7b36eb03173f3d1704d0a1b | main |
| 7 | c0ada3abd445dd5d8a023a994153001c905c59a6 | main |
| 8 | 9b525af4bb33346593bdf2e5709a4f81014a3de9 | main |
| 9 | a13e88d8b6e92bae3a86399ccba4ba5d64f398db | PR8 |
| 10 | 2897ca5f6b1bc29488fb090f00471bce64e8707f | PR7 |
| 11 | 576f040158637c2eba2c086b7ff532378656639b | PR10 |

All heads were rechecked against GitHub after review and remained unchanged.
Remote main was 517274f81657f16e4d2fdd3dd04b99b97e9138e0.
Local main was cf6aa22f0, ahead by two commits (sandbox support and Akuma docs).
A disposable detached integration worktree combined all seven PRs atop local
main without conflicts, producing local-only commit 32762cc3d. No local main
or remote branch was moved. Existing locked dependencies were reused through
symlinks in disposable worktrees; no dependencies were reinstalled.

## Confirmed non-blocking residual: PR11 delivery-trigger overreach

At src/akuma/heart/index.ts:228-229, a newly inserted Tell delivery is treated
as protectionReleased. A live delivery requiring a later receipt remains
pending, so insertion does not necessarily release any protection. Under a
protected backlog this still causes one full retention sweep per delivery.

The main reviewer executed pending-delivery-repro.mjs against the PR11 tree
and origin/main baseline. Both performed 20 full sweeps for 20 distinct
live/required deliveries, with every Tell remaining pending. This confirms a
residual pre-existing cost, not a new regression or a reason to block PR11.
A follow-up can distinguish actual protection release from row insertion and
add a regression for pending live deliveries. Do not suppress immediate
maintenance for genuinely settled Tells.

Reproduction and results:
- /tmp/keiyaku-pr5-11-review/pending-delivery-repro.mjs
- /tmp/keiyaku-pr5-11-review/pending-delivery-repro.log

## Verification

Passed on the combined integration tree:
- npm run test:typecheck (source, scoped tests, scripts).
- npm test phases: format, build, architecture, maintainability, reachability,
  and the complete local suite.
- One isolated serial focused run of ten files: akuma-heart, akuma-body,
  akuma-public, nuke, git-read-observation, repository-protocol-read,
  target-checkout-reconcile, concurrent-target-placement, facade-fleet,
  runtime-proc. All passed.
- The first failing wait test repeated 15 times on origin/main and 15 times
  on the combined integration tree: all 30 passed.
- Independent reviewers ran further candidate-specific focused verification;
  see their individual reports for exact attribution.

Not green / not proven:
- Combined full npm test run 1: one ENOTEMPTY during akuma-public test cleanup.
- Combined full npm test run 2: a different ENOTEMPTY in facade-fleet, a 1s
  pending-Tell disposition timeout in akuma-body, and a short-deadline runtime
  fixture diagnostic mismatch. These all passed in the later isolated serial
  focused run. Broad suites were running concurrently during earlier runs;
  load sensitivity is plausible but not proven to be the sole cause.
- The PR8/9 reviewer's full suite also failed once in a cross-process amend
  assertion; its focused file rerun passed. Causal attribution to the PRs was
  not established, and these failures are not silently counted as passes.
- PR7 GitHub full verification was CANCELLED; its other six checks passed.
  The seven listed checks for each other PR were successful at inspection.
- Windows behavior was not run locally; it relies on recorded native CI.

Logs live under /tmp/keiyaku-pr5-11-review/:
- integration-test.log
- integration-test-rerun.log
- integration-typecheck.log
- integration-focused.log
- baseline-wait-repeat-*.log and integration-wait-repeat-*.log

## Upgrade consequence

The Heart stack deliberately changes schema 25 -> 26 -> 27 -> 28 under the
existing no-migration law. Existing older Hearts are refused, not upgraded;
old Akuma identities/history cannot simply be resumed with the new runtime.
Finish needed workers before switching the runtime and avoid separately
rolling out intermediate schema versions. No reset or migration was performed.

## Review delegation and authority

Two ordinary reviewers covered PR5/6 and PR8/9. Two expert reviewers covered
PR7/10 and PR11. The main reviewer independently inspected the diffs, combined
the stacks, ran integration checks, and reproduced the residual sweep cost.
No architecture escalation was needed: the applicable Git, reconciliation,
Heart, execution, and shared process owner laws settled the decisions.

Individual reports:
- /tmp/keiyaku-pr5-11-review/review-5-6.md
- /tmp/keiyaku-pr5-11-review/review-7-10.md
- /tmp/keiyaku-pr5-11-review/review-8-9.md
- /tmp/keiyaku-pr5-11-review/review-11.md

The main review does NOT adopt a proposed deletion of PR9's early failure
assignment. It can remain observable if process retirement throws; deleting
it without proving queued-reader and close behavior is not established safe.
