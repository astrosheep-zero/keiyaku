# Contract Workspace

This chapter owns the Contract-facing files in a worktree. Git owns worktree
topology and reconciliation; this workspace owner owns the local appointment,
the derived guidance projection, its ignore file, advisory protection, and
terminal cleanup. The journal remains the sole Contract authority.

## Guidance Projection

One pure renderer consumes a current `ContractState` and emits, in order:

1. YAML frontmatter containing exactly these bytes in this order:

```yaml
---
contract: <ContractId>
description: This is a read-only projection. Do not edit manually.
---
```

The description is fixed ASCII product copy, not caller input, persisted
Contract data, lifecycle evidence, or a second appointment coordinate.
`contract` remains the only identity read from the frontmatter.
2. The exact admitted source Contract Markdown.
3. The current Arc, when present.
4. Exactly one `Fulfillment` H2 with ordered `Appointment`, `Worktree`,
   `Deliverer`, and `Reviewer` H3 sections.

`Appointment` requires every commission to name exactly one seat, Deliverer or
Reviewer; the worker never infers an omitted seat. `Worktree` identifies this
file as a derived view and requires work to remain in its Contract worktree.
`Deliverer` implements and verifies the Contract terms without deciding the
lifecycle and, when an Arc is active, stays within that current chapter. `Reviewer` reviews the complete current worktree snapshot without
modifying it. Candidate commits are only for historical review.

The same canonical frontmatter helper feeds initial here-worktree reservation
and complete rendered guidance, so `Keiyaku.guidance()`, `keiyaku show`,
managed worktree materialization, here projection, and reconciliation cannot
diverge. `show` text is exactly those bytes; JSON contains the Contract
identity and identical guidance. `audit` does not include guidance by default,
and `--show-diff-body` retains its delivery-diff meaning. The description is
not a public result field.

The source document reserves `Arc` and `Fulfillment` so caller extensions
cannot collide with the derived sections. No harness identity, worker identity,
or selected seat becomes a Contract or Dispatch fact. A commissioning harness
transports its selected seat and read-first file list in its own dispatch body.

## Worktree Appointment

For a `here` Contract, the frontmatter in `.keiyaku/KEIYAKU.md` is the only
worktree appointment. Bind reserves it atomically before admission while
holding one lock scoped to the caller worktree. An existing valid, invalid, or
foreign appointment refuses another here bind. A failed admission releases
only the exact reservation bytes it created. A terminal Contract removes its
own appointment; it never removes a foreign or replaced file.

Appointment reading recognizes the current canonical two-field projection. It
also recognizes the previous derived one-field form and a one-line manually
changed description when the first and only identity field is a valid
`contract`. Those bytes still appoint the same Contract; the next successful
projection restores the canonical description. Missing, duplicate, reordered,
multiline, or additional identity fields remain invalid. This repair
tolerance is only for derived workspace custody and creates no compatibility
or migration path for journal facts.

The file is not imported into Contract state. Editing it cannot amend,
reappoint, or otherwise change the journal. When the intended appointment is
known, a later workspace projection restores canonical bytes. Terminal
cleanup and foreign-appointment refusal use the parsed Contract identity and
never treat the description as lifecycle authority.

## Materialization And Cleanup

After Git reconciliation, library orchestration passes the freshly folded
Contract state to the workspace owner. The workspace owner creates or repairs
these derived files atomically:

```text
.keiyaku/.gitignore
.keiyaku/KEIYAKU.md
```

Appointment reads, metadata checks, file reads, advisory chmod, and cleanup are
awaited. Reservation and repair fulfill only after their durable-file commit
has completed. There is no synchronous appointment API or deferred cleanup
queue.

The nested ignore file contains exactly `.gitignore` and `KEIYAKU.md`. This
keeps both files out of ordinary Git status and delivery capture without
centralizing unrelated ignore policy. A tracked generated path is a failure.
After every successful guidance create or replacement, Keiyaku attempts
`0444`; inability to change the mode is advisory and does not create lag.

A write or cleanup failure returns a `contract-file-failed` lag naming the
worktree, path, and diagnostic while preserving admitted facts and completed
effects. Managed terminal cleanup stays governed by Git's sealed-byte law; a
here terminal removes only its matching appointment projection.

Git reconciliation has no projection callback, does not parse the frontmatter,
and neither reads nor writes these files. Explicit reconcile remains a public
repair entry point because library orchestration runs Git reconciliation first
and workspace projection second. Worktree hooks likewise do not consume
`KEIYAKU.md` declaratively; a hook command may read it as an ordinary file when
the invoking harness chooses to do so.
