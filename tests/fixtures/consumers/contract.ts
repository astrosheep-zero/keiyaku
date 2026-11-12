import {
  Kei,
  Keis,
  type Delivery,
  Repo,
  KeiyakuError,
  type ContractId,
  type BindInput,
  type BindOutcome,
  type ReviewOutcome,
  type VerifyInput,
  type VerifyOutcome,
  type DeliverOutcome,
  type DeliveryPreviewInput,
  type DeliveryPreviewOutcome,
  type ReviewInput,
  type PartialOutcomeEnvelope,
  type KeisOptions,
  type ContractObservation,
  type ContractResolveInput,
  type ContractResolution,
  type ContractSelectorRefusal,
  type Placement,
  type VerificationCheck,
} from "@astrosheep/keiyaku";

declare const repo: Repo;
declare const id: ContractId;
declare const markdown: string;

const input: BindInput = { markdown, after: [id], gates: ["reviewed"] };
const targetlessInput: BindInput = { markdown, target: null };
// @ts-expect-error a target is a branch name or an explicit absence, never another value
const invalidTarget: BindInput = { markdown, target: 7 };
const bound: BindOutcome = await Keis.of(repo).bind(input);
if (bound.kind === "accepted") {
  const handle: Kei = bound.kei;
  void [handle, bound.contractId, bound.worktreePath];
}
const selected = Keis.of(repo).kei({ id });
const previewInput: DeliveryPreviewInput = { includeDirty: true, showDiff: true, signal: new AbortController().signal };
const preview: DeliveryPreviewOutcome = await selected.previewDelivery(previewInput, { observe: () => {} });
if (preview.kind === "ready")
  void [preview.candidate, preview.integration, preview.contentId, preview.scope, preview.unmetGates];
if (preview.kind === "blocked") void preview.reason.kind;
// @ts-expect-error standalone audit is retired
selected.audit();
// @ts-expect-error preview cannot accept mutation-only options
selected.previewDelivery({ overwrite: true });
const resolveInput: ContractResolveInput = { selector: "@short", cwd: "/explicit/worktree" };
const resolution: ContractResolution = await Keis.of(repo).resolve(resolveInput);
if (resolution.kind === "resolved") Keis.of(repo).kei({ id: resolution.id });
if (resolution.kind === "refused") {
  const refusal: ContractSelectorRefusal = resolution.refusal;
  void refusal.kind;
}
// @ts-expect-error resolution has no transport route
Keis.of(repo).resolve({ selector: id, execution: {} });
const verifyInput: VerifyInput = { index: 1, includeDirty: true, signal: new AbortController().signal };
const verified: VerifyOutcome = await selected.verify(verifyInput, { observe: () => {} });
if (verified.kind === "accepted") {
  void verified.snapshot;
  verified.checks.forEach((check) => {
    void [check.index, check.requirement];
    if (check.kind === "terminal") {
      void check.verdict;
      if (typeof check.admission === "object") void check.admission.kind;
    } else {
      const stopped: Exclude<VerificationCheck, { kind: "terminal" }> = check;
      void stopped.kind;
    }
  });
}
// @ts-expect-error Verification indexes are numbers at the public boundary
selected.verify({ index: "1" });
const cancellable: ReviewInput = {
  verdict: "satisfied",
  summary: "Consumer review passed",
  signal: new AbortController().signal,
};
// @ts-expect-error review testimony requires a summary
const missingReviewSummary: ReviewInput = { verdict: "satisfied" };
void missingReviewSummary;
const reviewed: ReviewOutcome = await selected.review(cancellable, {
  observe: async (event) => {
    void event.kind;
  },
});
const failure = new KeiyakuError("internal", "failed", { cause: new TypeError("failed") });
const receipt: PartialOutcomeEnvelope | undefined = failure.outcome;
if (reviewed.kind === "accepted") {
  const placement: Placement | undefined = reviewed.placement;
  void [placement, reviewed.issues];
}
if (reviewed.kind === "refused") reviewed.reason.kind;
// @ts-expect-error only delivery can return handoff
const reviewHandoff: ReviewOutcome = { ...reviewed, kind: "handoff" };
declare const delivered: DeliverOutcome;
if (delivered.kind === "accepted") {
  void [delivered.candidate, delivered.integration, delivered.contentId, delivered.admission];
}
if (delivered.kind === "handoff") void [delivered.handoffBase, delivered.targetHead, delivered.conflictPaths];

const local: KeisOptions = { actor: "consumer" };
Keis.of(repo, local).kei({ id }).review(cancellable);
// @ts-expect-error the execution carrier is no longer a public construction input
Keis.of(repo, { execution: {} });
const observed: ContractObservation = await Keis.of(repo).observe({ id });
if (observed.kind === "present") observed.row.gates?.forEach(({ gate, requirements }) => void [gate, requirements]);
const reconciled = await Keis.of(repo).reconcile({ contract: id });
if (reconciled.kind === "contract") void [reconciled.effects, reconciled.issues];
const worldReconciled = await Keis.of(repo).reconcile({ retryHooks: true });
worldReconciled.kind;
const guidance = await selected.guidance();
if (guidance.kind === "present") void guidance.guidance;
const history = await selected.history({ full: true });
if (history.kind === "contract")
  history.events.forEach((event) => {
    if (event.kind === "bind" || event.kind === "amend") void [event.document, event.gates, event.after];
  });

// Handles cannot be independently constructed outside their repository authority.
// @ts-expect-error constructor is private
new Kei();
// @ts-expect-error Repo requires an explicit coordinate object
Repo.at(".");
// @ts-expect-error an omitted coordinate is never read from an ambient directory
Repo.at();
// @ts-expect-error a selected handle cannot switch repositories during an operation
selected.review({ ...cancellable, repo });
// @ts-expect-error binding must contain Markdown or a fork source
Keis.of(repo).bind({});
// @ts-expect-error selectors require branded Contract identities
Keis.of(repo).kei({ id: "kei/unbranded" });
// @ts-expect-error prerequisite identities cannot be unbranded strings
Keis.of(repo).bind({ markdown, after: ["kei/unbranded"] });
// @ts-expect-error a Repo cannot act as an alternative construction facade
repo.bind(input);
// @ts-expect-error a Delivery review takes an input object
(null as unknown as Delivery).review("satisfied");
// @ts-expect-error abandonment takes an options object
selected.abandon("manual");
// @ts-expect-error removed subscription methods are not public
selected.startDelivery();

void [bound, targetlessInput, invalidTarget, receipt, reviewHandoff];
