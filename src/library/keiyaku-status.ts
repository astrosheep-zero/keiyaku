/** @architectureCompositionRoot */
import type { ContractId } from "../core/facts/types.js";
import { identitySegments } from "../identity/coordinates.js";
import { kanshi, kanshiCategory, type KanshiCategoryReport, type KanshiReport } from "../kanshi/index.js";
import type { WorldRoot } from "../world.js";
import { observeNamedAddress, resolveNamedAddress, type NamedAddressAuthority } from "./address.js";
import { Akumas, type AkumaObservation } from "./akumas.js";
import { KeiyakuUsageError } from "./keiyaku-coordinates.js";
import type { Repo } from "./repo.js";

type StatusAt = Readonly<{ cwd: string; repo?: Repo; world: WorldRoot | null }>;
export type StatusInput = Readonly<{
  selectors?: readonly string[];
  selector?: string;
  category?: KanshiCategoryReport["category"];
  limit?: number;
}>;
type StatusObservation = KanshiReport | AkumaObservation;

function requiredRepo(at: StatusAt): Repo {
  if (at.repo === undefined) throw new KeiyakuUsageError("this command requires a resolved Repo");
  return at.repo;
}

async function contractStatus(at: StatusAt, selector: string): Promise<KanshiReport> {
  const repo = requiredRepo(at);
  try {
    identitySegments({ family: "kei", value: selector });
  } catch {
    throw new KeiyakuUsageError(`contract selector must use kei/: ${selector}`);
  }
  return kanshi({ world: at.world, repo, contract: selector as ContractId });
}

async function akumaStatus(at: StatusAt, selector: string): Promise<AkumaObservation> {
  if (at.world === null) throw new KeiyakuUsageError("no Keiyaku world contains the Akuma selector");
  return Akumas.of(at.world).status({
    akuma: selector,
    ...(at.repo === undefined ? {} : { repo: at.repo }),
  });
}

async function namedStatus(
  at: StatusAt,
  selector: string,
  authority: NamedAddressAuthority,
): Promise<StatusObservation> {
  const address = resolveNamedAddress({ selector, ...authority });
  return address.kind === "akuma" ? akumaStatus(at, address.id) : contractStatus(at, address.id);
}

export async function statusAt(
  at: StatusAt,
  input: StatusInput,
): Promise<KanshiReport | KanshiCategoryReport | AkumaObservation | readonly StatusObservation[]> {
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
      ? await observeNamedAddress({ world: at.world, repo: at.repo ?? null })
      : undefined;
    const values: StatusObservation[] = [];
    for (const selector of input.selectors) {
      values.push(
        selector.startsWith("aku/")
          ? await akumaStatus(at, selector)
          : selector.startsWith("@")
            ? await namedStatus(at, selector, authority!)
            : await contractStatus(at, selector),
      );
    }
    return values;
  }
  if (input.selector === undefined) {
    return kanshi({ world: at.world, ...(at.repo === undefined ? {} : { repo: at.repo }) });
  }
  if (input.selector.startsWith("aku/")) return akumaStatus(at, input.selector);
  if (input.selector.startsWith("@")) {
    const authority = await observeNamedAddress({ world: at.world, repo: at.repo ?? null });
    return namedStatus(at, input.selector, authority);
  }
  if (input.selector.startsWith("kei/")) return contractStatus(at, input.selector);
  throw new KeiyakuUsageError(`contract selector must use kei/: ${input.selector}`);
}
