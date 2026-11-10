/** @architectureCompositionRoot */
import { z } from "zod";
import { contractIdSchema } from "../git/identity.js";
import { AkumaOwner } from "../akuma/akuma-owner.js";
import { readHeart, readLatestTurnForBody } from "../akuma/heart/index.js";
import { akumaIdSchema, parseAkumaId, pathsForAkumaId } from "../akuma/identity.js";
import { Keis } from "./contract-composition.js";
import { NoGitWorldError, Repo } from "./repo.js";
import { observeNamedAddress } from "./address.js";
import { dispatchAssociations } from "./selection.js";
import { decodeAkumaCaller, type AkumaCaller } from "../akuma/caller.js";
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
const unavailableSchema = z.strictObject({ kind: z.literal("unavailable"), diagnostic: z.string() }).readonly();
const callerSchema = z.union([
  z.strictObject({ kind: z.literal("akuma"), world: worldRootSchema, akumaId: akumaIdSchema }).readonly(),
  z.strictObject({ kind: z.literal("external"), id: z.string() }).readonly(),
]);
function callerFact(caller: AkumaCaller): z.output<typeof callerSchema> {
  return caller.kind === "akuma" ? caller : { kind: "external", id: `${caller.integration}:${caller.id}` };
}
export const whoamiFactsSchema = z
  .strictObject({
    self: z.union([
      callerSchema,
      z.strictObject({ kind: z.literal("none") }).readonly(),
      z.strictObject({ kind: z.literal("invalid"), diagnostic: z.string() }).readonly(),
    ]),
    world: worldRootSchema.exactOptional(),
    initiator: z.union([z.string(), unavailableSchema]).exactOptional(),
    contextContract: z
      .union([contractIdSchema, z.strictObject({ kind: z.literal("ambiguous") }).readonly(), unavailableSchema])
      .exactOptional(),
    aliases: z.array(z.string()).min(1).readonly().exactOptional(),
    workdir: z.string().exactOptional(),
    provider: z.string().exactOptional(),
    model: z.string().exactOptional(),
    dispatchContract: contractIdSchema.exactOptional(),
    birthCaller: z.union([callerSchema, z.strictObject({ kind: z.literal("unknown") }).readonly()]).exactOptional(),
    forkOrigin: akumaIdSchema.exactOptional(),
    profileUnavailable: z.string().exactOptional(),
  })
  .readonly();
export type WhoamiFacts = z.output<typeof whoamiFactsSchema>;
type Profile = Pick<
  WhoamiFacts,
  | "aliases"
  | "workdir"
  | "provider"
  | "model"
  | "dispatchContract"
  | "birthCaller"
  | "forkOrigin"
  | "profileUnavailable"
>;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function selfFrom(environment: NodeJS.ProcessEnv): Promise<WhoamiFacts["self"]> {
  try {
    const caller = await akumaCallerFromEnvironment(environment);
    return caller === undefined ? { kind: "none" } : callerFact(caller);
  } catch (error) {
    return { kind: "invalid", diagnostic: reason(error) };
  }
}

async function contextualContract(
  coordinates: WhoamiCoordinates,
  world: WorldRoot | null,
): Promise<WhoamiFacts["contextContract"]> {
  if (world === null || coordinates.repo === undefined) return undefined;
  try {
    const result = await Keis.of(coordinates.repo).resolve({ cwd: coordinates.cwd });
    if (result.kind === "resolved") return result.id;
    return result.refusal.kind === "ambiguous-selector" ? { kind: "ambiguous" } : undefined;
  } catch (error) {
    return { kind: "unavailable", diagnostic: reason(error) };
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

async function currentTurn(self: Extract<AkumaCaller, { kind: "akuma" }>): Promise<WhoamiFacts["initiator"]> {
  try {
    const paths = pathsForAkumaId(self.world, self.akumaId);
    const body = (await readHeart(paths)).latestBody;
    if (body === null || body.end !== undefined || body.hung !== undefined) return undefined;
    const turn = await readLatestTurnForBody(paths, body.sequence);
    if (turn === null || turn.end !== undefined) return undefined;
    // A later Body cannot attribute this older Turn to the current execution.
    const latest = (await readHeart(paths)).latestBody;
    return latest?.sequence === body.sequence && latest.end === undefined && latest.hung === undefined
      ? turn.initiator
      : undefined;
  } catch (error) {
    return { kind: "unavailable", diagnostic: reason(error) };
  }
}

async function callerProfile(
  caller: Extract<AkumaCaller, { kind: "akuma" }>,
  coordinates: WhoamiCoordinates,
  environment: NodeJS.ProcessEnv,
): Promise<Profile> {
  try {
    if (!(await World.established(caller.world))) throw new Error("caller World is not established");
    const id = parseAkumaId(caller.akumaId);
    const [status, aliases, repo] = await Promise.all([
      new AkumaOwner(id.id, caller.world).status(),
      observeNamedAddress({ world: caller.world, repo: null, selectors: [] }),
      callerRepo(caller.world, coordinates, environment),
    ]);
    if (aliases.aliases.kind !== "present") {
      throw new Error(aliases.aliases.kind === "failed" ? aliases.aliases.failure.message : "aliases unavailable");
    }
    const dispatch = (await dispatchAssociations(repo, [id.id])).get(id.id)!;
    if (dispatch.kind === "failed") throw new Error(dispatch.diagnostic);
    const bindings = aliases.aliases.value
      .filter((binding) => binding.akumaId === id.id)
      .map((binding) => binding.alias);
    return {
      ...(bindings.length === 0 ? {} : { aliases: bindings }),
      ...(status.provider === undefined ? {} : { provider: status.provider }),
      ...(status.model === undefined ? {} : { model: status.model }),
      ...(status.cwd === undefined ? {} : { workdir: status.cwd }),
      ...(dispatch.kind === "associated" ? { dispatchContract: dispatch.contractId } : {}),
      birthCaller: status.birth.caller.kind === "unknown" ? status.birth.caller : callerFact(status.birth.caller),
      ...(status.birth.origin.kind === "fork" ? { forkOrigin: status.birth.origin.parent } : {}),
    };
  } catch (error) {
    return { profileUnavailable: reason(error) };
  }
}

export async function whoami(coordinates: WhoamiCoordinates, environment: NodeJS.ProcessEnv): Promise<WhoamiFacts> {
  const world = coordinates.world !== null && (await World.established(coordinates.world)) ? coordinates.world : null;
  const [self, contextContract] = await Promise.all([selfFrom(environment), contextualContract(coordinates, world)]);
  const initiator = self.kind === "akuma" ? await currentTurn(self) : undefined;
  return {
    self,
    ...(world === null || (self.kind === "akuma" && self.world === world) ? {} : { world }),
    ...(contextContract === undefined ? {} : { contextContract }),
    ...(initiator === undefined ? {} : { initiator }),
    ...(self.kind === "akuma" ? await callerProfile(self, coordinates, environment) : {}),
  };
}
