import { join } from "node:path";
import { AkumaOwner, listAkumaArchetypes, readAkumaCompleteRoster, readAkumaRoster } from "../../src/akuma/akuma.js";
import type { AkumaCallInput } from "../../src/akuma/akuma.js";
import { Akumas } from "../../src/index.js";
import { akumasWithExecution } from "../../src/library/akumas.js";
import type {
  AkumaConfiguration,
  AkumaCompleteList,
  AkumaList,
  AkumaListInput,
} from "../../src/akuma/akuma.js";
import { admitCallInitialTell } from "../../src/akuma/call-initial-tell.js";
import { parseAkuId } from "../../src/akuma/identity.js";
import { projectTell } from "../../src/akuma/heart/index.js";
import { readAliases, type AliasBinding } from "../../src/alias/index.js";
import type { AkumaAlias } from "../../src/identity/selector.js";
import type { WorldRoot } from "../../src/world.js";
import type { LastAnswer } from "../../src/akuma/akuma.js";
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
  const previousLocal = process.env.SQUARE_HOST_LEDGER_LOCAL;
  const previousUser = process.env.SQUARE_HOST_LEDGER_USER;
  process.env.SQUARE_HOST_LEDGER_LOCAL = join(root, "local-ledger");
  process.env.SQUARE_HOST_LEDGER_USER = join(root, "user-ledger");
  return () => {
    if (previousLocal === undefined) delete process.env.SQUARE_HOST_LEDGER_LOCAL;
    else process.env.SQUARE_HOST_LEDGER_LOCAL = previousLocal;
    if (previousUser === undefined) delete process.env.SQUARE_HOST_LEDGER_USER;
    else process.env.SQUARE_HOST_LEDGER_USER = previousUser;
  };
}

function withRosterAliases(roster: AkumaList, bindings: readonly AliasBinding[]): AkumaList {
  const byId = new Map<string, AkumaAlias[]>();
  for (const binding of bindings) {
    const aliases = byId.get(binding.akuId) ?? [];
    aliases.push(binding.alias);
    byId.set(binding.akuId, aliases);
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
    return new AkumaOwner(parseAkuId(input.id).id, this.root);
  }

  async call(input: AkumaCallInput): Promise<AkumaOwner> {
    const execution = this.configuration.execution;
    const caller = execution === undefined ? Akumas.of(this.root) : akumasWithExecution(this.root, execution);
    const cwd = input.cwd ?? (execution?.channel.kind === "body-request" ? undefined : process.cwd());
    const result = await caller.call({
      ...input,
      ...(cwd === undefined ? {} : { cwd }),
      ...(this.configuration.home === undefined ? {} : { home: this.configuration.home }),
      ...(this.configuration.settings === undefined ? {} : { settings: this.configuration.settings }),
      mode: "detach",
    });
    if (result.observation.kind === "failed") throw new Error(result.observation.failure.diagnostic);
    return this.of({ id: result.akuma });
  }

  async listArchetypes(): Promise<readonly string[]> {
    return await listAkumaArchetypes(
      this.root,
      this.configuration.home === undefined ? {} : { home: this.configuration.home },
    );
  }

  async listComplete(input: AkumaListInput = {}): Promise<AkumaCompleteList> {
    if (input.archetype !== undefined) return await readAkumaCompleteRoster(this.root, { archetype: input.archetype });
    return await readAkumaCompleteRoster(this.root);
  }

  async list(input: AkumaListInput = {}): Promise<AkumaList> {
    const roster = await readAkumaRoster(this.root, input);
    return roster.rows.length === 0 ? roster : withRosterAliases(roster, await readAliases(this.root));
  }
}

export { AkumaOwner };
export type { LastAnswer };
