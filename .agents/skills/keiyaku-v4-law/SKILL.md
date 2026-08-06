---
name: keiyaku-v4-law
description: Navigate and apply the Keiyaku v4 authority documents when changing or reviewing v4 architecture, facts, protocol, verbs, reconcile, persistence, lifecycle, identity, CLI, task, or response surfaces.
---

# Keiyaku v4 Authority Guide

Concrete product and architecture decisions live only in the repository-root
`docs/` documents. This skill is a reading and change-discipline guide; it is
not a copy of those decisions.

## Read First

1. Read [`docs/README.md`](../../../docs/README.md), the authority registry.
2. Read every owner document named there for the requested surface.
3. Read neighboring code and focused tests only after the owner is known.

The current owners are:

- [`docs/architecture.md`](../../../docs/architecture.md) for core identity,
  facts, protocol, admission, delivery, lifecycle, reconcile, persistence,
  operating limits, and dependency direction.
- [`docs/cli.md`](../../../docs/cli.md) for the contract CLI boundary,
  grammar, edge flow, result shapes, status, and task settlement.
- [`docs/porting-policy.md`](../../../docs/porting-policy.md) for v3 evidence
  and current-version-only porting rules.

## Change Discipline

- Treat root `docs/` as the only design authority. Do not copy a ruling into
  this skill, a task, a worker brief, a code comment, or a second document.
- Cite the exact owner document and section in every implementation or review
  brief. A task scopes work; it does not authorize design.
- If the owner documents do not settle a choice that affects public behavior,
  persistence, authority, data flow, recovery, concurrency, complexity, or
  process topology, stop the dependent implementation and report the concrete
  failing case. Settle the gap first, then update the owner document.
- Treat source code, tests, Square discussion, v3 precedent, and worker
  suggestions as evidence, not authority.
- Keep implementation changes and the corresponding owner-document update in
  one coherent accepted slice. Review the complete diff and focused tests
  against the owner documents.

## References

Use [`developing-keiyaku-v4`](../developing-keiyaku-v4/SKILL.md) for task-board,
Akuma dispatch, observation-window, and Faye-escalation procedure. Use
[`review-keiyaku-v4`](../review-keiyaku-v4/SKILL.md) for independent review
method and test-quality judgment. Neither skill is an authority source.
