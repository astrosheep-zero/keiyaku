# Contract Model

The journal is the sole lifecycle authority. Git storage, target refs,
worktrees, runtime results, and folded state are derived from or effects of the
journal; none is a second state store. v4 has no compatibility or migration
layer.

## Dependency Direction

Each component answers one class of question. Pact maps facts and intent to
pure state and decisions. Markdown and document methodology convert caller text
to private Library values. Git owns observation, admission, persistence, and
physical Git effects. Protocol is the only join between pact decisions and Git.
Execution-side producers consume the shared process runtime and return to
protocol. Library maps those capabilities to package-root operations; CLI only
adapts argv and renders public values.

Dependencies follow that direction without skipping a layer. Pact has no
repository handle, Git execution, ref/worktree effect, process, clock, current
directory, or physical object-format validator. Core knows no Markdown grammar,
section name, or producer-specific declaration.

A core `ContractsObservation` carries only the contract map that pure decisions
actually read: every requested identity maps to its folded `ContractState` or
to explicit `null` absence. A missing map key is a broken observation invariant,
not another spelling of contract absence. Raw journal entries belong to the
Git/protocol observation used for audit and unknown-admission recovery; they
do not enter the pact decision projection. Git snapshot identity and
physical provenance likewise remain Git concerns.

Contract board readers may project the source entry time for the displayed
phase from that same frozen journal observation. Current gate testimony carries
its attestation entry time; stale and missing testimony carry no time. These are
source facts, never stored ages or eligibility times inferred from another
Contract.

`SnapshotId` names a work snapshot and `ChangeId` names a byte-sensitive stable
patch identity. Git mints both and is the sole physical Git object-ID validator; pact
validates only their opaque nonblank values. A tender has one snapshot identity.
Its delivery records integration predecessor and snapshot for placement topology
and exactly one ChangeId for the complete captured tender tree relative to the
immutable Contract start. Review mints that same worktree-content identity.
Neither operation mints an integration-derived ChangeId or a second tender
identity. A producer or operation may include only the identities its owning
law permits in its dependency-key set.

## Identity Coordinates

Public identities use this closed registry:

| Prefix | Grammar |
| --- | --- |
| `aku/` | `aku/<human-archetype>/<lower-hex8>` |
| `kei/` | `kei/<contract-segment>` |
| `task/` | `task/<human-local-id>` or `task/<human-ns...>/<human-local-id>` |
| `resp/` | `resp/<machine-artifact>` |

A legal contract segment is nonempty and contains no slash, whitespace, or
control character. Coordinate validation does not rerun the narrower title
normalization used by bind.

The neutral coordinate primitive only joins and splits a caller-selected family;
it owns no product semantics. Each identity family then owns its public
constructor and parser or validator that accept only the complete prefixed
coordinate. Contract construction adds `kei/`; Task construction adds `task/`.
A bare stem or local ID is never a full identity, and no downstream consumer
repairs a missing family prefix.

An identity stem is normalized from human-readable input by NFKC normalization,
locale-independent lowercasing, retaining Unicode letters, numbers, and
complete emoji graphemes, and collapsing every intervening run to one hyphen.
The transformation is pure and idempotent: normalizing an already normalized
stem returns the same bytes. Its output uses a portable filename character form;
platform-specific physical names remain Git's concern.

Fitting is a separate pure operation. It truncates only at a grapheme boundary
under an owner-selected UTF-8 byte budget and may reserve room for a suffix. Each
identity family separately owns its prefix, namespace, suffix generation,
collision policy, and persistence. Legality validates an identity coordinate as
given and never substitutes for normalization or fitting.

Human segments are nonempty lowercase ASCII letters, digits, hyphens, or RGI
emoji sequences, with no whitespace. Machine segments match
`[a-z0-9][a-z0-9-]*`; a projection suffix is lower hex8. A task has one local-id
segment after `task/` and may have any number of namespace segments before it;
no namespace denotes the task root. Identity bytes are exact: no Unicode
normalization or visual-confusable deduplication applies.

Library bind derives the first ContractId as `kei/<fitted-normalized-title>`.
Its title-derived stem has a 48 UTF-8 byte budget; the `kei/` prefix is outside
that budget. Admission is the sole uniqueness adjudicator. Protocol bind accepts
one already selected complete ContractId and performs one preparation and
admission attempt; it does not normalize a title, mint a suffix, or retry a
different identity. When the unsuffixed identity exists, Library may make at
most three more Protocol admissions. Each one appends `-` and a newly minted
eight-byte lowercase hexadecimal suffix to the same fitted title stem; neither
separator nor suffix consumes its 48-byte budget. Suffixing is not part of
normalization. Other Git movement retries reuse the selected identity; they
never silently remint it. After the third suffixed collision, Library returns
that exact typed `contract-exists` refusal. An empty normalized stem uses
`contract` before the same collision rule. Readers, folds, and gates compare
the whole `ContractId` and never renormalize an admitted identity.
Complete-ID validation does not retroactively enforce the generation budget, so
existing longer identities remain valid.

`@` is input-only. A slash denotes a full registered identity after removing
`@`; no slash denotes a context-resolved movable reference. Neither form is
persisted.

An Akuma alias is the input-only selector `@<name>`, where `name` matches
`[a-z][a-z0-9-]{0,63}`. Identity is the sole parser and
constructor for this grammar. The complete spelling, including `@`, is the
selector value. Alias persistence and movement are owned by
[alias.md](alias.md); selector expansion is a Library concern and never changes
the complete `aku/...` identity stored by an owner.

An Akuma glob is the input-only selector
`aku/<archetype-pattern>/<hex-pattern>`. Each nonempty pattern uses only the
corresponding identity alphabet plus `*`, and at least one `*` is required.
Identity alone parses and matches this grammar. A Contract
worker selector is one complete `kei/...` identity. Alias, glob, and Contract
worker expansion are read-time Library snapshots; none is persisted as Akuma
identity or interpreted by Akuma.

Actor is optional testimony, not lifecycle identity or gate input. `ActorId` is
an opaque nonblank brand. A library write records it only when the caller
supplies it; its absence is legal. The CLI selects an explicit nonblank
`--actor`, then `KEIYAKU_ACTOR_ID`, then no signature. A visible delivery
commit uses that actor with `keiyaku@localhost`, otherwise the complete
repository-effective Git identity, otherwise `Keiyaku <keiyaku@localhost>`.
This presentation adds no fact or identity authority. Contract facts retain
full `kei/` identities; Git paths may privately strip that prefix but never
reconstruct public identity from a path.

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
  tenderSnapshot: SnapshotId
  integration: Readonly<{
    predecessor: SnapshotId
    snapshot: SnapshotId
    changeId: ChangeId
  }>
  method: "squash"
  policy: Readonly<{
    requireBranchesToBeUpToDate: boolean
  }>
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
or the Akuma pillar's own records defined by [akuma-heart.md](akuma-heart.md).

A Contract history read is not a third authority. Library composes the selected
journal and successful Dispatch facts from one call-scoped Git read observation
of keiyaku-state into a non-authoritative recorded-time projection: `fact.at`
ascending, then `dispatchedAt`, with journal before Dispatch on equal
timestamps. Journal ties keep append order; Dispatch ties use AkuId bytes. The
tie rule is presentation only and asserts no causality, publication order, or
shared sequence. There is no global cursor, reverse index, or expansion of
Akuma Heart history onto `kei/...`.

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
delivery is a read-model projection over this state. Placement prerequisite
eligibility is not a field on `ContractState`: placement derives it from the
current `terms.after` and the terminal states of those ContractIds. The durable
`bound` entry records the independent delivery-phase milestone; it neither
copies nor consumes an `after` snapshot. An active amend may therefore replace
`terms.after` before or after `bound` and `deliver`.

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

Git checks `meta/format.json` on every nonempty Git read. A
contract's `ContractHead` is its journal blob identity, so unrelated Git
movement does not change that contract. The journal's canonical bytes and entry
ULIDs identify accepted facts. A partial match of a multi-entry admission is
corrupted authority. Invalid canonical journal bytes, an impossible journal
fold, a malformed Git format, and a partial unknown-admission match throw
the package-root `AuthorityCorruptionError`. This exception identifies durable
authority that cannot be interpreted; it is not a programmer `TypeError`, a
lifecycle refusal, or a retry classification.

Persist a field only when a named invariant and reader require it. A field with
no reader is another state surface rather than authority.
