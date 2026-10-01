/** @architectureCompositionRoot */
import { localExecutionContext, type ExecutionContext, type LibraryExecution } from "../akuma/requests.js";
import { contractId, type ContractId } from "../core/facts/types.js";
import { withGitDecodeChannel } from "../git/read-observation.js";
import {
  contractCatalogueOperation,
  contractObservationOperation,
  contractsOperation,
} from "../protocol/operations.js";
import type { ContractObservation } from "../protocol/read/status.js";
import { bindKeiyaku } from "./contract-creation.js";
import type { BindOutcome } from "./contract-outcomes.js";
import {
  captureLocalContractComposition,
  derivedHooks,
  type LocalContractCompositionCapture,
} from "./contract-settings.js";
import type {
  BindInput,
  ContractList,
  ContractListInput,
  ContractObservationInput,
  KeiyakuSelectInput,
  LocalContractComposition,
} from "./contract-types.js";
import { requireInput } from "./input.js";
import type { Keiyaku, createKeiyakuHandle } from "./keiyaku.js";
import { KeiyakuError, errorCategory } from "./outcome.js";
import {
  completeReconcile,
  completeRepoReconcile,
  type ReconcileCompletion,
  type RepoReconcileReport,
} from "./reconcile.js";
import { scopeForRepo, type Repo } from "./repo.js";

export type ReconcileInput = Readonly<{ repo: Repo; contract?: string; retryHooks?: boolean }>;
interface KeiyakuLibraryReconcile {
  (input: ReconcileInput & Readonly<{ contract: string }>): Promise<ReconcileCompletion>;
  (input: ReconcileInput & Readonly<{ contract?: undefined }>): Promise<RepoReconcileReport>;
  (input: ReconcileInput): Promise<ReconcileCompletion | RepoReconcileReport>;
}

export type KeiyakuLibrary = Readonly<{
  bind(input: BindInput): Promise<BindOutcome>;
  select(input: KeiyakuSelectInput): Keiyaku;
  list(input: ContractListInput): Promise<ContractList>;
  observe(input: ContractObservationInput): Promise<ContractObservation>;
  reconcile: KeiyakuLibraryReconcile;
}>;

/**
 * The one private Contract composition constructor. `Keiyaku.with` fixes local execution; CLI and
 * Body pass their captured internal channel explicitly here instead of a second constructor. The
 * carrier is a positional argument, never a field of the public construction input, so no runtime
 * value reaching the public surface can select a private channel.
 */
export function composeContractLibrary(
  execution: LibraryExecution,
  createHandle: typeof createKeiyakuHandle,
  input?: LocalContractComposition,
): KeiyakuLibrary {
  const composition = captureLocalContractComposition(input);
  return Object.freeze({
    bind: (operation: BindInput) => bindKeiyaku(operation, createHandle, execution, composition),
    select: (operation: KeiyakuSelectInput) => selectKeiyaku(operation, createHandle, execution, composition),
    list: (operation: ContractListInput) => listKeiyaku(operation),
    observe: (operation: ContractObservationInput) => observeKeiyaku(operation),
    reconcile: reconcileOperation(composition),
  });
}

function selectKeiyaku(
  input: KeiyakuSelectInput,
  createHandle: typeof createKeiyakuHandle,
  execution: ExecutionContext = localExecutionContext(),
  composition: LocalContractCompositionCapture = captureLocalContractComposition(),
): Keiyaku {
  const values = requireInput(input, "Keiyaku.with().select input");
  const scope = scopeForRepo(values.repo);
  if (typeof values.id !== "string") throw new TypeError("contract ID must be a string");
  return createHandle(contractId(values.id), scope, execution, composition);
}

/**
 * The one public repair entry: an explicit Repo proves the Git world, the captured composition
 * supplies its Settings-derived hooks, and the same operation-local retryHooks choice stays
 * available. Omitted contract reconciles the complete world; a supplied one reconciles that
 * addressed Contract.
 */
function reconcileOperation(composition: LocalContractCompositionCapture): KeiyakuLibraryReconcile {
  function run(input: ReconcileInput & Readonly<{ contract: string }>): Promise<ReconcileCompletion>;
  function run(input: ReconcileInput & Readonly<{ contract?: undefined }>): Promise<RepoReconcileReport>;
  function run(input: ReconcileInput): Promise<ReconcileCompletion | RepoReconcileReport>;
  function run(input: ReconcileInput): Promise<ReconcileCompletion | RepoReconcileReport> {
    return reconcileKeiyaku(input, composition);
  }
  return run;
}

async function reconcileKeiyaku(
  input: ReconcileInput,
  composition: LocalContractCompositionCapture = captureLocalContractComposition(),
): Promise<ReconcileCompletion | RepoReconcileReport> {
  const values = requireInput(input, "Keiyaku.with().reconcile input", ["repo", "contract", "retryHooks"]);
  const scope = scopeForRepo(values.repo);
  const contract = values.contract;
  if (contract !== undefined && typeof contract !== "string") throw new TypeError("contract must be a string");
  if (values.retryHooks !== undefined && typeof values.retryHooks !== "boolean")
    throw new TypeError("retryHooks must be a boolean");
  const options = { scope, hooks: derivedHooks(composition), retryHooks: values.retryHooks ?? false };
  if (contract === undefined) {
    return await withGitDecodeChannel(scope, (channel) => completeRepoReconcile({ ...options, channel }));
  }
  const id = contractId(contract);
  return await readContractValue(() =>
    withGitDecodeChannel(scope, (channel) => completeReconcile({ ...options, channel, contractId: id })),
  );
}

export async function listKeiyaku(input: ContractListInput): Promise<ContractList> {
  const values = requireInput(input, "Keiyaku.with().list input");
  for (const key of Object.keys(values)) {
    if (key !== "repo" && key !== "limit") throw new TypeError(`Keiyaku.with().list input has unknown field: ${key}`);
  }
  const scope = scopeForRepo(values.repo);
  if (values.limit === undefined) {
    const board = await readContractValue(() =>
      withGitDecodeChannel(scope, (channel) => contractsOperation({ scope, channel })),
    );
    return { ...board, hasMore: false };
  }
  if (typeof values.limit !== "number") throw new TypeError("Contract list limit must be a number");
  return readContractValue(() =>
    withGitDecodeChannel(scope, (channel) =>
      contractCatalogueOperation({ scope, channel, limit: values.limit as number }),
    ),
  );
}

export async function observeKeiyaku(input: ContractObservationInput): Promise<ContractObservation> {
  const values = requireInput(input, "Keiyaku.observe input");
  for (const key of Object.keys(values))
    if (key !== "repo" && key !== "id") throw new TypeError(`Keiyaku.observe input has unknown field: ${key}`);
  const scope = scopeForRepo(values.repo);
  if (typeof values.id !== "string") throw new TypeError("contract ID must be a string");
  let id: ContractId;
  try {
    id = contractId(values.id);
  } catch (error) {
    throw new TypeError(error instanceof Error ? error.message : "contract ID is invalid");
  }
  return readContractValue(() =>
    withGitDecodeChannel(scope, (channel) => contractObservationOperation({ scope, channel, contractId: id })),
  );
}

export async function readContractValue<Value>(operation: () => Promise<Value>): Promise<Value> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof KeiyakuError) throw error;
    throw new KeiyakuError(errorCategory(error), error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}
