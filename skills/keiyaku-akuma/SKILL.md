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

`--contract` only records the association. It neither tells the Akuma about the
Contract nor picks its worktree: pass `--workdir`, and put both in the prompt.

```bash
keiyaku call worker --contract kei/add-rate-limit-a1b2 --workdir /path/to/worktree - <<'EOF'
Contract: kei/add-rate-limit-a1b2
Worktree: /path/to/worktree
This Arc: implement the limiter and its tests
EOF
```

An Akuma can `keiyaku report` to you mid-turn without stopping. For long work,
ask for it in the prompt (e.g. "report each milestone or blocker"); reports
show up in its `history`.

## Tell or ask an existing Akuma

```bash
keiyaku tell @reviewer "The candidate moved; re-examine the worktree"
keiyaku tell @reviewer --interrupt - < new-priority.md
keiyaku ask @reviewer --wait 10m "What is your verdict?"
keiyaku ask @reviewer --schema verdict.schema.json - < question.md
```

`tell` queues the next instruction and returns without waiting for an answer.
`ask` queues it and waits for that exact answer, bounded by `--wait`.
`--interrupt` admits the Tell and asks current work to yield; the Tell remains
admitted even if yielding cannot be confirmed. A deadline never withdraws it.
Only `ask` takes `--schema`. Read `tell --help` and `ask --help` for syntax.

## Observe work

```bash
keiyaku wait @deliverer @reviewer
keiyaku wait --all --timeout 30m @deliverer @reviewer
```

`wait` returns when any selected Akuma finishes (`--all`: every one). `--timeout`
ends the wait, not the workers. An already finished Akuma counts immediately.
Unlike `ask`, this observes existing work, not a newly submitted instruction.

`keiyaku wait kei/...` instead waits for the named Contract's next journal
change, even without a dispatched Akuma. Each invocation starts at the current
head; a terminal Contract does not count as a new change by itself. Use
`--all` to wait for every selected Contract, and do not mix Contract and Akuma
selectors in one wait. `kill kei/...` still selects the associated Akumas.

## Inspect and retrieve results

```bash
keiyaku whoami
keiyaku status
keiyaku status @reviewer
keiyaku ls aku/
keiyaku ls "aku/*/*"
keiyaku ls --mine
keiyaku history @reviewer --last
keiyaku history @reviewer --id turn/3
```

- `whoami`: who you are; for an Akuma, also who started its current turn.
- `status [<aku>]`: the roster, or one Akuma's state and workdir. `--json` shows `allowed`.
- `ls aku/`: callable names. `ls "aku/*/*"`: recent instances.
  `ls --mine`: Akumas you called, plus their descendants in this World.
  `--caller` selects another caller; see `ls --help`.
- `history <aku> --last`: latest answer. `--id turn/N`: one exact turn's
  answer or failure diagnostic (ids are in `history <aku> --json`).
  Keep the complete AkuId if an alias may move.

## Retention

Akumas idle for more than fifteen days may be cleaned up after a later
successful `call` or `fork`. Running Akumas, alias targets, and Akumas
dispatched to an open Contract are kept, and nothing is killed. Read-only
commands and `tell`/`ask`/`wait` never trigger cleanup.

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
job-specific JavaScript coordinator, structured answers, or multi-worker
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
