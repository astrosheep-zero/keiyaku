/** @architectureCompositionRoot */
import { readAkumaRoster } from "../akuma/akuma.js";
import type { AkumaList, AkumaListInput } from "../akuma/akuma.js";
import { readAliases, type AliasBinding } from "../alias/index.js";
import type { AkumaAlias } from "../identity/selector.js";
import { localExecutionContext, type ExecutionContext } from "../akuma/requests.js";
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
  killAkumaOn,
  selectionSeam,
  statusAkuma,
  tellAkumaOn,
  askAkumaOn,
  waitAkumaOn,
  type SelectionSeam,
  type AkumaHistoryInput as LibraryAkumaHistoryInput,
  type AkumaHistoryResult,
  type AkumaKillInput as LibraryAkumaKillInput,
  type AkumaKillResult,
  type AkumaObservation,
  type AkumaObservationStage,
  type AkumaTellInput as LibraryAkumaTellInput,
  type AkumaTellResult,
  type AkumaAskInput as LibraryAkumaAskInput,
  type AkumaAskResult,
  type AkumaWaitInput as LibraryAkumaWaitInput,
  type AkumaWaitResult,
} from "./selection.js";
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
export type AkumaAskInput<T = string> = Omit<LibraryAkumaAskInput<T>, "path">;
export type AkumaHistoryInput = Omit<LibraryAkumaHistoryInput, "path">;
export type CallInput = Omit<LibraryCallInput, "path">;
export type ForkInput = Omit<LibraryForkInput, "path">;

export type {
  AkumaHistoryResult,
  AkumaKillResult,
  AkumaObservation,
  AkumaObservationStage,
  AkumaTellResult,
  AkumaAskResult,
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
/** The existing native wait-observation seam, exposed type-only for CLI composition. */
export type { WaitObserver, WaitObservedAkuma, WaitSelectedAkuma } from "../akuma/akuma.js";

export type Akumas = AkumasHandle;

class AkumasHandle {
  #world: WorldRoot;
  #execution: ExecutionContext;
  #selection: SelectionSeam;

  constructor(world: WorldRoot, execution: ExecutionContext) {
    this.#world = world;
    this.#execution = execution;
    // One typed route seam captured at construction: no operation re-derives it.
    this.#selection = selectionSeam(execution);
    Object.freeze(this);
  }

  async list(input?: AkumaListInput): Promise<AkumaList> {
    const path = await World.prove(this.#world);
    const roster = await readAkumaRoster(path, input);
    if (roster.rows.length === 0) return roster;
    return withRosterAliases(roster, await readAliases(path));
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
    return tellAkumaOn(this.#selection, this.withWorld(input, "Akumas.tell input") as LibraryAkumaTellInput);
  }

  ask<T = string>(input: AkumaAskInput<T>): Promise<AkumaAskResult<T>> {
    return askAkumaOn(this.#selection, this.withWorld(input, "Akumas.ask input") as LibraryAkumaAskInput<T>);
  }

  wait(input: AkumaWaitInput): Promise<AkumaWaitResult> {
    return waitAkumaOn(this.#selection, this.withWorld(input, "Akumas.wait input") as LibraryAkumaWaitInput);
  }

  kill(input: AkumaKillInput): Promise<AkumaKillResult> {
    return killAkumaOn(this.#selection, this.withWorld(input, "Akumas.kill input") as LibraryAkumaKillInput);
  }

  history(input: AkumaHistoryInput): Promise<AkumaHistoryResult> {
    return historyAkuma(this.withWorld(input, "Akumas.history input") as LibraryAkumaHistoryInput);
  }

  private withWorld(input: unknown, label: string): Record<string, unknown> {
    const values = requireInput(input, label);
    if (Object.hasOwn(values, "path"))
      throw new TypeError(`${label} does not accept path; select World with Akumas.of`);
    return { ...values, path: this.#world };
  }
}

/**
 * Upper World composition attaches the frozen Alias context to the lower
 * roster's native membership and semantic order without reopening its extent.
 */
function withRosterAliases(roster: AkumaList, bindings: readonly AliasBinding[]): AkumaList {
  const byId = new Map<string, AkumaAlias[]>();
  for (const binding of bindings) {
    const aliases = byId.get(binding.akuId) ?? [];
    aliases.push(binding.alias);
    byId.set(binding.akuId, aliases);
  }
  return { ...roster, rows: roster.rows.map((row) => ({ ...row, aliases: byId.get(row.id) ?? [] })) };
}

/**
 * The one Akumas composition. Public `of` fixes local execution; CLI and Body pass their captured
 * internal channel through `akumasWithExecution` instead of a second constructor.
 */
export function akumasWithExecution(world: WorldRoot, execution: ExecutionContext): Akumas {
  if (typeof world !== "string") throw new TypeError("Akumas.of world must be a WorldRoot");
  return new AkumasHandle(world, execution);
}

export const Akumas = Object.freeze({
  of(world: WorldRoot): Akumas {
    return akumasWithExecution(world, localExecutionContext());
  },
});
