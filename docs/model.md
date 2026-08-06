# Contract Model

The journal is the sole lifecycle authority. Carrier storage, target refs,
worktrees, runtime results, and folded state are derived from or effects of the
journal; none is a second state store.

## Dependency Direction

Each component answers one class of question and has one legal consumer:

| Component | Question | Legal consumer |
| --- | --- | --- |
| `core` (pact) | facts to state; intent to decision | every layer, as pure functions and types |
| `markdown` | text to AST | `body` |
| `body` | document to `ContractBody` or arc value | `library` |
| `carrier` | fact observation, admission, persistence, and Git effects | `protocol` |
| `runtime/proc` | process execution to typed outcome | `verification` |
| `verification` | declarations to attempt and result | `protocol` |
| `protocol` | observe, decide, admit, and public reads | `library` |
| `library` | operations to public object syntax | `index.ts` |
| `index.ts` | package-root API | CLI and external callers |
| `cli` | argv to public operations and rendered output | no internal consumer |

Imports follow those edges without skipping a layer. `core` is readable as
pure functions and types throughout the graph. Pact has no repository handle,
Git execution, ref/worktree effect, process, clock, current directory, or
physical object-format validator. Protocol is the only join between pure pact
decisions and carrier observation/admission. Verification consumes the shared
process runtime without making either part of pact.

`SnapshotId` names a work snapshot and `ChangeId` names patch content. Carrier
mints both and is the sole physical Git object-ID validator; pact validates only
their opaque nonblank values. Every tender has both identities. Verification
pins the `SnapshotId`, review pins the `ChangeId`, and placement uses the
snapshot. A carrier may make them equal and thereby choose stricter freshness.

## Identity Coordinates

Public identities use this closed registry:

| Prefix | Grammar |
| --- | --- |
| `aku/` | `aku/<human-profile>` or `aku/<human-profile>/<lower-hex8>` |
| `kei/` | `kei/<machine-contract>` |
| `task/` | `task/<human-ns>/<human-local-id>` |
| `resp/` | `resp/<machine-artifact>` |

Human segments are nonempty lowercase ASCII letters, digits, hyphens, or RGI
emoji sequences, with no whitespace. Machine segments match
`[a-z0-9][a-z0-9-]*`; a projection suffix is lower hex8. A task has exactly its
namespace and local-id segments. Identity bytes are exact: no Unicode
normalization or visual-confusable deduplication applies.

Carrier mints a ContractId once before bind protocol attempts, and every
attempt for that bind reuses it. The Git carrier currently uses a lowercased
26-character Crockford-base32 ULID as the machine segment. Readers, folds,
gates, and paths compare the whole `ContractId` and do not parse its machine
segment. Admission adjudicates uniqueness; an existing identity produces the
typed `contract-exists` refusal for that bind.

`@` is input-only. A slash denotes a full registered identity after removing
`@`; no slash denotes a context-resolved movable reference. Neither form is
persisted.

Actor is optional testimony, not lifecycle identity or gate input. `ActorId` is
an opaque nonblank brand. A library write records it only when the caller
supplies it; its absence is legal. The CLI selects an explicit nonblank
`--actor`, then `KEIYAKU_PROJECTION_ID`, then no signature. Carrier uses a
neutral Git author when testimony is absent. Facts retain full `kei/` values;
carrier paths may privately strip the prefix but never reconstruct public
identity from a path.

## Values And Facts

```ts
type ContractCoordinates = Readonly<{
  start: SnapshotId
  target?: string
  workspace: "worktree" | "here"
}>

type ContractBody = Readonly<{
  title: string
  context: string
  objective: string
  design: string
  region: readonly string[]
  criteria: readonly ContractCriterion[]
  verification: readonly VerificationDeclaration[]
  extensions: readonly ContractExtension[]
  gates?: readonly Gate[]
  after?: readonly ContractId[]
}>

type JournalEnvelope<Kind extends string, Data> = Readonly<{
  v: 1
  kind: Kind
  contract: ContractId
  entry: EntryUlid
  at: string
  actor?: ActorId
  data: Data
}>
```

`BindData` is immutable `ContractCoordinates` plus revision-zero
`ContractBody`. `AmendData` is a complete replacement `ContractBody` and never
changes coordinates. Revision identity is the journal-entry coordinate. The
body's document fields are defined by [document.md](document.md); `gates` and
`after` are structured values carried with the body.

The fact vocabulary is closed:

```text
bind / amend / deliver / attestation / abandon
arc / bound / claimed / abandoned
```

```ts
type BoundData = {}

type DeliverData = Readonly<{
  expectedPredecessor: SnapshotId
  candidate: SnapshotId
  deliveryPatchId: ChangeId
}>

type AttestationData = Readonly<{
  gate: Gate
  subject: SubjectKey
  verdict: "satisfied" | "unsatisfied"
  summary?: string
}>

type ClaimedData = Readonly<{ delivery: EntryUlid }>
type ArcData = Readonly<{
  seq: number
  title: string
  objective: string
  brief: string
}>
type AbandonData = Readonly<{
  note?: string
}>
type AbandonedData = Readonly<{ finalHead: SnapshotId | null }>
```

The journal stores lifecycle facts and bounded intent data only. It stores no
raw review or verification logs, reports, patches, artifacts, or blob evidence.
Its `at` values are the contract timeline. Counts and elapsed intervals are
read-time projections; no telemetry file, persisted counter, duration field,
or additional fact kind is needed for a value derivable from journal facts, Git,
or the Akuma pillar's own records.

## Folded State

```ts
type ContractState = Readonly<{
  id: ContractId
  head: ContractHead | null
  coordinates: ContractCoordinates | null
  body: ContractBody | null
  bound: BoundEntry | null
  delivery: DeliverEntry | null
  attestations: readonly AttestationEntry[]
  currentArc?: ArcEntry
  abandon: AbandonEntry | null
  terminal: ClaimedEntry | AbandonedEntry | null
}>
```

`ContractState` is a fold snapshot, not stored authority. It holds the
contract head, coordinates, effective body, binding placement, current tender,
attestation history, current arc, abandonment intent, and terminal placement.
Pending delivery is a read-model projection over this state.

The carrier checks `meta/format.json` on every nonempty carrier read. A
contract's `ContractHead` is its journal blob identity, so unrelated carrier
movement does not change that contract. The journal's canonical bytes and entry
ULIDs identify accepted facts. A partial match of a multi-entry admission is
corrupted authority.

Persist a field only when a named invariant and reader require it. A field with
no reader is another state surface rather than authority.
