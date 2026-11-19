/** @architectureCompositionRoot */
import { decodeCanonicalContractDocument } from "../body/render.js";
import { targetName, type ContractId } from "../core/facts/types.js";
import { KeiyakuError } from "../errors.js";
import type { WorktreeHooks } from "../git/hooks.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import type { BindTargetSelection } from "../protocol/bind.js";
import type { IntentOutcome, RepositoryScope } from "../protocol/operations.js";
import { executionStop, isOperationalStop } from "../protocol/progress.js";
import { readManagedWorktreeAppointment } from "../workspace-place.js";
import { admitForkBindWithAppointment, prepareMarkdownBind } from "./bind.js";
import { retainAdmission, type BindOutcome } from "./contract-outcomes.js";
import {
  captureLocalContractComposition,
  derivedGates,
  derivedHooks,
  gateNames,
  type LocalContractCompositionCapture,
} from "./contract-settings.js";
import type { BindInput } from "./contract-types.js";
import { callerContractId, normalizedList, requireInput, requireMarkdown, debtOption } from "./input.js";
import { InvocationAccumulator } from "./invocation.js";
import { invokeContract, type Kei, type createKeiHandle } from "./kei.js";
import { validated } from "./outcome.js";
import { reconcileAffectedContracts } from "./reconcile.js";
import { compactReason, compactRetry } from "../protocol/result-reasons.js";
import { observeRegion } from "./region.js";

/** The one place a caller's omitted target becomes product behavior. */
function bindTargetSelection(target: string | null | undefined): BindTargetSelection {
  if (target === undefined) return { kind: "current-branch" };
  return target === null ? { kind: "targetless" } : { kind: "explicit", target };
}

function bindInput(input: BindInput, composition: LocalContractCompositionCapture) {
  const values = validated(() => requireInput(input, "Keis.bind input"));
  const allowed = values.forkOf === undefined ? ["terms", "debt", "target", "after", "gates"] : ["forkOf", "target"];
  requireInput(values, "Keis.bind input", allowed);
  return validated(() => {
    const forkOf = values.forkOf;
    if (values.target !== undefined && values.target !== null && typeof values.target !== "string")
      throw new KeiyakuError("invalid-input", "target must be a string or null");
    const document = forkOf === undefined ? parseMarkdown(requireMarkdown(values.terms, "terms")) : undefined;
    if (forkOf !== undefined && typeof forkOf !== "string")
      throw new KeiyakuError("invalid-input", "forkOf must be a ContractId");
    const derived = forkOf === undefined ? derivedGates(composition, gateNames(values.gates)) : undefined;
    return {
      forkOf: forkOf === undefined ? undefined : callerContractId(forkOf),
      document,
      target: values.target,
      debt: forkOf === undefined ? debtOption(values.debt) : undefined,
      gates: derived,
      after: forkOf === undefined ? normalizedList(values.after, "after", callerContractId) : undefined,
    };
  });
}

/**
 * One Contract bind. An omitted Markdown target names the current branch of the caller's explicit
 * Repo worktree coordinate, `null` is deliberately targetless, and a string is that literal target.
 */
export async function bindKei(
  scope: RepositoryScope,
  input: BindInput,
  createHandle: typeof createKeiHandle,
  composition: LocalContractCompositionCapture = captureLocalContractComposition(),
): Promise<BindOutcome> {
  const prepared = bindInput(input, composition);
  const hooks = derivedHooks(composition);
  const { forkOf, document, target } = prepared;
  const handle = (id: ContractId) => createHandle(id, scope, composition);
  const accumulator = new InvocationAccumulator();
  return await invokeContract<BindOutcome>("bind", scope, accumulator, async (channel) => {
    const context = { scope, channel, hooks, accumulator, handle };
    if (forkOf === undefined) {
      if (document === undefined) throw new Error("Markdown bind requires its prepared document");
      return await markdownBind(prepared, document, context);
    }
    const fork = await admitForkBindWithAppointment({
      scope,
      channel,
      progress: accumulator,
      sourceId: forkOf,
      ...(target === undefined ? {} : { target }),
    });
    if (fork.kind === "refused") return { kind: "refused", reason: compactReason(fork.refusal) };
    return await bindAnswer(context, fork.admission, fork.document.region);
  });
}

type BindContext = Readonly<{
  scope: RepositoryScope;
  channel: GitDecodeChannel;
  hooks: WorktreeHooks;
  accumulator: InvocationAccumulator;
  handle: (id: ContractId) => Kei;
}>;

async function bindAnswer<
  Value extends { contractId: ContractId },
  Refusal extends Parameters<typeof compactReason>[0],
>(
  { accumulator, scope, channel, hooks, handle }: BindContext,
  leading: IntentOutcome<Value, Refusal>,
  region: Parameters<typeof observeRegion>[3],
): Promise<BindOutcome> {
  if (leading.kind !== "accepted")
    return leading.kind === "refused"
      ? { kind: "refused", reason: compactReason(leading.refusal) }
      : compactRetry(leading.reason);
  const id = leading.value.contractId;
  retainAdmission(accumulator, id, leading);
  const bind = accumulator.firstFact("bind");
  if (bind?.contract !== id) throw new Error("bind receipt requires its admitted coordinates");
  const target = bind.data.coordinates.target;
  await reconcileAffectedContracts(accumulator, id, scope, channel, hooks);
  let worktreePath: string | undefined;
  try {
    const appointment = await readManagedWorktreeAppointment(scope, id);
    if (appointment.kind === "appointed") worktreePath = appointment.path;
  } catch (error) {
    if (!isOperationalStop(error, scope.signal)) throw error;
    accumulator.recordStop(executionStop(id, error, scope.signal));
  }
  const overlaps = await observeRegion(scope, channel, id, region);
  return Object.defineProperty(
    {
      kind: "accepted" as const,
      contractId: id,
      ...(target === undefined ? {} : { target: targetName(target) }),
      ...(worktreePath === undefined ? {} : { worktreePath }),
      ...overlaps,
      kei: handle(id),
    },
    "kei",
    { enumerable: false, writable: false, configurable: false },
  );
}

async function markdownBind(
  prepared: ReturnType<typeof bindInput>,
  document: ReturnType<typeof parseMarkdown>,
  context: BindContext,
): Promise<BindOutcome> {
  const { debt, target, gates, after } = prepared;
  if (gates === undefined || after === undefined) throw new Error("Markdown bind requires prepared terms");
  const targetSelection = bindTargetSelection(target);
  const admission = await prepareMarkdownBind({
    scope: context.scope,
    channel: context.channel,
    document,
    gates,
    progress: context.accumulator,
    after,
    targetSelection,
    ...(debt === undefined ? {} : { debt }),
  });
  return await bindAnswer(context, admission.admission?.result ?? admission.result, document.region);
}

function parseMarkdown(markdown: string) {
  return decodeCanonicalContractDocument(markdown, { requireTimeout: true });
}
