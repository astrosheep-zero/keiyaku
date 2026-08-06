# Source Tree Draft

**Status: rough draft aligned to the 2026-08-06 hard cut; non-authoritative
planning evidence.** The owner documents are registered in
[`README.md`](README.md). This file records the current ownership shape,
measurements, and deletion map. It cannot add product behavior or persisted
fields.

## Confirmed Tree

```text
src/
├── index.ts                 # sole public ESM package root
├── library/
│   └── keiyaku.ts           # public values and mapping-only facade
├── body/                    # ContractBody Markdown grammar and amend transforms
│   ├── grammar.ts
│   ├── decode.ts
│   ├── render.ts
│   ├── amend.ts
│   └── arc.ts
├── runtime/
│   └── proc/
│       └── run.ts           # domain-free spawn, capture, tree termination
├── verification/
│   ├── plan.ts              # pure executor plan
│   └── producer.ts          # synchronous Verification producer
├── markdown/               # generic source-aware Keiyaku Markdown dialect
│   ├── types.ts
│   ├── lex.ts
│   ├── parse.ts
│   └── query.ts
├── core/
│   ├── decide.ts            # pure decision/result vocabulary
│   ├── declaration-key.ts   # canonical Verification declaration-key primitive
│   ├── facts/
│   │   ├── types.ts       # ContractCoordinates, ContractBody, journal values
│   │   ├── codec.ts       # canonical current-version journal codec
│   │   ├── fold.ts        # one journal -> ContractState fold
│   │   ├── observation.ts # pure observed journal shapes
│   │   ├── offer.ts       # pure ordered append/ref offer
│   │   ├── eligibility.ts  # explicit fact-kind eligibility projection
│   │   └── gate.ts        # pure reviewed/verified key comparison
│   ├── verbs/
│   │   ├── bind.ts
│   │   ├── amend.ts
│   │   ├── deliver.ts     # candidate declaration
│   │   ├── verification.ts # verification fact admission only
│   │   ├── review.ts      # review intent admission
│   │   ├── placement.ts   # one explicit deliver/review placement adjudicator
│   │   ├── abandon.ts
│   │   └── arc.ts
├── protocol/
│   ├── attempt.ts          # disposable attempt context
│   ├── intent.ts           # low-level admission and Verification primitives
│   ├── operations.ts       # complete public-operation orchestration
│   ├── run.ts              # semantic retry and carrier admission loop
│   └── read/
│       ├── status.ts
│       └── audit.ts
├── carrier/
│   ├── repository.ts       # all Git execution and repository discovery
│   ├── identity.ts         # mint/validate carrier-backed opaque identities
│   ├── observe.ts          # one-snapshot carrier observation
│   ├── admission.ts        # atomic journal facts + optional target CAS
│   ├── delivery.ts         # candidate preparation
│   ├── verification.ts     # disposable candidate worktree preparation
│   └── reconcile.ts        # accepted facts + fresh observation -> effects/lag
├── cli/
│   ├── index.ts           # shebang-only executable entry
│   ├── main.ts            # process boundary and exit mapping
│   ├── parse.ts           # one closed argv grammar
│   ├── invoke.ts          # edge acquisition and public-library dispatch only
│   ├── actor.ts            # optional actor testimony resolution
│   ├── selectors.ts       # CLI selector/worktree inference edge
│   ├── settings.ts        # bind/amend gate snapshot acquisition
│   ├── accepted.ts        # accepted-fact result/effect adapter
│   ├── result.ts          # CLI invocation result data shapes
│   ├── diff.ts            # pure unified-diff presentation adapter
│   ├── commands/          # argv adapters only, one file per command
│   │   ├── bind.ts
│   │   ├── amend.ts
│   │   ├── deliver.ts
│   │   ├── review.ts
│   │   ├── abandon.ts
│   │   ├── arc.ts
│   │   ├── status.ts
│   │   ├── audit.ts
│   │   └── reconcile.ts
│   └── render/            # data-only result renderers
│       ├── text.ts
│       ├── board.ts
│       ├── contract.ts
│       └── refusal.ts
```

The `facts/types.ts` location is intentional: `ContractCoordinates` and the
journal form of `ContractBody` are pact values. The public domain object is
`Keiyaku`, not a second mutable `Contract` model. `facts/gate.ts` is shared by
deliver placement, review placement, and read views; it is pure and performs no
IO.

`markdown/` knows source structure and byte spans but no contract section
vocabulary. `body/` owns that vocabulary and emits one typed
`ContractBody`; neither layer is a second journal format.

`runtime/proc/` is the only shared execution primitive and has no domain
imports. `verification/` imports it and owns Verification-specific planning and
execution. Journal facts, not a second cache authority, carry accepted terminal
results. A future `akuma/` pillar may also import
`runtime/proc/`, but the two domains do not share a lifecycle runner.

`core/verbs/deliver.ts` records the selected existing candidate. The IO-bearing
`verification/` producer returns a terminal result to protocol orchestration,
which invokes the pure `core/verbs/verification.ts` decision to record a
separate matching journal fact. Explicit deliver/review requests share
`core/verbs/placement.ts`; audit never calls it. Neither verb imports another
verb.

`protocol/read/` contains the ruled read surfaces. A helper that observes or
executes Git belongs in `carrier/`; a helper with no ruled reader does not get a
new file. `commands/` adapts argv to public library calls and never decides
lifecycle or observes Git. Task management remains outside the Day1 package and
binary; no unreachable task pillar is shipped for a future reader.

## Deletion And Migration Map

| Legacy owner | Action | New owner |
| --- | --- | --- |
| `verbs/open.ts` | delete; materialize delivery effects from `bound` | `carrier/reconcile.ts` |
| `verbs/seal.ts` | delete; candidate preparation is part of delivery | `verbs/deliver.ts` |
| `verbs/renew.ts` | delete; freshness is recomputed from current keys | `carrier/reconcile.ts` / `facts/gate.ts` |
| `verbs/petition.ts` | delete; candidate and patch-id preparation move with delivery | `verbs/deliver.ts` |
| `verbs/petition-preparation.ts` | delete | `verbs/deliver.ts` |
| `verbs/claim.ts` | delete; target CAS and claimed placement are admission concerns | `carrier/admission.ts` |
| `verbs/forfeit.ts` | delete | `verbs/abandon.ts` |
| `verbs/approval-preparation.ts` | delete; review placement shares claimed admission | `verbs/review.ts` |
| `verbs/pipeline.ts` | delete | `facts/gate.ts` |
| old verb suites | delete and replace; no aliases or old decoders | focused v4 suites |

The old words and facts do not survive in runtime modules, codecs, fixtures, or
tests. Their rationale and porting evidence belong only in
[`porting-policy.md`](porting-policy.md) and [`porting-inventory.md`](porting-inventory.md).

## Measurements

The measured pre-cut tree was `4,418 LOC` on 2026-08-04. The current working
tree is `6,737 LOC` of `src/` and `4,064 LOC` of tests on 2026-08-06. These are
raw working-tree measurements, not a quota; generated `build/` output and
dependencies are excluded. The confirmed tree is an ownership target, not a
line-count quota. No target number licenses filler. A smaller implementation
that keeps the same boundaries is preferred.

The current source tree matches every named contract, protocol, carrier, CLI,
Markdown, body, formatting, Verification, and process-runtime owner above.
`verification/` is concretely split into `plan.ts` and `producer.ts`, while
`runtime/proc/` currently has the single real implementation `run.ts`. There
is no open structural delta in the current Day1 source tree.

Use this draft to check three things during the cut:

1. Did behavior move to its confirmed owner rather than get copied?
2. Did the deletion remove a second authority or stale vocabulary?
3. Does each new file have a named reader, producer, or ownership boundary?
