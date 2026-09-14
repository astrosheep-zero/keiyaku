---
id: task/pr-cleanup/audit-stacked-prs-21-22-23-24-25-380b
title: Audit stacked PRs 21 22 23 24 25 26 27 28
state: done
priority: 2
needs: []
parent: task/pr-cleanup/resolve-all-19-open-prs-with-38f9
supersedes: []
relates: []
note: Read-only stacked PR audit complete; findings and exact refs appended.
createdAt: 2026-09-10T07:39:29.990Z
updatedAt: 2026-09-10T08:13:56.828Z
---
Audit completed 2026-09-10 against local fetched origin/main 7e8619c9594b412dfa4e404775e9c59332f7d55e. Read-only: no remote mutation, dependency rewrite, or existing-worktree change.

Dependency chain:
#21 bb1d4f6712a17836ffc4a83eae93d2f1e7875101 (base origin/codex/test-consolidation-20260909 708334cb99e93147a0c572a2ebaa1d63e6b00620)
-> #22 20e146b9a0f4f0736271e1ff84d40d5fd7022477
-> #23 4a512cf8c612f7d0828f8fcfd20e09a08e822f40
-> #24 9e6edee9525970fecf7ea7fd9bcbfde1cdd36690
-> #25 b0a11befc45dca4e87d966ef8d9d3bb7639697e6
-> #26 a1d40429af2fcf4d0bf60b037f15aaf781ca6986
-> #27 a822667cb0db10b8ac69de202f81f98cd9296201
-> #28 b17ba7f4195233988390a5ba0d2ced34fbe43ffe

#21 FIX THEN MERGE. Suite deletion treated facade/Fleet overlap as proof packaged Akuma CLI behavior was duplicate. A packaged call/wait/history adapter or exit/rendering regression now has no successful end-to-end test after tests/cli-akuma.test.ts is deleted. Restore one minimal packaged call success/failure case and one wait/history raw-answer case.

#22 FIX THEN MERGE. Help pruning retained namespace sampling but removed the leaf owners of distinct deliver/review grammar. Removing deliver --materialize-conflict help or collapsing review-before-delivery versus placement wording passes. Restore focused deliver and review leaf-help assertions.

#23 FIX THEN MERGE. High-level pruning deleted executable Contract CLI adaptation and all successful Task CLI operation coverage, leaving parser/render tests as substitutes for wiring. Breaking Task CLI -> public mutation/read adaptation or a Contract CLI result adapter passes. Restore one successful Task mutation/read through CLI and one Contract CLI adaptation case.

#24 MERGE AS-IS after fixed predecessors. It retains public recovery/partial-creation cases and replaces export inventories with standalone external-consumer compile checks; no unique product invariant was found lost.

#25 FIX THEN MERGE. Adapter-overlay pruning removed every CLI Verification/audit integration test, confusing library protocol coverage with CLI result adaptation. Breaking deliver Verification JSON/text adaptation or audit Verification-summary rendering passes. Restore one deliver-with-Verification CLI case and one audit Verification-summary case.

#26 FIX THEN MERGE. scripts/run-tests.mjs:100-115 delegates compiled sweep to node:test.run() without awaiting terminal settlement or owning isolated child processes. With a delayed pending selected file, the parent can become exit-eligible and report 0 before all files settle. The branch also hard-codes spec instead of the selected default reporter. Use bounded explicit node --test workers, await every close, aggregate failures, forward reporterOptions; add a delayed completion-marker regression with a failing sibling. Later evidence ref origin/codex/test-runner-owned-workers-20260910 (747f0c00c29deb3d0fd71acee9431e980eabbc1f) has the ownership shape but no regression, so validate before carrying.

#27 MERGE AS-IS after #26 fix. Waiting before the common local/forwarded Tell branch removes the initial schema self-busy race and preserves detached fire-and-forget delivery. Non-blocking gap: forwarded ordering is not separately tested, but the control path is shared and local ordering is tested.

#28 MERGE AS-IS after #27. drainWithDeadline clears its timer in finally on success, rejection, or timeout; the child-process active-resource regression detects the old five-second retained timer. It does not claim cancellation of a non-cooperative plugin.

No PR is obsolete/already implemented at observed origin/main: it is an ancestor of every head. Land strictly in chain order; every later head contains all predecessors.

Evidence: inspected full base/head diffs, merge parents, surviving test titles/manifests through #25. For #26, isolated focused checks passed build, typecheck, test:compile, tests/run-tests.test.ts, format, lint, architecture, maintainability, reachability, and diff-check. #27/#28 diff-check clean and traced against public-akuma.md, akuma-execution.md, plugins.md. No exported model field changed; automated model-impact produced no report, so inspected manually.
