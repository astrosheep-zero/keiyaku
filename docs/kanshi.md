# Kanshi

Kanshi is the package's composite world observation. It owns the public report
shape, section availability, read-time association joins, and Contract
selection. It is a reader, never authority: it writes, caches, repairs, and
reconciles nothing.

## Report

`kanshi({ world, repo? })` consumes one already resolved world coordinate and
optional Git Repo and independently reads the
Contract board, complete Task world, and Akuma fleet. Every product remains a
public source value. A section is `present`, `absent`, or `failed`; absence is a
lawful missing product world, while corruption and IO are failures with a
bounded diagnostic. One section's failure does not suppress another section.

The report is:

```ts
type KanshiReport = {
  root: WorldRoot | null;
  observedAt: string;
  branch: string | null;
  contracts: Section<ContractKanshiBoard>;
  tasks: Section<TaskKanshiWorld>;
  akuma: Section<AkumaKanshiWorld>;
};
```

`observedAt` is one canonical ISO timestamp sampled before any section read.
`branch` is the invocation Repo's attached branch, or `null` without a Repo,
for detached HEAD, or when that observation fails. The immutable
`refs/heads/keiyaku-state` commit remains represented once as
`ContractBoard.state`, not copied into another report field. It is not the
invocation worktree HEAD.

## Contract endpoints

Task endpoints come only from current `held` TaskHolder facts read through the
package-root composition boundary; Task Markdown has no association field.
Kanshi outer-joins each endpoint id
against the already-read Contract board and exposes `{ id, observed }` in its
own row type. `observed` is the Contract's
public disposition when found, `missing` when a present board lacks the id, and
`unavailable` when the Contract section is absent or failed. Corruption and IO
are never collapsed into `missing`.

The same holder read is reverse-projected onto Kanshi-owned Contract rows as:

```ts
type ContractHolderObservation =
  | { kind: "held"; taskId: TaskId }
  | { kind: "none" }
  | { kind: "unavailable" };
```

`none` means the holder authority was read successfully and has no current
`held` fact for that Contract. `unavailable` means the holder read failed; it
is not absence. This decoration does not add Task knowledge to `ContractRow`
or change `ContractBoard`.

The join is one hop. Kanshi does not validate associations, infer them from cwd
or origin, follow Task associations to derive an Akuma association, or persist
the joined view. A malformed or unreadable holder fails only the Task section;
the base Contract section remains present with `unavailable` holder
observations, and the Akuma section remains independently observable. Task and
Akuma products do not import Contract lifecycle or Git behavior.

Kanshi obtains the complete Task board projection from one Task-owner
observation operation. A row present in the Task owner's
blocked projection copies its ordered unresolved `TaskRef[]` as `blockers`;
this includes open `blocked` and `in_progress` rows with unresolved needs. A
row outside that projection has no `blockers` field. Missing need targets
remain structured refs with `title: null` and `state: "missing"`. Kanshi does
not import Task persistence, reread the Task board, or derive blockers from
text.

Kanshi reads Dispatch and Alias through their concrete owners after the compact
Akuma fleet read. Each Akuma row carries its current world-local Alias list and,
when a Dispatch exists, one `{ id, observed }` Contract endpoint using the same
disposition join as Task endpoints. A malformed Alias or Dispatch fails only
the Akuma section. Kanshi does not infer association through Task, cwd, origin,
or Contract lifecycle, and never changes or repairs either authority.

## Selection

`selectKanshi({ report, contract })` projects an assembled report without new
reads. It keeps the addressed Contract row, Task rows whose joined endpoint id
exactly matches the selector, and Akuma rows whose Dispatch endpoint names that
Contract. Section presence, absence, and
failure remain unchanged. The text renderer consumes only this public report
and renders each present endpoint as `keiyaku <id> (<observed>)`.
