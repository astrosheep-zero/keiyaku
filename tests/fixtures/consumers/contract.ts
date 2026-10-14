import {
  Keiyaku,
  Delivery,
  Repo,
  KeiyakuError,
  type ContractId,
  type BindInput,
  type BindResult,
  type ReviewOutcome,
  type DeliverOutcome,
  type InvocationEffect,
  type PendingSurface,
  type ReviewInput,
  type PartialOutcomeEnvelope,
  type LocalContractComposition,
  type ContractObservation,
  type ContractResolveInput,
  type ContractResolution,
  type ContractSelectorRefusal,
} from "@astrosheep/keiyaku";

declare const repo: Repo;
declare const id: ContractId;
declare const markdown: string;

const input: BindInput = { repo, markdown, after: [id], gates: ["reviewed"] };
const targetlessInput: BindInput = { repo, markdown, target: null };
// @ts-expect-error a target is a branch name or an explicit absence, never another value
const invalidTarget: BindInput = { repo, markdown, target: 7 };
const bound: Promise<BindResult> = Keiyaku.with().bind(input);
const selected = Keiyaku.with().select({ repo, id });
const resolveInput: ContractResolveInput = { repo, selector: "@short", cwd: "/explicit/worktree" };
const resolution: ContractResolution = await Keiyaku.with().resolve(resolveInput);
if (resolution.kind === "resolved") Keiyaku.with().select({ repo, id: resolution.id });
if (resolution.kind === "refused") {
  const refusal: ContractSelectorRefusal = resolution.refusal;
  void refusal.kind;
}
// @ts-expect-error resolution has no transport route
Keiyaku.with().resolve({ repo, selector: id, execution: {} });
const cancellable: ReviewInput = { verdict: "satisfied", signal: new AbortController().signal };
const reviewed: ReviewOutcome = await selected.review(cancellable, { observe: async (event) => { void event.kind; } });
const effects: readonly InvocationEffect[] = reviewed.effects;
const pending: readonly PendingSurface[] = reviewed.pending;
const failure = new KeiyakuError("internal", "failed", { cause: new TypeError("failed") });
const receipt: PartialOutcomeEnvelope | undefined = failure.outcome;
if (reviewed.kind === "accepted") {
  reviewed.value.verification;
  // @ts-expect-error cleanup belongs to the invocation, not the review value
  reviewed.value.cleanup;
}
if (reviewed.kind === "refused") reviewed.refusal.kind;
// @ts-expect-error only delivery can return handoff
const reviewHandoff: ReviewOutcome = { ...reviewed, kind: "handoff" };
declare const delivered: DeliverOutcome;
if (delivered.kind === "accepted") { delivered.value.leading.fact; delivered.value.diff(); }
if (delivered.kind === "handoff") delivered.value.handoffBase;

const local: LocalContractComposition = { actor: "consumer" };
Keiyaku.with(local).select({ repo, id }).review(cancellable);
// @ts-expect-error the execution carrier is no longer a public construction input
Keiyaku.with({ execution: {} });

const observed: ContractObservation = await Keiyaku.with().observe({ repo, id });
if (observed.kind === "present") observed.row.gates.reports;
const reconciled = await Keiyaku.with().reconcile({ repo, contract: id });
reconciled.effects;
reconciled.settlement;
const worldReconciled = await Keiyaku.with().reconcile({ repo, retryHooks: true });
worldReconciled.kind;

// Handles cannot be independently constructed outside their repository authority.
// @ts-expect-error constructor is private
new Keiyaku();
// @ts-expect-error constructor is private
new Delivery();
// @ts-expect-error Repo requires an explicit coordinate object
Repo.at(".");
// @ts-expect-error an omitted coordinate is never read from an ambient directory
Repo.at();
// @ts-expect-error a selected handle cannot switch repositories during an operation
selected.review({ ...cancellable, repo });
// @ts-expect-error binding must contain Markdown or a fork source
Keiyaku.with().bind({ repo });

void bound;
void targetlessInput;
void invalidTarget;
void effects;
void pending;
void receipt;
void reviewHandoff;

// @ts-expect-error selectors require branded Contract identities
Keiyaku.with().select({ repo, id: "kei/unbranded" });
// @ts-expect-error prerequisite identities cannot be unbranded strings
Keiyaku.with().bind({ repo, markdown, after: ["kei/unbranded"] });
// @ts-expect-error obsolete singular cleanup is not a public result
reviewed.leak;
// @ts-expect-error a Repo cannot act as an alternative construction facade
repo.bind(input);
// @ts-expect-error a Delivery review takes an input object
(null as unknown as Delivery).review("satisfied");
// @ts-expect-error abandonment takes an options object
selected.abandon("manual");

// @ts-expect-error removed subscription methods are not public
selected.startDelivery();
// @ts-expect-error retired result sidecars are not public
reviewed.cleanup;
// @ts-expect-error forwarding-specific retries do not belong to local bind
const bindRetry: BindResult = { kind: "retry", operation: "bind", reason: { kind: "owner-reason-unavailable", diagnostic: "gone" }, facts: [], effects: [], pending: [] };
void bindRetry;
// @ts-expect-error the retired execution helper is not a public root name
type RemovedExecutionHelper = import("@astrosheep/keiyaku").bodyRequestExecution;
