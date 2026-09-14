---
id: task/usability/separate-call-workdir-from-the-32fc
title: Separate call workdir from the Keiyaku invocation directory
state: done
priority: 1
needs: []
parent: task/usability/follow-up-on-the-pi-flash-d8e2
supersedes: []
relates:
  - task/add-explicit-repo-coordinate-and-remove-call-wor
note: ""
createdAt: 2026-09-09T12:54:16.998Z
updatedAt: 2026-09-09T16:38:20.754Z
---
User-confirmed direction: add call --workdir as the explicit worker execution directory. -C / --cwd selects the Keiyaku invocation directory and World; it must no longer implicitly defeat automatic Contract-worktree selection. --repo retains its separate Git repository selection responsibility.

Worker cwd selection: explicit --workdir first; otherwise the appointed Contract worktree when --contract is supplied; otherwise the invocation directory. Supplying -C . while already in that directory must not change automatic Contract-worktree selection. Explicit --workdir can keep a whole-loop delegate in the primary repository. Preserve a receipt stating the actual selected execution directory.

This intentionally revisits the earlier completed Task task/add-explicit-repo-coordinate-and-remove-call-wor, which removed --workdir and made -C serve both roles. Do not resurrect that old coupling as an undocumented fallback. Account coherently for affected callers, public adaptation, executable help, bundled skills, examples, and tests. Do not add execution-directory overrides to wake or fork: a born Soul's cwd remains frozen. Resolve remaining parser/relative-coordinate details against existing coordinate authority rather than guessing them in this Task.

Regression observations: explicit --workdir wins; --contract with no --workdir selects its appointment even with explicit -C; no Contract/workdir falls back to invocation cwd; an explicit primary-repository workdir supports whole-loop delegation; invalid coordinates refuse rather than silently falling back; --repo does not accidentally retarget the invocation World.

Trial evidence: a worker born with -C . received execution.source=input at the primary clone; omitting -C with --contract selected execution.source=contract-worktree. No wrong-target edits were observed; the Deliverer was already reading seat guidance before the lead's corrective tell.

Before implementation read SOUL.md, docs/README.md and relevant owner chapters, initially cli.md, public-akuma.md, world.md, akuma.md and cli-output.md. Update owning conceptual law in the same coherent implementation change; literal grammar belongs in help/source. Validate focused cwd/CLI/dispatch regressions, npm test, npm run test:typecheck, and npm run build.
Placed 149fe9204cf579d6db06b390a81946e7dc2b0a3a on main over permissions commit 06a28aa after revised-candidate and exact-integration independent review. All four final Verification declarations passed; final review reused same-subject satisfied Verification and claimed. Corrected complete reviewer testimony: evidence/review-workdir-integration-verdict-corrected.txt. --repo remains independent Git selection and never retargets invocation World. Earlier external-fixture concurrent AkumaBusy and wait assertion failures remain unclassified contrary evidence; successful concurrent/isolated reruns do not establish their cause. Final receipt: evidence/workdir-final-review.json under /private/tmp/keiyaku-pi-flash-ux.iAwdzr.