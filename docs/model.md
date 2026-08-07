# Contract Model

The journal is the sole lifecycle authority. Carrier storage, target refs,
worktrees, runtime results, and folded state are derived from or effects of the
journal; none is a second state store. v4 has no compatibility or migration
layer.

## Dependency Direction

Each component answers one class of question and has one legal consumer:

| Component | Question | Legal consumer |
| --- | --- | --- |
| `core` (pact) | facts to state; intent to decision | every layer, as pure functions and types |
| `markdown` | text to AST | `library` |
| `body` | edge document methodology to private values | `library` |
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
decisions and carrier observation/admission. Execution-side producers consume
the shared process runtime without making either part of pact. Core knows no
Markdown grammar, section name, or producer-specific declaration.

A core `ContractsObservation` carries only the contract map that pure decisions
actually read: every requested identity maps to its folded `ContractState` or
to explicit `null` absence. A missing map key is a broken observation invariant,
not another spelling of contract absence. Raw journal entries belong to the
carrier/protocol observation used for audit and unknown-admission recovery; they
do not enter the pact decision projection. Carrier snapshot identity and
physical provenance likewise remain carrier concerns.

`SnapshotId` names a work snapshot and `ChangeId` names patch content. Carrier
mints both and is the sole physical Git object-ID validator; pact validates only
their opaque nonblank values. Every tender has both identities. A producer or
operation may include either identity in its dependency-key set when its own law
requires it. A carrier may make them equal and thereby choose stricter
freshness.

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
neutral Git author when testimony is absent. Contract facts retain full `kei/`
identities; carrier paths may privately strip that prefix but never reconstruct
public identity from a path.

## Values And Facts

```ts
type ContractCoordinates = Readonly<{
  start: SnapshotId
  target?: string
  workspace: "worktree" | "here"
}>

type DocumentKey = Opaque<"document-key">
type DocumentSegmentKey = Opaque<"document-segment-key">
type Gate = Opaque<"contract-gate">
type DependencyKeySet = Opaque<"dependency-key-set">
type ContractDocument = Readonly<{
  bytes: string
  key: DocumentKey
}>

type ContractTerms = Readonly<{
  document: ContractDocument
  segments: readonly DocumentSegmentKey[]
  gates: readonly Gate[]
  after: readonly ContractId[]
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
`ContractTerms`. `AmendData` is a complete replacement `ContractTerms` and
never changes coordinates. Revision identity is the journal-entry coordinate.
When present, `ContractCoordinates.target` is the canonical full
`refs/heads/...` ref produced at the public library boundary; target validation
and rejection are owned by [public-api.md](public-api.md).
The edge library supplies the opaque whole-document bytes and mints the whole
document and ordered segment keys from its Markdown methodology. Core stores
those bytes and keys with the machine terms `gates` and `after`; it knows none
of the source document's sections or syntax.

The fact vocabulary is closed:

```text
bind / amend / deliver / attestation
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
  subject: DependencyKeySet
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
type AbandonedData = Readonly<{
  note?: string
}>
```

`summary` is the attestation producer's bounded textual context. Human review
uses caller-authored prose; Verification uses a bounded rendering of terminal
process output. It remains part of the one attestation fact, not an evidence
blob, log ref, artifact store, or second authority.

`abandoned` is the one abandonment terminal fact. It carries only an optional
opaque `note`; it has no target snapshot, reason category, intent precursor, or
reopen fact. Abandonment never reads or changes the target ref.

The journal stores lifecycle facts and bounded intent data only. It stores no
raw producer logs, reports, patches, artifacts, or blob evidence.
Its `at` values are the contract timeline. Counts and elapsed intervals are
read-time projections; no telemetry file, persisted counter, duration field,
or additional fact kind is needed for a value derivable from journal facts, Git,
or the Akuma pillar's own records.

## Folded State

```ts
type ContractState = Readonly<{
  id: ContractId
  head: ContractHead | null
  coordinates: ContractCoordinates
  terms: ContractTerms
  bound: BoundEntry | null
  delivery: DeliverEntry | null
  attestations: readonly AttestationEntry[]
  currentArc?: ArcEntry
  terminal: ClaimedEntry | AbandonedEntry | null
}>
```

`ContractState` is a fold snapshot, not stored authority. It holds the
contract head, coordinates, effective opaque terms, binding placement, current
tender, attestation history, current arc, and terminal placement. Pending
delivery is a read-model projection over this state.

Contract absence has exactly one representation: its requested decision-map
entry is `null`. A `ContractState` value proves that a bind-rooted journal was
folded successfully, so its coordinates and terms are total. A
fold implementation may use a private partial accumulator while validating the
first entry, but that accumulator is not a `ContractState` and never crosses
the core boundary.

Gate, subject, and document identities are opaque pact values. Their lifecycle
meaning, producer ownership, and sole currentness adjudicator are defined once
in [lifecycle.md](lifecycle.md); their producer-specific Verification use is
defined in [verification.md](verification.md). Core derives none of those rules
from Markdown section names or Git objects.

The carrier checks `meta/format.json` on every nonempty carrier read. A
contract's `ContractHead` is its journal blob identity, so unrelated carrier
movement does not change that contract. The journal's canonical bytes and entry
ULIDs identify accepted facts. A partial match of a multi-entry admission is
corrupted authority. Invalid canonical journal bytes, an impossible journal
fold, a malformed carrier format, and a partial unknown-admission match throw
the package-root `AuthorityCorruptionError`. This exception identifies durable
authority that cannot be interpreted; it is not a programmer `TypeError`, a
lifecycle refusal, or a retry classification.

Persist a field only when a named invariant and reader require it. A field with
no reader is another state surface rather than authority.
