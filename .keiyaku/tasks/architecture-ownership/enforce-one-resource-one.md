---
id: task/architecture-ownership/enforce-one-resource-one
title: Enforce one resource one retirement
state: done
priority: 0
needs: []
parent: task/architecture-ownership/own-provider-resources-before
supersedes: []
relates: []
note: ""
createdAt: 2026-08-28T08:03:25.489Z
updatedAt: 2026-08-28T08:03:25.489Z
---
Provider Arc 1: remove Session double registration, memoize actual per-resource retirement operations, deduplicate resource identity, and prove repeated and late retirement deterministically.