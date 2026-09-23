/** @architectureCompositionRoot */
import {
  bindKeiyaku,
  captureLocalContractComposition,
  selectKeiyaku,
  listKeiyaku,
  observeKeiyaku,
  type LocalContractCompositionCapture,
} from "./contract.js";
import type {
  BindInput,
  BindResult,
  ContractList,
  ContractListInput,
  ContractObservationInput,
  KeiyakuSelectInput,
  LocalContractComposition,
} from "./contract-types.js";
import type { ContractObservation } from "./contract.js";
import type { Keiyaku, createKeiyakuHandle } from "./contract-handle.js";
import {
  executionChannel,
  libraryExecution,
  localExecutionContext,
  type ExecutionContext,
  type LibraryExecution,
} from "../akuma/requests.js";
import { requireInput } from "./input.js";

export type KeiyakuWithInput = LocalContractComposition & Readonly<{ execution?: LibraryExecution }>;

export type KeiyakuLibrary = Readonly<{
  bind(input: BindInput): Promise<BindResult>;
  select(input: KeiyakuSelectInput): Keiyaku;
  list(input: ContractListInput): Promise<ContractList>;
  observe(input: ContractObservationInput): Promise<ContractObservation>;
}>;

/** Contract-only composition for one immutable execution channel and local policy. */
export function composeContractLibrary(
  input: KeiyakuWithInput | undefined,
  createHandle: typeof createKeiyakuHandle,
): KeiyakuLibrary {
  const values = requireInput(input === undefined ? {} : input, "Keiyaku.with input", [
    "execution",
    "actor",
    "hooks",
    "requireBranchesToBeUpToDate",
  ]);
  const execution: ExecutionContext =
    values.execution === undefined ? localExecutionContext() : libraryExecution(values.execution);
  const captured = Object.freeze({ channel: executionChannel(execution) });
  const composition: LocalContractCompositionCapture = captureLocalContractComposition({
    ...(values.actor === undefined ? {} : { actor: values.actor as string }),
    ...(values.hooks === undefined ? {} : { hooks: values.hooks as NonNullable<LocalContractComposition["hooks"]> }),
    ...(values.requireBranchesToBeUpToDate === undefined
      ? {}
      : { requireBranchesToBeUpToDate: values.requireBranchesToBeUpToDate as boolean }),
  });
  return Object.freeze({
    bind: (operation: BindInput) => bindKeiyaku(operation, createHandle, captured, composition),
    select: (operation: KeiyakuSelectInput) => selectKeiyaku(operation, createHandle, captured, composition),
    list: (operation: ContractListInput) => listKeiyaku(operation),
    observe: (operation: ContractObservationInput) => observeKeiyaku(operation),
  });
}
