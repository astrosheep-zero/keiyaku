import { decodeContractDocument } from "../body/decode.js";
import { contractId, type ContractId } from "../core/facts/types.js";
import { withGitDecodeChannel } from "../git/read-observation.js";
import { admitForkBindWithAppointment, prepareMarkdownBind } from "./bind.js";
import { actorOption, normalizedGates, normalizedList, requireInput, requireMarkdown, taskOption } from "./input.js";
import { completionInput, completeHolderMutation, completeMutation, type MutationResult } from "./mutation.js";
import { requireAccepted } from "./refusal.js";
import { observeRegion, type RegionObservation } from "./region.js";
import { Repo, scopeForRepo } from "./repo.js";
import { worktreeHooksOption } from "./configuration.js";
import type { WorktreeHooks } from "./configuration.js";
import type { RepositoryScope } from "../protocol/operations.js";

type BindInput = Readonly<{
  repo: Repo;
  markdown?: unknown;
  forkOf?: unknown;
  task?: unknown;
  target?: unknown;
  workspace?: unknown;
  actor?: unknown;
  after?: unknown;
  gates?: unknown;
  hooks?: WorktreeHooks;
}>;
type BindResult<Handle> = Readonly<Omit<MutationResult<Handle>, "value"> & { keiyaku: Handle } & RegionObservation>;
type HandleFactory<Handle> = (contractId: ContractId, scope: RepositoryScope) => Handle;

function acceptedBindResult<Handle>(result: MutationResult<Handle>, region: RegionObservation): BindResult<Handle> {
  const { facts, head, lags, settlementLags, recoverySnapshot, pending, cleanup, leak, seatClose } = result;
  return {
    kind: "accepted",
    facts,
    head,
    keiyaku: result.value,
    lags,
    settlementLags,
    pending,
    ...(recoverySnapshot === undefined ? {} : { recoverySnapshot }),
    ...(cleanup === undefined ? {} : { cleanup }),
    ...(leak === undefined ? {} : { leak }),
    ...(seatClose === undefined || seatClose.length === 0 ? {} : { seatClose }),
    ...region,
  };
}

export async function bindKeiyaku<Handle>(
  input: BindInput,
  createHandle: HandleFactory<Handle>,
): Promise<BindResult<Handle>> {
  const values = requireInput(input, "Keiyaku.bind input");
  const hooks = worktreeHooksOption(values.hooks);
  const forkOf = values.forkOf;
  if (forkOf !== undefined) {
    for (const key of Object.keys(values)) {
      if (!["repo", "forkOf", "target", "workspace", "actor", "hooks"].includes(key)) {
        throw new TypeError(`fork bind input has unknown field: ${key}`);
      }
    }
    if (typeof forkOf !== "string") throw new TypeError("forkOf must be a ContractId");
    let sourceId: ContractId;
    try {
      sourceId = contractId(forkOf);
    } catch (error) {
      throw new TypeError(error instanceof Error ? error.message : "forkOf must be a ContractId");
    }
    const sourceScope = scopeForRepo(values.repo);
    if ((values.workspace ?? "worktree") !== "worktree") throw new TypeError("workspace must be worktree");
    const target = values.target;
    if (target !== undefined && typeof target !== "string") throw new TypeError("target must be a string");
    const actor = actorOption(values.actor);
    return withGitDecodeChannel(sourceScope, async (channel) => {
      const fork = await admitForkBindWithAppointment({
        scope: sourceScope,
        channel,
        sourceId,
        ...(target === undefined ? {} : { target }),
        ...actor,
      });
      const admission = requireAccepted(fork.admission);
      const id = admission.value.contractId;
      const toHandle = ({ contractId: contract }: { contractId: ContractId }): Handle =>
        createHandle(contract, sourceScope);
      const result = await completeMutation({
        ...completionInput(sourceScope, channel, id, toHandle, hooks),
        accepted: admission,
      });
      return acceptedBindResult(result, await observeRegion(sourceScope, channel, id, fork.document.region));
    });
  }
  return bindMarkdownFromValues(values, "targetless", createHandle);
}

export function parseMarkdownBindDocument(markdown: string) {
  return decodeContractDocument(requireMarkdown(markdown));
}

/** Internal CLI composition; not exported from the package root. */
export async function bindFromCli<Handle>(
  input: BindInput,
  createHandle: HandleFactory<Handle>,
): Promise<BindResult<Handle>> {
  const values = requireInput(input, "Keiyaku.bind input");
  return values.forkOf !== undefined
    ? bindKeiyaku(input, createHandle)
    : bindMarkdownFromValues(values, "current-branch", createHandle);
}

async function bindMarkdownFromValues<Handle>(
  values: Record<string, unknown>,
  omittedTarget: "targetless" | "current-branch",
  createHandle: HandleFactory<Handle>,
): Promise<BindResult<Handle>> {
  const hooks = worktreeHooksOption(values.hooks);
  const scope = scopeForRepo(values.repo as Repo);
  const task = taskOption(values.task);
  const document = parseMarkdownBindDocument(requireMarkdown(values.markdown));
  if ((values.workspace ?? "worktree") !== "worktree") throw new TypeError("workspace must be worktree");
  const target = values.target;
  if (target !== undefined && typeof target !== "string") throw new TypeError("target must be a string");
  const actor = actorOption(values.actor);
  const gates = normalizedGates(values.gates);
  const after = normalizedList(values.after, "after", contractId);
  const targetSelection = target !== undefined ? { kind: "explicit" as const, target } : { kind: omittedTarget };
  return withGitDecodeChannel(scope, async (channel) => {
    const admission = await prepareMarkdownBind({
      scope,
      channel,
      document,
      gates,
      after,
      workspace: "worktree",
      targetSelection,
      ...(task === undefined ? {} : { task }),
      ...actor,
    });
    const accepted = requireAccepted(admission.admission === null ? admission.result : admission.admission.result);
    const id = accepted.value.contractId;
    const toHandle = ({ contractId: contract }: { contractId: ContractId }): Handle => createHandle(contract, scope);
    const result =
      admission.admission === null
        ? await completeMutation({ ...completionInput(scope, channel, id, toHandle, hooks), accepted })
        : await completeHolderMutation({
            completion: completionInput(scope, channel, id, toHandle, hooks),
            admission: admission.admission,
            requireAccepted,
          });
    return acceptedBindResult(result, await observeRegion(scope, channel, id, document.region));
  });
}
