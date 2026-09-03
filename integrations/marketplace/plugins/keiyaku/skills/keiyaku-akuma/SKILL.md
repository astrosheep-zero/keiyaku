---
name: keiyaku-akuma
description: Use when delegating work to, supervising, steering, inspecting, forking, or stopping a Keiyaku v4 Akuma.
---

# Keiyaku Akuma

An Akuma is a durable callable worker. Its complete identity is
`aku/<akuma>/<hex8>` — keep it; it is how you address the same worker
later. An Alias is a movable world-local selector usable wherever a direct id
is accepted; the identity underneath never changes.

## Start One

```bash
keiyaku -C <cwd> call <akuma-name> [--alias @name] [--readonly] [--allowed <product.action>]... [--schema <file>] [--wait <duration> | -d | --detach] [--json] (<prompt> | -)
```

Give the worker's initial prompt as one argument (quote it when it contains
spaces), or use final `-` to read it from stdin. These forms are mutually
exclusive. Decide up front whether you will stay:

- The default observes up to five minutes and writes the complete answer when
  it arrives inside that window. `--wait <duration>` replaces that window.
- `-d` / `--detach` returns right after birth with the AkuId. Use it when the
  work outlives your attention; come back with `wait`.

`--alias @name` assigns that world-local selector to the born Akuma. If the
Alias already points elsewhere, it moves to the born Akuma. The worker's
execution cwd is exactly `-C <path>`, or your own cwd when `-C` is omitted.

Repeated `--allowed` values add actions to the selected Akuma's defaults. A
nested call can use only actions permitted by its direct parent Soul.

## Akuma Names

An Akuma name selects a Markdown file at `~/.keiyaku/akuma/<name>.md`; pass
the filename without `.md` as `<akuma-name>`. Its frontmatter selects the
provider and may declare `model`, `effort`, `readonly`, `network`, and
`description`; the body is an optional system prompt, and an empty body keeps
the harness default. If none grants the permissions and stance the work needs,
add a new Akuma name. A born Akuma keeps its selected defaults for its lifetime.

## Commission And Steer

A call assembles a commission from independent inputs: the selected Akuma fixes
capability stance for the identity's whole life; the `--contract` Dispatch
associates standing terms; allowed actions set what the callee may do, subject
to that Akuma's restrictions and the parent Soul's ceiling; the prompt carries
the question. None of these implies another — association is not a seat, forwarded
actions are not a seat, and no combination mints a role.

The prompt and every later tell genuinely direct the callee's work: they choose
the subject, scope, depth, risks, and deliverable of the round. They spend
decisions already made and ask questions still open; they never change the
Dispatch, the journal, or what counts as acceptance, and an expectation stated
in a prompt is never evidence for the callee's own findings.

A commission can be as large as a whole Contract's fulfillment loop: call one
Aku with the Contract association, forward the actions the loop needs —
including nested calls, which stay under this Soul's ceiling — and state the
loop as the question. Steering that delegation afterwards goes to the holder,
not around it.

## Watch

```bash
keiyaku status                            # deep fleet observation
keiyaku status <aku/...|@alias>           # one worker's snapshot
keiyaku ls aku/                           # shallow catalog; also aku/<akuma>/ and "aku/*/*"
keiyaku wait <selector>... [--any | --all] [--timeout <duration>]
```

`wait` accepts complete ids, aliases, and Akuma globs. Wait on one Akuma without
a mode. When observing multiple Akuma, prefer one plural wait over separate
waits and choose exactly one mode:

```bash
keiyaku -C <cwd> wait @worker-a --timeout 5m
keiyaku -C <cwd> wait @worker-a @worker-b --all --timeout 5m
keiyaku -C <cwd> wait @worker-a @worker-b --any --timeout 5m
```

`--all` waits until every selected Akuma stops running. `--any` returns when the
first one stops and leaves the others alone. When the timeout expires, `wait`
returns their current status without stopping them.

## Steer

```bash
keiyaku tell <aku/...|@alias> (<prompt> | -)
keiyaku tell <aku/...|@alias> --interrupt (<prompt> | -)
```

Give `tell` one prompt argument (quote it when it contains spaces) or final `-`
for stdin, never both.
`tell` continues the same worker: it steers a live Body in place, or — when
none is running, including after an answer — records the message durably and
wakes a successor. `tell --interrupt` puts down the current Body synchronously
first, then hands the message to the successor; it is not a kill. Choose plain
`tell` when the current attempt should finish with your guidance folded in;
choose `--interrupt` when the current attempt itself is the problem.

## Take The Answer

```bash
keiyaku history <aku/...|@alias> --last
keiyaku history <aku/...|@alias> --id <historyId>
keiyaku history <aku/...|@alias> [--before <N> | --since <N>] [--limit <N>]
```

`--last` writes exactly the complete answer bytes of the latest answered turn
and says so plainly when no answer exists yet. Snapshot rows elsewhere may
clip long text; the terminal answer from `call`/`wait` and the bytes from
`--last` are never clipped — when you need the full result, take it from one
of those. Every completed answered or failed outcome carries one Heart-owned
public `historyId` shaped as `turn/<positive-safe-integer>` in `status`, `wait`,
and history output. Use `--id` with that same value to read exactly one retained
outcome: text writes the complete answer or diagnostic bytes without clipping
or framing. Provider-native history coordinates remain private. A malformed or
unknown ID is a typed nonzero refusal. `--id` is mutually exclusive with
`--last`, `--before`, `--since`, and `--limit`.

Cursor reads page the activity timeline; `--before` and `--since` are exclusive
sequence cursors. `--limit` defaults to 50 and accepts at most 5000 semantic
rows.

## Stop

```bash
keiyaku kill <selector>...
```

`kill` accepts the same id, alias, and glob selectors as `wait`. It stops the
current Body and records that it did; everything else survives — Heart,
session, history, pending Tells, and Body Requests — so a later `tell` wakes
the same worker where it left off. Killing pauses a worker; nothing is
deleted.

## Branch

```bash
keiyaku fork <aku/...|@alias> --at <historyId> [--alias @name]
```

`fork` starts a child from one exact retained answered-turn coordinate and
leaves the source untouched. It is a provider capability, not a guarantee:
when the provider cannot fork from that turn, the command refuses rather than
fabricating a fresh start. Pass the same public `historyId` exposed by status,
wait, or history; Heart privately resolves the provider coordinate. The ID must
name an answered outcome with a provider fork point. Failed outcomes are not
forkable.
