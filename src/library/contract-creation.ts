/** @architectureCompositionRoot */
import { decodeCanonicalContractDocument } from "../body/render.js";
import { contractId, type ContractId } from "../core/facts/types.js";
import type { WorktreeHooks } from "../git/hooks.js";
import { withGitDecodeChannel, type GitDecodeChannel } from "../git/read-observation.js";
import type { BindTargetSelection } from "../protocol/bind.js";
import type { IntentOutcome, RepositoryScope } from "../protocol/operations.js";
import { executionStop, isOperationalFailure, isOperationalStop } from "../protocol/progress.js";
import { readManagedWorktreeAppointment } from "../workspace-place.js";
import { admitForkBindWithAppointment, prepareMarkdownBind } from "./bind.js";
import type { BindOutcome, BindValue } from "./contract-outcomes.js";
import { acceptedOutcome, expected, retainAdmission } from "./contract-outcomes.js";
import {
  captureLocalContractComposition,
  derivedGates,
  derivedHooks,
  gateNames,
  type LocalContractCompositionCapture,
} from "./contract-settings.js";
import type { BindInput } from "./contract-types.js";
import { actorOption, normalizedList, requireInput, requireMarkdown, debtOption } from "./input.js";
import { InvocationAccumulator } from "./invocation.js";
import type { Kei, createKeiHandle } from "./kei.js";
import { project, validated, type OutcomeProjection } from "./outcome.js";
import { reconcileAffectedContracts } from "./reconcile.js";
import { compactReason } from "../protocol/result-reasons.js";
import type { OperationRefusals } from "./refusal.js";
import { observeRegion, type RegionObservation } from "./region.js";

type AcceptedIntent<Value> = Extract<IntentOutcome<Value>, { kind: "accepted" }>;

/** The one place a caller's omitted target becomes product behavior. */
function bindTargetSelection(target: string | null | undefined): BindTargetSelection {
  if (target === undefined) return { kind: "current-branch" };
  return target === null ? { kind: "targetless" } : { kind: "explicit", target };
}

function bindInput(scope: RepositoryScope, input: BindInput, composition: LocalContractCompositionCapture) {
  const fields = validated(() => requireInput(input, "Keis.bind input"));
  const allowed =
    fields.forkOf === undefined
      ? ["markdown", "debt", "target", "workspace", "actor", "after", "gates"]
      : ["forkOf", "target", "workspace", "actor"];
  requireInput(input, "Keis.bind input", allowed);
  return validated(() => {
    const values = fields;
    const forkOf = values.forkOf;
    if ((values.workspace ?? "worktree") !== "worktree") throw new TypeError("workspace must be worktree");
    if (values.target !== undefined && values.target !== null && typeof values.target !== "string")
      throw new TypeError("target must be a string or null");
    const actor = actorOption(values.actor);
    const document = forkOf === undefined ? parseMarkdown(requireMarkdown(values.markdown)) : undefined;
    if (forkOf !== undefined) {
      if (typeof forkOf !== "string") throw new TypeError("forkOf must be a ContractId");
    }
    const derived = forkOf === undefined ? derivedGates(composition, gateNames(values.gates)) : undefined;
    return {
      forkOf: forkOf === undefined ? undefined : contractId(forkOf),
      scope,
      document,
      actor,
      target: values.target,
      debt: forkOf === undefined ? debtOption(values.debt) : undefined,
      gates: derived,
      after: forkOf === undefined ? normalizedList(values.after, "after", contractId) : undefined,
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
  const prepared = bindInput(scope, input, composition);
  const hooks = derivedHooks(composition);
  const { forkOf, document, target, actor } = prepared;
  const handle = (id: ContractId) => createHandle(id, scope, composition);
  const accumulator = new InvocationAccumulator();
  const projection = await (async (): Promise<OutcomeProjection<"bind", BindValue, OperationRefusals["bind"]>> => {
    let completed: OutcomeProjection<"bind", BindValue, OperationRefusals["bind"]> | undefined;
    let retirement: { error: unknown } | undefined;
    try {
      return await withGitDecodeChannel(
        scope,
        async (channel) => {
          completed = await (async (): Promise<OutcomeProjection<"bind", BindValue, OperationRefusals["bind"]>> => {
            if (forkOf !== undefined) {
              const fork = await admitForkBindWithAppointment({
                scope,
                channel,
                progress: accumulator,
                sourceId: forkOf,
                ...(target === undefined ? {} : { target }),
                ...actor,
              });
              if (fork.kind === "refused") return { kind: "refused", refusal: compactReason(fork.refusal) };
              const admission = fork.admission;
              if (admission.kind !== "accepted") return expected(undefined, admission);
              const id = admission.value.contractId;
              retainBindCoordinates(accumulator, admission);
              const value = await bindComplete(accumulator, id, scope, channel, admission, hooks, () =>
                observeRegion(scope, channel, id, fork.document.region).then((region) => bindValue(handle(id), region)),
              );
              return acceptedOutcome(id, accumulator, value);
            }
            if (document === undefined) throw new Error("Markdown bind requires its prepared document");
            return await markdownBind(prepared, document, hooks, scope, channel, accumulator, handle);
          })();
          return completed;
        },
        (error) => {
          retirement = { error };
          const id = accumulator.snapshot().facts.find((fact) => fact.kind === "bind")?.contract;
          if (id !== undefined) accumulator.recordChannelRetirement(id, error);
        },
      );
    } catch (error) {
      if (
        retirement !== undefined &&
        error === retirement.error &&
        completed?.kind === "accepted" &&
        isOperationalFailure(error)
      )
        return completed;
      const contract = accumulator.snapshot().facts.find((fact) => fact.kind === "bind")?.contract;
      return { kind: "failed", ...(contract === undefined ? {} : { contract }), error };
    }
  })();
  const projected = project("bind", accumulator.snapshot(), projection);
  if (projected.kind === "failed") throw projected.error;
  return projected.outcome;
}

function bindValue(kei: Kei, region: RegionObservation): BindValue {
  const value: BindValue = { ...region, kei };
  Object.defineProperty(value, "kei", { value: kei, enumerable: false });
  return value;
}

// eslint-disable-next-line max-params -- Keep this local operation's custody, admission, and policy witnesses explicit.
async function bindComplete<Value>(
  accumulator: InvocationAccumulator,
  id: ContractId,
  scope: RepositoryScope,
  channel: GitDecodeChannel,
  leading: AcceptedIntent<Value>,
  hooks: WorktreeHooks,
  value: () => Promise<BindValue>,
): Promise<BindValue> {
  retainAdmission(accumulator, id, leading);
  await reconcileAffectedContracts(accumulator, id, scope, channel, hooks);
  try {
    const appointment = await readManagedWorktreeAppointment(scope, id);
    if (appointment.kind === "appointed")
      accumulator.extendConclusions(id, {
        worktreePath: appointment.path,
      });
  } catch (error) {
    if (!isOperationalStop(error, scope.signal)) throw error;
    accumulator.recordStop(executionStop(id, error, scope.signal));
  }
  const result = await value();
  const built: BindValue = { ...result, ...accumulator.conclusions(id) };
  Object.defineProperty(built, "kei", { value: result.kei, enumerable: false });
  accumulator.extendConclusions(id, built);
  return built;
}

// eslint-disable-next-line max-params -- Keep this local operation's custody, admission, and policy witnesses explicit.
async function markdownBind(
  prepared: ReturnType<typeof bindInput>,
  document: ReturnType<typeof parseMarkdown>,
  hooks: WorktreeHooks,
  scope: RepositoryScope,
  channel: GitDecodeChannel,
  accumulator: InvocationAccumulator,
  handle: (id: ContractId) => Kei,
): Promise<OutcomeProjection<"bind", BindValue, OperationRefusals["bind"]>> {
  const { debt, target, actor, gates, after } = prepared;
  if (gates === undefined || after === undefined) throw new Error("Markdown bind requires prepared terms");
  const targetSelection = bindTargetSelection(target);
  const admission = await prepareMarkdownBind({
    scope,
    channel,
    document,
    gates,
    progress: accumulator,
    after,
    workspace: "worktree",
    targetSelection,
    ...(debt === undefined ? {} : { debt }),
    ...actor,
  });
  const leading = admission.admission === null ? admission.result : admission.admission.result;
  if (leading.kind !== "accepted") return expected(undefined, leading);
  const id = leading.value.contractId;
  retainBindCoordinates(accumulator, leading);
  const value = await bindComplete(accumulator, id, scope, channel, leading, hooks, async () =>
    bindValue(handle(id), await observeRegion(scope, channel, id, document.region)),
  );
  return acceptedOutcome(id, accumulator, value);
}

function retainBindCoordinates<Value>(accumulator: InvocationAccumulator, leading: AcceptedIntent<Value>): void {
  const bind = leading.facts.find((fact) => fact.kind === "bind");
  if (bind?.kind !== "bind") throw new Error("bind receipt requires its admitted coordinates");
  const target = bind.data.coordinates.target;
  if (target !== undefined)
    accumulator.extendConclusions(bind.contract, {
      target: typeof target === "string" ? target : target.contractId,
    });
}

function parseMarkdown(markdown: string) {
  return decodeCanonicalContractDocument(markdown, { requireTimeout: true });
}
