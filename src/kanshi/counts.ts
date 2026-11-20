import { z } from "zod";
import {
  activeAkumaCountsSchema,
  countActiveAkumas,
  countCallerRunningAkuma,
  countRunningAkuma,
} from "../akuma/akuma.js";
import { akumaCallerSchema } from "../akuma/caller.js";
import { KeiyakuError } from "../errors.js";
import { DebtAuthorityCorruptionError } from "../debt/index.js";
import { observeDebtBoard } from "../debt/operations.js";
import {
  withGitDecodeChannel,
  withGitTargetedReadObservation,
  type GitReadObservation,
} from "../git/read-observation.js";
import { scopeForRepo, type Repo } from "../library/repo.js";
import {
  activeContractCountsSchema,
  currentContractSummarySchema,
  readActiveContractSummary,
  readContractCount,
} from "../protocol/read/status.js";
import { World, worldRootSchema, type WorldRoot } from "../world.js";
import { observationSectionSchema, type ObservationSection } from "./report.js";
import type { KanshiCoordinates } from "./read.js";

export type KanshiCountsReport = z.output<typeof kanshiCountsReportSchema>;

const countsOptionsSchema = z.strictObject({ akumaCaller: akumaCallerSchema.nullable().exactOptional() }).readonly();
/** Omit akumaCaller for exact World totals; null marks only that section unavailable. */
export type KanshiCountsOptions = z.output<typeof countsOptionsSchema>;

const count = z.number().int().nonnegative();
export const kanshiCountsReportSchema = z
  .strictObject({
    root: worldRootSchema.nullable(),
    observedAt: z.string(),
    akuma: observationSectionSchema(count),
    contracts: observationSectionSchema(count),
    debts: observationSectionSchema(count),
  })
  .readonly();

const activeDebtCountsSchema = z.strictObject({ total: count, ready: count, blocked: count }).readonly();
export const kanshiStatusSummarySchema = z
  .strictObject({
    kind: z.literal("active-work-summary"),
    contracts: observationSectionSchema(activeContractCountsSchema),
    akumas: observationSectionSchema(activeAkumaCountsSchema),
    debts: observationSectionSchema(activeDebtCountsSchema),
    currentContract: currentContractSummarySchema.exactOptional(),
  })
  .readonly();
export type KanshiStatusSummary = z.output<typeof kanshiStatusSummarySchema>;

const absent = { kind: "absent" } as const;

function failure(error: unknown): Extract<ObservationSection<never>, { kind: "failed" }> {
  const text = (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/gu, " ").trim();
  return {
    kind: "failed",
    failure: {
      message: text.length <= 240 ? text : `${text.slice(0, 239)}…`,
      ...(error instanceof DebtAuthorityCorruptionError && error.coordinate !== undefined
        ? { coordinate: error.coordinate }
        : {}),
    },
  };
}

async function section<Value>(read: () => Value | Promise<Value>): Promise<ObservationSection<Value>> {
  try {
    return await read();
  } catch (error) {
    return failure(error);
  }
}

function contractSection<Value>(repo: Repo | undefined, read: (at: GitReadObservation) => Value | Promise<Value>) {
  if (repo === undefined) return Promise.resolve(absent);
  const scope = scopeForRepo(repo);
  return section(() =>
    withGitDecodeChannel(scope, (channel) =>
      withGitTargetedReadObservation(scope, channel, { subtrees: ["contracts/active"] }, read),
    ),
  );
}

async function worldSections<A, D>(
  world: WorldRoot | null,
  akumas: (world: WorldRoot) => Promise<A>,
  debts: (world: WorldRoot) => Promise<D>,
): Promise<readonly [ObservationSection<A>, ObservationSection<D>]> {
  if (world === null) return [absent, absent];
  try {
    if (!(await World.established(world))) return [absent, absent];
  } catch (error) {
    const failed = failure(error);
    return [failed, failed];
  }
  return Promise.all([section(() => akumas(world)), section(() => debts(world))]);
}

async function activeDebtCounts(world: WorldRoot): Promise<z.output<typeof activeDebtCountsSchema>> {
  let ready = 0;
  let blocked = 0;
  for (const { disposition } of await observeDebtBoard(world)) {
    if (disposition === "ready") ++ready;
    if (disposition === "blocked") ++blocked;
  }
  return { total: ready + blocked, ready, blocked };
}

export async function kanshiCounts(
  input: KanshiCoordinates,
  options: KanshiCountsOptions = {},
): Promise<KanshiCountsReport> {
  const parsed = countsOptionsSchema.safeParse(options);
  if (!parsed.success)
    throw new KeiyakuError("invalid-input", `Invalid Kanshi counts options: ${parsed.error.message}`);
  const { akumaCaller } = parsed.data;
  const world = input.world === null ? null : await World.prove(input.world);
  const observedAt = new Date().toISOString();
  const [contracts, [akuma, debts]] = await Promise.all([
    contractSection(input.repo, readContractCount),
    worldSections(
      world,
      async (world) => {
        if (akumaCaller === null) throw new Error("Akuma caller selection unavailable");
        return akumaCaller === undefined ? countRunningAkuma(world) : countCallerRunningAkuma(world, akumaCaller);
      },
      async (world) => (await activeDebtCounts(world)).total,
    ),
  ]);
  return { root: world, observedAt, akuma, contracts, debts };
}

/** The invocation already resolved its independent Repo and World coordinates. */
export async function kanshiStatusSummary(
  input: KanshiCoordinates,
  invocationWorktree?: string,
): Promise<KanshiStatusSummary> {
  const [contract, [akumas, debts]] = await Promise.all([
    contractSection(input.repo, (at) => readActiveContractSummary(at, invocationWorktree)),
    worldSections(input.world, countActiveAkumas, activeDebtCounts),
  ]);
  if ("kind" in contract) return { kind: "active-work-summary", contracts: contract, akumas, debts };
  const { counts, currentContract } = contract;
  return {
    kind: "active-work-summary",
    contracts: counts,
    akumas,
    debts,
    ...(currentContract === undefined ? {} : { currentContract }),
  };
}
