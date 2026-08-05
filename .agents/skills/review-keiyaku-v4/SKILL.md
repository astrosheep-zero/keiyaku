---
name: review-keiyaku-v4
description: Use for independent Keiyaku v4 review when judging architecture, implementation, tests, or model-change impact by root cause, authority, deletion, ownership, and future-change friction.
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

## Test quality

- Each test proves one externally meaningful invariant with the smallest useful
  fixture and would fail if that invariant were removed.
- Cover the normal path and each meaningful reachable refusal; add one focused
  failure, race, restart, or unknown-input case only for an introduced risk.
- Reject duplicate cases, coverage-padding branches, opaque fixtures, and tests
  coupled to implementation details or broad snapshots. Run focused checks,
  then broader checks in proportion to the touched surface.

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
Keep assumptions and residual risk separate; if there are no findings, say so
plainly and still name meaningful test gaps.
