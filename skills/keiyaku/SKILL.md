---
name: keiyaku
description: >-
  Keiyaku records unresolved work, writes handoff terms for deliveries, and
  calls delegates. Use this skill when deciding which Keiyaku concept or skill
  to reach for.
---

# Keiyaku

## Three Independent Pillars

Keiyaku has three pillars that work alone or together:

- **Debt (`keiyaku-debt`):** confirmed unresolved work and its dependencies.
  Does **not** require a closed design — record a Debt as soon as a problem or
  prerequisite is confirmed, even while the solution is still open.
- **Contract (`kei`):** one independently acceptable delivery whose objective,
  design, and acceptance boundary are already closed, owned by **one and only
  one holder** (you by default, or one Akuma handed the whole Contract loop). If
  the design is not closed yet, investigate the codebase yourself or send an
  Akuma to settle the approach before binding. Complex `kei`s divide their
  execution into **Arcs** (chapters inside that one acceptance boundary).
- **Akuma (`keiyaku-akuma`):** delegated workers addressed by `@alias` or
  `AkuId` across parallel lanes.

## Which Skill To Read

- Recording or querying unresolved work and prerequisites: `keiyaku-debt`
- Splitting acceptance boundaries and authoring a Contract: `keiyaku-bind`
- Running a Contract's fulfillment loop (deliver, verify, review): `keiyaku-workflow`
- Calling, aliasing, steering, and waiting on Akumas: `keiyaku-akuma`
- Supervising multiple active Contracts and Akumas in parallel: `keiyaku-babysit`

Get exact command or tool syntax from CLI `--help` or the exposed tool
descriptions.
