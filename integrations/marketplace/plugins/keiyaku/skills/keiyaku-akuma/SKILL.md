---
name: keiyaku-akuma
description: Use when delegating work to, supervising, steering, inspecting, forking, or stopping a Keiyaku v4 Akuma.
---

# Keiyaku Akuma

An Akuma is a durable callable worker projection. Its complete id is
`aku/<persona>/<hex8>`; keep that id for recovery. A Contract association is
opaque evidence at this boundary, not Akuma lifecycle authority.

## Choose A Verb

```bash
keiyaku-v4 call --persona <name> -
keiyaku-v4 wait <aku/...> [--timeout <duration>]
keiyaku-v4 tell <aku/...> -
keiyaku-v4 interrupt <aku/...> -
keiyaku-v4 history <aku/...>
keiyaku-v4 fork <aku/...> --at <historyId>
keiyaku-v4 kill <aku/...>
```

`call` starts from a Persona and requires a final stdin body. `tell` continues
the same projection, including after it has answered. `fork` starts a child
from one exact retained answered-turn coordinate and leaves the source alone.
`interrupt` puts down the current body synchronously, then records the tell;
it is not terminal kill. `kill` records death and returns typed physical
evidence.

## Observe

```bash
keiyaku-v4 status
keiyaku-v4 status <aku/...>
keiyaku-v4 wait <aku/...> --timeout 5m
keiyaku-v4 history <aku/...> --before <index>
keiyaku-v4 history <aku/...> --since <index>
keiyaku-v4 history <aku/...> --last
```

Bare `status` shows the compact fleet. Exact `status <aku/...>` and `wait`
share the public status carrier; a wait timeout returns the current snapshot,
not a fabricated timeout state. History cursors are persistent activity
sequences and `--before`/`--since` are exclusive. `--last` writes only the
complete answer bytes. Use `--json` when a script needs the typed values.

Read the exact command help for duration syntax and provider-specific Persona
configuration. Do not use old `follow`, plural wait, `--after`, `--at` index,
or `--detach` forms; they are not v4 root commands.
