---
name: review-keiyaku-v4
description: Use for independent Keiyaku v4 review when judging architecture, implementation, tests, model-change impact, duplication, redundancy, or simplification opportunities by root cause, authority, deletion, ownership, and future-change friction.
---

# Review Keiyaku V4

This is a judgment skill, not a checklist of current model names. Read
`docs/README.md`, the owning root documents under `docs/`, the task, neighboring
source, tests, and the complete diff before forming a verdict. The root docs are
the authority; this skill supplies only review method.

## Keiyaku judgment

- Construct a concrete failing input/state first. If no invariant breaks,
  reject the premise and the complexity built to defend it.
- Prefer, in order: dissolution, deletion, responsibility reassignment, then
  mechanism. Any mechanism must pay for itself by removing an alternative.
- Apply the existence razor: every field, check, branch, and abstraction needs
  a named reader and invariant. Unread state is deletion evidence.
- Apply the ownership razor: the component with the facts and capability owns
  the duty. Apply the single-adjudicator razor: one question has one judge;
  pre-checks must not replay a downstream race or decision.
- Find second authorities, shadow state, duplicated lifecycle logic, ghost
  defenses, one-implementation interfaces/registries, and compatibility residue.
- Follow facts through process, persistence, and external-tool boundaries. Test
  restart, retry, concurrency, partial failure, and unknown input where real.
- Check scale, not trivia: ignore text micro-optimizations; flag accidental
  `O(N^2)`, repeated full scans, or unnecessary process fan-out.
- Prefer one-way data flow, explicit inputs, deterministic outcomes, and a
  module split that lowers the friction of the next change.

## Mandatory simplification review

Do not equate correctness or green tests with an acceptable implementation.
For every complete diff, inspect the whole candidate for code that can be
deleted, combined, or homed more narrowly while preserving the required
behavior.

- Measure the diff by file and separate product code, tests, owner documents,
  and generated or policy changes. A large count is a prompt to investigate,
  not a verdict or an excuse.
- Compare repeated call sites, renderers, result projections, schemas,
  fixtures, and error handling. Prefer one existing owner or helper when the
  blocks express the same invariant; reject a generic abstraction when only
  superficial syntax is shared.
- Trace every new field, union arm, branch, adapter, wrapper, and compatibility
  path to a reachable producer and a named reader. Delete derived state,
  impossible states, pass-through layers, and defenses without a constructible
  failure.
- Check whether the change makes one fact cross avoidable layers or forces the
  same future edit through documents, protocol, library, CLI, and tests without
  each layer adding meaning. Treat that fan-out as an ownership finding, not
  merely a line-count observation.
- Inspect tests for repeated setup, duplicate assertions, and oversized
  fixtures. Compress setup only when each scenario remains legible and each
  distinct invariant remains independently falsifiable.
- State the smallest coherent simplification and estimate its removable
  surface when the evidence is concrete. Never meet a deletion target by
  collapsing readable code, weakening types, hiding behavior, or deleting
  meaningful tests.

A review cannot conclude "no findings" until it has explicitly answered
whether the candidate contains material duplication, redundant state,
unreachable defense, avoidable fan-out, or a simpler ownership boundary.

## Test quality

- Each test proves one externally meaningful invariant with the smallest useful
  fixture and would fail if that invariant were removed.
- Review the normal end-to-end path before counting edge cases. For a lifecycle
  change, follow the real caller sequence through admission, physical effects,
  terminal settlement, cleanup, and the next read or reconcile; a missing happy
  path is a blocking test gap even when many edge tests are green.
- Cover each meaningful reachable refusal only after the normal path is proven.
  Add a failure, race, restart, or unknown-input case only when the diff
  introduces that concrete risk. Do not reward a synthetic test matrix,
  paranoid branch enumeration, or coverage-padding cases.
- Reject duplicate cases, opaque fixtures, and tests coupled to implementation
  details or broad snapshots. Prefer one small regression that reproduces the
  root-cause lifecycle failure. Run focused checks, then broader checks in
  proportion to the touched surface.

## Model change impact

For every complete diff, choose the actual review base before judging model
fan-out. Run `npm run review:model-impact` for working-tree changes, or
`npm run review:model-impact -- --base <base> --head HEAD` for committed
changes. Never interpret an empty report until the selected base and head cover
the candidate.

Treat the report as evidence, never as a numeric gate. Inspect every exported
field change that crosses owners and distinguish required fact/protocol flow
from duplicated construction, writes, destructuring, serialization, rendering,
or compatibility translation. A high count alone is not a finding. Report a
finding only when the owning documents or one-way dependency direction show
that a consumer interprets state outside its owner, creates a second authority,
or makes the next model change cross an avoidable boundary. If the command
cannot run, state that limitation and inspect changed model declarations and
their consumers manually; never infer that impact is absent.

## Report

Lead with findings ordered by severity. Include file/line, concrete failure
path or proof, impact, and the smallest regression test that exposes it.
Include simplification findings even when they are not correctness blockers;
label their delivery impact rather than omitting them. Keep assumptions and
residual risk separate. If there are no findings, say so plainly, summarize
the duplication/redundancy review performed, and still name meaningful test
gaps.
