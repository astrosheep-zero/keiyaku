/** @architectureCompositionRoot */
import { z } from "zod";
import { contractId } from "../core/facts/types.js";
import { akumaObservationSchema, type AkumaObservation } from "../akuma/selection-observation.js";
import { kanshi, kanshiCategory } from "../kanshi/index.js";
import {
  kanshiCategoryReportSchema,
  contractStatusSchema,
  kanshiReportSchema,
  type KanshiCategoryReport,
  type ContractStatus,
  type KanshiReport,
} from "../kanshi/report.js";
import type { WorldRoot } from "../world.js";
import { observeNamedAddress, resolveNamedAddress, type NamedAddressAuthority } from "./address.js";
import { Akumas } from "./akumas.js";
import { KeiyakuUsageError } from "./keiyaku-coordinates.js";
import type { Repo } from "./repo.js";

type StatusAt = Readonly<{ cwd: string; repo?: Repo; world: WorldRoot | null }>;
export type StatusInput = Readonly<{
  selectors?: readonly string[];
  selector?: string;
  category?: "contract" | "akuma";
  limit?: number;
}>;

/** One resolved subject; a plural selection cannot return World or category observations. */
export const statusItemSchema = z.union([contractStatusSchema, akumaObservationSchema]);
export const statusResultSchema = z.union([
  statusItemSchema,
  kanshiReportSchema,
  kanshiCategoryReportSchema,
  z.strictObject({ items: z.array(statusItemSchema).min(2).readonly() }).readonly(),
]);
export type StatusItem = ContractStatus | AkumaObservation;
export type StatusByMode = {
  world: KanshiReport;
  contract: ContractStatus;
  akuma: AkumaObservation;
  named: StatusItem;
  multiple: Readonly<{ items: readonly StatusItem[] }>;
  "contract-category": KanshiCategoryReport<"contract">;
  "akuma-category": KanshiCategoryReport<"akuma">;
};
export type StatusResult<M extends keyof StatusByMode = keyof StatusByMode> = StatusByMode[M];

function requiredRepo(at: StatusAt): Repo {
  if (at.repo === undefined) throw new KeiyakuUsageError("this command requires a resolved Repo");
  return at.repo;
}

async function contractStatus(at: StatusAt, selector: string): Promise<ContractStatus> {
  const repo = requiredRepo(at);
  let id;
  try {
    id = contractId(selector);
  } catch {
    throw new KeiyakuUsageError(`contract selector must use kei/: ${selector}`);
  }
  const report = await kanshi({ world: at.world, repo, contract: id });
  if (report.kind === "contract-absent") throw new Error("Contract observation with a Repo cannot be absent");
  return report;
}

async function akumaStatus(at: StatusAt, selector: string): Promise<AkumaObservation> {
  if (at.world === null) throw new KeiyakuUsageError("no Keiyaku world contains the Akuma selector");
  return Akumas.of(at.world).status({
    akuma: selector,
    ...(at.repo === undefined ? {} : { repo: at.repo }),
  });
}

async function namedStatus(at: StatusAt, selector: string, authority: NamedAddressAuthority): Promise<StatusItem> {
  const address = resolveNamedAddress({ selector, ...authority });
  return address.kind === "akuma" ? akumaStatus(at, address.id) : contractStatus(at, address.id);
}

export async function statusAt(at: StatusAt, input: StatusInput): Promise<StatusResult> {
  if (input.category !== undefined) {
    if (input.category === "contract") requiredRepo(at);
    return kanshiCategory({
      world: at.world,
      ...(at.repo === undefined ? {} : { repo: at.repo }),
      category: input.category,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
  }
  if (input.selectors !== undefined) {
    if (input.selectors.length < 2) throw new KeiyakuUsageError("status requires at least two selectors");
    if (
      at.repo === undefined &&
      input.selectors.some((selector) => !selector.startsWith("aku/") && !selector.startsWith("@"))
    ) {
      throw new KeiyakuUsageError("cannot select a contract while the Contract world is absent");
    }
    const authority = input.selectors.some((selector) => selector.startsWith("@"))
      ? await observeNamedAddress({ world: at.world, repo: at.repo ?? null, selectors: input.selectors })
      : undefined;
    const items: StatusItem[] = [];
    for (const selector of input.selectors) {
      items.push(
        selector.startsWith("aku/")
          ? await akumaStatus(at, selector)
          : selector.startsWith("@")
            ? await namedStatus(at, selector, authority!)
            : await contractStatus(at, selector),
      );
    }
    return { items };
  }
  if (input.selector === undefined) {
    return kanshi({ world: at.world, ...(at.repo === undefined ? {} : { repo: at.repo }) });
  }
  if (input.selector.startsWith("aku/")) return akumaStatus(at, input.selector);
  if (input.selector.startsWith("@")) {
    const authority = await observeNamedAddress({
      world: at.world,
      repo: at.repo ?? null,
      selectors: [input.selector],
    });
    return namedStatus(at, input.selector, authority);
  }
  if (input.selector.startsWith("kei/")) return contractStatus(at, input.selector);
  throw new KeiyakuUsageError(`contract selector must use kei/: ${input.selector}`);
}
