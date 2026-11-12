import { z } from "zod";
import { boundedListLimit } from "../bounded-list.js";
import { akumaRowsAt, joinedAkumas, aliasesAt, dispatchesAt, diagnostic } from "../library/akumas.js";
import { aliasBindingSchema, type AliasBinding } from "../alias/index.js";
import { decodeContractDocument } from "../body/decode.js";
import { assertRegionPattern } from "../body/region.js";
import { contractId, type ContractId } from "../core/facts/types.js";
import type { Dispatch } from "../dispatch/index.js";
import { withGitDecodeChannel, withGitReadObservation, type GitReadObservation } from "../git/read-observation.js";
import { Repo, scopeForRepo } from "../library/repo.js";
import { readDocuments } from "../protocol/read/documents.js";
import {
  readContractCatalogue,
  readContractObservation,
  readContractPhase,
  type ContractSummaryAssociation,
} from "../protocol/read/status.js";
import { readDebtHolderProjectionAt, type DebtHolderProjection } from "../settlement/holder.js";
import { observeRecentDebtStatus, DebtAuthorityCorruptionError } from "../debt/index.js";
import type { WorldRoot } from "../world.js";
import type {
  AkumaKanshiWorld,
  BoardSection,
  DebtSection,
  ContractKanshiBoard,
  ContractRosterAttachment,
  DebtKanshiWorld,
  KanshiContractReport,
  KanshiRegionSelection,
  KanshiReport,
  RegionRead,
  Section,
} from "./report.js";
import { kanshiReportSchema, kanshiContractReportSchema, sectionSchema } from "./report.js";
import { ROSTER_SNAPSHOT_ROWS, ROSTER_VISIBLE_ROWS } from "./roster.js";
import { selectRegion } from "./select.js";

export type KanshiScopeInput = Readonly<{ world?: WorldRoot | null; repo?: Repo | null }>;
export type KanshiBoardOptions = Readonly<{ akumaLimit?: number }>;

export type KanshiCoordinates = Readonly<{ world: WorldRoot | null; repo?: Repo }>;
type KanshiInput = KanshiCoordinates & Readonly<{ contract?: ContractId }>;
export type KanshiObservation = Readonly<{
  report: KanshiReport | KanshiContractReport;
  aliases: Section<readonly AliasBinding[]>;
}>;
export const kanshiObservationSchema = z
  .strictObject({
    report: z.union([kanshiReportSchema, kanshiContractReportSchema]),
    aliases: sectionSchema(z.array(aliasBindingSchema).readonly()),
  })
  .readonly();
type Holders = Section<DebtHolderProjection>;
type Dispatches = Section<readonly Dispatch[]>;
const absent = { kind: "absent" } as const;

function failure(error: unknown): Extract<Section<never>, { kind: "failed" }> {
  return {
    kind: "failed",
    failure: {
      message: diagnostic(error),
      ...(error instanceof DebtAuthorityCorruptionError && error.coordinate !== undefined
        ? { coordinate: error.coordinate }
        : {}),
    },
  };
}
function boardFailure(error: unknown): Extract<BoardSection<never>, { kind: "failed" }> {
  return { kind: "failed", diagnostic: diagnostic(error) };
}
function debtFailure(error: unknown): Extract<DebtSection<never>, { kind: "failed" }> {
  const failed = failure(error);
  return {
    kind: "failed",
    diagnostic: failed.failure.message,
    ...(failed.failure.coordinate === undefined ? {} : { coordinate: failed.failure.coordinate }),
  };
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`kanshi ${label} must be an object`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new TypeError(`kanshi ${label} has unknown field: ${key}`);
}
export function captureKanshiScope(input: KanshiScopeInput): KanshiCoordinates {
  const value = record(input, "scope");
  exactKeys(value, ["world", "repo"], "scope");
  const world = input.world ?? null;
  const repo = input.repo ?? undefined;
  if (world !== null && (typeof world !== "string" || world.trim().length === 0))
    throw new TypeError("kanshi world must be a WorldRoot or null");
  if (repo !== undefined && !(repo instanceof Repo)) throw new TypeError("kanshi repo must be a Repo");
  return Object.freeze({ world, ...(repo === undefined ? {} : { repo }) });
}
function regionSelection(value: unknown): KanshiRegionSelection {
  const selection = record(value, "region selection");
  if (Object.keys(selection).length === 0) return { kind: "declarations" };
  if (selection.kind === "declarations") {
    exactKeys(selection, ["kind"], "region selection");
    return { kind: "declarations" };
  }
  if (selection.kind === "contract") {
    exactKeys(selection, ["kind", "contract"], "region selection");
    if (typeof selection.contract !== "string") throw new TypeError("kanshi region contract must be a ContractId");
    try {
      return { kind: "contract", contract: contractId(selection.contract) };
    } catch (cause) {
      throw new TypeError("kanshi region contract must be a canonical ContractId", { cause });
    }
  }
  if (selection.kind === "path") {
    exactKeys(selection, ["kind", "patterns"], "region selection");
    if (!Array.isArray(selection.patterns) || selection.patterns.length === 0)
      throw new TypeError("Region query requires one or more path patterns");
    const patterns = selection.patterns.map((pattern) => {
      if (typeof pattern !== "string") throw new TypeError("Region path patterns must be strings");
      try {
        return assertRegionPattern(pattern);
      } catch (cause) {
        throw new TypeError(cause instanceof Error ? cause.message : String(cause), { cause });
      }
    });
    const [first, ...rest] = patterns;
    if (first === undefined) throw new TypeError("Region query requires one or more path patterns");
    return { kind: "path", patterns: [first, ...rest] };
  }
  throw new TypeError(`kanshi region selection kind is invalid: ${String(selection.kind)}`);
}
async function holdersAt(observation: GitReadObservation): Promise<Holders> {
  try {
    return { kind: "present", value: await readDebtHolderProjectionAt(observation) };
  } catch (error) {
    return failure(error);
  }
}
async function debtRowsAt(world: WorldRoot | null): Promise<DebtSection<DebtKanshiWorld>> {
  if (world === null) return absent;
  try {
    const recent = await observeRecentDebtStatus(world, { limit: 10 });
    return {
      kind: "present",
      ...(recent.rows.length === 0 ? {} : { rows: recent.rows }),
      ...(recent.hasMore ? { more: true } : {}),
    };
  } catch (error) {
    return debtFailure(error);
  }
}
function joinedDebts(debts: DebtSection<DebtKanshiWorld>, holders: Holders): DebtSection<DebtKanshiWorld> {
  if (debts.kind !== "present") return debts;
  const byDebt = new Map(
    holders.kind === "present"
      ? [...holders.value.values()]
          .filter((item) => item.disposition === "held")
          .map((item) => [item.debtId, item.contractId])
      : [],
  );
  const rows = (debts.rows ?? []).map((row) => {
    const id = byDebt.get(row.id);
    return {
      ...row,
      ...(holders.kind === "failed"
        ? { contract: { kind: "unavailable" as const } }
        : id === undefined
          ? {}
          : { contract: { kind: "associated" as const, contractId: id } }),
    };
  });
  return {
    kind: "present",
    ...(rows.length === 0 ? {} : { rows }),
    ...(debts.more === true ? { more: true } : {}),
  };
}
function contractAssociations(
  id: ContractId,
  holders: Holders,
  dispatches: Dispatches,
  aliases: Section<readonly AliasBinding[]>,
): readonly ContractSummaryAssociation[] {
  const items: ContractSummaryAssociation[] = [];
  if (holders.kind === "failed")
    items.push({ kind: "unavailable", source: "holder", diagnostic: holders.failure.message });
  else if (holders.kind === "present") {
    const holder = holders.value.get(id);
    if (holder?.disposition === "held") items.push({ kind: "debt", debtId: holder.debtId });
  }
  if (dispatches.kind === "failed")
    items.push({ kind: "unavailable", source: "roster", diagnostic: dispatches.failure.message });
  else if (dispatches.kind === "present")
    for (const item of dispatches.value) {
      if (item.contractId !== id) continue;
      const names =
        aliases.kind === "present"
          ? aliases.value.filter((binding) => binding.akumaId === item.akumaId).map((binding) => binding.alias)
          : [];
      items.push({
        kind: "akuma",
        akumaId: item.akumaId,
        ...(names.length === 0 ? {} : { aliases: names }),
        ...(aliases.kind === "failed" ? { aliasesUnavailable: true } : {}),
      });
    }
  return items;
}
async function contractsAt(
  observation: GitReadObservation,
  limit: number,
  holders: Holders,
  dispatches: Dispatches,
  aliases: Section<readonly AliasBinding[]>,
): Promise<BoardSection<ContractKanshiBoard>> {
  try {
    const source = await readContractCatalogue(observation, limit);
    const rows = (source.rows ?? []).map((row) => {
      const associations = contractAssociations(row.id, holders, dispatches, aliases);
      return { ...row, ...(associations.length === 0 ? {} : { associations }) };
    });
    return {
      kind: "present",
      ...(rows.length === 0 ? {} : { rows }),
      ...(source.more ? { more: true } : {}),
    };
  } catch (error) {
    return boardFailure(error);
  }
}
async function selectedContract(
  observation: GitReadObservation,
  id: ContractId,
  links: Readonly<{ holders: Holders; dispatches: Dispatches; aliases: Section<readonly AliasBinding[]> }>,
): Promise<KanshiContractReport> {
  const { holders, dispatches, aliases } = links;
  try {
    const selected = await readContractObservation(observation, id);
    if (selected.kind === "missing") return { kind: "contract-missing", id };
    const row = selected.row;
    const held = holders.kind === "present" ? holders.value.get(id) : undefined;
    const roster: ContractRosterAttachment[] =
      dispatches.kind !== "present"
        ? []
        : dispatches.value
            .filter((item) => item.contractId === id)
            .map((item) => {
              const names =
                aliases.kind === "present"
                  ? aliases.value.filter((binding) => binding.akumaId === item.akumaId).map((binding) => binding.alias)
                  : [];
              return {
                id: item.akumaId,
                ...(names.length === 0 ? {} : { aliases: names }),
                ...(aliases.kind === "failed" ? { aliasesUnavailable: true as const } : {}),
              };
            });
    return {
      ...row,
      kind: "contract",
      ...(holders.kind === "failed"
        ? { holder: { kind: "unavailable" } }
        : held?.disposition === "held"
          ? { holder: held.debtId }
          : {}),
      ...(dispatches.kind === "failed" ? { roster: { kind: "unavailable" } } : roster.length === 0 ? {} : { roster }),
    };
  } catch (error) {
    return { kind: "contract-failed", id, diagnostic: diagnostic(error) };
  }
}
export async function readKanshiRegion(
  repo: Repo | undefined,
  input: KanshiRegionSelection | Readonly<Record<string, never>> = {},
): Promise<RegionRead> {
  const selection = regionSelection(input);
  if (repo === undefined) return { kind: "absent" };
  try {
    return await withGitDecodeChannel(scopeForRepo(repo), (channel) =>
      withGitReadObservation(scopeForRepo(repo), channel, async (observation) => {
        if (selection.kind === "contract") {
          const phase = await readContractPhase(observation, selection.contract);
          if (phase === null) return { kind: "contract-missing", id: selection.contract };
          if (phase !== "bound") return { kind: "contract-terminal", id: selection.contract };
        }
        const declarations = (await readDocuments(observation))
          .map((item) => ({ id: item.contract, patterns: decodeContractDocument(item.documentBytes).region }))
          .sort((a, b) => a.id.localeCompare(b.id));
        return selectRegion({ declarations, selection });
      }),
    );
  } catch (error) {
    return { kind: "failed", diagnostic: diagnostic(error) };
  }
}
export function observeKanshi(
  input: KanshiInput & Readonly<{ contract: ContractId }>,
  options?: KanshiBoardOptions,
): Promise<KanshiObservation & Readonly<{ report: KanshiContractReport }>>;
export function observeKanshi(
  input: KanshiInput & Readonly<{ contract?: undefined }>,
  options?: KanshiBoardOptions,
): Promise<KanshiObservation & Readonly<{ report: KanshiReport }>>;
export async function observeKanshi(input: KanshiInput, options: KanshiBoardOptions = {}): Promise<KanshiObservation> {
  const { world, repo, contract } = input;
  const board = record(options, "board options");
  exactKeys(board, ["akumaLimit"], "board options");
  const akumaLimit = board.akumaLimit === undefined ? ROSTER_VISIBLE_ROWS : boundedListLimit(board.akumaLimit);
  const observedAt = new Date().toISOString();
  const [aliases, akumaProduct, debts] = await Promise.all([
    aliasesAt(world),
    contract === undefined && world !== null
      ? akumaRowsAt(world, akumaLimit, undefined, undefined, ROSTER_SNAPSHOT_ROWS).then(
          ({ kind: _kind, observedAt: _observedAt, ...rows }): BoardSection<AkumaKanshiWorld> => ({
            kind: "present",
            ...rows,
          }),
          boardFailure,
        )
      : Promise.resolve(absent),
    contract === undefined ? debtRowsAt(world) : Promise.resolve(absent),
  ]);
  const worldReport = (
    contracts: BoardSection<ContractKanshiBoard>,
    holders: Holders,
    dispatches: Dispatches,
  ): KanshiReport => ({
    kind: "world",
    observedAt,
    contracts,
    debts: joinedDebts(debts, holders),
    akumas: akumaProduct.kind === "present" ? joinedAkumas(akumaProduct, aliases, dispatches) : akumaProduct,
  });
  if (repo === undefined)
    return {
      report: contract === undefined ? worldReport(absent, absent, absent) : { kind: "contract-absent", id: contract },
      aliases,
    };
  let observed: KanshiReport | KanshiContractReport | undefined;
  try {
    return await withGitDecodeChannel(scopeForRepo(repo), (channel) =>
      withGitReadObservation(scopeForRepo(repo), channel, async (observation) => {
        const [holders, dispatches] = await Promise.all([holdersAt(observation), dispatchesAt(observation)]);
        if (contract !== undefined) {
          observed = await selectedContract(observation, contract, { holders, dispatches, aliases });
        } else {
          const contracts = await contractsAt(observation, 10, holders, dispatches, aliases);
          observed = worldReport(contracts, holders, dispatches);
        }
        return { report: observed, aliases };
      }),
    );
  } catch (error) {
    const failed = failure(error);
    if (observed !== undefined && "contracts" in observed) {
      return { report: { ...observed, contracts: boardFailure(error) }, aliases };
    }
    return {
      report:
        contract === undefined
          ? worldReport(boardFailure(error), failed, failed)
          : { kind: "contract-failed", id: contract, diagnostic: failed.failure.message },
      aliases,
    };
  }
}
