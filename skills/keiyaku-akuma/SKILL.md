---
name: keiyaku-akuma
description: >-
  Use when the work involves `Akuma` or `Aku`, or when you want other hands on
  it: delegating a job, or fanning out research, checks, or other parallel
  work.
---

# Keiyaku Akuma

Use `Akumas` to delegate implementation, review, verification, or parallel
research.

## 1. Aliases And Operations (`spawn`, `tell`, `wait`, `ask`)

- **Give every worker an `@alias` at birth:** assign a role or lane alias when
  spawning an `Akuma` (`@deliverer`, `@reviewer`, `@scout`). Aliases make
  `status`, `wait`, `tell`, and `history` readable by role across
  parallel lanes; keep the underlying `aku/<name>/<id>` only when reassigning
  that `@alias` to a replacement worker. Spawning an akumaName name (`worker`,
  `review-akuma`) always spawns a new instance — address the existing `@alias`
  or `AkuId` with `tell` to continue with the same worker.
- **`spawn`, `tell`, and `wait`:** `spawn` observes birth and submission of
  optional first input. Ordinary `tell` confirms admission, not submission.
  Neither waits for an answer. Supervise with a separate
  `wait <aku/...|@name|kei/...>... --for <duration>`: it wakes on any
  settlement by default (or every selected member with `--all`), accepts mixed
  Contract and Akuma selectors, and a deadline never kills workers. A
  `kei/...` member waits for the `Contract`'s next journal change or terminal
  state.
- **Observe the exact input's answer:** use `tell --wait [<duration>]` for
  text. Use `ask` for a JSON Schema answer contract; `ask --wait <duration>`
  bounds that observation. Use a separate `wait` for worker-wide completion.
- **`tell` vs. interrupting `tell`:** `tell` queues steering instructions
  without blocking; request an interrupt only when the worker is on the wrong
  track and should yield its current attempt first.

## 2. Commissioning Context

- **Set both `Contract` association and working directory:** associating a
  `kei/...` records `Dispatch` for `status`, but neither sets the working
  directory nor injects `Contract` terms into the prompt. Point the working
  directory at the appointed worktree and write the `Contract` ID, worktree path,
  current `Arc`, and expected return in the prompt.
- **Request `report` on long tasks:** a worker can record mid-turn progress
  reports without stopping; inspect them in `history`.

## 3. Observing, Branching, And Automation

- **`kanshi`, `status`, and `history`:** `kanshi` shows the `World` board;
  `status <aku/...|kei/...|@name>` observes one identity, with current work and
  file-change summary for an Akuma. Plural and category status are refused.
  `history` reads bounded timeline entries; `--before`, `--since`, and `--limit`
  page either Contract or Akuma history. Copy a decimal row address to `--id` for
  a complete Contract record or Akuma activity, or an Akuma `turn/N` or `report/N`
  address for that retained item. `--answer` returns the latest retained answered
  Turn as raw bytes; JSON also carries its exact Turn coordinate.
- **`ls`, `fork`, and `kill`:** `ls` lists akumaNames (`aku/`), recent
  instances with life and associations (`"aku/*/*"`), or your own call tree;
  `fork` branches a new `Akuma`
  from an answered `turn/N`; `kill` stops active work while keeping history.
- **JavaScript orchestration:** for multi-agent tournaments, adversarial claim
  checking, or custom concurrency control in code, read
  [Automation With The `Akuma` API](references/automation.md).
