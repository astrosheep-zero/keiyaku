---
name: developing-keiyaku-v4
description: Use when developing, reviewing, or coordinating work in the Keiyaku v4 repository. Follow the v4 authority law, task board, Keiyaku Akuma dispatch, five-minute observation windows, and the narrow Faye escalation rules below.
---

# Developing Keiyaku v4

This is the operating guide for the clean v4 rewrite. Read it together with
`docs/README.md` and every owner document it names. The v4 repository is
`/Users/astrosheep/Developer/keiyaku-v4`; do not accidentally operate on the
legacy repository at `/Users/astrosheep/Developer/keiyaku`.

## Authority Workflow

- Read the root authority registry and the owner document before touching code.
- Keep concrete product decisions in their owning root document; skills, tasks,
  Square discussion, source code, and tests provide procedure or evidence only.
- If a requested behavior is not settled by the owner document, stop the
  dependent implementation and report the smallest concrete authority gap.
- Keep the current-version-only cut: port evidence selectively, never because
  a v3 abstraction already exists.

## Repository and task commands

Always select the v4 repository explicitly:

```bash
keiyaku -C /Users/astrosheep/Developer/keiyaku-v4 task ls
keiyaku -C /Users/astrosheep/Developer/keiyaku-v4 task show <task-id>
```

Use the task board when work needs durable planning: decomposition,
dependencies, priority, readiness, or coordination across deliveries. A Task
is optional and is never required merely because a bounded Contract will be
delivered. Do not create a Task that only duplicates a Contract objective. A
task is open, in-progress, done, or dropped; it is never a contract binding.
When a real Task already owns the plan, its loop is `task add` → `task start`
→ implementation/review → `task done` (or `task stop`/`task drop`), and
`bind --task <task/...>` atomically installs the optional Settlement-owned
TaskHolder. Contract claim settles the current held Task to `done`, while
abandon releases it. Otherwise bind the Contract without `--task`.

Contract gates come from the Settings `gates` namespace. Omitting `--gates`
selects `gates.default`, or freezes `[]` when that entry is absent. `--gates
<name>` selects one named gate set; it does not name a literal gate word.

## Akuma dispatch

Delegated implementation, review, scanning, and design work must use the
`keiyaku akuma` command surface, not an ad-hoc subagent lane or a contract
workflow. Every dispatch uses `-C` (or `--cwd`) for the v4 repository and has
an explicit bounded brief:

```bash
keiyaku -C <contract-worktree> call worker \
  --detach --alias @<alias> - <<'EOF'
<bounded implementation brief, exact files, tests, and forbidden scope>
EOF
```

Add `--contract <kei/...>` when Dispatch evidence should associate the Akuma
with one Contract. `call` waits up to five minutes by default; use `--detach`
only when the coordinator intends to observe it separately with `wait`.

### Authority-grounded briefs

Every implementation brief must cite the exact current law or owning document
that defines the behavior being implemented. A task scopes and schedules work;
it is not design authority. Draft code, v3 precedent, Square discussion, and a
worker's "reasonable default" do not authorize product or architecture choices.

A worker may decide only truly local implementation details: equivalent private
control flow, local names, helper placement, or minimal fixture construction.
A choice is design, not implementation detail, if it can change public commands
or output, persisted data, authority or ownership, module/data-flow direction,
failure/retry/recovery/concurrency semantics, complexity class, or process
topology.

If the owner documents do not determine such a choice, the worker stops at a
precise gap report and does not implement an assumption. Investigation and
design lanes may produce evidence or a proposal, but dependent implementation
starts only after the settled decision is written into its owning root document.
The coordinator must enforce this boundary in the brief and
when reviewing the returned diff.

Use the roles deliberately:

- `worker`: implementation or focused repository investigation.
- `review-akuma` or `expert-review-akuma`: independent candidate review with
  concrete findings and file references; review does not silently become an
  implementation lane.
- `super-fast`: cheap broad scans, adversarial eyes, or a quick second read
  when the question benefits from parallel evidence. Its use does not need a
  separate usage report unless the result changes a decision.

Prefer parallel Akuma lanes whenever the work can be split without overlapping
write surfaces: for example, implementation, independent review, and a broad
scan can run together. Give each lane one bounded responsibility and one
observable handoff; serialize only the part that truly depends on another
lane's result.

To finish a Contract that declares the `reviewed` gate:

1. Send an independent reviewer the exact Contract worktree and wait for its
   completed report.
2. If it reports blocking findings, fix the worktree and review the changed
   patch again. Use `review --unsatisfied --summary <text>` only when retaining
   that negative judgment in Contract history is useful.
3. When it reports no blocking findings, run `review --satisfied --summary
   <text>`. If the same patch is already delivered and all other gates pass,
   the receipt shows placement and the Contract becomes `claimed`. If no
   candidate is delivered yet, the receipt keeps the review and shows the
   placement stop; delivering those same bytes can then complete placement.
4. Read exact Contract `status`: `✓` is current satisfied testimony, `!` is
   current unsatisfied testimony, `?` is stale testimony after the document or
   patch changed, and `○` is missing testimony. For `?` or `○`, review the
   current patch and record its result.

The reviewer answer remains review input; the coordinator runs the Contract
`review` command that changes the gate-visible journal.

Akuma may call another Akuma when it has an independent, bounded subtask. It
must still use `keiyaku -C /Users/astrosheep/Developer/keiyaku-v4 ...`, keep the
child scope explicit, and return the child result to its own coordinator. Do
not create overlapping write surfaces merely to increase parallelism.

Use tasks to coordinate lanes, not contracts. Inspect `git status` before and
after each lane. Workers must not revert unrelated user changes; the
coordinator reviews the combined diff and owns the accepted commit.

## Observation and steering

The default Akuma observation window is one foreground wait of five minutes:

```bash
keiyaku -C /Users/astrosheep/Developer/keiyaku-v4 wait <projection> --timeout 5m
```

Treat that command as a blocking foreground operation, not a polling tick. If
the shell harness returns a session handle before `keiyaku wait` itself returns,
continue waiting on that same handle with one blocking `write_stdin` call for
the remaining foreground window. Its `yield_time_ms` must be at least
`300000` ms when five minutes remain (use the shorter remaining duration only
when the requested window is already shorter). Keep waiting on that handle
until `keiyaku wait` exits or the requested timeout is reached; do not start a
second wait in parallel or replace it with a shell timeout.

Never implement observation as short polling: do not loop over `status
--akuma`, repeatedly restart `wait`, or inspect the projection at arbitrary
three-minute intervals. The `5m` value is the default observation window and
causes `keiyaku wait` to return one activity snapshot; it is not an
implementation deadline, completion signal, or permission to stop a still-live
projection.

Five minutes is an observation timeout, not a hard implementation deadline.
When it expires, the Akuma may still be running; the returned activity snapshot
is the observation result. A timeout is never evidence that the work is complete,
blocked, stale, or ready to kill. Only after that one wait has returned may the
coordinator read `status --akuma`, inspect history, or steer with `tell`, and
only when the snapshot exposes a real blocker, scope drift, or useful correction.
An interrupted or idle projection is likewise not a completion receipt. Leave a
still-live projection running and begin another full observation window later;
do not replace it merely because the timeout elapsed.

Only stop or replace a projection when there is actual evidence of one of these
conditions: it returned a completed result; it reports a concrete blocker that
cannot be resolved within scope; it has demonstrably drifted outside its brief;
or the user explicitly asks to stop it. Otherwise leave it running and continue
with another observation window. Do not inspect at an arbitrary three-minute
mark or infer a stop decision from elapsed time alone.

## When to involve Faye

Faye is an architecture judge, not a per-commit reviewer or progress channel.
Use Square and ask Faye only for one of these cases:

1. A genuine architecture ambiguity or cross-module invariant that local code
   and existing law cannot settle.
2. A large simplification, deletion, or irreversible model cut.
3. A product/architecture milestone with concrete diff, tests, or runtime
   evidence that gives Faye something material to object to.

Before asking, inspect the current Square history and local source. Send one
self-contained question with the current data flow, authority boundaries,
verified evidence, exact decision needed, and the consequences of each
unresolved interpretation. Do not ask Faye to re-approve ordinary commits or
repeat a settled ruling. After a usable ruling, implement it and update the
owning root document in the same accepted change when it is durable architecture.

## Delivery loop

1. Read `docs/README.md`, the owning root document, and neighboring code before editing.
2. Add or update a Task only when durable planning has a concrete reader;
   otherwise bind a bounded delivery directly.
3. Write every settled design into the owning root document before implementation.
4. Dispatch independent Akuma lanes with exact `-C`, authority citations, and
   non-overlapping scope.
5. Keep changes small, run focused tests first, then source-only typecheck and
   broader tests proportional to the risk.
6. Review the combined diff for second authorities, dead compatibility code,
   duplicated lifecycle gates, and accidental v3 import.
7. Commit only the coherent accepted slice; leave unrelated dirty files alone.

Use `apply_patch` for manual edits. Never use destructive Git commands to clean
up a worktree you do not own.
