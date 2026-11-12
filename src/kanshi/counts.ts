import { z } from "zod";
import { countRunningAkuma } from "../akuma/akuma.js";
import { DebtAuthorityCorruptionError } from "../debt/index.js";
import { observeDebtBoard } from "../debt/operations.js";
import { withGitDecodeChannel, withGitTargetedReadObservation } from "../git/read-observation.js";
import { scopeForRepo } from "../library/repo.js";
import { readContractCount } from "../protocol/read/status.js";
import { World, worldRootSchema } from "../world.js";
import { sectionSchema, type Section } from "./report.js";
import type { KanshiCoordinates } from "./read.js";

export type KanshiCountsReport = z.output<typeof kanshiCountsReportSchema>;

export const kanshiCountsReportSchema = z
  .strictObject({
    root: worldRootSchema.nullable(),
    observedAt: z.string(),
    akuma: sectionSchema(z.number()),
    contracts: sectionSchema(z.number()),
    debts: sectionSchema(z.number()),
  })
  .readonly();

async function section(read: () => Promise<number>): Promise<Section<number>> {
  try {
    return { kind: "present", value: await read() };
  } catch (error) {
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
}

export async function kanshiCounts(input: KanshiCoordinates): Promise<KanshiCountsReport> {
  const world = input.world === null ? null : await World.prove(input.world);
  const observedAt = new Date().toISOString();
  const absent = { kind: "absent" } as const;
  const contracts =
    input.repo === undefined
      ? Promise.resolve(absent)
      : section(async () => {
          const repo = scopeForRepo(input.repo!);
          return withGitDecodeChannel(repo, (channel) =>
            withGitTargetedReadObservation(repo, channel, { subtrees: ["contracts/active"] }, readContractCount),
          );
        });
  const worldSections = async (): Promise<readonly [Section<number>, Section<number>]> => {
    if (world === null) return [absent, absent];
    let established: boolean;
    try {
      established = await World.established(world);
    } catch (error) {
      const failed = await section(async () => {
        throw error;
      });
      return [failed, failed];
    }
    if (!established) return [absent, absent];
    return Promise.all([
      section(() => countRunningAkuma(world)),
      section(
        async () =>
          (await observeDebtBoard(world)).filter((row) => row.disposition === "ready" || row.disposition === "blocked")
            .length,
      ),
    ]);
  };
  const [contractSection, [akuma, debts]] = await Promise.all([contracts, worldSections()]);
  return { root: world, observedAt, akuma, contracts: contractSection, debts };
}
