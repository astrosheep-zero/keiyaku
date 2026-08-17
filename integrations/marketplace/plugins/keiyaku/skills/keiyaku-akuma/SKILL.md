---
name: keiyaku-akuma
description: Use when delegating work to, supervising, steering, inspecting, forking, or stopping a Keiyaku v4 Akuma.
---

# Keiyaku Akuma

An Akuma is a durable callable worker. Its complete identity is
`aku/<archetype>/<hex8>` — keep it; it is how you address the same worker
later. An Alias is a movable world-local selector usable wherever a direct id
is accepted; the identity underneath never changes.

## Start One

```bash
keiyaku -C <cwd> call <akuma-name> [--alias @name] [--wait <duration> | -d | --detach] [--json] (<prompt> | -)
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

## Archetypes

An Archetype is a Markdown file at `~/.keiyaku/akuma/<name>.md`. Its
frontmatter selects the provider and may declare `model`, `effort`,
`readonly`, `network`, and `description`; the body is an optional system
prompt, and an empty body keeps the harness default. Write a new one when no
existing file grants the permissions and stance the work needs; a worker never
outgrows its Archetype mid-life.

## Watch

```bash
keiyaku status                            # deep fleet observation
keiyaku status <aku/...|@alias>           # one worker's snapshot
keiyaku ls aku/                           # shallow catalog; also aku/<archetype>/ and "aku/*/*"
keiyaku wait <selector>... [--any | --all] [--timeout <duration>] [--json]
```

`wait` accepts complete ids, aliases, and Akuma globs, resolved once into a
stable deduplicated set. One member needs no mode; two or more require exactly
one of `--any` or `--all`. A timeout returns the current real snapshot — never
a fabricated timeout state — and `--any` leaves the unfinished members
running.

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
keiyaku history <aku/...|@alias> [--before <N> | --since <N>] [--limit <N>]
```

`--last` writes exactly the complete answer bytes of the latest answered turn
and says so plainly when no answer exists yet. Snapshot rows elsewhere may
clip long text; the terminal answer from `call`/`wait` and the bytes from
`--last` are never clipped — when you need the full result, take it from one
of those. Cursor reads page the activity timeline; `--before` and `--since`
are exclusive sequence cursors. `--limit` defaults to 50 and accepts at most
5000 semantic rows.

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
fabricating a fresh start. Take the `historyId` from `history` output; it must
name an answered turn.
