---
name: keiyaku-akuma
description: >-
  Calling an Akuma: delegate work to a new or existing worker, then observe,
  guide, and collect the result.
---

# Keiyaku Akuma

Use Akumas to delegate work to another worker. `call` creates a new Akuma;
`tell` gives an existing Akuma another prompt. Keep the complete AkuId, such
as `aku/worker/1234abcd`, when you need to address the same worker later. An
alias such as `@reviewer` is a shorter, world-local name.

## Call a new Akuma

```bash
keiyaku -C <cwd> call <akuma-name> [--contract <kei/...>] [--workdir <path>] [--alias @name] [--allowed <product.action>]... [--schema <file>] [--wait <duration>] (<prompt> | -)
```

The prompt is the new Akuma's first prompt. Give it as one argument, or use
`-` to read stdin, never both. Calls are detached by default: they return the
new identity after birth without waiting for the first answer. Use explicit
`--wait <duration>` when this invocation should block while observing that
initial work. `--wait` only bounds this command; it never stops the Akuma.

Useful options:

- `--alias @name` assigns a reusable world-local selector; an existing alias moves to this Akuma.
- `--contract <kei/...>` associates the Akuma with a Contract.
- `--workdir <path>` chooses its execution directory.
- `--allowed <product.action>` adds actions subject to the Akuma's restrictions.
- `--schema <file>` requests a structured answer described by a JSON Schema.

The selected Akuma name is a reusable worker configuration, not an individual.
Calling it again creates an independent Akuma. Use different names for
capabilities, not merely for parallelism.

## Public-library core example

```ts
const akuma = await Akuma.birth({ path, archetype: "worker" });
const answer = await akuma.tell("Inspect the change");
console.log(answer);
```

## Commission Context

`--contract` only records the association. It does not tell the Akuma the
Contract or worktree. Put them in the prompt explicitly:

```text
Contract: <kei/...>
Worktree: <exact path>
This Arc: <what to do>
```

`--contract` does not choose a worktree. Use `--workdir <path>` when needed.

## Tell an existing Akuma

```bash
keiyaku tell <aku/...|@alias> [--interrupt] [--schema <file>] [--wait <duration>] (<prompt> | -)
```

Use `tell` for the next instruction. Plain `tell` lets current work continue;
`--interrupt` asks the current Body to yield before the new prompt is handled.
Use `--wait <duration>` to wait for this Tell's answer. An admitted Tell is
not withdrawn when the wait ends. Use `--schema` when the answer must follow a
JSON Schema.

## Observe work

```bash
keiyaku wait <selector>... [--any | --all] [--timeout <duration>]
```

Use `wait` for one or more existing Akumas. The default is `--any`; use
`--all` for every selected Akuma. `--timeout` limits observation and does not
stop workers. A completed Akuma already counts, so repeating a wait can return
immediately.

The three waiting forms have distinct subjects:

```text
call --wait   create an Akuma and observe its initial work
tell --wait   deliver a Tell and observe that Tell's answer
wait          observe existing Akumas
```

## Inspect and retrieve results

```bash
keiyaku status                         # current Akuma fleet
keiyaku status <aku/...|@alias>        # one Akuma
keiyaku ls aku/                        # names available to call
keiyaku ls aku/<akuma>/                # existing workers from one name
keiyaku ls "aku/*/*"                   # existing workers across names
keiyaku history <aku/...|@alias> --last
keiyaku history <aku/...|@alias> --id <historyId>
keiyaku history <aku/...|@alias> [--before <N> | --since <N>] [--limit <N>]
```

Use `history --last` for the latest complete answer. Use `--id` for one exact
answered result named by a status, wait, or history result. Use the complete
AkuId when an alias may move.

## Stop and branch

```bash
keiyaku kill <selector>...
keiyaku fork <aku/...|@alias> --at <historyId> [--alias @name]
```

`kill` stops current work without deleting the Akuma or its history. `fork`
creates a new Akuma from one exact retained answered history point; the source
is unchanged, and providers that cannot fork report that refusal.

## JavaScript automation

For a task-specific JavaScript program that coordinates Akumas, read
[Automation With The Akuma API](references/automation.md). `Akuma.birth`
creates an Akuma without a prompt; call `tell` on the returned handle to give
it its first prompt. Use `idle()` when a script must wait before sending
another schema Tell, and keep AkuIds in the script's own results.
