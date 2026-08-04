---
name: keiyaku-v4-law
description: Law authority for any change or review of Keiyaku v4 architecture, facts, protocol, verbs, reconcile, persistence, lifecycle, identity, CLI, task, Akuma, projection, or response surfaces.
---

# Keiyaku v4 Law

Journal decides what happened. [Act 169]
Evidence preserves related material. Evidence blob bytes never enter fold input or lifecycle judgment; journaled evidence facts remain ordinary fold input. [Acts 169, 171, 175]
Reconcile aligns the external world to accepted facts; carrier commit/ref is Git transport, not a second ledger. [Acts 165, 169]

## Identity Laws

1. The registered public identity grammars are `aku/<human-profile>` or `aku/<human-profile>/<lower-hex8>`, `kei/<machine-contract>`, `task/<human-ns>/<human-local-id>`, and `resp/<machine-artifact>`. A task has exactly its two payload segments, namespace and local ID, with no hub form. Slash is the only type bit: parsing dispatches on an exact registered prefix. [Acts 173, 175]
2. A human-named segment and movable reference match `/^(?:[a-z0-9\-]|\p{RGI_Emoji})+$/v`: nonempty lowercase ASCII letters, digits, and hyphens mixed with Unicode RGI emoji sequences, with no whitespace. Identity is exact bytes: do not normalize Unicode or deduplicate visual confusables. Machine segments match `[a-z0-9][a-z0-9-]*`; projection suffixes are lower hex8, and `resp` payloads use the machine-segment grammar. [Acts 173, 175]
3. `@` is input-only. After stripping it, a slash selects a full registered identity and no slash selects a context-resolved movable reference matching the human rule. Neither `@` nor a movable reference persists as a durable fact coordinate. [Acts 173, 175]
4. Full `kei/...` coordinates persist in journal facts. Carrier paths privately map their payload to `contracts/<payload>.jsonl` and `contracts/<payload>/evidence/**`; paths never reconstruct a public identity. Reject unprefixed contract IDs: the format cut has no legacy reader, classifier, or migration. [Acts 173, 175]

## Facts Laws

1. Keep fact authority separate from physical transport and effects. [Acts 76, 78, 146, 150, 169]
2. Persist state only as lattice scalars, current-entry pointers, and folded body. [Acts 146, 148, 169]
3. Add a field only when an invariant reads it. [Acts 151, 169]
4. Treat typed definite outcomes as terminal; probe only typed `unknown`. [Acts 150, 151, 152, 169]
5. Make every semantic judgment from one carrier snapshot. [Acts 150, 169]
6. Treat canonical entry bytes as attempt identity; ULIDs are coordinates. [Acts 150, 169]
7. Split retries: facts mechanically rebuild only when progress-coupled to observed carrier movement; protocol semantically redecides with fresh ULIDs. [Acts 146, 148, 150, 151, 152, 169]

## Protocol Laws

1. Keep shared protocol/facts fully parameterized over Input, Handoff, and Refusal; verbs depend on protocol/facts, never the reverse. [Acts 162, 168, 169]
2. Treat handoff and reconcile intermediates as disposable; accepted facts plus fresh observation must reconstruct required effects. If losing the handoff loses information, that information belongs in a journal fact. [Acts 162, 165, 169, 171]
3. Keep `DecideInput` closed to plain input, same-snapshot states, and runner ULIDs; exclude cwd, signals, callbacks, random values, and IO handles. [Acts 162, 168, 169]
4. Keep decisions to `refused` or `offer`; each verb owns its refusal type, distinct from admission outcomes. [Acts 162, 165, 169]
5. Return movement to its producer: runner-observed contract head movement redecides inside the runner; shell-prepared ref movement returns terminal `ref-moved` to shell preparation. [Acts 162, 168, 169]

## Reconcile Law

Assign a reconcile effect to a verb only when accepted facts plus fresh observation reconstruct it. Align only journaled coordinates, never a newer world; never append a journal, write the carrier, or decide lifecycle. [Acts 165, 169]

## Prohibitions

Do not add an effect journal/receipt protocol, replay gate, pre-admission second judge, verb registry/table dispatch, world-fact provider abstraction, common Handoff base, cross-verb refusal enum, single-implementation Storage interface, or repository ledger/current-state snapshot publication. Do not classify identities by payload shape, prove identity separation with pairwise shape predicates, normalize Unicode identity bytes, or deduplicate visual confusables. [Acts 162, 165, 168, 169, 173, 175]

## Acceptance Nails

1. Prove `decide` deterministic and pure, with offer expectations exactly equal to their premises. [Acts 162, 168, 169]
2. Prove a stale ref premise reaches typed admission rejection, then shell reprepare runs a new protocol invocation with fresh ULIDs. [Acts 168, 169]
3. Prove reconcile idempotent and disposable, including null handoff and restart. [Acts 165, 169]
4. Prove dependency direction. [Acts 162, 169]

Update this law in the same commit as every future settled ruling and its implementation. [Act 169]
