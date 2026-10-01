---
id: task/maintenance/repository-wide-simplification-adad
title: Repository-wide simplification, deduplication, CI recovery, and boundary maintenance
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates:
  - task/usability/investigate-inconsistent-full-6096
note: |
  Campaign completion receipt (baseline e6e9821487aefa60cc8ad19044a402c3f1a93600 -> final 69637c8fd6a989a0a9c6b1be9e03069d84df8bc3, 2026-09-30).

  Reproducible tracked physical-line census: git ls-tree at baseline / git ls-files at final, each listed file's byte splitlines; delta from git diff --numstat BASE..FINAL restricted to src tests scripts docs integrations plugins. Baseline src 283/60,482; tests 121/41,987; scripts 20/3,057; docs 30/3,106; integrations 15/1,037; plugins 5/438. CORRECTION to initial census note: 444 files / 107,001 lines excluded docs; inclusive product corpus is 474 files / 110,107 lines. Final inclusive corpus: 474 files / 109,089 lines (src 283/60,220; tests 121/41,225; scripts 20/3,063; docs 30/3,106; integrations 15/1,037; plugins 5/438). Tracked product delta: 75 changed files, +1,597/-2,615, net -1,018 physical lines; absolute churn 4,212. Distribution: src 26 files +445/-707 net -262; tests 47 files +1,143/-1,905 net -762; scripts 2 files +9/-3 net +6; docs/integrations/plugins unchanged. The floor was -1,000; stretch -1,500 was never permission to delete evidence.

  Decomposition: all eleven independently scoped child Tasks are done (task tree and task doctor healthy). Source-owner Contracts retired obsolete workspace KEIYAKU.md appointment parser/lock/release, unread Akuma status wrappers, unused coordination exclusive-create primitive and Task catalogue projection; Place register, public observation, durable replacement and recent Task view remain. Earlier source work collapsed CLI dead render/adaptation paths, simplified owner-local lifecycle placement decoding and Git/reconciliation classifier; Git and protocol result codecs deliberately remain distinct because they own different semantics. Test fixtures shared within their actual owner suites without deleting test titles or softening assertions. CI corrections project docs into compiled tests, correct packaged expectations against actual CLI vocabulary, explicitly type compile-test link tuples, and cover all 101 current TypeScript test/e2e modules in strict test config with truthful fixture data. A parallel-load review-fence test watchdog was widened from 2s to 15s after a full-suite failure at 5.37s; its satisfied-attestation, unchanged-delivery, held-fence and terminal-placement assertions remain unchanged. No owner law changed; no new configuration, generic codec, cross-product authority, or dependency inversion was introduced. Retained mass buys exact Git byte custody/currentness, protocol refusal meanings, Akuma live-vs-frozen observation, and critical-path/error-path evidence.

  Final main verification after the last test edit: npm test PASS (format, architecture, maintainability, build, compile, reachability, complete release test sweep); npm run test:e2e:built PASS; npm run test:typecheck PASS; npm run lint PASS; npm run build PASS; npm run test:reachability PASS; completion-regressions workflow's seven serial focused suites PASS (57 tests); git diff --check PASS. Architecture owner-policy check passed on 302 source files. The first full sweep exposed the test's 2s concurrency watchdog, then the asserted fixture was repaired and a fresh full release sweep passed; not concealed by skipping or treating a red run as green. Baseline eight lint/maintainability red gates, deterministic packaged e2e red assertions and compiled docs ENOENT are resolved. Windows native/MSYS/e2e, macOS e2e/path, Linux and minimum-Node GitHub runners remain unproven locally, not claimed green. Separate related task/usability/investigate-inconsistent-full-6096 remains in progress for its previously unclassified load-sensitive runtime-process observation; a green current sweep is not proof that investigation is complete. Dirty unrelated usability Task authority remains untouched.
createdAt: 2026-09-29T12:00:43.205Z
updatedAt: 2026-09-29T16:34:09.120Z
---
## Why this exists

The repository has accumulated structural mass faster than it has retired it. Recent receipt work exposed the immediate shape: repeated test fixtures dominate growth, typed facts cross too many hand-threaded layers, the maintainability gate is red on baseline, and parallel work repeatedly collides at owner boundaries. Existing narrow consolidation work covers only the latest receipt campaign; this Task owns the repository-wide follow-through.

This is durable planning authority, not one mega-refactor. Audit first, then decompose into independently acceptable child work by owner boundary. Do not create a single Contract that rewrites the repository at once.

## Outcomes

1. Establish one reproducible baseline: source/test/doc line counts, absolute churn, largest and most complex owner modules, duplicate fixtures and schemas, dead exports and compatibility arms, copied adjudication, boundary mirrors, and the exact green/red state of every CI-authoritative command.
2. Split findings into small child Tasks and Contracts with one owner chapter and one acceptance boundary each. Use `needs` only for real ordering; independent cleanup proceeds in parallel.
3. Simplify and delete before abstracting: collapse repeated fixture construction, remove dead paths and duplicate tests, converge copied codecs/projections/adjudication, and keep coherent owner modules rather than replacing them with directories of tiny wrappers.
4. Restore and keep CI green. At minimum cover `npm test`, `npm run test:typecheck`, `npm run build`, and `npm run test:maintainability`, plus every command actually enforced by repository CI. Distinguish deterministic failures from known flakes; do not hide either with retries, skips, or weaker assertions.
5. Maintain product boundaries while shrinking: owner documents remain the sole law, dependency direction stays one-way, Task/Contract/Akuma/Git products do not acquire mirror schemas or lifecycle knowledge they do not own, and newly settled durable law updates exactly one owner chapter.
6. Finish with a repository-wide delta report: insertions, deletions, net lines, absolute churn, file and owner distribution, CI receipts, deleted concepts, retained mass and the invariant each retained part buys.

## Guardrails

- Behavior and public vocabulary stay stable unless a separately adjudicated bug or law change requires otherwise.
- No new configuration knob, compatibility layer, generated mirror, or generic framework merely to reduce a metric.
- Tests cover critical paths and representative error paths; matrix size is not quality. Exact evidence must survive fixture factoring.
- Do not move lines between modules and call it simplification. The campaign must be materially net-negative after its census-derived target is set.
- Existing focused Tasks remain their own authority. This Task coordinates and relates; it does not duplicate their implementation scope.

## Completion evidence

The Task is complete only when the census and final delta are recorded, CI-authoritative commands are green on the final main snapshot, every child is terminal or explicitly dropped with reason, and an owner-boundary audit finds no newly introduced mirror or reversed dependency.