---
name: architect-judgment
description: How to make architecture decisions — judge whether an incoming question is a real problem before solving it, dissolve problems instead of inventing mechanisms, and rank every answer by how much friction it removes from future change. Use whenever ruling on a design question, reviewing an abstraction, or answering "how should X work".
---

# Architect Judgment

The job is not to answer the question as asked. The job is to find what is
actually needed — which is usually less than what was asked for. Mechanically
inventing a new abstraction or mechanism for every incoming question is how
systems rot: each answer is locally reasonable and the sum is unmaintainable.

## The sequence

Run these steps in order before designing anything. Most questions die at
step 2 or 3 and never reach step 5.

1. **Restate the real need.** Not the question — the situation behind it. What
   is the asker trying to make true in the world? Read the whole picture first:
   the governing laws, the shipped state of the code, the neighboring decisions
   already made. Questions are usually framed inside a stale or borrowed
   premise, and you cannot see that from the question alone.

2. **Ask: is this a problem?** Name the invariant that breaks if you do
   nothing. If you cannot construct a concrete failure — actual inputs, actual
   state, actual wrong outcome — there is no problem, and anything you build
   is defense against a ghost. Do not legislate against unconstructable
   enemies.

3. **Attack the premise.** Hard questions almost always presuppose something
   ("the gate must read this file", "this verb needs that input"). Test the
   presupposition before serving it. The first question about any "X must
   handle Y" is: must it?

4. **Try dissolution before mechanism.** The best resolution to a
   contradiction is discovering that one side of it was never required. A
   dissolved problem costs zero maintenance forever; a mechanized one costs
   maintenance forever.

5. **Only then design.** And every mechanism you add must be *bought* — paid
   for by deleting the alternative mechanism it replaces. A design that only
   adds is a design you have not finished thinking about.

## Razors

- **Existence razor.** A field, check, or mechanism exists only if a named
  invariant reads it. No reader, no existence. Applies retroactively: finding
  an unread field means deleting it, not finding it a reader.

- **Premise razor.** When a question contains "so how do we make X do Y",
  first ask whether X needs to do Y at all. Accepting the premise and
  mechanizing it is the most common failure mode of a smart architect.

- **Ownership razor.** Duties live where the capability lives. A rebuild duty
  belongs to whoever holds the facts to rebuild from; a retry loop belongs to
  whoever produced the invalidated premise. If a component "cannot" do its
  assigned duty, the assignment is wrong, not the component.

- **Category-error signal.** When a design demands the impossible — pure code
  needing IO, a consumer needing data that dies before it arrives — that is
  not a defect to patch. It is the architecture reporting a misassigned
  responsibility. Reassign; never punch a hole.

- **Single-implementor rule.** No interface, registry, or provider abstraction
  for a single implementor. An abstraction with one implementation is a
  contract written for ghosts. Extract the abstraction when the second
  implementor is real, not before.

- **Second-adjudicator rule.** One question, one judge. Any pre-check that
  duplicates a downstream atomic adjudication is not safety — it is a second
  authority that will disagree with the first under exactly the race it
  pretends to prevent.

- **Ontology-not-topology rule.** Model boundaries follow the domain —
  identity, lifecycle, readers, rate of change — never the current
  implementation's writer, call site, or timing. How the code happens to be
  orchestrated today is coincidence; the model must outlive it.

- **Representability rule.** A state that genuinely occurs in the domain must
  be representable. A model cannot eliminate a real state — only make it
  unrepresentable, and unrepresentable reality returns as patches and special
  cases.

- **Patch-as-falsification signal.** A fresh design that immediately needs a
  patch to stay correct has been falsified, not polished. Roll back the shape
  instead of tightening screws. Corollary: things with the same semantics get
  the same representation; noticing the sameness is the alarm, not the
  conclusion.

- **Sunk-coherence bias.** Re-derive each ruling from the domain, not from
  keeping your earlier judgment chain consistent. A collapsed premise poisons
  every downstream ruling that defends it.

## Answer shapes, ranked

When you do answer, prefer the highest shape available:

1. **Dissolution** — the problem does not exist; name the false premise.
2. **Deletion** — the problem exists because of something removable; remove it.
3. **Reassignment** — the duty is real but homed wrong; move it, add nothing.
4. **Mechanism** — the last resort. Ship it with its own reject list: the
   nearby over-abstractions you considered and refused, so successors do not
   reinvent them.

## Case studies (this repository's own scars)

- **Budget/contention machinery**: legislated against a contention failure
  nobody could construct. Deleted whole. (Step 2 kills it.)
- **Arc-number tripwire in dispatch**: defended against a mismatch that the
  read-at-every-round law already made impossible. Deleted whole. (Existence
  razor.)
- **CONFORMANCE.md into the evidence system**: the question presupposed the
  gate must read the file. It must not — the reviewer's verdict is already a
  recorded fact, and the gate reads that. Pure dissolution; zero mechanism.
  (Premise razor.)
- **bind's base-head premise**: imported from the previous system's bind shape
  and contradicted the shipped schema. bind pins nothing about the world; the
  premise belongs to the verb that installs delivery. Dissolved by
  reassignment. (Ownership razor.)
- **validateOffer's ref pre-check**: re-judged staleness before the atomic
  admission that owns that judgment, turning a typed movement into a crash.
  Deleted; one adjudicator remains. (Second-adjudicator rule.)

## Final test

Every ruling must pass one bar: **after this change, is the friction of the
next change lower?** (重构之后必须减少后续开发修改的阻力。) A clever
abstraction that makes tomorrow's edit harder is wrong no matter how clean it
looks today. When two designs are otherwise tied, take the one with less to
delete later.
