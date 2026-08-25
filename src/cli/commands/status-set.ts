import type { StatusSetResult } from "../result.js";
import { CliUsageError } from "../parse.js";
import { canonicalContractSelector } from "../selectors.js";
import type { Repo } from "../../library/repo.js";
import type { WorldRoot } from "../../world.js";

type StatusSetEntry = StatusSetResult["entries"][number];
type NamedStatusObservation = Awaited<ReturnType<typeof import("../../kanshi/index.js").observeKanshi>>;

async function statusSetAkuma(
  selector: string,
  id: string,
  alias: string | undefined,
  world: WorldRoot | null,
  repo: Repo | undefined,
): Promise<StatusSetEntry> {
  if (world === null) throw new CliUsageError("no Keiyaku world contains the Akuma selector");
  const result = await (await import("./akuma-invoke.js")).invokeAkumaStatus(world, id, alias, repo);
  if (result.action !== "status") throw new Error("status invocation returned a non-status Akuma result");
  return {
    selector,
    kind: "akuma",
    status: result.status,
    ...(result.alias === undefined ? {} : { alias: result.alias }),
  };
}

async function statusSetEntry(
  selector: string,
  world: WorldRoot | null,
  repo: Repo | undefined,
  observed: NamedStatusObservation | undefined,
): Promise<StatusSetEntry> {
  let resolved = selector;
  let alias: string | undefined;
  if (selector.startsWith("@")) {
    if (observed === undefined) throw new CliUsageError("cannot resolve a named status selector");
    const { resolveNamedAddress } = await import("../../library/address.js");
    const address = resolveNamedAddress({ selector, report: observed.report, aliases: observed.aliases });
    if (address.kind === "akuma") return await statusSetAkuma(selector, address.id, selector, world, repo);
    resolved = address.id;
    alias = selector;
  }
  if (resolved.startsWith("aku/")) return await statusSetAkuma(selector, resolved, alias, world, repo);
  if (repo === undefined) throw new CliUsageError("cannot select a contract while the Contract world is absent");
  if (observed === undefined) throw new CliUsageError("cannot observe Contract status without a Kanshi report");
  return {
    selector,
    kind: "contract",
    report: (await import("../../kanshi/index.js")).selectKanshi({
      report: observed.report,
      contract: canonicalContractSelector(resolved),
    }),
  };
}

export async function invokeStatusSet(
  selectors: readonly string[],
  world: WorldRoot | null,
  repo: Repo | undefined,
): Promise<StatusSetResult> {
  if (selectors.length < 2) throw new CliUsageError("status requires at least two selectors");
  if (selectors.some((selector) => !selector.startsWith("aku/") && !selector.startsWith("@")) && repo === undefined) {
    throw new CliUsageError("cannot select a contract while the Contract world is absent");
  }
  const needsKanshi = selectors.some((selector) => !selector.startsWith("aku/"));
  const observed = needsKanshi
    ? await (
        await import("../../kanshi/index.js")
      ).observeKanshi({
        world,
        ...(repo === undefined ? {} : { repo }),
      })
    : undefined;
  const entries: StatusSetEntry[] = [];
  for (const selector of selectors) entries.push(await statusSetEntry(selector, world, repo, observed));
  return { kind: "status-set", entries };
}
