/** @architectureCompositionRoot */
import { localExecutionContext, type ExecutionContext } from "../akuma/requests.js";
import { decodeContractDocument } from "../body/decode.js";
import { regionWarnings } from "../body/region.js";
import { contractId, type ContractId } from "../core/facts/types.js";
import type { WorktreeHooks } from "../git/hooks.js";
import { withGitDecodeChannel, type GitDecodeChannel } from "../git/read-observation.js";
import type { IntentOutcome, RepositoryScope } from "../protocol/operations.js";
import { executionStop, isOperationalFailure, isOperationalStop } from "../protocol/progress.js";
import { readManagedWorktreeAppointment, type ContractWorkspaceLocation } from "../workspace-place.js";
import { admitForkBindWithAppointment, prepareMarkdownBind } from "./bind.js";
import type { BindOutcome, BindValue } from "./contract-outcomes.js";
import { acceptedOutcome, conclusions, expected, retainAdmission } from "./contract-outcomes.js";
import {
  captureLocalContractComposition,
  derivedGates,
  derivedHooks,
  gateNames,
  type LocalContractCompositionCapture,
} from "./contract-settings.js";
import type { BindInput } from "./contract-types.js";
import { actorOption, normalizedList, requireInput, requireMarkdown, taskOption } from "./input.js";
import { InvocationAccumulator } from "./invocation.js";
import type { Keiyaku, createKeiyakuHandle } from "./keiyaku.js";
import { project, validated, type OutcomeProjection } from "./outcome.js";
import { completeReconcile } from "./reconcile.js";
import type { OperationRefusals } from "./refusal.js";
import { observeRegion, type RegionObservation } from "./region.js";
import { scopeForRepo } from "./repo.js";

type AcceptedIntent<Value> = Extract<IntentOutcome<Value>, { kind: "accepted" }>;
function bindInput(input: BindInput, composition: LocalContractCompositionCapture) {
  return validated(() => {
    const values = requireInput(input, "Keiyaku.bind input");
    const forkOf = values.forkOf;
    const allowed =
      forkOf === undefined
        ? ["repo", "markdown", "task", "target", "workspace", "actor", "after", "gates"]
        : ["repo", "forkOf", "target", "workspace", "actor"];
    requireInput(input, "Keiyaku.bind input", allowed);
    if ((values.workspace ?? "worktree") !== "worktree") throw new TypeError("workspace must be worktree");
    if (values.target !== undefined && typeof values.target !== "string")
      throw new TypeError("target must be a string");
    const actor = actorOption(values.actor);
    const document = forkOf === undefined ? parseMarkdown(requireMarkdown(values.markdown)) : undefined;
    if (forkOf !== undefined) {
      if (typeof forkOf !== "string") throw new TypeError("forkOf must be a ContractId");
    }
    return {
      forkOf: forkOf === undefined ? undefined : contractId(forkOf as string),
      scope: scopeForRepo(values.repo),
      document,
      actor,
      target: values.target as string | undefined,
      task: forkOf === undefined ? taskOption(values.task) : undefined,
      gates: forkOf === undefined ? derivedGates(composition, gateNames(values.gates)) : undefined,
      after: forkOf === undefined ? normalizedList(values.after, "after", contractId) : undefined,
    };
  });
}

export async function bindKeiyaku(
  input: BindInput,
  createHandle: typeof createKeiyakuHandle,
  execution: ExecutionContext = localExecutionContext(),
  composition: LocalContractCompositionCapture = captureLocalContractComposition(),
): Promise<BindOutcome> {
  const prepared = bindInput(input, composition);
  const hooks = derivedHooks(composition);
  const { forkOf, scope, document, target, actor } = prepared;
  const handle = (id: ContractId) => createHandle(id, scope, execution, composition);
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
              if (fork.kind === "refused") return { kind: "refused", refusal: fork.refusal };
              const admission = fork.admission;
              if (admission.kind !== "accepted") return expected(undefined, admission);
              const id = admission.value.contractId;
              accumulator.extendConclusions(id, { keiyaku: handle(id) });
              const value = await bindComplete(accumulator, id, scope, channel, admission, hooks, () =>
                observeRegion(scope, channel, id, fork.document.region).then((region) =>
                  bindValue(handle(id), region, []),
                ),
              );
              return acceptedOutcome("bind", id, accumulator, value);
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
  return projected.outcome as BindOutcome;
}

function bindValue(
  keiyaku: Keiyaku,
  region: RegionObservation,
  warnings: readonly string[],
  workspace?: ContractWorkspaceLocation,
  appointmentLag?: readonly { path: string; diagnostic: string }[],
): BindValue {
  const base = {
    keiyaku,
    ...(workspace === undefined ? {} : { workspace }),
    ...(warnings.length === 0 ? {} : { warnings }),
    ...region,
  };
  void appointmentLag;
  return base;
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
  retainAdmission(accumulator, id, leading, false);
  await reconcileAll(accumulator, id, scope, channel, hooks);
  try {
    const appointment = await readManagedWorktreeAppointment(scope, id);
    if (appointment.kind === "appointed")
      accumulator.extendConclusions(id, {
        workspace: { kind: "worktree", path: appointment.path },
      });
  } catch (error) {
    if (!isOperationalStop(error, scope.signal)) throw error;
    accumulator.recordStop(executionStop(id, "reconciliation", error, scope.signal));
  }
  const built = { ...(await value()), ...accumulator.conclusions(id) } as BindValue;
  accumulator.extendConclusions(id, conclusions(built));
  return built;
}

async function reconcileAll(
  accumulator: InvocationAccumulator,
  id: ContractId,
  scope: RepositoryScope,
  channel: GitDecodeChannel,
  hooks: WorktreeHooks,
): Promise<void> {
  for (const contract of [...new Set([id, ...accumulator.snapshot().affected])]) {
    try {
      accumulator.observe({ kind: "stage", contractId: contract, stage: "reconciliation", state: "started" });
      const report = await (async () => {
        try {
          return await completeReconcile({
            scope,
            channel,
            contractId: contract,
            hooks,
            retryHooks: false,
            progress: accumulator,
          });
        } finally {
          accumulator.observe({ kind: "stage", contractId: contract, stage: "reconciliation", state: "finished" });
        }
      })();
      void report;
    } catch (error) {
      if (!isOperationalStop(error, scope.signal)) throw error;
      accumulator.recordStop(executionStop(contract, "reconciliation", error, scope.signal));
    }
  }
}

// eslint-disable-next-line max-params -- Keep this local operation's custody, admission, and policy witnesses explicit.
async function markdownBind(
  prepared: ReturnType<typeof bindInput>,
  document: ReturnType<typeof parseMarkdown>,
  hooks: WorktreeHooks,
  scope: RepositoryScope,
  channel: GitDecodeChannel,
  accumulator: InvocationAccumulator,
  handle: (id: ContractId) => Keiyaku,
): Promise<OutcomeProjection<"bind", BindValue, OperationRefusals["bind"]>> {
  const { task, target, actor, gates, after } = prepared;
  if (gates === undefined || after === undefined) throw new Error("Markdown bind requires prepared terms");
  const targetSelection =
    target !== undefined ? { kind: "explicit" as const, target } : { kind: "targetless" as const };
  const admission = await prepareMarkdownBind({
    scope,
    channel,
    document,
    gates,
    progress: accumulator,
    after,
    workspace: "worktree",
    targetSelection,
    ...(task === undefined ? {} : { task }),
    ...actor,
  });
  const leading = admission.admission === null ? admission.result : admission.admission.result;
  if (leading.kind !== "accepted") return expected(undefined, leading);
  const id = leading.value.contractId;
  accumulator.extendConclusions(id, { keiyaku: handle(id), warnings: regionWarnings(document.region) });
  const value = await bindComplete(accumulator, id, scope, channel, leading, hooks, async () =>
    bindValue(handle(id), await observeRegion(scope, channel, id, document.region), regionWarnings(document.region)),
  );
  return acceptedOutcome("bind", id, accumulator, value);
}

function parseMarkdown(markdown: string) {
  return decodeContractDocument(markdown, { requireTimeout: true });
}
