# Kanshi

Kanshi is the package's composite world observation. It owns the public report
shape, section availability, read-time association joins, and Contract
selection. It is a reader, never authority: it writes, caches, repairs, and
reconciles nothing.

## Report

`kanshi({ path? })` normalizes one world coordinate and independently reads the
Contract board, complete Task world, and Akuma fleet. Every product remains a
public source value. A section is `present`, `absent`, or `failed`; absence is a
lawful missing product world, while corruption and IO are failures with a
bounded diagnostic. One section's failure does not suppress another section.

The report is:

```ts
type KanshiReport = {
  root: string;
  contracts: Section<ContractBoard>;
  tasks: Section<TaskKanshiWorld>;
  akuma: Section<AkumaKanshiWorld>;
};
```

## Contract endpoints

Task and Akuma source rows may each name one Contract. Kanshi outer-joins that
opaque id against the already-read Contract board and replaces the source
field with `{ id, observed }` in its own row type. `observed` is the Contract's
public disposition when found, `missing` when a present board lacks the id, and
`unavailable` when the Contract section is absent or failed. Corruption and IO
are never collapsed into `missing`.

The join is one hop. Kanshi does not validate associations, infer them from cwd
or origin, follow Task associations to derive an Akuma association, or persist
the joined view. Task and Akuma products do not import Contract lifecycle or
carrier behavior.

## Selection

`selectKanshi({ report, contract })` projects an assembled report without new
reads. It keeps the addressed Contract row and Task and Akuma rows whose joined
endpoint id exactly matches the selector. Section presence, absence, and
failure remain unchanged. The text renderer consumes only this public report
and renders each present endpoint as `keiyaku <id> (<observed>)`.
