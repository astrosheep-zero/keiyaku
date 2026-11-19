/** @architectureCompositionRoot */
import { z } from "zod";
import { decodeHarnessOwner, harnessOwner, type Owner } from "@astrosheep/square";
import { contractIdSchema } from "../git/identity.js";
import { AkumaNotBornError } from "../akuma/akuma-errors.js";
import { KeiyakuError } from "../errors.js";
import { readActorObservation, type ActorObservation } from "../akuma/heart/index.js";
import { akumaIdSchema, parseAkumaId, pathsForAkumaId } from "../akuma/identity.js";
import { Keis } from "./contract-composition.js";
import { NoGitWorldError, Repo } from "./repo.js";
import { observeNamedAddress } from "./address.js";
import { dispatchAssociations } from "./selection.js";
import { akumaCallerSchema, decodeAkumaCaller, projectAkumaBirth, type AkumaCaller } from "../akuma/caller.js";
import { World, worldRootSchema, type WorldRoot } from "../world.js";

function callerFromOwner(owner: Owner): AkumaCaller {
  const coordinate = decodeHarnessOwner(owner);
  // Only session-only native coordinates have an existing lineage representation.
  // Keep other Owners whole, especially agents sharing one harness session.
  if (
    coordinate !== undefined &&
    coordinate.agent === undefined &&
    ["pi", "codex", "claude-code", "opencode", "paseo"].includes(coordinate.channel)
  ) {
    const caller = akumaCallerSchema.safeParse({
      kind: "external",
      integration: coordinate.channel === "claude-code" ? "claude" : coordinate.channel,
      id: coordinate.session,
    });
    try {
      if (caller.success && harnessOwner(coordinate) === owner) return caller.data;
    } catch {
      // A valid opaque Owner need not be representable as a harness coordinate.
    }
  }
  return { kind: "external", integration: "square", id: owner };
}

/** Actor declarations win; a host Owner bypasses native environment decoding. */
export async function akumaCallerFromEnvironment(
  environment: NodeJS.ProcessEnv,
  owner?: Owner,
): Promise<AkumaCaller | undefined> {
  const id = environment.KEIYAKU_ACTOR_ID;
  const world = environment.KEIYAKU_ACTOR_WORLD;
  if ((id === undefined) !== (world === undefined)) {
    throw new KeiyakuError("invalid-input", "Akuma caller requires both KEIYAKU_ACTOR_ID and KEIYAKU_ACTOR_WORLD");
  }
  if (id !== undefined && world !== undefined) {
    const resolved = await World.resolve({ cwd: world, repositoryRoot: world });
    return decodeAkumaCaller({ kind: "akuma", akumaId: id, world: resolved.candidate });
  }
  if (owner !== undefined) return callerFromOwner(owner);
  const hosts = [
    { integration: "codex", variable: "CODEX_THREAD_ID", id: environment.CODEX_THREAD_ID },
    { integration: "pi", variable: "PI_SESSION_ID", id: environment.PI_SESSION_ID },
    { integration: "claude", variable: "CLAUDE_CODE_SESSION_ID", id: environment.CLAUDE_CODE_SESSION_ID },
  ].filter(({ id }) => id !== undefined && id !== "");
  if (hosts.length > 1) {
    throw new KeiyakuError(
      "invalid-input",
      `Ambiguous native host caller: ${hosts.map(({ variable }) => variable).join(", ")}`,
    );
  }
  if (hosts[0]) return decodeAkumaCaller({ kind: "external", integration: hosts[0].integration, id: hosts[0].id });
  const external = environment.KEIYAKU_EXTERNAL_CALLER;
  if (external === undefined) return undefined;
  const colon = external.indexOf(":");
  if (colon < 0) throw new KeiyakuError("invalid-input", "KEIYAKU_EXTERNAL_CALLER must be <integration>:<id>");
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
type MutableProfile = { -readonly [Key in keyof Profile]: Profile[Key] };

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function selfFrom(environment: NodeJS.ProcessEnv, explicit?: Owner): Promise<WhoamiFacts["self"]> {
  try {
    const caller = await akumaCallerFromEnvironment(environment, explicit);
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

type ActorState = Readonly<{ observation?: ActorObservation; unavailable?: string }>;

async function observeActor(self: Extract<AkumaCaller, { kind: "akuma" }>): Promise<ActorState> {
  try {
    return { observation: await readActorObservation(pathsForAkumaId(self.world, self.akumaId)) };
  } catch (error) {
    return { unavailable: reason(error) };
  }
}

/** The initiator is the open Turn of the current Body, and nothing else. */
function currentInitiator(actor: ActorState): WhoamiFacts["initiator"] {
  if (actor.unavailable !== undefined) return { kind: "unavailable", diagnostic: actor.unavailable };
  return actor.observation?.turn?.initiator;
}

async function callerProfile(
  caller: Extract<AkumaCaller, { kind: "akuma" }>,
  actor: ActorState,
  coordinates: WhoamiCoordinates,
  environment: NodeJS.ProcessEnv,
): Promise<Profile> {
  let id: ReturnType<typeof parseAkumaId>;
  try {
    if (!(await World.established(caller.world))) return { profileUnavailable: "caller World is not established" };
    id = parseAkumaId(caller.akumaId);
  } catch (error) {
    return { profileUnavailable: reason(error) };
  }

  const profile: MutableProfile = {};
  const failures: string[] = [];

  try {
    const aliases = await observeNamedAddress({ world: caller.world, repo: null, selectors: [] });
    if (aliases.aliases.kind === "present") {
      const bindings = aliases.aliases.value
        .filter((binding) => binding.akumaId === id.id)
        .map((binding) => binding.alias);
      if (bindings.length > 0) profile.aliases = bindings;
    } else {
      failures.push(aliases.aliases.kind === "failed" ? aliases.aliases.failure.message : "aliases unavailable");
    }
  } catch (error) {
    failures.push(reason(error));
  }

  try {
    const repo = await callerRepo(caller.world, coordinates, environment);
    const dispatch = (await dispatchAssociations(repo, [id.id])).get(id.id)!;
    if (dispatch.kind === "failed") failures.push(dispatch.diagnostic);
    else if (dispatch.kind === "associated") profile.dispatchContract = dispatch.contractId;
  } catch (error) {
    failures.push(reason(error));
  }

  // Alias, Dispatch and the Heart profile are independent observations; only
  // the failing authority becomes unavailable while every known fact stays.
  if (actor.unavailable !== undefined) failures.push(actor.unavailable);
  else {
    const soul = actor.observation?.soul ?? null;
    if (soul === null) failures.push(new AkumaNotBornError(id.id).message);
    else if (soul.id !== id.id) failures.push("Akuma soul does not match its coordinate");
    else {
      const birth = projectAkumaBirth(soul);
      profile.provider = soul.provider.name;
      if (soul.options.model !== undefined) profile.model = soul.options.model;
      profile.workdir = soul.cwd;
      profile.birthCaller = birth.caller.kind === "unknown" ? birth.caller : callerFact(birth.caller);
      if (soul.origin.kind === "fork") profile.forkOrigin = soul.origin.parent;
    }
  }

  if (failures.length > 0) profile.profileUnavailable = failures.join("; ");
  return profile;
}

export async function whoami(
  coordinates: WhoamiCoordinates,
  environment: NodeJS.ProcessEnv,
  owner?: Owner,
): Promise<WhoamiFacts> {
  const world = coordinates.world !== null && (await World.established(coordinates.world)) ? coordinates.world : null;
  const [self, contextContract] = await Promise.all([
    selfFrom(environment, owner),
    contextualContract(coordinates, world),
  ]);
  const worldFact = world === null || (self.kind === "akuma" && self.world === world) ? {} : { world };
  const contextFact = contextContract === undefined ? {} : { contextContract };
  if (self.kind !== "akuma") return { self, ...worldFact, ...contextFact };
  const actor = await observeActor(self);
  const initiator = currentInitiator(actor);
  return {
    self,
    ...worldFact,
    ...contextFact,
    ...(initiator === undefined ? {} : { initiator }),
    ...(await callerProfile(self, actor, coordinates, environment)),
  };
}
