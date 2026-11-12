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
import { retainAdmission } from "./contract-outcomes.js";
import {
  captureLocalContractComposition,
  derivedGates,
  derivedHooks,
  gateNames,
  type LocalContractCompositionCapture,
} from "./contract-settings.js";
import type { BindInput } from "./contract-types.js";
import { normalizedList, requireInput, requireMarkdown, debtOption } from "./input.js";
import { InvocationAccumulator } from "./invocation.js";
import type { Kei, createKeiHandle } from "./kei.js";
import { project, validated, type InvocationFailure } from "./outcome.js";
import { reconcileAffectedContracts } from "./reconcile.js";
import { compactReason, compactRetry } from "../protocol/result-reasons.js";
import { observeRegion, type RegionObservation } from "./region.js";

type AcceptedIntent<Value> = Extract<IntentOutcome<Value>, { kind: "accepted" }>;

/** The one place a caller's omitted target becomes product behavior. */
function bindTargetSelection(target: string | null | undefined): BindTargetSelection {
  if (target === undefined) return { kind: "current-branch" };
  return target === null ? { kind: "targetless" } : { kind: "explicit", target };
}

function bindInput(input: BindInput, composition: LocalContractCompositionCapture) {
  const values = validated(() => requireInput(input, "Keis.bind input"));
  const allowed = values.forkOf === undefined ? ["markdown", "debt", "target", "after", "gates"] : ["forkOf", "target"];
  requireInput(values, "Keis.bind input", allowed);
  return validated(() => {
    const forkOf = values.forkOf;
    if (values.target !== undefined && values.target !== null && typeof values.target !== "string")
      throw new TypeError("target must be a string or null");
    const document = forkOf === undefined ? parseMarkdown(requireMarkdown(values.markdown)) : undefined;
    if (forkOf !== undefined && typeof forkOf !== "string") throw new TypeError("forkOf must be a ContractId");
    const derived = forkOf === undefined ? derivedGates(composition, gateNames(values.gates)) : undefined;
    return {
      forkOf: forkOf === undefined ? undefined : contractId(forkOf),
      document,
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
  const prepared = bindInput(input, composition);
  const hooks = derivedHooks(composition);
  const { forkOf, document, target } = prepared;
  const handle = (id: ContractId) => createHandle(id, scope, composition);
  const accumulator = new InvocationAccumulator();
  const projection = await (async (): Promise<BindOutcome | InvocationFailure> => {
    let completed: BindOutcome | InvocationFailure | undefined;
    let retirement: { error: unknown } | undefined;
    try {
      return await withGitDecodeChannel(
        scope,
        async (channel) => {
          completed = await (async (): Promise<BindOutcome | InvocationFailure> => {
            if (forkOf !== undefined) {
              const fork = await admitForkBindWithAppointment({
                scope,
                channel,
                progress: accumulator,
                sourceId: forkOf,
                ...(target === undefined ? {} : { target }),
              });
              if (fork.kind === "refused") return { kind: "refused", reason: compactReason(fork.refusal) };
              const admission = fork.admission;
              if (admission.kind !== "accepted")
                return admission.kind === "refused"
                  ? { kind: "refused", reason: compactReason(admission.refusal) }
                  : compactRetry(admission.reason);
              const id = admission.value.contractId;
              retainBindCoordinates(accumulator, admission);
              const value = await bindComplete(accumulator, id, scope, channel, admission, hooks, () =>
                observeRegion(scope, channel, id, fork.document.region).then((region) => bindValue(handle(id), region)),
              );
              return Object.defineProperty({ kind: "accepted" as const, contractId: id, ...value }, "kei", {
                value: value.kei,
                enumerable: false,
              });
            }
            if (document === undefined) throw new Error("Markdown bind requires its prepared document");
            return await markdownBind(prepared, document, hooks, scope, channel, accumulator, handle);
          })();
          if (completed.kind === "accepted" && accumulator.head(completed.contractId) === undefined)
            throw new Error("missing leading admission receipt");
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
  const projected = project<BindOutcome>("bind", accumulator.snapshot(), projection);
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
): Promise<BindOutcome | InvocationFailure> {
  const { debt, target, gates, after } = prepared;
  if (gates === undefined || after === undefined) throw new Error("Markdown bind requires prepared terms");
  const targetSelection = bindTargetSelection(target);
  const admission = await prepareMarkdownBind({
    scope,
    channel,
    document,
    gates,
    progress: accumulator,
    after,
    targetSelection,
    ...(debt === undefined ? {} : { debt }),
  });
  const leading = admission.admission === null ? admission.result : admission.admission.result;
  if (leading.kind !== "accepted")
    return leading.kind === "refused"
      ? { kind: "refused", reason: compactReason(leading.refusal) }
      : compactRetry(leading.reason);
  const id = leading.value.contractId;
  retainBindCoordinates(accumulator, leading);
  const value = await bindComplete(accumulator, id, scope, channel, leading, hooks, async () =>
    bindValue(handle(id), await observeRegion(scope, channel, id, document.region)),
  );
  return Object.defineProperty({ kind: "accepted" as const, contractId: id, ...value }, "kei", {
    value: value.kei,
    enumerable: false,
  });
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
