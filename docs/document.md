# Contract Documents

This chapter owns the Markdown boundary for Contracts. It turns caller-authored
terms into private library values; it does not judge lifecycle legality, admit
journal facts, or perform Git effects. Core persists opaque document terms and
their identities, never a decoded body, section tree, or Markdown grammar.

## Contract Terms

A Contract document communicates its context, objective, design, intended
write Region, acceptance criteria, and optional Verification declarations.
Those required terms must be structurally valid and nonempty where meaningful;
invalid documents are rejected before a lifecycle attempt. Extensions may carry
additional author terms without becoming core vocabulary.

`Region` is planning evidence. It lets callers see likely interaction among
active Contracts, but grants no filesystem authority, predicts no eventual
diff, and never rejects concurrent work. A real dependency or an irreconcilable
interaction is instead an `after` relation owned by [lifecycle.md](lifecycle.md).
Exact document, Region-pattern, and fence grammar belong to leaf help and
executable specifications, not this owner law.

The document boundary reserves machine and guidance sections from author
extensions. Reserved names cannot silently become structured Contract terms.
Forking creates an ordinary new Contract from the source terms with a forked
title; it creates neither a source relationship nor a second document dialect.

## Amendments And Arcs

An amendment is an explicit operation over whole Contract sections. It may
replace, append to, add, update, or remove the section forms that support that
meaning; ambiguous or invalid operations are refused. Untouched source terms
retain their identity. An amendment never silently retargets its supplied terms
to a later document: document currency is judged by the lifecycle decision.

An arc is a title, objective, and brief naming the current narrative chapter of
one active Contract. It frames the currently dispatched work without splitting
acceptance, gates, or settlement into a second lifecycle. Arc sequence and
terminal legality belong to [lifecycle.md](lifecycle.md).

## Boundary

The library decodes a document once per attempt and may pass only an
attempt-local, identity-stamped derivation required by the operation, including
its title and prepared Verification work. That derivation is not persisted,
cached, or exposed as a second document authority. Review instead testifies to
the document and worktree it actually observed. The sole lifecycle decision
judges a derivation's currency.

Public callers supply Markdown through the package boundary described by
[public-api.md](public-api.md). Rendering, detailed grammar, and private
decoded values do not cross that boundary.
