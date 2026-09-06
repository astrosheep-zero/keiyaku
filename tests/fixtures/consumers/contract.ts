import {
  Keiyaku,
  Delivery,
  Repo,
  bodyRequestExecution,
  executionReceipt,
  projectMutationFinality,
  type ContractId,
  type BindInput,
  type BindResult,
  type Review,
  type ReviewInput,
  type MutationResult,
  type ExecutionCleanup,
  type ExecutionStop,
  type ExecutionReceipt,
  type LocalContractComposition,
  type ContractObservation,
  type RepoReconcileReport,
} from "@astrosheep/keiyaku";

declare const repo: Repo;
declare const id: ContractId;
declare const markdown: string;

const input: BindInput = { repo, markdown, after: [id], gates: ["reviewed"] };
const bound: Promise<BindResult> = Keiyaku.bind(input);
const selected = Keiyaku.of({ repo, id });
const cancellable: ReviewInput = { verdict: "satisfied", signal: new AbortController().signal };
const reviewed: MutationResult<Review> = await selected.review(cancellable);
const cleanup: readonly ExecutionCleanup[] = reviewed.cleanup;
const stops: readonly ExecutionStop[] = reviewed.executionStops;
const receipt: ExecutionReceipt | undefined = executionReceipt(new TypeError("failed"));
projectMutationFinality(reviewed);

const local: LocalContractComposition = {
  actor: "consumer",
  hooks: { create: [], destroy: [] },
  requireBranchesToBeUpToDate: true,
};
Keiyaku.withLocal(local).of({ repo, id }).review(cancellable);
const execution = bodyRequestExecution({ directory: "/tmp/keiyaku-requests" });
Keiyaku.withExecution({ execution }).of({ repo, id }).review(cancellable);

const observed: ContractObservation = await Keiyaku.observe({ repo, id });
if (observed.kind === "present") observed.row.gates.reports;
declare const reconciled: RepoReconcileReport;
if (reconciled.kind === "completed") reconciled.contracts;
else reconciled.diagnostic;

// Handles cannot be independently constructed outside their repository authority.
// @ts-expect-error constructor is private
new Keiyaku();
// @ts-expect-error constructor is private
new Delivery();
// @ts-expect-error Repo requires an explicit coordinate object
Repo.at(".");
// @ts-expect-error a selected handle cannot switch repositories during an operation
selected.review({ ...cancellable, repo });
// @ts-expect-error cleanup belongs to the invocation, not the review value
reviewed.value.cleanup;
// @ts-expect-error a failed reconciliation cannot omit its reason
const unreported: RepoReconcileReport = { kind: "world-observation-failed" };
// @ts-expect-error a successful reconciliation must describe its contracts
const incomplete: RepoReconcileReport = { kind: "completed" };
// @ts-expect-error binding must contain Markdown or a fork source
Keiyaku.bind({ repo });

void bound;
void cleanup;
void stops;
void receipt;
void unreported;
void incomplete;
