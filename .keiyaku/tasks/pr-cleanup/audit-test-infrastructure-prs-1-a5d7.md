---
id: task/pr-cleanup/audit-test-infrastructure-prs-1-a5d7
title: Audit test infrastructure PRs 1 4 18 19 20
state: done
priority: 2
needs: []
parent: task/pr-cleanup/resolve-all-19-open-prs-with-38f9
supersedes: []
relates: []
note: PR audit completed with per-PR evidence and merge order.
createdAt: 2026-09-10T07:39:29.990Z
updatedAt: 2026-09-10T07:51:46.697Z
---
Audit evidence (2026-09-10; remote baseline origin/main 7e8619c95):

- PR #1: CLOSE. Declared base 52e4b886; GitHub says CONFLICTING; current main has 103 exclusive commits. Its activation-in-flight signal behavior is already in src/plugin/runtime.ts and tests/plugin-runtime.test.ts; its 120-line Akuma paging replacement is covered more strongly by tests/facade-fleet.test.ts.
- PR #4: CLOSE. Declared base 515b948e; GitHub says CONFLICTING; current main has 28 exclusive commits. Its diff would delete current high-value delivery/reconcile/history/fork regressions; its external-consumer direction is superseded by #20.
- PR #18: MERGE AS-IS. Directly extends origin/main by two commits; refactors only repeated Markdown and Akuma fixture carriers while preserving case payloads. Full CI has a successful rerun (ubuntu, Windows, macOS, completion); earlier duplicate-run failures make the PR status unstable.
- PR #19: MERGE AS-IS. Direct main child; CI all green. It cancels the redundant audit verification wait while retaining unrecorded-verification assertions, and makes the nested runner test prove both success and failure execution.
- PR #20: FIX THEN MERGE after #18, then rebase/refresh onto updated main. It is based on #18; all CI checks are green. Keep its real Contract/Task/Kanshi/plugin consumer compilation and deep-import rejection, but restore one focused external-package runtime assertion that Keiyaku and Delivery reject Reflect.construct. The new TypeScript @ts-expect-error checks do not cover that deleted runtime property; do not restore brittle export-name inventories.

Order: #19, #18, corrected/refreshed #20. #1 and #4 may close first or at any point; neither is a dependency.