/** @architectureCompositionRoot */
import { readAkumaCatalog } from "../akuma/akuma.js";
import type { AkumaList, AkumaListInput } from "../akuma/akuma.js";
import {
  libraryExecution,
  localExecutionContext,
  type ExecutionContext,
  type LibraryExecution,
} from "../akuma/requests.js";
import type {
  CallInput as LibraryCallInput,
  CallResult,
  CallWaitHead,
  DispatchStage,
  ForkInput as LibraryForkInput,
  ForkResult,
} from "./akuma-creation.js";
import { callAkumas, forkAkumas } from "./akuma-creation.js";
import {
  historyAkuma,
  interruptAkuma,
  killAkuma,
  statusAkuma,
  tellAkuma,
  waitAkuma,
  type AkumaHistoryInput as LibraryAkumaHistoryInput,
  type AkumaHistoryResult,
  type AkumaInterruptInput as LibraryAkumaInterruptInput,
  type AkumaInterruptResult,
  type AkumaKillInput as LibraryAkumaKillInput,
  type AkumaKillResult,
  type AkumaObservation,
  type AkumaObservationStage,
  type AkumaTellInput as LibraryAkumaTellInput,
  type AkumaTellResult,
  type AkumaWaitInput as LibraryAkumaWaitInput,
  type AkumaWaitResult,
} from "./fleet.js";
import { requireInput } from "./input.js";
import type { AkumaAddressInput as LibraryAkumaAddressInput, AkumaWorldScopeRefusal } from "./address.js";
export { AkumaWorldScopeError, AkumaAddressError } from "./address.js";
import type { TellResult, TellWake } from "../akuma/akuma.js";
import type { DispatchAssociation } from "../dispatch/association.js";
import type { CreatedTaskObservation } from "../task/created-observation.js";
import { World, type WorldRoot } from "../world.js";

export type AkumaAddressInput = Omit<LibraryAkumaAddressInput, "path">;
export type AkumaWaitInput = Omit<LibraryAkumaWaitInput, "path">;
export type AkumaKillInput = Omit<LibraryAkumaKillInput, "path">;
export type AkumaTellInput = Omit<LibraryAkumaTellInput, "path">;
export type AkumaInterruptInput = Omit<LibraryAkumaInterruptInput, "path">;
export type AkumaHistoryInput = Omit<LibraryAkumaHistoryInput, "path">;
export type CallInput = Omit<LibraryCallInput, "path">;
export type ForkInput = Omit<LibraryForkInput, "path">;
export type AkumasOfInput = Readonly<{ execution?: LibraryExecution }>;

export type {
  AkumaHistoryResult,
  AkumaInterruptResult,
  AkumaKillResult,
  AkumaObservation,
  AkumaObservationStage,
  AkumaTellResult,
  AkumaWaitResult,
  CallResult,
  CallWaitHead,
  CreatedTaskObservation,
  DispatchStage,
  DispatchAssociation,
  ForkResult,
  TellResult,
  TellWake,
};
export type { AkumaWorldScopeRefusal };
export type { AkumaList, AkumaListInput };

export type Akumas = AkumasHandle;

class AkumasHandle {
  #world: WorldRoot;
  #execution: ExecutionContext;

  constructor(world: WorldRoot, execution: ExecutionContext) {
    this.#world = world;
    this.#execution = execution;
    Object.freeze(this);
  }

  async list(input?: AkumaListInput): Promise<AkumaList> {
    return readAkumaCatalog(await World.prove(this.#world), input);
  }

  call(input: CallInput): Promise<CallResult> {
    return callAkumas(this.withWorld(input, "Akumas.call input") as LibraryCallInput, this.#execution);
  }

  fork(input: ForkInput): Promise<ForkResult> {
    return forkAkumas(this.withWorld(input, "Akumas.fork input") as LibraryForkInput);
  }

  status(input: AkumaAddressInput): Promise<AkumaObservation> {
    return statusAkuma(this.withWorld(input, "Akumas.status input") as LibraryAkumaAddressInput);
  }

  tell(input: AkumaTellInput): Promise<AkumaTellResult> {
    return tellAkuma(this.withWorld(input, "Akumas.tell input") as LibraryAkumaTellInput, this.#execution);
  }

  wait(input: AkumaWaitInput): Promise<AkumaWaitResult> {
    return waitAkuma(this.withWorld(input, "Akumas.wait input") as LibraryAkumaWaitInput, this.#execution);
  }

  kill(input: AkumaKillInput): Promise<AkumaKillResult> {
    return killAkuma(this.withWorld(input, "Akumas.kill input") as LibraryAkumaKillInput, this.#execution);
  }

  history(input: AkumaHistoryInput): Promise<AkumaHistoryResult> {
    return historyAkuma(this.withWorld(input, "Akumas.history input") as LibraryAkumaHistoryInput);
  }

  interrupt(input: AkumaInterruptInput): Promise<AkumaInterruptResult> {
    return interruptAkuma(this.withWorld(input, "Akumas.interrupt input") as LibraryAkumaInterruptInput);
  }

  private withWorld(input: unknown, label: string): Record<string, unknown> {
    const values = requireInput(input, label);
    if (Object.hasOwn(values, "path"))
      throw new TypeError(`${label} does not accept path; select World with Akumas.of`);
    return { ...values, path: this.#world };
  }
}

function executionFor(input?: AkumasOfInput): ExecutionContext {
  const values = requireInput(input === undefined ? {} : input, "Akumas.of input", ["execution"]);
  return values.execution === undefined ? localExecutionContext() : libraryExecution(values.execution);
}

export const Akumas = Object.freeze({
  of(world: WorldRoot, input?: AkumasOfInput): Akumas {
    if (typeof world !== "string") throw new TypeError("Akumas.of world must be a WorldRoot");
    return new AkumasHandle(world, executionFor(input));
  },
});
