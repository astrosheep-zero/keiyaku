import { AKUMA_REQUESTS_ENTRY_ENV, AKUMA_REQUESTS_ENV } from "../../akuma/providers/execution-environment.js";
import { AkumaOwner } from "../../akuma/akuma-owner.js";
import { readSoul } from "../../akuma/heart/index.js";
import { parseAkuId, pathsForAkuId } from "../../akuma/identity.js";
import { Keiyaku, NoGitWorldError, Repo, type AkumaCaller, type AkumaStatus, type ContractId } from "../../index.js";
import { observeNamedAddress } from "../../library/address.js";
import { dispatchAssociations } from "../../library/selection.js";
import { World, type WorldRoot } from "../../world.js";
import { akumaCallerFromEnvironment } from "../akuma-caller.js";
import type { CliCoordinates } from "../coordinates.js";
import type { ParsedWhoamiCommand } from "../parse.js";
import { renderWhoami } from "../render/whoami.js";
import { submittingInitiator, type SubmittingInitiator } from "../square-identity.js";
import { emit } from "../streams.js";

type Caller = AkumaCaller | Readonly<{ kind: "none" }> | Readonly<{ kind: "invalid"; reason: string }>;
type Contract =
  | Readonly<{ kind: "resolved"; id: ContractId }>
  | Readonly<{ kind: "none" | "ambiguous" }>
  | Readonly<{ kind: "unavailable"; reason: string }>;
type Profile =
  | Readonly<{
      kind: "available";
      archetype: string;
      aliases: readonly string[];
      provider: string | null;
      model: string | null;
      workdir: string | null;
      birth: AkumaStatus["birth"];
      bornAt: string | null;
      allowed: AkumaStatus["allowed"];
      contracts: readonly ContractId[];
    }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

export type WhoamiFacts = Readonly<{
  world: WorldRoot | null;
  caller: Caller;
  initiator: SubmittingInitiator | null;
  requests: "local" | "parent";
  contract: Contract;
  profile?: Profile;
}>;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function callerFrom(environment: NodeJS.ProcessEnv): Promise<Caller> {
  try {
    return (await akumaCallerFromEnvironment(environment)) ?? { kind: "none" };
  } catch (error) {
    return { kind: "invalid", reason: reason(error) };
  }
}

async function contextualContract(coordinates: CliCoordinates, world: WorldRoot | null): Promise<Contract> {
  if (world === null || coordinates.repo === undefined) return { kind: "none" };
  try {
    const result = await Keiyaku.with().resolve({ repo: coordinates.repo, cwd: coordinates.cwd });
    if (result.kind === "resolved") return result;
    return { kind: result.refusal.kind === "ambiguous-selector" ? "ambiguous" : "none" };
  } catch (error) {
    return { kind: "unavailable", reason: reason(error) };
  }
}

async function callerRepo(
  world: WorldRoot,
  coordinates: CliCoordinates,
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

async function callerProfile(
  caller: Extract<AkumaCaller, { kind: "akuma" }>,
  coordinates: CliCoordinates,
  environment: NodeJS.ProcessEnv,
): Promise<Profile> {
  try {
    if (!(await World.established(caller.world))) throw new Error("caller World is not established");
    const id = parseAkuId(caller.akuId);
    // This is the same status owner as the public read, without its plugin outcome observer.
    const [status, soul, aliases, repo] = await Promise.all([
      new AkumaOwner(id.id, caller.world).status(),
      readSoul(pathsForAkuId(caller.world, id.id)),
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
      archetype: id.archetype,
      aliases: aliases.aliases.value.filter((binding) => binding.akuId === id.id).map((binding) => binding.alias),
      provider: status.provider ?? null,
      model: status.model ?? null,
      workdir: status.cwd ?? null,
      birth: status.birth,
      bornAt: soul?.createdAt ?? null,
      allowed: status.allowed,
      contracts: dispatch.kind === "associated" ? [dispatch.contractId] : [],
    };
  } catch (error) {
    return { kind: "unavailable", reason: reason(error) };
  }
}

export async function runWhoami(
  command: ParsedWhoamiCommand,
  coordinates: CliCoordinates,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<number> {
  const world = coordinates.world !== null && (await World.established(coordinates.world)) ? coordinates.world : null;
  const [caller, initiator, contract] = await Promise.all([
    callerFrom(environment),
    submittingInitiator({
      ...(coordinates.candidateWorld === null ? {} : { path: coordinates.candidateWorld }),
      environment,
      readOnly: true,
      ...(signal === undefined ? {} : { signal }),
    }),
    contextualContract(coordinates, world),
  ]);
  const facts: WhoamiFacts = {
    world,
    caller,
    initiator: initiator ?? null,
    requests:
      environment[AKUMA_REQUESTS_ENV] !== undefined || environment[AKUMA_REQUESTS_ENTRY_ENV] !== undefined
        ? "parent"
        : "local",
    contract,
    ...(caller.kind === "akuma" ? { profile: await callerProfile(caller, coordinates, environment) } : {}),
  };
  return emit(command.output, facts, () => renderWhoami(facts), 0);
}
