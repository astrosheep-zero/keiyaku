import { countRunningAkuma } from "../akuma/akuma.js";
import { DebtAuthorityCorruptionError } from "../debt/index.js";
import { observeDebtBoard } from "../debt/operations.js";
import { withGitDecodeChannel, withGitReadObservation } from "../git/read-observation.js";
import { Repo, scopeForRepo } from "../library/repo.js";
import { readContractBoard } from "../protocol/read/status.js";
import { World, type WorldRoot } from "../world.js";
import type { Section } from "./report.js";

export type KanshiCountsInput = Readonly<{ world: WorldRoot | null; repo?: Repo }>;
export type KanshiCountsReport = Readonly<{
  root: WorldRoot | null;
  observedAt: string;
  akuma: Section<number>;
  contracts: Section<number>;
  debts: Section<number>;
}>;

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

export async function kanshiCounts(input: KanshiCountsInput): Promise<KanshiCountsReport> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new TypeError("kanshi counts input must be an object");
  for (const key of Object.keys(input))
    if (key !== "world" && key !== "repo") throw new TypeError(`kanshi counts input has unknown field: ${key}`);
  if (input.world !== null && (typeof input.world !== "string" || input.world.trim().length === 0))
    throw new TypeError("kanshi world must be a WorldRoot or null");
  if (input.repo !== undefined && !(input.repo instanceof Repo)) throw new TypeError("kanshi repo must be a Repo");
  const world = input.world === null ? null : await World.prove(input.world);
  const observedAt = new Date().toISOString();
  const absent = { kind: "absent" } as const;
  const contracts =
    input.repo === undefined
      ? Promise.resolve(absent)
      : section(async () => {
          const repo = scopeForRepo(input.repo!);
          return withGitDecodeChannel(repo, (channel) =>
            withGitReadObservation(
              repo,
              channel,
              async (observation) => (await readContractBoard(observation)).rows.length,
            ),
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
      section(async () => (await observeDebtBoard(world)).statusRows.filter((row) => row.state === "open").length),
    ]);
  };
  const [contractSection, [akuma, debts]] = await Promise.all([contracts, worldSections()]);
  return { root: world, observedAt, akuma, contracts: contractSection, debts };
}
