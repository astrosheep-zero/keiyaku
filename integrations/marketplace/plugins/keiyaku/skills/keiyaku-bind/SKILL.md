---
name: keiyaku-bind
description: Author and bind one Keiyaku delivery Contract. Use when deciding whether a bounded delivery is ready for Contract terms, writing those terms for an implementer, binding an existing Task with `bind --task`, choosing bind inputs, or interpreting the bind receipt and worktree handoff.
---

# Keiyaku Bind

## What Bind Records

Bind journals decisions that have already been made. The Contract author
arrives with the public outcome decided: Objective, Design, Region, Criteria,
Verification. A design gap discovered while authoring goes back to whoever
owns the decision — it is never forwarded into the worktree for a worker to
resolve.

## Author And Freedom

The author pins every public, high-level fact: surfaces, semantics, persisted
shapes, the observable acceptance boundary. Private decomposition, helper
names, and control flow belong to the Deliverer — and that freedom comes from
the author genuinely not caring, never from the author not deciding. Criteria
are observable accept/reject observations a Reviewer can judge without asking
the author anything further.

## Author And Bind

`keiyaku -C <repo> bind --help` lists the options; only the heredoc is
stdin. Each section states what it must contain:

~~~~bash
keiyaku -C <repo> bind - <<'KEIYAKU'
# <Delivery name — one decision, active voice; source of the kei/... identity>

## Context
<Premises: coordinates of the governing decision or document, and facts a
reader would otherwise re-derive wrongly. Never narrative. If Objective and
Design read the same without a sentence here, delete it.>

## Objective
<One end-state you could watch happen, named at the level of intent and goal
— above implementation detail, above spec recital. If "and" joins two
outcomes that would each stand alone, bind two Contracts. Even an outcome
that cannot split into two may still need arcs to organize its
fulfillment.>

## Design
<The closed decisions. A statement belongs here exactly when a test-green
candidate could still violate it: which module owns the change; the exact
public surface — each type with its fields, each verb with its success,
refusal, and error arms and their reason words; the persisted format; which
way data flows and where it commits or refuses; which parallel shapes are
forbidden. Helper names and equivalent control flow do not belong here —
they are the worker's.>

```text
<pseudocode — only where ordering matters>
```

## Region
```
<intended write patterns — planning evidence for overlap detection, never
ownership or the exact diff. Narrow enough that overlap is a real signal;
directory patterns end with `/`.>
```

## Criteria
### <one observable condition>
<One accept/reject observation with its method: run this, observe that.
Decidable without consulting you.>

## Verification
```bash timeout=<honest bound>
<commands runnable exactly as written>
```
KEIYAKU
~~~~

Use separate fences for checks that need separate timeouts or results. Fences
run top-to-bottom, and later fences may use earlier outputs. Put setup/build
before its consumers; use `&&` in one fence only when the consumer must stop
if setup fails.

Each declaration may set an individual timeout in its fence info string, using
an explicit duration unit such as `bash timeout=5m`. Omit it for an unbounded
declaration; there is no Verification-wide timeout.

For a saved document:

```bash
keiyaku -C <repo> bind - < CONTRACT.md
keiyaku -C <repo> bind --task <task/...> - < CONTRACT.md
```

Use `--task` only for an existing Task with scheduling or dependency value;
do not create one just to mirror the Contract.

## Authority Order

Settled upstream decisions and their documentation → this Contract → commission
and brief (directs the current round's work and questions; never terms, never
acceptance) → review evidence (witnessed fact, never law). The journaled terms
are the standing acceptance floor. A brief or tell genuinely commands what this
round works on and what evidence it gathers; anything that must survive beyond
the round as a placement condition enters the journal through bind or amend, or
it is not acceptance.

## One Boundary, One Contract

One atomic acceptance boundary per Contract. Independent boundaries are
separate Contracts; a boundary that cannot be split but is too large for one
pass is chaptered with Arcs, and dispatch carries only the current Arc.

## Read The Receipt

Treat the receipt as the handoff. Keep the complete `kei/...` identity, work
in the reported managed worktree when one was created, and retain the target
and gate facts it reports. A waiting receipt means prerequisites remain; it
is not a second authoring workflow.

Continue the delivery with `keiyaku-workflow`.
