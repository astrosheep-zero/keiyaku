---
name: keiyaku-workflow
description: Use when authoring, binding, delivering, reviewing, amending, auditing, or abandoning a Keiyaku v4 Contract.
---

# Keiyaku Workflow

A Contract is one delivery authority. Its document is ordinary input until
`bind` admits it; the bound Contract owns its coordinates, terms, prerequisite
snapshot, candidate, reviews, gates, and terminal decision. Task planning and
Akuma execution remain separate products.

## Lifecycle

```text
bind -> waiting | bound -> pending delivery -> claimed
                                      \-> abandoned
```

`claimed` and `abandoned` are terminal. A prerequisite `after` list is ordered
and immutable after `bound`; `amend` can replace terms and change prerequisites
only before they are consumed. `deliver` tenders current worktree bytes.
`review --satisfied` records testimony and requests placement; placement claims
only when every declared gate is current. `review --unsatisfied` records
judgment without claiming. `audit` observes and never places.

## Bind

Write one canonical Contract document to stdin and bind it:

```bash
keiyaku bind -
keiyaku bind --target <ref> -
keiyaku bind --here -
keiyaku bind --after <kei/...> --gates <name> -
```

The document owns the delivery objective, design, scope, criteria, and optional
verification declaration. Use the exact `bind --help` grammar; do not invent
identity or timestamps. A successful receipt is the source of the complete
Contract coordinate and any managed worktree facts.

## Work And Acceptance

```bash
keiyaku status [<contract>|@<contract>]
keiyaku amend [<contract>|@<contract>] -
keiyaku arc [<contract>|@<contract>] -
keiyaku deliver [<contract>|@<contract>]
keiyaku review [<contract>|@<contract>] --satisfied
keiyaku review [<contract>|@<contract>] --unsatisfied
keiyaku audit [<contract>|@<contract>] [--show-diff-body]
keiyaku reconcile [<contract>|@<contract>]
```

Use complete `kei/...` IDs or `@...` managed-worktree references. Omitted
selectors are contextual only when the CLI reports exactly one active
worktree contract. `amend` reads amendment operations, `arc` reads arc
Markdown, and both require their final `-`; `deliver`, `review`, `audit`, and
`reconcile` do not read an unselected stdin body. `review --summary <text>` is
opaque testimony and is mutually exclusive with review stdin.

## Terminal Choice

`abandon [<contract>|@<contract>] [--note <text>]` writes the terminal
abandoned fact and does not touch a target ref. There is no `petition`, `claim`,
`forfeit`, `renew`, or `bind --task` command in v4. A successful placement
produces the claimed terminal state; inspect the typed result and decide what
to do next.

Use default text output for routine observation. Add `--json` when a script
needs the public result without renderer-specific text.
