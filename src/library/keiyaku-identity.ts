/** @architectureCompositionRoot */
import { z } from "zod";
import { decodeHarnessOwner, harnessOwner, type Owner } from "@astrosheep/square";
import { contractIdSchema } from "../git/identity.js";
import { AkumaNotBornError } from "../akuma/akuma-errors.js";
import { KeiyakuError } from "../errors.js";
import { readActorObservation } from "../akuma/heart/index.js";
import { akumaIdSchema, pathsForAkumaId, type AkumaId } from "../akuma/identity.js";
import { readAliases } from "../alias/index.js";
import { Keis } from "./contract-composition.js";
import { NoGitWorldError, Repo } from "./repo.js";
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

async function observeActor({ world, akumaId }: Extract<AkumaCaller, { kind: "akuma" }>) {
  try {
    const actor = await readActorObservation(pathsForAkumaId(world, akumaId), akumaId);
    if (actor === null) return { profileUnavailable: new AkumaNotBornError(akumaId).message };
    const { soul, initiator } = actor;
    const { caller, origin } = projectAkumaBirth(soul);
    const { model } = soul.options;
    return {
      ...(initiator === undefined ? {} : { initiator }),
      provider: soul.provider.name,
      ...(model === undefined ? {} : { model }),
      workdir: soul.cwd,
      birthCaller: caller.kind === "unknown" ? caller : callerFact(caller),
      ...(origin.kind === "fork" ? { forkOrigin: origin.parent } : {}),
    };
  } catch (error) {
    const diagnostic = reason(error);
    return { initiator: { kind: "unavailable" as const, diagnostic }, profileUnavailable: diagnostic };
  }
}

async function observeActorDispatch(world: WorldRoot, akumaId: AkumaId, repo?: Repo, gitPath?: string) {
  try {
    const actorRepo =
      repo?.root === world ? repo : await Repo.at({ path: world, ...(gitPath === undefined ? {} : { gitPath }) });
    return (await dispatchAssociations(actorRepo.root === world ? actorRepo : undefined, [akumaId])).get(akumaId)!;
  } catch (error) {
    if (error instanceof NoGitWorldError) return { kind: "none" as const };
    return { kind: "failed" as const, diagnostic: reason(error) };
  }
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
  const facts: { -readonly [Key in keyof WhoamiFacts]: WhoamiFacts[Key] } = { self };
  if (world !== null && (self.kind !== "akuma" || self.world !== world)) facts.world = world;
  if (contextContract !== undefined) facts.contextContract = contextContract;
  if (self.kind !== "akuma") return facts;

  const { akumaId, world: actorWorld } = self;
  const { initiator, profileUnavailable, ...profile } = await observeActor(self);
  if (initiator !== undefined) facts.initiator = initiator;
  try {
    if (!(await World.established(actorWorld)))
      return { ...facts, profileUnavailable: "caller World is not established" };
  } catch (error) {
    return { ...facts, profileUnavailable: reason(error) };
  }

  const failures: string[] = [];
  try {
    const aliases = (await readAliases(actorWorld)).filter((binding) => binding.akumaId === akumaId);
    if (aliases.length > 0) facts.aliases = aliases.map(({ alias }) => alias);
  } catch (error) {
    failures.push(reason(error));
  }
  const dispatch = await observeActorDispatch(actorWorld, akumaId, coordinates.repo, environment.KEIYAKU_GIT_PATH);
  if (dispatch.kind === "failed") failures.push(dispatch.diagnostic);
  else if (dispatch.kind === "associated") facts.dispatchContract = dispatch.contractId;
  if (profileUnavailable !== undefined) failures.push(profileUnavailable);
  if (failures.length > 0) facts.profileUnavailable = failures.join("; ");
  return { ...facts, ...profile };
}
