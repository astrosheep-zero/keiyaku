# Keiyaku

**Keiyaku is not designed for you, but for your frontier model.**

**Current world:** frontier models are formidable — and expensive. Cheap
models work fine, but they drift, and they always report success. And
human attention is the scarcest of the three.

So Keiyaku gives each of the three the right job.

**The frontier gets an exoskeleton, not a cage.** It breaks goals apart,
authors explicit contracts, commands a fleet in parallel. Its limited
context goes to decision-grade signal — the state of every contract,
never individual workers. A worker can drift, stall, or lie; a contract
cannot.

**The workers get contracts, not trust.** Terms in bytes before the
first edit; every delivery judged mechanically against the diff.
Whatever drifted or lied never reaches the board.

**You step back.** Delegate when possible — by default, everything goes
to the frontier; the verbs are its to type. Steer when necessary — the
top was never handed over. The wheel stays yours.

---

## What a contract looks like

```markdown
# Ship typed Task query

## Context
Task reads scan documents ad hoc.

## Objective
One typed query surface over the whole board.

## Design
A single evaluator over persisted facts.

## Region
```
src/task/**
tests/task-*.test.ts
```

## Criteria
### Query is typed
The CLI parses a predicate; the evaluator never sees a raw shell string.

### Reads stay Task-owned
Query reads only Task facts. No Contract. No Akuma.

## Verification
```bash timeout=2m
npm test
```
```

## What a deal looks like

```bash
keiyaku bind - < contract.md                        # terms written; an isolated worktree appears
keiyaku call worker -                               # a worker goes in
keiyaku deliver <contract>                          # delivered; Verification runs; gates judge
keiyaku review <contract> --satisfied --summary -   # attested; main moves with a commit receipt
```

## What the journal records

One real deal, read back with `keiyaku history`:

```text
history  kei/ship-typed-task-query-b186 · accepted · 9 entries

2026-10-04

16:53 bound to targetless @ 3c5d8c0 · gate review
16:53 delivered 210eeed · ✓ verification · 10 lines
16:53 × review · 6 lines
16:53 delivered aebef87 · ✓ verification · 10 lines
16:53 ✓ review · 6 lines
16:53 accepted
```

The review said no, and the deal did not land. The verdict and its reason
stay on the journal as bytes — `keiyaku history --json` reads them:

```json
{
  "kind": "attestation",
  "contract": "kei/ship-typed-task-query-b186",
  "data": {
    "gate": "reviewed",
    "verdict": "unsatisfied",
    "summary": "Query evaluator still reaches for Contract facts; reads are not Task-owned."
  }
}
```

## The board

`keiyaku status` is the one screen. Two Contracts and two Tasks in flight:

```text
CONTRACTS // recent

⧗ kei/ship-typed-task-query-c898 · 1s · Ship typed Task query
  [✓] delivery  [ ] review
⧗ kei/tighten-receipt-vocabulary-4a70 · 18s · Tighten receipt vocabulary
  [ ] delivery  [ ] review

TASKS // recent

○ task/regenerate-readme-from-real-010b · ready · P1 · Regenerate README from real output
○ task/align-task-cli-truth-promises-3af5 · ready · P0 · Align Task CLI truth promises
```

Marks accelerate scanning; the words carry the state.

## The worker

```markdown
---
provider: pi
model: kimi-coding/k3-256k
description: Repository implementation agent
---
Make scoped changes and run relevant tests.
```

One Markdown file, one worker. `keiyaku call worker` summons it.

## Install

```bash
npm install -g @astrosheep/keiyaku
```

Node ≥ 22.19. Product law lives in [`docs/`](docs/README.md).

## Source builds

Building from source also builds the Windows launcher with Zig 0.14.1 or later. Install
that system tool separately and make `zig` available on `PATH`, or set
`KEIYAKU_ZIG` to the selected executable. `npm ci` alone is not sufficient for
the Windows launcher: use `npm ci --ignore-scripts --prefer-offline` followed by
`npm run build` (or `npm test`). On non-Windows hosts, a missing or unusable
Zig skips only the Windows launcher so the rest of `npm run build` and `npm test`
can continue; Windows builds fail with an actionable diagnostic.
