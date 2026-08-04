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
5. Return movement to its producer: runner-observed contract head movement redecides inside the runner; `claim` derives the sole `RefOperation` premise from its petition fact. A moved claim premise is terminal `petition-stale`: do not reprepare or retry claim, and petition anew after fresh observation with fresh ULIDs. `forfeit` and `claim` race through journal-head admission without intent gating; both pass the one adjudicator, and the loser observes contract-head movement, redecides against the terminal state, and refuses typed. [Acts 162, 168, 169, 179, 181]

## Delivery Laws

1. `open` is the first delivery installation. `OpenData` is `{ target, base }`; fold installs `delivery = { target, base, head: base }`. `target` is the external Git ref name as a plain string, not a registered identity. [Act 179]
2. Only `open` installs delivery. `renew` and `seal` refuse when `delivery == null`; no sealed state has `delivery == null`. `RenewData` is `{ newBase, oldHead, newHead }`; `renew` preserves `delivery.target`, requires `oldHead` to equal the current `delivery.head`, then records `delivery.base = newBase` and `delivery.head = newHead`. [Act 179]
3. Journal facts include the target ref name, delivery base/head OIDs, and candidate OID. Delivery-ref names and worktree paths are repository-private deterministic conventions derived from contract identity, not facts. [Act 179]
4. `open` and `renew` carry no `RefOperation`; their base/head OIDs are shell-observed values and admission is carrier CAS only. `claim` is the sole verb whose Offer carries a `RefOperation`; all other ref effects are reconcile projections. [Act 179]
5. `PetitionData` is exactly `{ expectedPredecessor, deliveryHead, candidate }`; it has no `intent`, `oath`, `seat`, forfeit-petition, or payload variants. One entry kind carries one verb meaning. The candidate is shell-prepared before `decide`; merge conflict is a typed verb refusal, not an admission outcome. [Acts 179, 181]
6. Candidate commits use a deterministic merge strategy, the petition actor and `at` for author/committer identity and timestamp, and a fixed message format. Equal inputs produce byte-identical content and the same OID. No candidate ref or retention rule exists: a collected candidate is re-derived from the petition fact and retained inputs. Claim lands exactly `petition.candidate`; there is no predicted/realized duality. [Act 179]
7. `ClaimData` is `{ petition }`. Its `RefOperation` moves the target from `petition.expectedPredecessor` to `petition.candidate`. Claim has no shell preparation; a moved premise produces terminal `petition-stale`, requiring a new petition rather than a claim retry. [Act 179]
8. `approved` is not a lifecycle phase; `ContractState` holds it as a current approval `ReviewEntry` pointer, never a search over historical evidence. An approved review sets it; changes-requested, amend, renew, a new petition, and terminal settlement clear it as applicable. The approval carries `{ reviewedHead }`. Claim refuses unless `approval.reviewedHead == petition.deliveryHead`; a renew that moves delivery head requires re-review. [Acts 179, 181]
9. `forfeit` refuses only in terminal states, `claimed` and `forfeited`. Every nonterminal lifecycle state is forfeitable, including after a claim petition exists and after approval. [Act 181]
10. The current delivery implementation slice is schema/fold work plus pure `open` and `renew` owners and tests. Petition and claim owners are the next slice; claim exercises Nail 2 end to end with the sole target `RefOperation` and terminal `petition-stale`. [Act 179]

## Reconcile Law

Assign a reconcile effect to a verb only when accepted facts plus fresh observation reconstruct it. Ref alignment belongs to reconcile: `open` creates the delivery ref at head and materializes its conventional worktree; `renew` moves that ref to `newHead` and refreshes the worktree; `petition` has no reconcile effect; `claim` and `forfeit` delete the delivery ref and worktree as settlement cleanup when delivery exists. Each is idempotent from null handoff. Align only journaled coordinates, never a newer world; never append a journal, write the carrier, or decide lifecycle. [Acts 165, 169, 179, 181]

## Delivery Refusals

Do not add queue/seat machinery, predicted-commit duality, candidate refs or retention, verification-run gating, persisted worktree paths or delivery-ref names, or target-pin `RefOperation`s on `open` or `renew`. [Act 179]

## Prohibitions

Do not add an effect journal/receipt protocol, replay gate, pre-admission second judge, verb registry/table dispatch, world-fact provider abstraction, common Handoff base, cross-verb refusal enum, single-implementation Storage interface, or repository ledger/current-state snapshot publication. Do not classify identities by payload shape, prove identity separation with pairwise shape predicates, normalize Unicode identity bytes, deduplicate visual confusables, or add intent/kind-discriminated payload variants inside one entry type. One entry kind carries one verb meaning. [Acts 162, 165, 168, 169, 173, 175, 181]

## Acceptance Nails

1. Prove `decide` deterministic and pure, with offer expectations exactly equal to their premises. [Acts 162, 168, 169]
2. Prove a stale `claim` `RefOperation` produces terminal `petition-stale`; claim does not reprepare or retry, and a fresh petition follows new observation with fresh ULIDs. [Acts 168, 169, 179]
3. Prove reconcile idempotent and disposable, including null handoff and restart. [Acts 165, 169]
4. Prove dependency direction. [Acts 162, 169]

Update this law in the same commit as every future settled ruling and its implementation. [Act 169]
