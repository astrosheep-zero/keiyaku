/** @architectureCompositionRoot */
import { captureAkumaHostDiagnostic, type AkumaHostOptions } from "../akuma/akuma-instance.js";
import type { AkumaList, AkumaListInput } from "../akuma/akuma.js";
import { readAkumaRoster } from "../akuma/akuma.js";
import type { TellResult, TellWake } from "../akuma/body.js";
import { captureAkumaHost } from "../body-host.js";
import type { BodyLauncher } from "../akuma/body-launch.js";
import { readAliases, type AliasBinding } from "../alias/index.js";
import type { DispatchAssociation } from "../akuma/dispatch-association.js";
import type { AkumaAlias } from "../identity/selector.js";
import type { CreatedDebtObservation } from "../debt/created-observation.js";
import { World, type WorldRoot } from "../world.js";
import { sweepInactiveAkumas } from "./akuma-retention.js";
import type { AkumaAddressInput, AkumaWorldScopeRefusal } from "./address.js";
import type { DispatchStage, ForkInput, ForkResult, SpawnInput, SpawnResult, SpawnWaitHead } from "./akuma-creation.js";
import { callAkumas, forkAkumas } from "./akuma-creation.js";
import { requireInput } from "./input.js";
import {
  askAkuma,
  historyAkuma,
  killAkuma,
  statusAkuma,
  tellAkuma,
  waitAkuma,
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
} from "./selection.js";

export { AkumaAddressError, AkumaWorldScopeError } from "./address.js";

export type { AkumaAddressInput } from "./address.js";
export type { ForkInput, SpawnInput } from "./akuma-creation.js";
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
  CreatedDebtObservation,
  DispatchAssociation,
  DispatchStage,
  ForkResult,
  SpawnResult,
  SpawnWaitHead,
  TellResult,
  TellWake,
};
/** The existing native wait-observation seam, exposed type-only for CLI composition. */

export type Akumas = AkumasHandle;

class AkumasHandle {
  #world: WorldRoot;
  #spawn: BodyLauncher;
  #reportDiagnostic: AkumaHostOptions["reportDiagnostic"];
  #maintenance: Promise<void> | undefined;

  constructor(world: WorldRoot, spawn: BodyLauncher, host?: AkumaHostOptions) {
    this.#world = world;
    this.#spawn = spawn;
    this.#reportDiagnostic = captureAkumaHostDiagnostic(host);
    Object.freeze(this);
  }

  async list(input?: AkumaListInput): Promise<AkumaList> {
    const path = await World.prove(this.#world);
    const roster = await readAkumaRoster(path, input);
    if (roster.rows.length === 0) return roster;
    return withRosterAliases(roster, await readAliases(path));
  }

  spawn(input: SpawnInput): Promise<SpawnResult> {
    const pending = callAkumas(this.withWorld(input, "Akumas.spawn input"), this.#spawn, this.#reportDiagnostic);
    return pending.then(async (result) => {
      await this.maintain(this.#world);
      return result;
    });
  }

  fork(input: ForkInput): Promise<ForkResult> {
    const pending = forkAkumas(this.withWorld(input, "Akumas.fork input"), this.#spawn);
    return pending.then(async (result) => {
      if (result.kind === "forked") await this.maintain(this.#world);
      return result;
    });
  }

  status(input: AkumaAddressInput): Promise<AkumaObservation> {
    return statusAkuma(this.withWorld(input, "Akumas.status input"), this.#reportDiagnostic);
  }

  tell(input: AkumaTellInput): Promise<AkumaTellResult> {
    return tellAkuma(this.withWorld(input, "Akumas.tell input"), this.#spawn);
  }

  ask<T = string>(input: AkumaAskInput<T>): Promise<AkumaAskResult<T>> {
    return askAkuma(this.withWorld(input, "Akumas.ask input"), this.#spawn, this.#reportDiagnostic);
  }

  wait(input: AkumaWaitInput): Promise<AkumaWaitResult> {
    return waitAkuma(this.withWorld(input, "Akumas.wait input"), this.#reportDiagnostic);
  }

  kill(input: AkumaKillInput): Promise<AkumaKillResult> {
    return killAkuma(this.withWorld(input, "Akumas.kill input"), this.#spawn);
  }

  history(input: AkumaHistoryInput): Promise<AkumaHistoryResult> {
    return historyAkuma(this.withWorld(input, "Akumas.history input"), this.#reportDiagnostic);
  }

  /**
   * The one write-side maintenance point: a successful birth is already durable,
   * so one best-effort sweep may follow it. Only an in-flight sweep is
   * coalesced; a completed or failed sweep leaves the next successful birth free
   * to start a fresh one. It never changes the birth result or any observation.
   */
  private maintain(world: WorldRoot): Promise<void> {
    const inFlight = this.#maintenance;
    if (inFlight !== undefined) return inFlight;
    const pending = this.sweep(world).finally(() => {
      this.#maintenance = undefined;
    });
    this.#maintenance = pending;
    return pending;
  }

  private async sweep(world: WorldRoot): Promise<void> {
    try {
      await sweepInactiveAkumas(world);
    } catch (error) {
      try {
        this.#reportDiagnostic?.(
          `akuma retention sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } catch {
        // A diagnostic sink failure cannot change the ordinary operation.
      }
    }
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
    const aliases = byId.get(binding.akumaId) ?? [];
    aliases.push(binding.alias);
    byId.set(binding.akumaId, aliases);
  }
  return { ...roster, rows: roster.rows.map((row) => ({ ...row, aliases: byId.get(row.id) ?? [] })) };
}

/** Internal host composition for an explicitly owned launcher. */
export function akumasWithLauncher(world: WorldRoot, spawn: BodyLauncher, host?: AkumaHostOptions): Akumas {
  if (typeof world !== "string") throw new TypeError("Akumas.of world must be a WorldRoot");
  return new AkumasHandle(world, spawn, host);
}

export const Akumas = Object.freeze({
  of(world: WorldRoot, host?: AkumaHostOptions): Akumas {
    const { spawn, reportDiagnostic } = captureAkumaHost(host);
    return akumasWithLauncher(world, spawn, reportDiagnostic === undefined ? undefined : { reportDiagnostic });
  },
});
