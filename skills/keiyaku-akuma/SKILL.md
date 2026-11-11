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

## 1. Aliases And Operations (`spawn`, `tell`, `wait`)

- **Give every worker an `@alias` at birth:** assign a role or lane alias when
  spawning an `Akuma` (`@deliverer`, `@reviewer`, `@scout`). Aliases make
  `status`, `wait`, `tell`, and `history` readable by role across
  parallel lanes; keep the underlying `aku/<name>/<id>` only when reassigning
  that `@alias` to a replacement worker. Spawning an archetype name (`worker`,
  `review-akuma`) always spawns a new instance — address the existing `@alias`
  or `AkuId` with `tell` to continue with the same worker.
- **Detached `spawn` + `wait` for real work:** launch workers detached, then
  supervise them together with `wait` (wakes on any settlement by default, or
  all; a wait deadline never kills workers). `wait` on `kei/...` waits for a
  `Contract`'s next journal change or terminal state.
- **`tell --wait <duration>` for single-turn answers:** submits an instruction
  and observes that exact `Turn`'s answer. `--schema <file>` supplies a JSON
  Schema answer contract and also observes; without `--wait` it has no deadline.
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

- **`status` and `history`:** bare `status` shows the `World` board;
  `status <aku/...|kei/...|@name>` observes one identity, with current work and
  file-change summary for an Akuma. Plural and category status are refused.
  `history` reads recent timeline events, the latest answer, or one exact
  `turn/N` or `report/N` item.
- **`ls`, `fork`, and `kill`:** `ls` lists archetypes (`aku/`), recent
  instances with current work and outcomes (`"aku/*/*"`), or your own call tree;
  `fork` branches a new `Akuma`
  from an answered `turn/N`; `kill` stops active work while keeping history.
- **JavaScript orchestration:** for multi-agent tournaments, adversarial claim
  checking, or custom concurrency control in code, read
  [Automation With The `Akuma` API](references/automation.md).
