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
`Deliverer` implements and verifies the Contract terms and, when an Arc is
active, stays within that current chapter. For work requiring three or more
steps, you prefer `keiyaku task -C <worktree>` to organize and manage Tasks,
and you promptly update progress for Tasks already present in the current
worktree. `Reviewer` reviews the complete current worktree snapshot without
modifying it. Candidate commits are only
for historical review.

The same canonical frontmatter projection feeds complete rendered guidance,
so `Keiyaku.guidance()`, `keiyaku show`, managed worktree materialization,
and reconciliation cannot
diverge. `show` text is exactly those bytes; JSON contains the Contract
identity and identical guidance. `audit` does not include guidance by default,
and `--diff` retains its delivery-diff meaning. The description is
not a public result field.

The source document reserves `Arc` and `Fulfillment` so caller extensions
cannot collide with the derived sections. No harness identity, worker identity,
or selected seat becomes a Contract or Dispatch fact. A commissioning harness
transports its selected seat and read-first file list in its own dispatch body.

## Managed Place Appointment

Place is the sole managed local appointment. It is not a Git identity, journal
field, or a second product.

The sole managed appointment authority is one canonical file and one
coordination lock under the pinned common Git directory:

```text
<git-common-dir>/keiyaku/places.json
<git-common-dir>/keiyaku/locks/places.sqlite
```

The current file shape is exactly:

```json
{"version":1,"appointments":{"atlantis":"kei/example"}}
```

It is one canonical JSON line with one trailing LF. The top-level fields are
exactly `version` then `appointments`; `version` is exactly `1`; appointment
keys are sorted by byte order and values are complete valid ContractIds. Each
ContractId occurs at most once. A missing file means no appointments. An
empty register, once written, remains the complete
`{"version":1,"appointments":{}}\n` document. Noncanonical bytes, unknown
fields or version, an invalid Place or ContractId, or duplicate Contract
appointment are corruption. Mutation surfaces propagate the verbatim
corruption diagnostic as exit 3; observation returns a typed failed arm
without suppressing other independently readable status sections.

The first-generation Place vocabulary is the exact ordered 173-entry catalog
owned by the workspace Place owner. A later generation appends its canonical
decimal integer, at least 2 and without a leading zero, to each base.
Allocation is generation-major with a per-Contract stable start: for a new
Contract, SHA-256 its complete UTF-8 ContractId bytes, interpret all 32 digest
bytes as one unsigned big-endian integer, and reduce it modulo 173. For each
generation, scan the ordered catalog from that start with one wraparound and
choose the first unappointed Place; when a generation is full, advance to the
next generation and scan again from the same start. Generation arithmetic is
exact beyond `Number.MAX_SAFE_INTEGER`. Existing appointments return unchanged
before this hash is computed. Within one locked mutation, supplied ContractIds
are processed in input order, so earlier new appointments occupy their
candidates before later collisions probe forward.
The register stores only current appointments; it has no cursor,
free list, tombstone, reverse index, migration bit, or physical occupancy
fact. Decode builds one immutable in-memory snapshot with derived by-Place
and by-Contract indexes. Those indexes are not persisted authority.

Every register mutation holds one SQLite `BEGIN IMMEDIATE` transaction at
the exact lock path across decode, map mutation, and durable same-directory
replacement. Readers do not lock and observe one complete old or new file
through atomic rename. One invocation decodes the register at most once for
its read or bulk path and passes that snapshot through reconcile, bulk
observation, and public reading; there is no per-Contract file read or
cross-invocation cache. A writer decodes its fresh mutation premise only
inside the lock. A caller-held register snapshot is read-only projection
and is never a writer premise or a later Git-effect authorization.

Managed bind admission remains journal-only. Materialization then runs in
this order: fold the admitted Contract; under the register lock, decode once
and reuse the Contract's appointment or durably appoint by its hash-derived
forward scan; if that
appointment failed operationally, return typed lag and perform no Git
effect. Realize Git at `<primary-worktree>/.keiyaku/wt/<place>`; project
workspace guidance at that realized worktree. Once an appointment is durable
it survives every later failure, and retry uses the same Place. Existing
appointments are never reselected from Git or filesystem topology.
Allocation does not pre-check a physical directory.

Only an active managed Contract may receive a missing appointment. A
terminal Contract consumes an existing appointment for retained cleanup
and is never freshly appointed after a successful release. Appointment
absence for an ordinary terminal Contract is the proof that terminal
physical cleanup already completed, because release is ordered after
hooks and removal. Repeated per-Contract and whole-repo reconcile must
remain unappointed and clean.
Managed terminal cleanup keeps the appointment through hooks and physical
Git worktree removal. Git's cleanup result must prove the appointed path
is physically absent before one locked durable register mutation removes
that Contract's entry. An unregistered-but-existing appointed path is
typed retention and keeps the appointment. A truly absent path may permit
release even when this attempt reports no removal. Any hook, removal, or
operational register-write failure leaves the appointment, so a free
Place never hides managed bytes. The next reconcile retries that same
absence proof and release. Release corruption propagates. There is no
second persisted release marker.

The sole appointment read returns `appointed` with place and path,
`unappointed`, or `failed` with a diagnostic. `appointed` comes only from the
decoded register. `unappointed` includes an admitted managed Contract not yet
appointed.
Register corruption or an unavailable read is one `failed` arm. The reader
does not inspect the journal, Git registration, or filesystem existence and
does not reconcile. Public status uses that same appointment fact: an
unappointed managed Contract reports a typed `unappointed` workspace
observation, keeps `worktreePath` null, and never names `places.json` as a
worktree path or issues Git workspace or target-lag probes against a
nonexistent worktree. Contract journals, coordinates, state refs, delivery
refs, candidate pins, selectors, Tasks, Dispatch, Alias, Akuma Heart, and
guidance frontmatter never persist Place. Managed worktrees contain no
second appointment marker; `.keiyaku/KEIYAKU.md` is guidance inside a
managed worktree.

## Materialization And Cleanup

Post-admission Place lifecycle composition has one private concrete Library
owner. That owner appoints a managed Place
before Git realization, then passes the freshly folded Contract state
for guidance. Mutation and Repo remain thin entry points and do not repeat
that appointment, cleanup, release, or register-lag policy. The workspace
owner creates or repairs these derived files atomically:

```text
<primary-worktree>/.keiyaku/.gitignore
<appointed-worktree>/.keiyaku/.gitignore
<appointed-worktree>/.keiyaku/KEIYAKU.md
```

Appointment reads, metadata checks, file reads, advisory chmod, and cleanup are
awaited. Reservation and repair fulfill only after their durable-file commit
has completed. There is no synchronous appointment API or deferred cleanup
queue.

The primary ignore is local to that checkout. It is not
`$GIT_DIR/info/exclude` and not a project-root `.gitignore` rule. It uses the
owned-data wildcard `*` so primary-only management bytes stay out of ordinary
Git status and dirty capture, and it re-includes `settings.json` and `tasks/`
so project Settings and Task authority remain capturable. Each managed
worktree's ignore file contains exactly `.gitignore` and `KEIYAKU.md`. This
keeps both guidance files out of ordinary Git status and delivery capture
without hiding other nested `.keiyaku/` bytes. A tracked generated path is a
failure. After every successful guidance create or replacement, Keiyaku
attempts `0444`; inability to change the mode is advisory and does not create
lag.

A write or cleanup failure returns a `contract-file-failed` lag naming the
worktree, path, and diagnostic while preserving admitted facts and completed
effects. Managed terminal cleanup stays governed by Git's sealed-byte and
ephemeral-abandonment-recovery law.

Git reconciliation has no projection callback, does not parse the frontmatter,
and neither reads nor writes these files. Explicit reconcile remains a public
repair entry point because library orchestration runs Git reconciliation first
and workspace projection second. Worktree hooks likewise do not consume
`KEIYAKU.md` declaratively; a hook command may read it as an ordinary file when
the invoking harness chooses to do so.
