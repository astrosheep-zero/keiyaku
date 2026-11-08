import { join } from "node:path";
import { AkumaOwner } from "../../src/akuma/akuma-owner.js";
import { readAkumaCompleteRoster, readAkumaRoster } from "../../src/akuma/akuma.js";
import type { AkumaCallInput } from "../../src/akuma/akuma-call.js";
import { Akumas } from "../../src/index.js";
import type { AkumaConfiguration } from "../../src/akuma/akuma-call.js";
import type { AkumaCompleteList, AkumaList, AkumaListInput } from "../../src/akuma/akuma.js";
import { listArchetypes } from "../../src/akuma/archetype.js";
import { admitCallInitialTell } from "../../src/akuma/call-initial-tell.js";
import { parseAkumaId } from "../../src/akuma/identity.js";
import { projectTell } from "../../src/akuma/heart/index.js";
import { readAliases, type AliasBinding } from "../../src/alias/index.js";
import type { AkumaAlias } from "../../src/identity/selector.js";
import type { WorldRoot } from "../../src/world.js";
import type { LastAnswer } from "../../src/akuma/akuma-owner.js";
export function recordCallInitialTell(world: WorldRoot, now: () => string = () => new Date().toISOString()) {
  return async (input: Omit<Parameters<typeof admitCallInitialTell>[0], "world" | "now" | "wake">) =>
    await admitCallInitialTell({
      world,
      ...input,
      now,
      wake: async (tell) => ({
        admission: { tellId: tell.id, fact: "recorded" },
        row: projectTell(tell),
        wake: { kind: "held" },
      }),
    });
}

export function isolateSquareFixtureLedger(root: string): () => void {
  const previous = process.env.SQUARE_DELIVERY;
  process.env.SQUARE_DELIVERY = join(root, "square-ledger", "delivery.sqlite");
  return () => {
    if (previous === undefined) delete process.env.SQUARE_DELIVERY;
    else process.env.SQUARE_DELIVERY = previous;
  };
}

function withRosterAliases(roster: AkumaList, bindings: readonly AliasBinding[]): AkumaList {
  const byId = new Map<string, AkumaAlias[]>();
  for (const binding of bindings) {
    const aliases = byId.get(binding.akumaId) ?? [];
    aliases.push(binding.alias);
    byId.set(binding.akumaId, aliases);
  }
  return { ...roster, rows: roster.rows.map((row) => ({ ...row, aliases: byId.get(row.id) ?? [] })) };
}

/** Test composition over the one lower owner; no parallel production facade. */
export class AkumaComposition {
  private constructor(
    private readonly root: WorldRoot,
    private readonly configuration: AkumaConfiguration,
  ) {}

  static of(root: WorldRoot, input: AkumaConfiguration = {}): AkumaComposition {
    return new AkumaComposition(root, input);
  }

  of(input: Readonly<{ id: string }>): AkumaOwner {
    return new AkumaOwner(parseAkumaId(input.id).id, this.root);
  }

  async call(input: AkumaCallInput): Promise<AkumaOwner> {
    const result = await Akumas.of(this.root).spawn({
      ...input,
      cwd: input.cwd ?? process.cwd(),
      ...(this.configuration.home === undefined ? {} : { home: this.configuration.home }),
      ...(this.configuration.settings === undefined ? {} : { settings: this.configuration.settings }),
      mode: "detach",
    });
    if (result.observation.kind === "failed") throw new Error(result.observation.failure.diagnostic);
    return this.of({ id: result.akuma });
  }

  async listArchetypes(): Promise<readonly string[]> {
    return await listArchetypes({
      project: this.root,
      ...(this.configuration.home === undefined ? {} : { home: this.configuration.home }),
    });
  }

  async listComplete(input: AkumaListInput = {}): Promise<AkumaCompleteList> {
    return await readAkumaCompleteRoster(this.root, {
      ...(input.akumaName === undefined ? {} : { akumaName: input.akumaName }),
      ...(input.caller === undefined ? {} : { caller: input.caller }),
    });
  }

  async list(input: AkumaListInput = {}): Promise<AkumaList> {
    const roster = await readAkumaRoster(this.root, input);
    return roster.rows.length === 0 ? roster : withRosterAliases(roster, await readAliases(this.root));
  }
}

export { AkumaOwner };
export type { LastAnswer };
