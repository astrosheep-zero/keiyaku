---
name: keiyaku-akuma
description: >-
  Use when the work involves Akuma or Aku, or when you want other hands on
  it: delegating a job, or fanning out research, checks, or other parallel
  work.
---

# Keiyaku Akuma

Use Akumas to delegate work to another worker. `call` creates a new Akuma;
`tell` admits a Tell for an existing Akuma; `ask` admits one and observes its
exact answer. Keep the complete AkuId, such as `aku/worker/1234abcd`, when you
need to address the same worker later. An alias such as `@reviewer` is a
shorter, world-local name.

## Call a new Akuma

```bash
keiyaku call worker "Summarize the recent changes in src/cli"
keiyaku call worker --alias @reviewer --wait 10m - < brief.md
keiyaku call worker
```

The prompt is optional for prompt-free birth. Otherwise it is the new Akuma's
first prompt: give it as one argument, or use `-` to read stdin, never both.
Calls are detached by default: they return the new identity after birth without
waiting for the first answer. Use explicit `--wait <duration>` when this
invocation should block while observing that initial work. `--wait` only bounds
this command; it never stops the Akuma. Read `call --help` for flag syntax,
defaults, and action vocabulary.
To hand a Contract role to an Akuma, use the grant table in `keiyaku-workflow`.

The selected Akuma name is a reusable worker configuration, not an individual.
Calling it again creates an independent Akuma. Use different names for
capabilities, not merely for parallelism.

## Commission Context

`--contract` only records the association. It does not tell the Akuma the
Contract or worktree. Put them in the prompt explicitly:

```bash
keiyaku call worker --contract kei/add-rate-limit-a1b2 --workdir /path/to/worktree - <<'EOF'
Contract: kei/add-rate-limit-a1b2
Worktree: /path/to/worktree
This Arc: implement the limiter and its tests
EOF
```

`--contract` does not choose a worktree. Use `--workdir <path>` when needed.

## Tell or ask an existing Akuma

```bash
keiyaku tell @reviewer "The candidate moved; re-examine the worktree"
keiyaku tell @reviewer --interrupt - < new-priority.md
keiyaku ask @reviewer --wait 10m "What is your verdict?"
keiyaku ask @reviewer --schema verdict.schema.json - < question.md
```

`tell` admits the next instruction and returns its admission receipt; it does
not await an answer. `ask` admits a Tell and observes that exact answer,
unbounded unless `--wait` limits observation. Both require a prompt and accept
`--interrupt` to put down current work before admitting the new Tell. Schema
belongs only to `ask`; `tell --schema` and `tell --wait` refuse and point to
`ask`. A deadline never withdraws an admitted Tell. Read `tell --help` and
`ask --help` for the complete flag grammar.

## Observe work

```bash
keiyaku wait @deliverer @reviewer
keiyaku wait --all --timeout 30m @deliverer @reviewer
```

Use `wait` for one or more existing Akumas. The default is `--any`; use
`--all` for every selected Akuma. `--timeout` limits observation and does not
stop workers. A completed Akuma already counts, so repeating a wait can return
immediately. See `wait --help` for the complete grammar. Unlike `ask`, `wait`
observes existing Akuma-wide work, not the answer to a newly admitted Tell.

## Inspect and retrieve results

```bash
keiyaku status
keiyaku status @reviewer
keiyaku ls aku/
keiyaku ls "aku/*/*"
keiyaku ls --mine
keiyaku history @reviewer --last
keiyaku history @reviewer --id turn/3
```

`status` shows the roster or one Akuma's workdir and effective actions.
`ls aku/` shows callable names; `ls "aku/*/*"` shows born workers.
`ls --mine` narrows that roster to Akumas this process's caller called and their
transitive descendants in this World; `--caller <integration>:<id>` or
`--caller aku/<name>/<suffix>` names the same selection explicitly. Descendant
rows show their immediate caller as `· by <akuId>`. The selection is World-local
and refuses for Contract, Debt, and Akuma-name catalogues.
`history --last` reads the latest complete answer; `history --id` reads an
exact result named by status or wait. Use the complete AkuId when an alias may
move; see `history --help` for paging.

## Stop and branch

```bash
keiyaku kill @reviewer
keiyaku fork @reviewer --at turn/3
```

`kill` stops current work without admitting a Tell, deleting the Akuma, or
removing its history. `fork` creates a new Akuma from one exact retained
answered history point; the source is unchanged, and providers that cannot
fork report that refusal. See `kill --help` and `fork --help` for the
complete grammar.

## JavaScript automation

Use [Automation With The Akuma API](references/automation.md) for a
debt-specific JavaScript coordinator, structured answers, or multi-worker
orchestration. The CLI is enough for one commission and its return. A
prompt-free birth followed by one input-bound ask uses the same identity:

```ts
import { Akuma, Akumas, World } from "@astrosheep/keiyaku";

const root = await World.at(process.cwd());
const called = await Akumas.of(root).call({ archetype: "worker" });
const worker = Akuma.select(root, called.akuma);
const result = await worker.ask("Inspect the change");
console.log(result.observation);
```

The automation guide covers schema-based answer handling and longer workflows.
