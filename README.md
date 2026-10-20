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

## Debt, not a todo list

`keiyaku debt` records confirmed, unresolved problems and requests. Dependencies
and the derived `ready` / `blocked` views remain; execution progress and plan
composition do not. A debt is `open`, `done`, or `drop`. Contract acceptance can
settle an associated debt automatically.

This replaces the former `task` CLI and `Tasks` API; use `debt` and `Debts`.
For an existing board, stop ledger writers and run the offline upgrade from a
source checkout:

```bash
node scripts/migrate-task-board.mjs /absolute/path/to/world
```

It moves `.keiyaku/tasks` to `.keiyaku/debts`, rewrites identity and relationship
prefixes, and returns old progress states to `open`. Local IDs, namespaces,
testimony and timestamps are unchanged. Original bytes remain in
`.keiyaku/tasks.pre-debt`; an existing destination or backup is refused. Reads
of an unmigrated board fail explicitly instead of reporting an empty ledger.
If an interrupted upgrade leaves only the backup, restore that directory to
`.keiyaku/tasks` before retrying. Contract journals and existing holder records
are not rewritten or orphaned. Existing Soul permissions retain their surviving
capabilities; update any explicit Archetype `allowed` configuration to the
`debt.*` vocabulary. Do not run old and new writers concurrently.

## What a contract looks like

```markdown
# Ship typed Debt query

## Context
Debt reads scan documents ad hoc.

## Objective
One typed query surface over the whole board.

## Design
A single evaluator over persisted facts.

## Region
```
src/debt/**
tests/debt-*.test.ts
```

## Criteria
### Query is typed
The CLI parses a predicate; the evaluator never sees a raw shell string.

### Reads stay Debt-owned
Query reads only Debt facts. No Contract. No Akuma.

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
history  kei/ship-typed-debt-query-b186 · accepted · 9 entries

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
  "contract": "kei/ship-typed-debt-query-b186",
  "data": {
    "gate": "reviewed",
    "verdict": "unsatisfied",
    "summary": "Query evaluator still reaches for Contract facts; reads are not Debt-owned."
  }
}
```

## The board

`keiyaku status` is the one screen. Two Contracts and two Debts in flight:

```text
CONTRACTS // recent

⧗ kei/ship-typed-debt-query-c898 · 1s · Ship typed Debt query
  [✓] delivery  [ ] review
⧗ kei/tighten-receipt-vocabulary-4a70 · 18s · Tighten receipt vocabulary
  [ ] delivery  [ ] review

DEBTS // recent

○ debt/regenerate-readme-from-real-010b · ready · P1 · Regenerate README from real output
○ debt/align-debt-cli-truth-promises-3af5 · ready · P0 · Align Debt CLI truth promises
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

## Configuration

Settings are JSON at two addresses: `~/.keiyaku/settings.json` for the user,
`.keiyaku/settings.json` in the project. A project record
wholly shadows the same-name user record. There is no write command; edit the
files directly and inspect the merged, provenance-annotated view with
`keiyaku settings`.

Named gate groups provide reusable gate sets. Bind and amend select them with
`--gates`; the `default` group applies when binding with `--gates` omitted.
Amending without `--gates` keeps the existing gates:

```json
{
  "gates": {
    "default": { "kind": "bundle", "gates": ["reviewed"] },
    "strict": { "kind": "bundle", "gates": ["reviewed", "verified"] }
  }
}
```

Selections accept the built-in names `reviewed` and `verified`, or configured
group names. Unknown names are rejected with the known names listed. Custom gates
must be declared inside a configured group; they stay unsatisfied until a producer
attests them.

Worktree hooks run commands when a Contract's managed worktree is created or
destroyed — dependency installs are the usual suspect:

```json
{
  "worktree": {
    "create": [
      { "name": "install", "argv": ["npm", "ci", "--ignore-scripts", "--prefer-offline"], "timeoutMs": 300000 }
    ],
    "destroy": [
      { "name": "teardown", "argv": ["docker", "compose", "down", "-v"], "timeoutMs": 60000 }
    ]
  }
}
```

Hooks run as one ordered phase inside the worktree and must be replay-safe: a
retry reruns the phase from its beginning. Create hooks prepare the worktree;
destroy hooks release external resources the worktree deletion alone cannot.
A failing hook retains the worktree
and reports lag; it never abandons the Contract. `keiyaku settings --help`
lists every recognized namespace.

## Install

```bash
npm install -g @astrosheep/keiyaku
```

Pi loads the extension from the package source and invokes the `keiyaku` CLI from `PATH`, so Pi users must have that command installed and available in the host environment.

Node ≥ 22.19. Product law lives in [`docs/`](docs/README.md).

## Source builds

Host integration sources live in `plugins/pi`, `plugins/claude`, `plugins/codex`,
and `plugins/opencode`. Shared skills live in `skills/`; the build copies them
into each host package so native installations are self-contained. The separate
`plugins/square` workspace is Keiyaku's internal Square observer, not a coding
harness plugin. Installation recipes and harness package metadata select the built
assets under `build/plugins` and `build/skills`, except the Pi package metadata,
which selects the source extension and `skills/` so a source checkout is loadable
without a build.

Building from source also builds the Windows launcher with Zig 0.14.1 or later. Install
that system tool separately and make `zig` available on `PATH`, or set
`KEIYAKU_ZIG` to the selected executable. `npm ci` alone is not sufficient for
the Windows launcher: use `npm ci --ignore-scripts --prefer-offline` followed by
`npm run build` (or `npm test`). On non-Windows hosts, a missing or unusable
Zig skips only the Windows launcher so the rest of `npm run build` and `npm test`
can continue; Windows builds fail with an actionable diagnostic.
