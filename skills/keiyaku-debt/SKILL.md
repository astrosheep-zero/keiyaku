---
name: keiyaku-debt
description: >-
  Must read when recording confirmed unresolved work or dependencies in Debts.
---

# Keiyaku Debt

A Debt records confirmed unresolved work and its relationships. Debt is an
independent product; it is not a Contract, Arc, Akuma, permission, acceptance
boundary, or fulfillment lifecycle.

## 1. When To Use A Debt

Use a Debt when confirmed unresolved work or a dependency must outlive the
current conversation. Keep plans and execution progress in reasoning or session
notes instead.

- Use a `kei` for one independently acceptable outcome.
- Use an Arc for a chapter inside one `kei`.
- Use a Debt for confirmed unresolved work and its prerequisites.
- Do not create a Debt just to mirror a `kei`.

A Debt may exist without a Contract. Associating a Debt with a `kei` does not
transfer the Contract's holder, acceptance, or lifecycle to the Debt.

## 2. Relationships And Parallel Work

Independent work may proceed in parallel when its dependencies allow it.
Debt records no execution-progress state.

Use the relationships for their actual meanings:

- `needs` means this Debt must wait for another Debt to become terminal.
- `parent` groups decomposition; it does not create a dependency.
- `supersedes` points to work replaced by this Debt.
- `relates` records a connection without affecting readiness.

Only `needs` orders work. Do not add it because Debts touch the same Region or
because one Debt is related to another. A terminal Debt releases its dependents.

## 3. Debt Commands

Create and inspect Debts:

```bash
keiyaku debt add "<title>"
keiyaku debt add "<title>" --priority 1 --needs <debt-id>
keiyaku debt show <debt-id>
keiyaku debt ls
keiyaku debt ready
keiyaku debt blocked
keiyaku debt tree <debt-id>
keiyaku debt doctor
```

Use complete Debt IDs for targeted commands. `ls`, `ready`, and `blocked` use
the current namespace; use `--world` to inspect the complete Debt world.

Close work:

```bash
keiyaku debt done <debt-id>...
keiyaku debt drop <debt-id>... --note "<reason>"
```

Use `done` when the Debt is complete. Use `drop` when it is no longer owed.
Both terminal states release dependent Debts. Unresolved `needs` appear in
`blocked`; open work with all prerequisites terminal appears in `ready`.

Update a Debt without changing its lifecycle:

```bash
keiyaku debt update <debt-id> --title "<title>"
keiyaku debt update <debt-id> --body "<body>"
keiyaku debt update <debt-id> --needs <debt-id>
```

## 4. After Creating A Debt

Read the returned Debt identity. Then:

1. Add or remove relationships when the confirmed prerequisites change.
2. Mark completed work `done`, or work no longer owed `drop` with a reason.
3. Use `ready`, `blocked`, `tree`, or `doctor` to inspect the current ledger.

Debt records unresolved work. It does not perform the work, claim acceptance,
assign a holder, or decide what a Contract may accept.

Read `keiyaku-bind` for Contract authoring and `keiyaku-workflow` for Contract
lifecycle.
