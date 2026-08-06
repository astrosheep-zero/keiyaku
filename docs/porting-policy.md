# Porting Policy

The v3 repository is evidence, not a dependency. Its command surface is a
special case: it is field-tested intent encoding and is inherited by default.
The v4 rewrite replaces the journal/provider/storage foundation, not the
established intent vocabulary. A v4 command-surface deviation must carry
specific contrary product evidence; implementation convenience is not enough.
[Act 225]

Move code only when all of these are true:

1. The product behavior remains required in v4.
2. The code has one clear owner and no hidden authority.
3. Its persisted data is either authoritative in the carrier tree or safely
   disposable.
4. Its failure cannot overwrite an already accepted product fact.
5. Focused tests can state the invariant without recreating v3 internals.

Rewrite code when it mentions repository ledger topology, detached evidence
commits, current-state SQLite, carrier gates, effect journals, accepted-tail
replay, construction ownership, or compatibility formats.

The initial porting order is facts, evidence bytes, transaction protocol,
reconcile, verb decisions, rendering, then CLI. Projection/provider code is out
of scope until the facts kernel is proven. Porting the command surface means
preserving the agent's intent vocabulary while reimplementing the protocol
below it; it never means restoring a v3 ledger or compatibility substrate.
