/** @architectureCompositionRoot */
import { captureAkumaHostDiagnostic, type AkumaHostOptions } from "../akuma/akuma-instance.js";
import type { AkumaCaller } from "../akuma/caller.js";
import type { AkumaRosterInput } from "../akuma/akuma.js";
import { observeAkumaRoster, readAkumaTimeline, rosterInput } from "../akuma/akuma.js";
import { boundedListLimit } from "../bounded-list.js";
import { boundedMap } from "../akuma/read-pool.js";
import { projectStatusPreview, projectStatusOutcome } from "../akuma/status-projection.js";
import { readDispatchesAt, type Dispatch } from "../dispatch/index.js";
import { withGitDecodeChannel, withGitReadObservation, type GitReadObservation } from "../git/read-observation.js";
import { Repo, scopeForRepo } from "./repo.js";
import type { AkumaKanshiRow, AkumaKanshiWorld, Section } from "../kanshi/report.js";
import type { z } from "zod";
import type { akumaCatalogueSchema } from "../kanshi/report.js";
import { captureAkumaHost } from "../body-host.js";
import type { BodyLauncher } from "../akuma/body-launch.js";
import { readAliases, type AliasBinding } from "../alias/index.js";
import { parseAkumaId } from "../akuma/identity.js";
import type { DispatchAssociation } from "../akuma/dispatch-association.js";
import type { CreatedDebtObservation } from "../debt/created-observation.js";
import { World, type WorldRoot } from "../world.js";
import { sweepInactiveAkumas } from "./akuma-retention.js";
import type { AkumaAddressInput, AkumaWorldScopeRefusal } from "./address.js";
import type { ForkInput, ForkResult, SpawnInput, SpawnResult, SpawnWaitHead } from "./akuma-creation.js";
import { callAkumas, forkAkumas } from "./akuma-creation.js";
import { normalizedList, requireInput } from "./input.js";
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
  AliasBinding,
  AkumaAskResult,
  AkumaHistoryResult,
  AkumaKillResult,
  AkumaObservation,
  AkumaTellResult,
  AkumaWaitResult,
  AkumaWorldScopeRefusal,
  CreatedDebtObservation,
  DispatchAssociation,
  ForkResult,
  SpawnResult,
  SpawnWaitHead,
};
/** The existing native wait-observation seam, exposed type-only for CLI composition. */

export type Akumas = AkumasHandle;

export type AkumaAliasesInput = Readonly<{ akumaIds: readonly string[] }>;
export type AkumaListInput = AkumaRosterInput & Readonly<{ repo?: Repo }>;
export type AkumaList = z.output<typeof akumaCatalogueSchema>;

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

  async list(input: AkumaListInput = {}): Promise<AkumaList> {
    const { repo, ...native } = requireInput(input, "Akumas.list input", ["repo", "akumaName", "caller", "limit"]);
    if (repo !== undefined && !(repo instanceof Repo)) throw new TypeError("Akumas.list repo must be a Repo");
    const selection = rosterInput(native, true);
    const limit = boundedListLimit(native.limit);
    const path = await World.prove(this.#world);
    const [roster, aliases] = await Promise.all([
      akumaRowsAt(path, limit, selection.akumaName, selection.caller),
      aliasesAt(path),
    ]);
    if (repo === undefined) return joinedAkumas(roster, aliases, { kind: "absent" });
    return withGitDecodeChannel(scopeForRepo(repo), (channel) =>
      withGitReadObservation(scopeForRepo(repo), channel, async (observation) =>
        joinedAkumas(roster, aliases, await dispatchesAt(observation)),
      ),
    );
  }

  async aliases(input: AkumaAliasesInput): Promise<readonly AliasBinding[]> {
    const values = requireInput(input, "Akumas.aliases input", ["akumaIds"]);
    if (!Array.isArray(values.akumaIds)) throw new TypeError("akumaIds must be an array");
    const selected = new Set(normalizedList(values.akumaIds, "akumaIds", (value) => parseAkumaId(value).id));
    const path = await World.prove(this.#world);
    return (await readAliases(path)).filter((binding) => selected.has(binding.akumaId));
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
    return tellAkuma(this.withWorld(input, "Akumas.tell input"), this.#spawn, this.#reportDiagnostic);
  }

  ask(input: AkumaAskInput): Promise<AkumaAskResult> {
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

export function diagnostic(error: unknown): string {
  const source = error instanceof Error ? error.message : String(error);
  const line = source.replaceAll(/\s+/gu, " ").trim();
  return line.length <= 240 ? line : `${line.slice(0, 239)}…`;
}
export async function aliasesAt(world: WorldRoot | null): Promise<Section<readonly AliasBinding[]>> {
  if (world === null) return { kind: "absent" };
  try {
    return { kind: "present", value: await readAliases(world) };
  } catch (error) {
    return { kind: "failed", failure: { message: diagnostic(error) } };
  }
}
export async function dispatchesAt(observation: GitReadObservation): Promise<Section<readonly Dispatch[]>> {
  try {
    return { kind: "present", value: await readDispatchesAt(observation) };
  } catch (error) {
    return { kind: "failed", failure: { message: diagnostic(error) } };
  }
}
/** Shared catalogue projection; World bounds snapshots by original roster position. */
export async function akumaRowsAt(
  world: WorldRoot,
  limit: number,
  name?: string,
  caller?: AkumaCaller,
  snapshotRows = Number.POSITIVE_INFINITY,
): Promise<AkumaList> {
  const source = await observeAkumaRoster(world, limit, name, caller);
  const rows = await boundedMap([...(source.rows ?? []).entries()], async ([index, row]): Promise<AkumaKanshiRow> => {
    if (row.kind === "unborn") {
      const { kind: _kind, ...summary } = row;
      return summary;
    }
    const { kind: _kind, caller, ...facts } = row;
    const summary = { ...facts, ...(caller?.kind === "akuma" ? { parentAkumaId: caller.akumaId } : {}) };
    if (index >= snapshotRows) return summary;
    try {
      const snapshot = await readAkumaTimeline(world, row.id);
      const activity = snapshot.entries.findLast(
        (entry) => entry.kind === "row" && ["tool", "said", "thought", "note", "report"].includes(entry.row.kind),
      );
      const preview = activity?.kind === "row" ? projectStatusPreview(activity.row) : undefined;
      return {
        ...summary,
        ...(preview === undefined ? {} : { activity: preview }),
        ...(snapshot.kind === "idle" && snapshot.outcome !== undefined
          ? { outcome: projectStatusOutcome(snapshot.outcome) }
          : {}),
      };
    } catch (error) {
      return { ...summary, activity: { kind: "unavailable", diagnostic: diagnostic(error) } };
    }
  });
  return { ...source, ...(rows.length === 0 ? {} : { rows }) };
}
export function joinedAkumas<T extends AkumaKanshiWorld>(
  product: T,
  aliases: Section<readonly AliasBinding[]>,
  dispatches: Section<readonly Dispatch[]>,
): T {
  const byId = new Map(dispatches.kind === "present" ? dispatches.value.map((item) => [item.akumaId, item]) : []);
  const rows = (product.rows ?? []).map((row): AkumaKanshiRow => {
    const dispatch = byId.get(row.id);
    const names =
      aliases.kind === "present"
        ? aliases.value.filter((binding) => binding.akumaId === row.id).map((binding) => binding.alias)
        : [];
    return {
      ...row,
      ...(names.length === 0 ? {} : { aliases: names }),
      ...(dispatches.kind === "failed"
        ? { contract: { kind: "unavailable" } }
        : dispatch === undefined
          ? {}
          : { contract: { kind: "associated", contractId: dispatch.contractId } }),
    };
  });
  return {
    ...product,
    ...(rows.length === 0 ? {} : { rows }),
    ...(aliases.kind === "failed" ? { aliasesError: aliases.failure.message } : {}),
  };
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
