# Settlement

Settlement is the sole owner of Contract-to-Debt coordination. Contract journals
and Debt documents retain their own lifecycle authority; DebtHolder is the one
durable cross-product association. Forking creates no holder, lineage, sibling
registry, or comparison outcome.

No other module joins Contract write-side facts to Debt writes. Library composes
holder changes with Contract admission and gives Settlement its opportunity
outside Git custody. CLI never settles directly, and Kanshi may only consume
the read projection.

## DebtHolder

Each Debt has one canonical current holder record naming the Contract that holds
it or its released disposition. Settlement alone owns its storage, decoding,
currentness, and mutation. Binding a Debt supersedes its prior holder; abandonment
releases a holder only when that Contract is still current. An older Contract
therefore cannot release or settle a Debt taken by a later Contract.

Holder mutation and its associated Contract admission publish together. Holder
records are not copied into Debts, deleted, reverse-indexed, or written by a
second owner. Each association names the exact flat Debt identity, including a
held completion that still needs replay. Git carries their opaque companion
bytes without interpreting them. Holder claim and release serialize per Debt,
while the Debt store alone
adjudicates its own concurrent document writes; neither product borrows the
other's concurrency authority.

## Settlement Rules And Replay

When an accepted Contract remains a Debt's matching held holder, Settlement moves
that Debt to its settled completion state and releases the holder as its final
action. An already settled Debt remains settled. A dropped Debt, missing Debt,
Debt refusal, concurrent Debt movement, or failed holder publication is visible
lag. Contention for publication custody is retryable lag for the addressed
association and allows reconciliation of other Contracts to proceed. The holder
remains when release did not publish and a later replay re-evaluates it. A terminal Contract without its matching held holder is
strictly inert: it does not create, repair, or inspect unrelated Debt, World, or
context state. Explicitly reopening a Debt does not restore a released holder or
reverse Contract acceptance. A still-held matching accepted holder continues to
owe replay even if the Debt was reopened; Settlement still refuses to complete
dropped work.

Only explicit current DebtHolder facts establish Contract-to-Debt association.
Contract names and identity spelling carry no association authority. Settlement
has no Akuma rule, configurable lifecycle hook, event bus, or generic cross-product registry.

Admission is irreversible. A Contract's Settlement opportunity follows Git
repair and any active workspace projection, and precedes terminal cleanup.
Settlement receives the authority repair observed, not a terminal conclusion
inferred from later physical effects. Git, workspace, or Settlement lag cannot
reject an accepted fact, manufacture abandonment, or hide the Contract.

Settlement reuses the invocation's proof of irreversible Contract acceptance.
It observes only holder authority to discover and revalidate the association,
first under the Debt's holder fence and again under publication custody after
Debt completion. The Debt store still judges its own current authority and
predecessor. Settlement records completed actions before proceeding and reports
independent failure and cleanup evidence without storing another lifecycle state,
completion bit, replay queue, or receipt.

## Cross-owner replay review

Every Settlement review records the same small set of facts without creating a
second authority:

- **Leading irreversible fact:** Contract admission is published before Git
  reconciliation and Settlement. Once admitted, later lag cannot reject or
  erase that Contract fact.
- **Durable replay token:** The current matching held DebtHolder is the sole
  durable token that says this accepted Contract still owes Debt settlement.
- **Token consumption point:** Only publication of the released holder consumes
  the token, after confirmed Debt completion or a judgment that it is already
  done. An uncertain publication is confirmed only by exact durable readback
  of that release, under an independent bound even if the caller cancelled.
  Recovery selects the original holder in one fresh private-state observation
  and judges its canonical bytes only after the finite Git reads succeed. A
  failed read supplies a diagnostic and no release proof. Failure to prove
  release grants no permission to resubmit the old offer.
- **Crash windows:** An interruption after admission, during Git reconciliation,
  after Debt completion, or during release is recovered from the durable
  acceptance and fresh holder authority. Only a still-held matching holder
  permits replay, and the Debt's current state is judged again. A released
  holder or a superseding owner grants no replay to the old Contract.
- **Cleanup requirement:** Holder release is the final Settlement action.
  Publication custody and Debt-scoped coordination are retired before terminal
  managed-worktree removal. A Debt fence close failure remains observable
  alongside a failed admission or settlement. Cleanup preserves the primary
  cause and any completed work.
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
