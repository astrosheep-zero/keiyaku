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
```bash
npm test
```
```

## What a deal looks like

```bash
keiyaku bind - < keiyaku.md     # terms written; an isolated worktree appears
keiyaku call worker -           # a worker goes in
keiyaku deliver                 # tendered; Verification runs; gates judge
keiyaku review --satisfied      # attested; main moves with a commit receipt
```

## What the journal records

One real deal, pulled from this repo's own journal:

```text
$ keiyaku audit kei/add-acp-provider-and-grok-build-profile

accepted audit kei/add-acp-provider-and-grok-build-profile head=0508f7eb9cb738bcab06060b13ff1a96d36e3754
report {"reworks":1,"reviews":2,"timeline":[
  {"kind":"bind","at":"2026-08-14T08:18:36.224Z"},
  {"kind":"deliver","at":"2026-08-14T13:02:08.339Z"},
  {"kind":"attestation","gate":"reviewed","verdict":"unsatisfied","summary":
   "Implementation review found no blocking code issues; authenticated official
    Grok smoke remains unavailable because this host has no grok binary."},
  {"kind":"attestation","gate":"verified","verdict":"satisfied","summary":"[1 bash exit 0] …"}]}
```

The review said no — with a reason, in bytes, on the journal. The deal
did not land until the gates had current evidence.

## The board

`keiyaku status` is the one screen. A slice of this repository, right now:

```text
kanshi ─ 7 keiyaku · 18 akuma · 286 task ─ /Users/astrosheep/Developer/keiyaku-v4 main 9cfdca6017633e51827b9b2eba3c76a7fe08e05f

keiyaku 7
⧗ kei/add-acp-provider-and-grok-build-profile pending-delivery
  worktree · integration c5cafef6 · -> refs/heads/main
  ! reviewed
⧗ kei/align-task-cli-truth-promises waiting
  ? reviewed
  held by task/align-task-cli-truth-promises-for-ready-compose

akuma 18
● aku/expert-akuma/a7aafc9e running
  alias @process-custody-lead
  keiyaku kei/make-process-custody-capability-honest (active)
○ aku/design-akuma/cc53ef08 asleep
  alias @timeline-design
? aku/grok/95d90b7d stranded
  alias @acp-provider-impl

task 8 · 5 ready · 2 held
● task/align-task-cli-truth-promises-for-ready-compose in_progress
  Align Task CLI truth promises for ready compose and world absence
  P0 · keiyaku kei/align-task-cli-truth-promises (active)
```

Marks accelerate scanning; the words carry the state.

## The worker

```markdown
---
provider: claude-agent-sdk
model: claude-sonnet-4-5
access: write
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
