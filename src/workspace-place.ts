import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { replaceFileDurably } from "./coordination/durable-file.js";
import { acquireSqliteTransactionLock } from "./coordination/sqlite-transaction-lock.js";
import { AuthorityCorruptionError } from "./core/facts/errors.js";
import { contractId, type ContractId } from "./core/facts/types.js";
import type { GitRepository } from "./git/process.js";
import { worktreePath } from "./git/workspace.js";

export const CONTRACT_PLACES = Object.freeze([
  "atlantis",
  "hogwarts",
  "narnia",
  "neverland",
  "mordor",
  "shire",
  "olympus",
  "valhalla",
  "asgard",
  "hades",
  "camelot",
  "avalon",
  "utopia",
  "azkaban",
  "konoha",
  "namek",
  "laputa",
  "tatooine",
  "stomach",
  "eyeball",
  "braincell",
  "appendix",
  "nostril",
  "armpit",
  "chineseroom",
  "catbox",
  "babel",
  "teapot",
  "blackhole",
  "wormhole",
  "devnull",
  "localhost",
  "recyclebin",
  "bikeshed",
  "serverroom",
  "spawnpoint",
  "bossroom",
  "hiddenlevel",
  "warpzone",
  "styx",
  "limbo",
  "purgatory",
  "penglai",
  "longgong",
  "nantianmen",
  "guimenguan",
  "naiheqiao",
  "backrooms",
  "bermuda",
  "upsidedown",
  "mindpalace",
  "pandorabox",
  "friendzone",
  "comfortzone",
  "echochamber",
  "rabbithole",
  "ivorytower",
  "doghouse",
  "panicroom",
  "shoebox",
  "snowglobe",
  "dollhouse",
  "donuthole",
  "dumpster",
  "blanketfort",
  "kotatsu",
  "fishbowl",
  "pokeball",
  "pineapple",
  "titanic",
  "disneyland",
  "ikea",
  "costco",
  "warppipe",
  "tetris",
  "minecraft",
  "ufo",
  "catbus",
  "timemachine",
  "moonbox",
  "huaguoshan",
  "pansidong",
  "bellybutton",
  "sock",
  "spam",
  "downloads",
  "toilet",
  "blender",
  "toaster",
  "litterbox",
  "kiddiepool",
  "beanbag",
  "vacuum",
  "elevator",
  "glovebox",
  "attic",
  "cloud",
  "wall",
  "can",
  "cup",
  "wc",
  "bean",
  "bus",
  "helicopter",
  "commandroom",
  "box",
  "jar",
  "pot",
  "wok",
  "bowl",
  "bucket",
  "drawer",
  "sofa",
  "fridge",
  "microwave",
  "well",
  "ditch",
  "puddle",
  "tent",
  "cave",
  "shed",
  "garage",
  "basement",
  "balcony",
  "corner",
  "pigpen",
  "henhouse",
  "excavator",
  "tank",
  "submarine",
  "treehouse",
  "igloo",
  "phonebooth",
  "mailbox",
  "doormat",
  "bathtub",
  "wardrobe",
  "quicksand",
  "tarpit",
  "haystack",
  "manhole",
  "chimney",
  "dryer",
  "fittingroom",
  "lazysusan",
  "revolvingdoor",
  "minibar",
  "casino",
  "karaoke",
  "pinball",
  "funhouse",
  "burrito",
  "dumpling",
  "hotpot",
  "bento",
  "teabag",
  "fortunecookie",
  "airlock",
  "escapepod",
  "hammock",
  "legroom",
  "sidequest",
  "lootbox",
  "gutter",
  "pawnshop",
  "hermitcrab",
  "couchgap",
  "dumbwaiter",
  "petridish",
  "baggageclaim",
  "morgue",
  "ballpit",
  "clawmachine",
]);

const PLACE_INDEX = new Map(CONTRACT_PLACES.map((base, index) => [base, index]));
const PLACE_VERSION = 1;
const GENERATION_SUFFIX = /^(?:[2-9]|[1-9][0-9]+)$/u;

export type Place = string & { readonly [placeBrand]: "Place" };
declare const placeBrand: unique symbol;

export type PlaceAppointment = Readonly<{ place: Place; contract: ContractId }>;
export type PlaceRegister = Readonly<{
  appointments: readonly PlaceAppointment[];
  byPlace: ReadonlyMap<Place, PlaceAppointment>;
  byContract: ReadonlyMap<ContractId, PlaceAppointment>;
}>;
export type ManagedWorktreeAppointment =
  | Readonly<{ kind: "appointed"; place: Place; path: string }>
  | Readonly<{ kind: "unappointed" }>
  | Readonly<{ kind: "failed"; diagnostic: string }>;

function placePaths(repository: GitRepository): Readonly<{ authority: string; lock: string }> {
  return {
    authority: join(repository.commonDirectory, "keiyaku", "places.json"),
    lock: join(repository.commonDirectory, "keiyaku", "locks", "places.sqlite"),
  };
}

export function placeRegisterPath(repository: GitRepository): string {
  return placePaths(repository).authority;
}

function indexedRegister(appointments: readonly PlaceAppointment[]): PlaceRegister {
  return {
    appointments,
    byPlace: new Map(appointments.map((appointment) => [appointment.place, appointment])),
    byContract: new Map(appointments.map((appointment) => [appointment.contract, appointment])),
  };
}

function parsedPlace(value: string): Readonly<{ base: string; generation: bigint }> | undefined {
  if (PLACE_INDEX.has(value)) return { base: value, generation: 1n };
  for (let end = value.length - 1; end > 0; end -= 1) {
    const base = value.slice(0, end);
    const suffix = value.slice(end);
    if (PLACE_INDEX.has(base) && GENERATION_SUFFIX.test(suffix)) {
      return { base, generation: BigInt(suffix) };
    }
  }
  return undefined;
}

function composePlace(base: string, generation: bigint): Place {
  return (generation === 1n ? base : `${base}${generation.toString()}`) as Place;
}

export function place(value: string): Place {
  if (parsedPlace(value) === undefined) throw new TypeError(`Place is not canonical: ${value}`);
  return value as Place;
}

export function nextPlace(current?: Place): Place {
  if (current === undefined) return place(CONTRACT_PLACES[0]!);
  const parsed = parsedPlace(current);
  if (parsed === undefined) throw new TypeError(`Place is not canonical: ${current}`);
  const index = PLACE_INDEX.get(parsed.base)!;
  return index + 1 < CONTRACT_PLACES.length
    ? composePlace(CONTRACT_PLACES[index + 1]!, parsed.generation)
    : composePlace(CONTRACT_PLACES[0]!, parsed.generation + 1n);
}

export function canonicalPlaceRegister(register: PlaceRegister): string {
  const appointments = Object.fromEntries(
    register.appointments
      .slice()
      .sort((left, right) => Buffer.compare(Buffer.from(left.place), Buffer.from(right.place)))
      .map((appointment) => [appointment.place, appointment.contract]),
  );
  return `${JSON.stringify({ version: PLACE_VERSION, appointments })}\n`;
}

function placeCorruption(path: string, message: string, cause?: unknown): never {
  throw new AuthorityCorruptionError(`${message}: ${path}`, cause === undefined ? {} : { cause });
}

export function decodePlaceRegister(path: string, bytes: string): PlaceRegister {
  let value: unknown;
  try {
    if (!bytes.endsWith("\n") || bytes.slice(0, -1).includes("\n")) {
      placeCorruption(path, "Place file is not one canonical JSON line");
    }
    value = JSON.parse(bytes);
  } catch (error) {
    if (error instanceof AuthorityCorruptionError) throw error;
    return placeCorruption(path, "invalid Place JSON", error);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    placeCorruption(path, "Place file must be an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, "version") || !Object.hasOwn(record, "appointments")) {
    placeCorruption(path, "Place file has invalid fields");
  }
  if (record.version !== PLACE_VERSION) placeCorruption(path, `Place file version must be ${PLACE_VERSION}`);
  if (typeof record.appointments !== "object" || record.appointments === null || Array.isArray(record.appointments)) {
    placeCorruption(path, "Place appointments must be an object");
  }
  const appointments: PlaceAppointment[] = [];
  const contracts = new Set<ContractId>();
  for (const [rawPlace, rawContract] of Object.entries(record.appointments as Record<string, unknown>)) {
    if (typeof rawContract !== "string") placeCorruption(path, "Place appointment must be a ContractId");
    try {
      const appointed = { place: place(rawPlace), contract: contractId(rawContract) };
      if (contracts.has(appointed.contract)) placeCorruption(path, "Place file has duplicate Contract appointment");
      contracts.add(appointed.contract);
      appointments.push(appointed);
    } catch (error) {
      return placeCorruption(path, "Place appointment is invalid", error);
    }
  }
  appointments.sort((left, right) => Buffer.compare(Buffer.from(left.place), Buffer.from(right.place)));
  const register = indexedRegister(appointments);
  if (canonicalPlaceRegister(register) !== bytes) placeCorruption(path, "Place bytes are not canonical");
  return register;
}

export function emptyPlaceRegister(): PlaceRegister {
  return indexedRegister([]);
}

export async function readPlaceRegister(repository: GitRepository): Promise<PlaceRegister> {
  const path = placePaths(repository).authority;
  try {
    return decodePlaceRegister(path, await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyPlaceRegister();
    throw error;
  }
}

export function appointmentFor(register: PlaceRegister, contract: ContractId): PlaceAppointment | undefined {
  return register.byContract.get(contract);
}

async function mutatePlaceRegister(
  repository: GitRepository,
  mutate: (register: PlaceRegister) => PlaceRegister,
): Promise<PlaceRegister> {
  const location = placePaths(repository);
  const held = await acquireSqliteTransactionLock({ path: location.lock, mode: "immediate" });
  try {
    const current = await readPlaceRegister(repository);
    const next = mutate(current);
    const bytes = canonicalPlaceRegister(next);
    try {
      if (await readFile(location.authority, "utf8") === bytes) return next;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(dirname(location.authority), { recursive: true });
    await replaceFileDurably(location.authority, bytes);
    return next;
  } finally {
    held.close();
  }
}

function withAppointments(register: PlaceRegister, contracts: readonly ContractId[]): PlaceRegister {
  const additions: PlaceAppointment[] = [];
  const occupied = new Set(register.byPlace.keys());
  const known = new Set(register.byContract.keys());
  let cursor: Place | undefined;
  for (const contract of contracts) {
    if (known.has(contract)) continue;
    let candidate = cursor === undefined ? nextPlace() : nextPlace(cursor);
    while (occupied.has(candidate)) candidate = nextPlace(candidate);
    additions.push({ place: candidate, contract });
    occupied.add(candidate);
    known.add(contract);
    cursor = candidate;
  }
  return additions.length === 0 ? register : indexedRegister([...register.appointments, ...additions]);
}

export async function appointManagedWorktrees(
  repository: GitRepository,
  contracts: readonly ContractId[],
): Promise<PlaceRegister> {
  return await mutatePlaceRegister(repository, (current) => withAppointments(current, contracts));
}

export async function releaseManagedWorktrees(
  repository: GitRepository,
  contracts: readonly ContractId[],
): Promise<void> {
  if (contracts.length === 0) return;
  const drop = new Set(contracts);
  await mutatePlaceRegister(repository, (current) => {
    const kept = current.appointments.filter((appointment) => !drop.has(appointment.contract));
    return kept.length === current.appointments.length ? current : indexedRegister(kept);
  });
}

export async function readManagedWorktreeAppointment(
  repository: GitRepository,
  contract: ContractId,
  register?: PlaceRegister,
): Promise<ManagedWorktreeAppointment> {
  try {
    const snapshot = register ?? await readPlaceRegister(repository);
    const appointed = appointmentFor(snapshot, contract);
    return appointed === undefined
      ? { kind: "unappointed" }
      : { kind: "appointed", place: appointed.place, path: worktreePath(repository, appointed.place) };
  } catch (error) {
    return { kind: "failed", diagnostic: error instanceof Error ? error.message : String(error) };
  }
}
