/** @architectureCompositionRoot */
import type { AkumaList, AkumaListInput } from "../akuma/akuma.js";
import { readAkumaRoster } from "../akuma/akuma.js";
import type { TellResult, TellWake } from "../akuma/body.js";
import { localExecutionContext, type ExecutionContext } from "../akuma/requests.js";
import { readAliases, type AliasBinding } from "../alias/index.js";
import type { DispatchAssociation } from "../dispatch/association.js";
import type { AkumaAlias } from "../identity/selector.js";
import type { CreatedTaskObservation } from "../task/created-observation.js";
import { World, type WorldRoot } from "../world.js";
import type { AkumaAddressInput, AkumaWorldScopeRefusal } from "./address.js";
import type { CallInput, CallResult, CallWaitHead, DispatchStage, ForkInput, ForkResult } from "./akuma-creation.js";
import { callAkumas, forkAkumas } from "./akuma-creation.js";
import { requireInput } from "./input.js";
import {
  askAkumaOn,
  historyAkuma,
  killAkumaOn,
  selectionSeam,
  statusAkuma,
  tellAkumaOn,
  waitAkumaOn,
  type AkumaAskInput,
  type AkumaAskResult,
  type AkumaHistoryInput,
  type AkumaHistoryResult,
  type AkumaKillInput,
  type AkumaKillResult,
  type AkumaObservation,
  type AkumaObservationStage,
  type AkumaTellInput,
  type AkumaTellResult,
  type AkumaWaitInput,
  type AkumaWaitResult,
  type SelectionSeam,
} from "./selection.js";

export { AkumaAddressError, AkumaWorldScopeError } from "./address.js";

export type { AkumaAddressInput } from "./address.js";
export type { CallInput, ForkInput } from "./akuma-creation.js";
export type { AkumaAskInput, AkumaHistoryInput, AkumaKillInput, AkumaTellInput, AkumaWaitInput } from "./selection.js";
export type {
  AkumaAskResult,
  AkumaHistoryResult,
  AkumaKillResult,
  AkumaList,
  AkumaListInput,
  AkumaObservation,
  AkumaObservationStage,
  AkumaTellResult,
  AkumaWaitResult,
  AkumaWorldScopeRefusal,
  CallResult,
  CallWaitHead,
  CreatedTaskObservation,
  DispatchAssociation,
  DispatchStage,
  ForkResult,
  TellResult,
  TellWake,
};
/** The existing native wait-observation seam, exposed type-only for CLI composition. */
export type { WaitObservedAkuma, WaitObserver, WaitSelectedAkuma } from "../akuma/akuma-wait.js";

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
    return callAkumas(this.withWorld(input, "Akumas.call input"), this.#execution);
  }

  fork(input: ForkInput): Promise<ForkResult> {
    return forkAkumas(this.withWorld(input, "Akumas.fork input"));
  }

  status(input: AkumaAddressInput): Promise<AkumaObservation> {
    return statusAkuma(this.withWorld(input, "Akumas.status input"));
  }

  tell(input: AkumaTellInput): Promise<AkumaTellResult> {
    return tellAkumaOn(this.#selection, this.withWorld(input, "Akumas.tell input"));
  }

  ask<T = string>(input: AkumaAskInput<T>): Promise<AkumaAskResult<T>> {
    return askAkumaOn(this.#selection, this.withWorld(input, "Akumas.ask input"));
  }

  wait(input: AkumaWaitInput): Promise<AkumaWaitResult> {
    return waitAkumaOn(this.#selection, this.withWorld(input, "Akumas.wait input"));
  }

  kill(input: AkumaKillInput): Promise<AkumaKillResult> {
    return killAkumaOn(this.#selection, this.withWorld(input, "Akumas.kill input"));
  }

  history(input: AkumaHistoryInput): Promise<AkumaHistoryResult> {
    return historyAkuma(this.withWorld(input, "Akumas.history input"));
  }

  private withWorld<Input>(input: Input, label: string): Input & Readonly<{ path: WorldRoot }> {
    const values = requireInput(input, label);
    if (Object.hasOwn(values, "path"))
      throw new TypeError(`${label} does not accept path; select World with Akumas.of`);
    return { ...values, path: this.#world } as Input & Readonly<{ path: WorldRoot }>;
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
