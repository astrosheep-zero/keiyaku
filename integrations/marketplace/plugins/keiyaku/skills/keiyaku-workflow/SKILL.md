---
name: keiyaku-workflow
description: >-
  Must read before binding a `kei` (Contract) or when acting as its holder.
  Use when deciding when to bind a kei, how to shape and hold it, how to
  delegate its work, and how to accept, amend, or end it.
---

# Keiyaku Workflow

This skill manages a `kei` (Contract) from preparation to completion.

## 1. Prepare Before Binding

Before `bind`, settle the information that makes the `kei` truthful:

- objective and intended outcome;
- design and approach;
- affected Region;
- acceptance conditions;
- verification and required evidence;
- prerequisites;
- holder.

If the design, approach, or acceptance conditions are still open, do not bind.
Resolve them with their owner first. Private implementation details may remain
for the Deliverer; the public meaning and acceptance boundary may not.

Bind independent `kei`s in parallel. Do not split one acceptance boundary just
to create parallel work.

## 2. Split the Work

Use these rules:

- Separate `kei`s have independently acceptable outcomes.
- An Arc is a chapter of one `kei`; it is not separately accepted.
- A Task stores decomposition or dependencies that must outlive the current
  conversation.

Use `after` only when one `kei` requires another `kei` to be completed first.
Ordinary overlap is not a dependency.

## 3. Hold the `kei`

Every `kei` has exactly one holder. The holder owns it until completion or
termination, coordinates its work, delegates when useful, and is responsible
for acceptance.

The holder may work directly or delegate Akumas, Deliverers, Reviewers, Tasks,
or Arcs. An Akuma holder must receive the `kei`, current Arc when one exists,
worktree, and holder responsibilities in its prompt, and must have
`contract.*` and `akuma.*`.

## 4. Lifecycle

```text
bind -> tender -> gates and prerequisites pass -> automatic claim
                                      \\-> abandon
```

- `bind` creates the `kei` with its terms, acceptance conditions, gates, and
  dependencies.
- `tender` submits the candidate for acceptance.
- After tender, the `kei` is claimed automatically when its prerequisites and
  every required gate pass.
- `abandon` ends a `kei` without claiming it.
- A claimed or abandoned `kei` is terminal.

The holder may continue work and tender again while the `kei` is not terminal.

## 5. Gates

A gate is a named acceptance obligation. A tendered `kei` cannot be claimed
until every selected gate has satisfied evidence.

Bind gate options:

```bash
keiyaku bind --gates <name,...> -
keiyaku bind --gates "" -
keiyaku bind --gates reviewed -
```

- Omitting `--gates` selects `gates.default`; when no default bundle exists,
  it selects `reviewed`.
- `--gates <name,...>` selects gate names and configured bundles. Bundles
  expand to their configured gates.
- `--gates ""` binds the `kei` with no gates.
- `--gates reviewed` selects the `reviewed` gate directly.

Gates are acceptance requirements, not work assignments. The Deliverer
produces the candidate, the relevant producer supplies evidence, and the holder
coordinates the remaining work.

## 6. Delegate the Work

Delegate with a clear owner, objective, worktree, and expected result. Include
the current Arc when one exists. A Deliverer produces the candidate. A Reviewer
checks it against the `kei`'s acceptance conditions and returns evidence.
Delegation does not transfer the holder's responsibility.

Use `keiyaku-akuma` for Akuma invocation, telling, waiting, permissions, and
history. Use command help for exact syntax.

## 7. Decide What Happens Next

The holder checks the tendered candidate, verification, review evidence,
prerequisites, and gates.

- If everything passes, automatic claim completes the `kei`.
- If something is missing, continue the work or delegate the next chapter.
- Amend when the objective and acceptance boundary remain the same but the
  terms need to change.
- Abandon and bind a new `kei` when the objective or acceptance boundary has
  changed.

For Contract authoring, read `keiyaku-bind`. For Akuma delegation, read
`keiyaku-akuma`. For supervising many waiting `kei`s, read
`keiyaku-babysit`.
