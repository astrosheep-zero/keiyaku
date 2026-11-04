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
are not rewritten or orphaned. Do not run old and new writers concurrently.

## What a contract looks like

````markdown
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
````

## What a deal looks like

```bash
keiyaku bind --gates reviewed,verified - < contract.md # terms written; an isolated worktree appears
keiyaku call worker -                                  # commission names Contract and appointed worktree
keiyaku verify <contract>                              # each declared check executes and attests independently
keiyaku deliver <contract>                             # delivered; existing evidence judges placement
keiyaku review <contract> --satisfied --summary -       # review attested; ready delivery can land
```

## Explicit Verification

Only `verify` executes a Contract's Verification declarations. Select `verified`
at bind or amendment to make them placement requirements; otherwise the section
is inert. Run verify from the appointed worktree, with the Contract selector
optional there:

```bash
keiyaku verify <contract>                        # execute all current declarations
keiyaku verify <contract> --index 2              # execute only the current second declaration
keiyaku verify --index 1 --include-dirty         # contextual Contract; explicitly capture local edits
keiyaku deliver <contract> --dry-run             # observe prospective evidence without execution
```

`--index` is a positive one-based position in the current document. Invalid syntax
is a usage error; an out-of-range position refuses before execution or admission.
Verify uses delivery's clean-worktree rule unless `--include-dirty` authorizes
capture. It prepares the exact prospective target integration without delivering
it; integration conflicts refuse without materializing a handoff. Evidence
produced before delivery applies when that delivery names the same integration
snapshot. A changed target or candidate needs evidence for its new snapshot.

Every declaration gets its own clean scratch, setup, and cleanup. Put a build or
other prerequisite in the same script as the check that needs it, or in setup;
separate fences cannot share generated files. Normal failure or timeout attests
only that requirement as unsatisfied, and full verify continues. Setup, spawn,
unknown-exit, or cancellation stops admit no verdict for the affected check;
previous admissions survive. Failed scenes are retained independently per
Contract and requirement, with diagnostic paths in the result.

All current requirements need current satisfied testimony to satisfy a gate.
A selected green check is only one check. Identity follows canonical executor,
script, and declared timeout, so reordering preserves evidence, editing one
check affects only that requirement, and exact duplicates share a requirement.
Removing a check removes its obligation while leaving its testimony in history.
Every verify invocation executes its selection again; an identical attestation
may reuse admission without skipping execution.

Delivery, review, preview, and dependent completion never execute Verification.
They consume existing evidence, leaving missing, stale, or unsatisfied
requirements pending. Verify can also complete an already-delivered Contract
when prerequisites and every gate pass. Pre-delivery verify records evidence
without placement. Review remains an independent obligation.

## What the journal records

Inspect durable facts and their requirement scope separately from live execution:

```bash
keiyaku history <contract>
keiyaku history <contract> --json
keiyaku status <contract>
keiyaku deliver <contract> --dry-run --json
```

Each terminal check records testimony for its gate, stable requirement, and exact
captured snapshot; there is no aggregate Verification attestation. A later
unsatisfied result supersedes earlier satisfaction only for the same requirement
and subject. Review testifies to the current document and candidate content.
Historical testimony stays readable even after its declaration is removed.

Status, preview, history, receipts, and JSON preserve each requirement's missing,
stale, satisfied, or unsatisfied evidence. Current declarations can use their
one-based positions; removed requirements keep their stable identities. Verify
receipts distinguish executed verdicts, new or reused admissions, operational
stops, retained scenes, and completion. Live observations identify the check and
snapshot but create no log store or replay authority.

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
attests every current requirement. `reviewed` and custom gates each have one
requirement; `verified` derives its requirements from distinct current
declarations. There is no separate aggregate gate attestation.

Verification runs only through explicit `verify`; delivery and review consume
existing evidence. Each check runs locally with the invoking process's Git and
process custody.

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

### Paseo provider

Configure a local, already-running Paseo server in settings.json:

```json
{
  "providers": {
    "paseo": {
      "kind": "paseo",
      "config": { "url": "ws://127.0.0.1:6767/ws", "provider": "claude" }
    }
  }
}
```

The native provider id is bare (`claude`, `codex`, `pi`), not provider/model.
Select it in an Akuma definition such as .keiyaku/akumas/paseo-worker.md:

```markdown
---
provider: paseo
model: <native-model-id>
effort: high
---
```

Model and effort must be offered by that native provider; effort is its native
thinking option id. Call with
`PASEO_PASSWORD=<password> keiyaku call paseo-worker "<prompt>"`.

- After a Paseo native reload or restart, call a fresh Akuma instead of resuming.
- `kill` and `--interrupt` control current execution session-wide and may affect
  concurrent human work. Normal completion only disconnects the client; it does
  not cancel later work or close the native runtime.
- Busy agents refuse new work, but steering can still race concurrent input.
- A dropped connection does not prove cancellation succeeded.

## Install

```bash
npm install -g @astrosheep/keiyaku
```

Pi's shipped extension provides native `akuma_*` tools through the public SDK,
plus the `/keiyaku` status overlay. The overlay still invokes `keiyaku` from
`PATH`; native tools do not. See [`plugins/pi/README.md`](plugins/pi/README.md)
for host lifetime and detached work.

Node ≥ 22.19. Product law lives in [`docs/`](docs/README.md).

## Source builds

Host integration sources live in `plugins/pi`, `plugins/claude`, `plugins/codex`,
and `plugins/opencode`. Shared skills live in `skills/`; the build copies them
into each host package so native installations are self-contained. The separate
`plugins/square` workspace is Keiyaku's internal Square observer, not a coding
harness plugin. Installation recipes and harness package metadata select the built
assets under `build/plugins` and `build/skills`, except the Pi package metadata,
which selects the TypeScript extension and `skills/`. Build a source checkout
before loading that extension so its package-root SDK is available; published
packages already include the SDK build.

Building from source also builds the Windows launcher with Zig 0.14.1 or later. Install
that system tool separately and make `zig` available on `PATH`, or set
`KEIYAKU_ZIG` to the selected executable. `npm ci` alone is not sufficient for
the Windows launcher: use `npm ci --ignore-scripts --prefer-offline` followed by
`npm run build` (or `npm test`). On non-Windows hosts, a missing or unusable
Zig skips only the Windows launcher so the rest of `npm run build` and `npm test`
can continue; Windows builds fail with an actionable diagnostic.
