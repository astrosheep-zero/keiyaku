---
name: keiyaku-akuma
description: Use when delegating work to, supervising, steering, inspecting, forking, or stopping a Keiyaku v4 Akuma.
---

# Keiyaku Akuma

An Akuma is a durable callable worker projection. Its complete id is
`aku/<archetype>/<hex8>`; keep that id for recovery.

## Choose A Verb

```bash
keiyaku -C <repo> call <akuma> [--contract <kei/...>] [--alias @name] [--workdir <path>] [--wait [--timeout <duration>] | -d | --detach] [--json] -
keiyaku -C <repo> wait <aku/...> [--timeout <duration>]
keiyaku -C <repo> tell <aku/...> -
keiyaku -C <repo> tell <aku/...> --interrupt -
keiyaku -C <repo> history <aku/...>
keiyaku -C <repo> fork <aku/...> --at <historyId>
keiyaku -C <repo> kill <aku/...>
```

`call` starts from an Archetype, requires a final stdin body, and waits up to
five minutes by default. Use `-d` or `--detach` to return after birth. `tell` continues
the same projection, including after it has answered. `fork` starts a child
from one exact retained answered-turn coordinate and leaves the source alone.
`tell --interrupt` puts down the current Body synchronously, then records the
Tell for its successor. `kill` stops the current Body while preserving the
Akuma's Heart, session, history, pending Tells, and Body Requests; a later Tell
wakes the same Akuma.

## Observe

```bash
keiyaku -C <repo> status
keiyaku -C <repo> status <aku/...>
keiyaku -C <repo> wait <aku/...> --timeout 5m
keiyaku -C <repo> history <aku/...> --before <index>
keiyaku -C <repo> history <aku/...> --since <index>
keiyaku -C <repo> history <aku/...> --last
```

Bare `status` shows the compact fleet. Exact `status <aku/...>` and `wait`
share the public status carrier; a wait timeout returns the current snapshot,
not a fabricated timeout state. History cursors are persistent activity
sequences and `--before`/`--since` are exclusive. `--last` writes only the
complete answer bytes. Use `--json` when a script needs the typed values.

Read the exact command help for duration syntax and provider-specific Archetype
configuration. Do not use old `follow`, plural wait, `--after`, or `--at`
index forms; they are not root commands.
