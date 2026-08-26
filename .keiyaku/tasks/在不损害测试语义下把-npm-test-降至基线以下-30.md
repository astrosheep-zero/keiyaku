---
id: task/在不损害测试语义下把-npm-test-降至基线以下-30
title: 在不损害测试语义下把 npm test 降至基线以下 30%
state: drop
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: Stopped at a verified 95.50s full green run from the 123.56s baseline; the 86.49s two-run target was not reached, and remaining candidates lacked a large semantics-preserving payoff.
createdAt: 2026-08-26T12:56:17.860Z
updatedAt: 2026-08-26T15:26:29.725Z
---
Objective: Reduce full npm test from the measured 123.56s baseline to an average at or below 86.49s across two green runs. Preserve every distinct lifecycle, race, custody, recovery, cleanup, CLI-adapter, and refusal invariant. Do not rely on increased concurrency or suite ordering. Reuse only immutable pre-state templates cloned into independent repositories with fresh worktrees and handles. Attribute remaining time to setup, act, assertion, cleanup, or production paths before choosing each optimization.