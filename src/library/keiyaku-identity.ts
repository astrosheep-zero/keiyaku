/** @architectureCompositionRoot */
import { z } from "zod";
import { contractIdSchema } from "../git/identity.js";
import { AkumaOwner } from "../akuma/akuma-owner.js";
import type { AkumaStatus } from "../akuma/akuma.js";
import { readHeart, readLatestTurnForBody } from "../akuma/heart/index.js";
import { parseAkumaId, pathsForAkumaId } from "../akuma/identity.js";
import type { ContractId } from "../core/facts/types.js";
import { Keis } from "./contract-composition.js";
import { NoGitWorldError, Repo } from "./repo.js";
import { observeNamedAddress } from "./address.js";
import { dispatchAssociations } from "./selection.js";
import { akumaBirthSchema, akumaCallerSchema, decodeAkumaCaller, type AkumaCaller } from "../akuma/caller.js";
import { World, worldRootSchema, type WorldRoot } from "../world.js";

/** Environment attribution is explicit invocation input, never SDK admission. */
export async function akumaCallerFromEnvironment(environment: NodeJS.ProcessEnv): Promise<AkumaCaller | undefined> {
  const id = environment.KEIYAKU_ACTOR_ID;
  const world = environment.KEIYAKU_ACTOR_WORLD;
  if ((id === undefined) !== (world === undefined)) {
    throw new TypeError("Akuma caller requires both KEIYAKU_ACTOR_ID and KEIYAKU_ACTOR_WORLD");
  }
  if (id !== undefined && world !== undefined) {
    const resolved = await World.resolve({ cwd: world, repositoryRoot: world });
    return decodeAkumaCaller({ kind: "akuma", akumaId: id, world: resolved.candidate });
  }
  const hosts = [
    { integration: "codex", variable: "CODEX_THREAD_ID", id: environment.CODEX_THREAD_ID },
    { integration: "pi", variable: "PI_SESSION_ID", id: environment.PI_SESSION_ID },
    { integration: "claude", variable: "CLAUDE_CODE_SESSION_ID", id: environment.CLAUDE_CODE_SESSION_ID },
  ].filter(({ id }) => id !== undefined && id !== "");
  if (hosts.length > 1) {
    throw new TypeError(`Ambiguous native host caller: ${hosts.map(({ variable }) => variable).join(", ")}`);
  }
  if (hosts[0]) return decodeAkumaCaller({ kind: "external", integration: hosts[0].integration, id: hosts[0].id });
  const external = environment.KEIYAKU_EXTERNAL_CALLER;
  if (external === undefined) return undefined;
  const colon = external.indexOf(":");
  if (colon < 0) throw new TypeError("KEIYAKU_EXTERNAL_CALLER must be <integration>:<id>");
  return decodeAkumaCaller({ kind: "external", integration: external.slice(0, colon), id: external.slice(colon + 1) });
}

type WhoamiCoordinates = Readonly<{ cwd: string; repo?: Repo; world: WorldRoot | null }>;

type Self = AkumaCaller | Readonly<{ kind: "none" }> | Readonly<{ kind: "invalid"; reason: string }>;
type Contract =
  | Readonly<{ kind: "resolved"; id: ContractId }>
  | Readonly<{ kind: "none" | "ambiguous" }>
  | Readonly<{ kind: "unavailable"; reason: string }>;
type Profile =
  | Readonly<{
      kind: "available";
      akumaName: string;
      aliases: readonly string[];
      provider: string | null;
      model: string | null;
      workdir: string | null;
      birth: AkumaStatus["birth"];
      bornAt: string | null;
      contracts: readonly ContractId[];
    }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

export type WhoamiFacts = Readonly<{
  world: WorldRoot | null;
  self: Self;
  initiator: string | null;
  initiatorUnavailable?: string;
  contract: Contract;
  profile?: Profile;
}>;

export const whoamiFactsSchema = z
  .strictObject({
    world: worldRootSchema.nullable(),
    self: z.union([
      akumaCallerSchema,
      z.strictObject({ kind: z.literal("none") }).readonly(),
      z.strictObject({ kind: z.literal("invalid"), reason: z.string() }).readonly(),
    ]),
    initiator: z.string().nullable(),
    initiatorUnavailable: z.string().exactOptional(),
    contract: z.union([
      z.strictObject({ kind: z.literal("resolved"), id: contractIdSchema }).readonly(),
      z.strictObject({ kind: z.enum(["none", "ambiguous"]) }).readonly(),
      z.strictObject({ kind: z.literal("unavailable"), reason: z.string() }).readonly(),
    ]),
    profile: z
      .union([
        z
          .strictObject({
            kind: z.literal("available"),
            akumaName: z.string(),
            aliases: z.array(z.string()).readonly(),
            provider: z.string().nullable(),
            model: z.string().nullable(),
            workdir: z.string().nullable(),
            birth: akumaBirthSchema,
            bornAt: z.string().nullable(),
            contracts: z.array(contractIdSchema).readonly(),
          })
          .readonly(),
        z.strictObject({ kind: z.literal("unavailable"), reason: z.string() }).readonly(),
      ])
      .exactOptional(),
  })
  .readonly();

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function selfFrom(environment: NodeJS.ProcessEnv): Promise<Self> {
  try {
    return (await akumaCallerFromEnvironment(environment)) ?? { kind: "none" };
  } catch (error) {
    return { kind: "invalid", reason: reason(error) };
  }
}

async function contextualContract(coordinates: WhoamiCoordinates, world: WorldRoot | null): Promise<Contract> {
  if (world === null || coordinates.repo === undefined) return { kind: "none" };
  try {
    const result = await Keis.of(coordinates.repo).resolve({ cwd: coordinates.cwd });
    if (result.kind === "resolved") return result;
    return { kind: result.refusal.kind === "ambiguous-selector" ? "ambiguous" : "none" };
  } catch (error) {
    return { kind: "unavailable", reason: reason(error) };
  }
}

async function callerRepo(
  world: WorldRoot,
  coordinates: WhoamiCoordinates,
  environment: NodeJS.ProcessEnv,
): Promise<Repo | undefined> {
  if (coordinates.repo?.root === world) return coordinates.repo;
  try {
    const repo = await Repo.at({
      path: world,
      ...(environment.KEIYAKU_GIT_PATH === undefined ? {} : { gitPath: environment.KEIYAKU_GIT_PATH }),
    });
    return repo.root === world ? repo : undefined;
  } catch (error) {
    if (error instanceof NoGitWorldError) return undefined;
    throw error;
  }
}

type CurrentTurn = Readonly<{ initiator: string | null; bornAt: string | null; unavailable?: string }>;

async function currentTurn(self: Extract<AkumaCaller, { kind: "akuma" }>): Promise<CurrentTurn> {
  let bornAt: string | null = null;
  try {
    const paths = pathsForAkumaId(self.world, self.akumaId);
    const heart = await readHeart(paths);
    bornAt = heart.soul?.createdAt ?? null;
    const body = heart.latestBody;
    if (body === null || body.end !== undefined || body.hung !== undefined) return { initiator: null, bornAt };
    const turn = await readLatestTurnForBody(paths, body.sequence);
    if (turn === null || turn.end !== undefined) return { initiator: null, bornAt };
    // Confirm that the Body was still current and open when this Turn was observed.
    const latest = (await readHeart(paths)).latestBody;
    const initiator =
      latest?.sequence === body.sequence && latest.end === undefined && latest.hung === undefined
        ? (turn.initiator ?? null)
        : null;
    return { initiator, bornAt };
  } catch (error) {
    return { initiator: null, bornAt, unavailable: reason(error) };
  }
}

async function callerProfile(
  caller: Extract<AkumaCaller, { kind: "akuma" }>,
  coordinates: WhoamiCoordinates,
  environment: NodeJS.ProcessEnv,
  bornAt: string | null,
): Promise<Profile> {
  try {
    if (!(await World.established(caller.world))) throw new Error("caller World is not established");
    const id = parseAkumaId(caller.akumaId);
    // This is the same status owner as the public read, without its plugin outcome observer.
    const [status, aliases, repo] = await Promise.all([
      new AkumaOwner(id.id, caller.world).status(),
      observeNamedAddress({ world: caller.world, repo: null }),
      callerRepo(caller.world, coordinates, environment),
    ]);
    if (aliases.aliases.kind !== "present") {
      throw new Error(aliases.aliases.kind === "failed" ? aliases.aliases.failure.message : "aliases unavailable");
    }
    const dispatch = (await dispatchAssociations(repo, [id.id])).get(id.id)!;
    if (dispatch.kind === "failed") throw new Error(dispatch.diagnostic);
    return {
      kind: "available",
      akumaName: id.akumaName,
      aliases: aliases.aliases.value.filter((binding) => binding.akumaId === id.id).map((binding) => binding.alias),
      provider: status.provider ?? null,
      model: status.model ?? null,
      workdir: status.cwd ?? null,
      birth: status.birth,
      bornAt,
      contracts: dispatch.kind === "associated" ? [dispatch.contractId] : [],
    };
  } catch (error) {
    return { kind: "unavailable", reason: reason(error) };
  }
}

export async function whoami(coordinates: WhoamiCoordinates, environment: NodeJS.ProcessEnv): Promise<WhoamiFacts> {
  const world = coordinates.world !== null && (await World.established(coordinates.world)) ? coordinates.world : null;
  const [self, contract] = await Promise.all([selfFrom(environment), contextualContract(coordinates, world)]);
  const turn = self.kind === "akuma" ? await currentTurn(self) : undefined;
  const facts: WhoamiFacts = {
    world,
    self,
    initiator: turn?.initiator ?? null,
    ...(turn?.unavailable === undefined ? {} : { initiatorUnavailable: turn.unavailable }),
    contract,
    ...(self.kind === "akuma"
      ? { profile: await callerProfile(self, coordinates, environment, turn?.bornAt ?? null) }
      : {}),
  };
  return facts;
}
