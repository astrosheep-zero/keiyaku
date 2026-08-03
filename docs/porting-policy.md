# Porting Policy

The v3 repository is evidence, not a dependency.

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
of scope until the facts kernel is proven.
