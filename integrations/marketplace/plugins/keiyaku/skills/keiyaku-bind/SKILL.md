---
name: keiyaku-bind
description: Author and bind one Keiyaku delivery Contract. Use when deciding whether a bounded delivery is ready for Contract terms, writing those terms for an implementer, binding an existing Task with `bind --task`, choosing bind inputs, or interpreting the bind receipt and worktree handoff.
---

# Keiyaku Bind

Use bind for a settled delivery, not an investigation. Investigate first if
an unresolved fact could change the Objective, Design, Region, or Criteria.

## Author The Terms

Design closes every decision a candidate could get wrong: owner, boundary,
data flow, commit point, authority, and forbidden shapes. Add high-level
pseudocode when ordering matters.

Region declares the intended write surface for coarse overlap detection against
active Contracts. Keep it narrow enough to make that signal useful; do not use
`src/**` unless the whole tree is genuinely intended. Region is not filesystem
authority or a forecast of the exact final diff. Each criterion states one
observable accept/reject condition.

## Bind

Inspect the installed command before choosing options:

```bash
keiyaku -C <repo> bind --help
```

The comments explain the fields; only the heredoc is stdin.

~~~~bash
# H1: delivery name; source of the first kei/... identity.
# Context: facts the delivery depends on.
# Objective: one observable outcome.
# Design: closed decisions and necessary pseudocode.
# Region: intended writes for active-Contract overlap detection.
# Criteria: independently decidable acceptance conditions.
# Verification: optional executable declaration and timeout.
keiyaku -C <repo> bind - <<'KEIYAKU'
# Guard ignored bytes during target placement

## Context
Target checkout can overwrite an ignored untracked path in the candidate's
write footprint.

## Objective
Refuse before checkout and name every colliding path.

## Design
The target-placement layer owns this check. Derive literal write paths from
the predecessor/candidate diff, inspect only those paths, and return
`checkout-not-followable` with reason `untracked` before checkout.

```text
writes = diff(predecessor, candidate)
collisions = ignoredUntrackedPaths(writes)
if collisions: refuse({ reason: "untracked", paths: collisions })
```

## Region
```
src/git/target-placement.ts
tests/git-delivery.test.ts
```

## Criteria
### Collisions are named
The refusal lists every colliding path once.

### Unrelated paths are not observed
A large ignored population outside the write footprint does not affect placement.

## Verification
```bash timeout=5m
node --import tsx --test tests/git-delivery.test.ts
```
KEIYAKU
~~~~

For a saved document:

```bash
keiyaku -C <repo> bind - < CONTRACT.md
keiyaku -C <repo> bind --task <task/...> - < CONTRACT.md
```

Use `--task` only for an existing Task with scheduling or dependency value;
do not create one just to mirror the Contract. Use `bind --help` for other
options.

## Read The Receipt

Treat the receipt as the handoff. Keep the complete `kei/...` identity, work in
the reported managed worktree when one was created, and retain the target and
gate facts it reports. A waiting receipt means prerequisites remain; it is not
a second authoring workflow. A post-admission lag does not erase the admitted
Contract; read the typed facts, effects, and lag before acting.

Continue the delivery with `keiyaku-workflow`.
