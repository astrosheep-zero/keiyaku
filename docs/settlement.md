# Settlement

Settlement is the sole owner of Contract-to-Debt coordination. Contract journals
and Debt documents retain their own lifecycle authority; DebtHolder is the one
durable cross-product association. Forking creates no holder, lineage, sibling
registry, or comparison outcome.

No other module joins Contract write-side facts to Debt writes. Library composes
holder changes with Contract admission and invokes settlement after Git
reconciliation. CLI never settles directly, and Kanshi may only consume the
read projection.

## DebtHolder

Each Debt has one canonical current holder record naming the Contract that holds
it or its released disposition. Settlement alone owns its storage, decoding,
currentness, and mutation. Binding a Debt supersedes its prior holder; abandonment
releases a holder only when that Contract is still current. An older Contract
therefore cannot release or settle a Debt taken by a later Contract.

Holder mutation and its associated Contract admission publish together. Holder
records are not copied into Debts, deleted, reverse-indexed, or written by a
second owner. Renaming the ledger product preserves existing holder authority,
including a held completion that still needs replay; the rename is never a
reason to orphan an association. Git carries their opaque companion bytes without interpreting
them. Holder claim and release serialize per Debt, while the Debt store alone
adjudicates its own concurrent document writes; neither product borrows the
other's concurrency authority.

## Settlement Rules And Replay

When an accepted Contract remains a Debt's matching held holder, Settlement moves
that Debt to its settled completion state and releases the holder as its final
action. An already settled Debt remains settled. A dropped Debt, missing Debt,
Debt refusal, concurrent Debt movement, or failed holder publication is visible
lag; the holder remains when release did not publish and a later replay
re-evaluates it. A terminal Contract without its matching held holder is
strictly inert: it does not create, repair, or inspect unrelated Debt, World, or
context state.

Contract-derived namespace context belongs to the active managed worktree
projection. Settlement never installs or repairs it, and terminal Contracts
never receive an active context projection. Kanshi uses the same Contract-derived
namespace only as a read-time matching coordinate. Settlement has no Akuma rule,
configurable lifecycle hook, event bus, or generic cross-product registry.

Admission is irreversible. The public sequence is admission, Git reconciliation,
active workspace projection, Settlement, then result projection. Git, workspace,
or Settlement lag cannot reject an accepted fact, manufacture abandonment, or
hide the Contract. Terminal managed worktree removal waits until this
invocation's settlement opportunity ends.

Settlement derives desired work anew from current Contract, holder, Debt, and
Git observations on every invocation. It stores no completion bit, replay queue,
or secondary receipt. The per-Debt holder boundary and Debt's own predecessor
comparison preserve concurrent correctness; a failed Debt settlement or holder
publication leaves the matching holder held for a later replay. Settlement
reports completed actions and independent lags, without inventing a second
lifecycle state or nested receipt.

## Cross-owner replay review

Every Settlement review records the same small set of facts without creating a
second authority:

- **Leading irreversible fact:** Contract admission is published before Git
  reconciliation and Settlement. Once admitted, later lag cannot reject or
  erase that Contract fact.
- **Durable replay token:** The current matching held DebtHolder is the sole
  durable token that says this accepted Contract still owes Debt settlement.
- **Token consumption point:** Settlement consumes that token only when it
  publishes the holder as released, after Debt completion and the namespace
  projection opportunity have been attempted.
- **Crash windows:** A crash after admission, during Git reconciliation, after
  Debt completion but before holder release, or while holder release is being
  published is resolved by re-observing current Contract, Debt, and Git facts.
  A still-held matching holder means replay is owed; a released holder means
  token consumption succeeded. A publication that remains held is observable
  lag for a later replay.
- **Cleanup requirement:** The holder release is the final Settlement action;
  Debt-scoped coordination is closed, and terminal managed-worktree removal
  waits until this invocation's settlement opportunity has ended. Failed
  release publication retains the held token for replay.
- **Post-consumption failure:** Coordination cleanup, terminal cleanup, or
  result projection may still report invocation lag after release. Such a
  failure cannot recreate a holder or repeat the settled Debt effect; a
  released holder makes later Settlement inert.

## Boundary

Settlement is not a hook. Hooks are external commands attached to physical
effects and remain owned by those effects. Adding another settlement behavior
requires an explicit rule in this chapter rather than a plugin point or
configurable Contract, Debt, or Akuma event.

Invocation reporting retains each completed settlement action and lag before
later holder publication or cleanup can fail. Programming failures and corrupt
authority stay exceptional rather than becoming operational settlement lags.
This reporting grants no new replay token: only the current held association
can authorize a later settlement attempt.
