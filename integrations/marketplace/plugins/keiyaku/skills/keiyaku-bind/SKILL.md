---
name: keiyaku-bind
description: Author and bind one Keiyaku delivery Contract. Use when deciding whether a bounded delivery is ready for Contract terms, writing those terms for an implementer, binding an existing Task with `bind --task`, choosing bind inputs, or interpreting the bind receipt and worktree handoff.
---

# Keiyaku Bind

A Contract records a decision that already exists; writing terms does not
produce one. You supply **all high-level design and public-surface facts this
Keiyaku creates or changes**, and **all** pseudocode where ordering matters.
The worker is a cheap executor: every choice you leave open, it resolves —
possibly the way you like least, discovered at review and billed at review
prices.

## Before You Bind

Bind is the last step of an investigation, never the first step of an idea.

- Design the delivery to the depth you could implement it yourself, against
  the code as it is — not as you remember it. An unknown surfacing while
  you design is the next investigation, not a detail for the worker.
- Walk the implementation path once, end to end. A step you cannot walk is
  an unresolved fact.
- Observe active Contracts whose Regions intersect yours. Region overlap is a
  prompt signal only; it does not by itself imply a logical conflict. The
  caller decides autonomously whether to proceed in parallel or serialize.
- A decision settled elsewhere binds only its explicit words; converting it
  into concrete shape is your job, and a question it left open goes back to
  its decider, never to the worker.
- If the delivery must land documentation, you can draft its exact sentence
  now. Cannot draft means unresolved design — "the worker will sort out the
  docs" is a design gap in disguise.

Split complex work wherever independently acceptable delivery boundaries
exist. When a complex Keiyaku cannot be split without breaking one acceptance
boundary, bind one Contract and plan its fulfillment as explicit arcs. Treat
each arc as a chapter as in a work of literature, not as a task sequence.
Commission one current chapter at a time; never hand the whole undifferentiated
Contract to one Deliverer and trust it to finish everything in one pass.
Continue with `keiyaku-workflow` for the arc document and command.

Two tests close the gate:

- **Substitution.** Two workers who never met each deliver test-green from
  your terms. If any external reader could tell the deliveries apart, that
  fact is undecided — decide it and write it.
- **Rework.** For each blank: "if the worker picks what I like least, do I
  demand rework?" Yes — write it. No — write nothing.

Public — anything visible outside the diff — is always yours to pin.
Private — helper names, decomposition, control flow — is the worker's;
its freedom comes from your genuine indifference, not from omission.

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

> Settled upstream decisions and their documentation → this Contract → worker
> brief (zero authority) → review evidence (witnessed fact, never law).

Gaps flow upstream, never down: a design gap found by a worker or reviewer
returns to you, never filled silently downstream.

## Read The Receipt

Treat the receipt as the handoff. Keep the complete `kei/...` identity, work
in the reported managed worktree when one was created, and retain the target
and gate facts it reports. A waiting receipt means prerequisites remain; it
is not a second authoring workflow.

Continue the delivery with `keiyaku-workflow`.
