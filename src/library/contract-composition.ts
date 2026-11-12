/** @architectureCompositionRoot */
import { contractId, type ContractId } from "../core/facts/types.js";
import { withGitDecodeChannel } from "../git/read-observation.js";
import {
  contractCatalogueOperation,
  contractObservationOperation,
  type RepositoryScope,
} from "../protocol/operations.js";
import type { ContractObservation } from "../protocol/read/status.js";
import { resolveContract } from "./contract-address.js";
import { bindKei } from "./contract-creation.js";
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
  ContractResolveInput,
  ContractResolution,
  KeisOptions,
} from "./contract-types.js";
import { requireInput } from "./input.js";
import {
  validateContractWait,
  waitContractLocal,
  type ContractWaitInput,
  type ContractWaitResult,
} from "./contract-wait.js";
import { createKeiHandle, type Kei } from "./kei.js";
import { readContractValue } from "./outcome.js";
import { InvocationAccumulator } from "./invocation.js";
import {
  completeReconcile,
  completeRepoReconcile,
  reconcileException,
  type ReconcileCompletion,
  type RepoReconcileReport,
} from "./reconcile.js";
import { scopeForRepo, type Repo } from "./repo.js";

export type ReconcileInput = Readonly<{ contract?: string; retryHooks?: boolean }>;
export interface KeisReconcile {
  (input: ReconcileInput & Readonly<{ contract: string }>): Promise<ReconcileCompletion>;
  (input: ReconcileInput & Readonly<{ contract?: undefined }>): Promise<RepoReconcileReport>;
  (input: ReconcileInput): Promise<ReconcileCompletion | RepoReconcileReport>;
}

export type Keis = Readonly<{
  bind(input: BindInput): Promise<BindOutcome>;
  kei(input: Readonly<{ id: ContractId }>): Kei;
  resolve(input: ContractResolveInput): Promise<ContractResolution>;
  list(input?: ContractListInput): Promise<ContractList>;
  observe(input: ContractObservationInput): Promise<ContractObservation>;
  wait(input: ContractWaitInput): Promise<ContractWaitResult>;
  reconcile: KeisReconcile;
}>;

/** Captures one Repo and immutable Contract settings. */
export const Keis = Object.freeze({
  of(repo: Repo, input?: KeisOptions): Keis {
    const scope = scopeForRepo(repo);
    const composition = captureLocalContractComposition(input);
    return Object.freeze({
      bind: (operation: BindInput) => bindKei(scope, operation, createKeiHandle, composition),
      kei: (input: Readonly<{ id: ContractId }>) => {
        const values = requireInput(input, "Keis.kei input", ["id"]);
        if (typeof values.id !== "string") throw new TypeError("contract ID must be a string");
        return createKeiHandle(contractId(values.id), scope, composition);
      },
      resolve: (operation: ContractResolveInput) => resolveContract(scope, operation),
      list: (operation: ContractListInput = {}) => listKeis(scope, operation),
      observe: (operation: ContractObservationInput) => observeKei(scope, operation),
      wait: async (operation: ContractWaitInput) => await waitContractLocal(validateContractWait(scope, operation)),
      reconcile: reconcileOperation(scope, composition),
    });
  },
});

/**
 * The one public repair entry: an explicit Repo proves the Git world, the captured composition
 * supplies its Settings-derived hooks, and the same operation-local retryHooks choice stays
 * available. Omitted contract reconciles the complete world; a supplied one reconciles that
 * addressed Contract.
 */
function reconcileOperation(scope: RepositoryScope, composition: LocalContractCompositionCapture): KeisReconcile {
  function run(input: ReconcileInput & Readonly<{ contract: string }>): Promise<ReconcileCompletion>;
  function run(input: ReconcileInput & Readonly<{ contract?: undefined }>): Promise<RepoReconcileReport>;
  function run(input: ReconcileInput): Promise<ReconcileCompletion | RepoReconcileReport>;
  function run(input: ReconcileInput): Promise<ReconcileCompletion | RepoReconcileReport> {
    return reconcileKeiyaku(scope, input, composition);
  }
  return run;
}

async function reconcileKeiyaku(
  scope: RepositoryScope,
  input: ReconcileInput,
  composition: LocalContractCompositionCapture = captureLocalContractComposition(),
): Promise<ReconcileCompletion | RepoReconcileReport> {
  const values = requireInput(input, "Keis.reconcile input", ["contract", "retryHooks"]);
  const contract = values.contract;
  if (contract !== undefined && typeof contract !== "string") throw new TypeError("contract must be a string");
  if (values.retryHooks !== undefined && typeof values.retryHooks !== "boolean")
    throw new TypeError("retryHooks must be a boolean");
  const options = { scope, hooks: derivedHooks(composition), retryHooks: values.retryHooks ?? false };
  const accumulator = new InvocationAccumulator();
  const id = contract === undefined ? undefined : contractId(contract);
  try {
    return await withGitDecodeChannel<ReconcileCompletion | RepoReconcileReport>(
      scope,
      (channel) =>
        id === undefined
          ? completeRepoReconcile({ ...options, channel, accumulator })
          : completeReconcile({ ...options, channel, contractId: id, accumulator }),
      (error) => {
        if (id !== undefined) accumulator.recordChannelRetirement(id, error);
      },
    );
  } catch (error) {
    return reconcileException(error, accumulator, id);
  }
}

export async function listKeis(scope: RepositoryScope, input: ContractListInput): Promise<ContractList> {
  const values = requireInput(input, "Keis.list input");
  for (const key of Object.keys(values)) {
    if (key !== "limit") throw new TypeError(`Keis.list input has unknown field: ${key}`);
  }
  const limit = values.limit;
  if (limit === undefined) {
    return readContractValue(() =>
      withGitDecodeChannel(scope, (channel) => contractCatalogueOperation({ scope, channel })),
    );
  }
  if (typeof limit !== "number") throw new TypeError("Contract list limit must be a number");
  return readContractValue(() =>
    withGitDecodeChannel(scope, (channel) => contractCatalogueOperation({ scope, channel, limit })),
  );
}

export async function observeKei(
  scope: RepositoryScope,
  input: ContractObservationInput,
): Promise<ContractObservation> {
  const values = requireInput(input, "Keis.observe input");
  for (const key of Object.keys(values))
    if (key !== "id") throw new TypeError(`Keis.observe input has unknown field: ${key}`);
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
