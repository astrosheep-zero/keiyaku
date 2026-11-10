import { z } from "zod";
import { observeAkumaRoster, readAkumaTimeline } from "../akuma/akuma.js";
import { aliasBindingSchema, readAliases, type AliasBinding } from "../alias/index.js";
import { decodeContractDocument } from "../body/decode.js";
import { assertRegionPattern } from "../body/region.js";
import { contractId, type ContractId } from "../core/facts/types.js";
import { readDispatchesAt, type Dispatch } from "../dispatch/index.js";
import { withGitDecodeChannel, withGitReadObservation, type GitReadObservation } from "../git/read-observation.js";
import { Repo, scopeForRepo } from "../library/repo.js";
import { readDocuments } from "../protocol/read/documents.js";
import { projectStatusPreview, projectStatusOutcome } from "../akuma/status-projection.js";
import {
  readContractCatalogue,
  readContractObservation,
  readContractPhase,
  type ContractSummaryAssociation,
} from "../protocol/read/status.js";
import { readDebtHolderProjectionAt, type DebtHolderProjection } from "../settlement/holder.js";
import { contractNamespace } from "../debt/identity.js";
import { observeRecentDebtStatus, DebtAuthorityCorruptionError, type DebtSummary } from "../debt/index.js";
import { observeDebtBoard } from "../debt/operations.js";
import type { WorldRoot } from "../world.js";
import type {
  AkumaKanshiRow,
  AkumaKanshiWorld,
  BoardSection,
  DebtSection,
  ContractKanshiBoard,
  ContractRosterAttachment,
  DebtKanshiWorld,
  KanshiCategoryReport,
  KanshiContractReport,
  KanshiRegionSelection,
  KanshiReport,
  RegionRead,
  Section,
} from "./report.js";
import { kanshiReportSchema, kanshiContractReportSchema, sectionSchema } from "./report.js";
import { ROSTER_SNAPSHOT_ROWS, ROSTER_VISIBLE_ROWS } from "./roster.js";
import { selectRegion } from "./select.js";

export type KanshiInput = Readonly<{
  world: WorldRoot | null;
  repo?: Repo;
  region?: KanshiRegionSelection;
  contract?: ContractId;
}>;
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

function diagnostic(error: unknown): string {
  const source = error instanceof Error ? error.message : String(error);
  const line = source.replaceAll(/\s+/gu, " ").trim();
  return line.length <= 240 ? line : `${line.slice(0, 239)}…`;
}
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
function worldCoordinate(world: unknown, repo: unknown): void {
  if (world !== null && (typeof world !== "string" || world.trim().length === 0))
    throw new TypeError("kanshi world must be a WorldRoot or null");
  if (repo !== undefined && !(repo instanceof Repo)) throw new TypeError("kanshi repo must be a Repo");
}
function regionSelection(value: unknown): KanshiRegionSelection {
  const selection = record(value, "region selection");
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
function coordinate(input: KanshiInput): KanshiInput {
  const value = record(input, "input");
  exactKeys(value, ["world", "repo", "region", "contract"], "input");
  worldCoordinate(value.world, value.repo);
  if (input.contract !== undefined && input.region !== undefined)
    throw new TypeError("kanshi contract and region selections are exclusive");
  return {
    ...input,
    ...(input.region === undefined ? {} : { region: regionSelection(input.region) }),
    ...(input.contract === undefined ? {} : { contract: contractId(input.contract) }),
  };
}
async function holdersAt(observation: GitReadObservation): Promise<Holders> {
  try {
    return { kind: "present", value: await readDebtHolderProjectionAt(observation) };
  } catch (error) {
    return failure(error);
  }
}
async function dispatchesAt(observation: GitReadObservation): Promise<Dispatches> {
  try {
    return { kind: "present", value: await readDispatchesAt(observation) };
  } catch (error) {
    return failure(error);
  }
}
async function aliasesAt(world: WorldRoot | null): Promise<Section<readonly AliasBinding[]>> {
  if (world === null) return absent;
  try {
    return { kind: "present", value: await readAliases(world) };
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
async function namespaceDebtsAt(
  world: WorldRoot | null,
  id: ContractId,
): Promise<DebtSection<Readonly<{ rows?: readonly DebtSummary[] }>>> {
  if (world === null) return absent;
  try {
    const rows = (await observeDebtBoard(world)).selectNamespace(contractNamespace(id));
    return { kind: "present", ...(rows.length === 0 ? {} : { rows }) };
  } catch (error) {
    return debtFailure(error);
  }
}
async function akumaRowsAt(
  world: WorldRoot | null,
  limit = ROSTER_VISIBLE_ROWS,
): Promise<BoardSection<AkumaKanshiWorld>> {
  if (world === null) return absent;
  try {
    const source = await observeAkumaRoster(world, limit);
    const rows = await Promise.all(
      (source.rows ?? []).map(async (row, index): Promise<AkumaKanshiRow> => {
        const summary = "parentAkumaId" in row ? (({ parentAkumaId: _parent, ...summary }) => summary)(row) : row;
        if (index >= ROSTER_SNAPSHOT_ROWS) return summary;
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
      }),
    );
    return {
      kind: "present",
      ...(rows.length === 0 ? {} : { rows }),
      ...(source.more ? { more: true } : {}),
    };
  } catch (error) {
    return boardFailure(error);
  }
}
function joinedAkumas(
  product: BoardSection<AkumaKanshiWorld>,
  aliases: Section<readonly AliasBinding[]>,
  dispatches: Dispatches,
): BoardSection<AkumaKanshiWorld> {
  if (product.kind !== "present") return product;
  const byId = new Map(dispatches.kind === "present" ? dispatches.value.map((item) => [item.akumaId, item]) : []);
  const rows = (product.rows ?? []).map((row): AkumaKanshiRow => {
    const dispatch = byId.get(row.id);
    const names =
      aliases.kind === "present"
        ? aliases.value.filter((binding) => binding.akumaId === row.id).map((binding) => binding.alias)
        : [];
    const { aliases: _oldAliases, ...facts } = row;
    return {
      ...facts,
      ...(names.length === 0 ? {} : { aliases: names }),
      ...(dispatches.kind === "failed"
        ? { contract: { kind: "unavailable" } }
        : dispatch === undefined
          ? {}
          : {
              contract: {
                kind: "associated",
                contractId: contractId(dispatch.contractId),
              },
            }),
    };
  });
  return {
    kind: "present",
    ...(rows.length === 0 ? {} : { rows }),
    ...(product.more === true ? { more: true } : {}),
    ...(aliases.kind === "failed" ? { aliasesError: aliases.failure.message } : {}),
  };
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
  world: WorldRoot | null,
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
    const namespace = await namespaceDebtsAt(world, id);
    return {
      ...row,
      kind: "contract",
      ...(holders.kind === "failed"
        ? { holder: { kind: "unavailable" } }
        : held?.disposition === "held"
          ? { holder: held.debtId }
          : {}),
      ...(dispatches.kind === "failed" ? { roster: { kind: "unavailable" } } : roster.length === 0 ? {} : { roster }),
      namespaceDebts: namespace,
    };
  } catch (error) {
    return { kind: "contract-failed", id, diagnostic: diagnostic(error) };
  }
}
async function regionAt(repo: Repo | undefined, selection: KanshiRegionSelection): Promise<RegionRead> {
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
export async function observeKanshi(input: KanshiInput): Promise<KanshiObservation> {
  const { world, repo, contract, region } = coordinate(input);
  if (region !== undefined)
    throw new TypeError("observeKanshi observes World or Contract; use kanshi for Region selection");
  const observedAt = new Date().toISOString();
  const [aliases, akumaProduct, debts] = await Promise.all([
    aliasesAt(world),
    contract === undefined ? akumaRowsAt(world) : Promise.resolve(absent),
    contract === undefined ? debtRowsAt(world) : Promise.resolve(absent),
  ]);
  const worldReport = (
    contracts: BoardSection<ContractKanshiBoard>,
    holders: Holders,
    dispatches: Dispatches,
  ): KanshiReport => ({
    observedAt,
    contracts,
    debts: joinedDebts(debts, holders),
    akumas: joinedAkumas(akumaProduct, aliases, dispatches),
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
          observed = await selectedContract(observation, world, contract, { holders, dispatches, aliases });
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
export function kanshi(input: KanshiInput & Readonly<{ region: KanshiRegionSelection }>): Promise<RegionRead>;
export function kanshi(input: KanshiInput & Readonly<{ contract: ContractId }>): Promise<KanshiContractReport>;
export function kanshi(
  input: KanshiInput & Readonly<{ contract?: undefined; region?: undefined }>,
): Promise<KanshiReport>;
export function kanshi(input: KanshiInput): Promise<KanshiReport | KanshiContractReport | RegionRead>;
export async function kanshi(input: KanshiInput): Promise<KanshiReport | KanshiContractReport | RegionRead> {
  const value = coordinate(input);
  return value.region === undefined ? (await observeKanshi(value)).report : regionAt(value.repo, value.region);
}
export type KanshiCategoryInput = Readonly<{
  world: WorldRoot | null;
  repo?: Repo;
  category: "contract" | "akuma";
  limit?: number;
}>;
function failedCategory(report: KanshiCategoryReport, error: unknown): KanshiCategoryReport {
  return { observedAt: report.observedAt, section: { kind: "failed", diagnostic: diagnostic(error) } };
}
export function kanshiCategory(
  input: KanshiCategoryInput & Readonly<{ category: "akuma" }>,
): Promise<KanshiCategoryReport<"akuma">>;
export function kanshiCategory(
  input: KanshiCategoryInput & Readonly<{ category: "contract" }>,
): Promise<KanshiCategoryReport<"contract">>;
export function kanshiCategory(input: KanshiCategoryInput): Promise<KanshiCategoryReport>;
export async function kanshiCategory(input: KanshiCategoryInput): Promise<KanshiCategoryReport> {
  const value = record(input, "category input");
  exactKeys(value, ["world", "repo", "category", "limit"], "category input");
  worldCoordinate(value.world, value.repo);
  if (value.category !== "contract" && value.category !== "akuma")
    throw new TypeError(`kanshi category is invalid: ${String(value.category)}`);
  const { world, repo, category, limit = 10 } = input;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new TypeError("kanshi category limit must be a positive safe integer");
  if (category === "contract" && repo === undefined) throw new TypeError("kanshi contract category requires a Repo");
  const observedAt = new Date().toISOString();
  const aliases = await aliasesAt(world);
  let observed: KanshiCategoryReport | undefined;
  if (category === "akuma") {
    const product = await akumaRowsAt(world, limit);
    const result = (dispatches: Dispatches): KanshiCategoryReport<"akuma"> => {
      const report: KanshiCategoryReport<"akuma"> = { observedAt, section: joinedAkumas(product, aliases, dispatches) };
      observed = report;
      return report;
    };
    if (repo === undefined) return result(absent);
    try {
      return await withGitDecodeChannel(scopeForRepo(repo), (channel) =>
        withGitReadObservation(scopeForRepo(repo), channel, async (observation) => {
          const dispatches = await dispatchesAt(observation);
          return result(dispatches);
        }),
      );
    } catch (error) {
      return observed === undefined ? result(failure(error)) : failedCategory(observed, error);
    }
  }
  try {
    const selectedRepo = scopeForRepo(repo!);
    return await withGitDecodeChannel(selectedRepo, (channel) =>
      withGitReadObservation(selectedRepo, channel, async (observation) => {
        const [holders, dispatches] = await Promise.all([holdersAt(observation), dispatchesAt(observation)]);
        const section = await contractsAt(observation, limit, holders, dispatches, aliases);
        if (section.kind === "absent") throw new Error("Contract category with Repo cannot be absent");
        const report: KanshiCategoryReport<"contract"> = { observedAt, section };
        observed = report;
        return report;
      }),
    );
  } catch (error) {
    return observed === undefined
      ? { observedAt, section: { kind: "failed", diagnostic: diagnostic(error) } }
      : failedCategory(observed, error);
  }
}
