import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  HeldAkumaLeash,
  admitRequest,
  readNonterminalRequests,
  readRequest,
  readSoul,
  refuseRequest,
  reserveRequest,
  serveRequest,
  voidRequest,
  type RequestFact,
  type RequestRecipe,
  type Soul,
} from "./heart/index.js";
import {
  parseAkuId,
  pathsForAkuId,
  archetypeName,
  worldRootForAkumaPaths,
  type AkuId,
  type AkumaPaths,
} from "./identity.js";
import { BIRTH_TIMEOUT_MS, publishAkuma } from "./publication.js";
import { AKUMA_REQUESTS_ENV, decodeProviderOptions } from "./provider.js";
import { decodeProviderExecution, providerNamed } from "./providers/index.js";
import type { ProcessCollar } from "../runtime/proc/run.js";

const POLL_MS = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type RequestClaim = Readonly<{
  id: string;
  world: string;
  archetype: string;
  body: string;
  cwd?: string;
  recipe: RequestRecipe;
}>;

type RequestReceipt =
  | Readonly<{ id: string; state: "served"; child: AkuId }>
  | Readonly<{ id: string; state: "refused"; diagnostic: string }>
  | Readonly<{ id: string; state: "voided"; evidence: string }>;

export type RequestChildLaunch = Readonly<{
  paths: AkumaPaths;
  seed: Omit<Soul, "createdAt">;
  initialBody: string;
}>;

export class AkumaBodyRequestError extends Error {
  readonly kind = "akuma-body-request";
  constructor(
    readonly outcome: "refused" | "voided",
    readonly diagnostic: string,
  ) {
    super(`Akuma body request ${outcome}: ${diagnostic}`);
    this.name = "AkumaBodyRequestError";
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function absolute(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value;
}

function matchingConfinement(value: unknown, expected: RequestRecipe["confinement"]): boolean {
  const confinement = object(value);
  if (confinement === null || confinement.kind !== expected.kind) return false;
  if (expected.kind === "unconfined") return exactKeys(confinement, ["kind"]);
  if (!exactKeys(confinement, ["kind", "writableRoots"]) || !Array.isArray(confinement.writableRoots)) return false;
  return confinement.writableRoots.length === expected.writableRoots.length
    && confinement.writableRoots.every((root, index) => root === expected.writableRoots[index]);
}

function decodeRecipe(value: unknown, cwd: string): RequestRecipe | null {
  const recipe = object(value);
  if (recipe === null) return null;
  const expectedKeys = [
    "confinement",
    ...(recipe.description === undefined ? [] : ["description"]),
    "options",
    "provider",
  ];
  if (!exactKeys(recipe, expectedKeys)) return null;
  if (recipe.description !== undefined
    && (typeof recipe.description !== "string" || recipe.description.trim().length === 0)) return null;
  try {
    const provider = decodeProviderExecution(recipe.provider);
    const adapter = providerNamed(provider);
    const decodedOptions = decodeProviderOptions(recipe.options);
    const admission = adapter.admitOptions(decodedOptions);
    if (admission.kind === "refused") return null;
    const confinement = adapter.confinement({ cwd, options: admission.options });
    if (!matchingConfinement(recipe.confinement, confinement)) return null;
    return Object.freeze({
      ...(recipe.description === undefined ? {} : { description: recipe.description }),
      provider,
      options: admission.options,
      confinement,
    });
  } catch {
    return null;
  }
}

function decodeClaim(bytes: string, fileId: string): RequestClaim | null {
  let decoded: unknown;
  try { decoded = JSON.parse(bytes); } catch { return null; }
  const value = object(decoded);
  if (value === null) return null;
  const expected = [
    "archetype",
    "body",
    ...(value.cwd === undefined ? [] : ["cwd"]),
    "id",
    "recipe",
    "world",
  ];
  if (!exactKeys(value, expected)) return null;
  if (value.id !== fileId || typeof value.id !== "string" || !UUID.test(value.id)) return null;
  if (typeof value.body !== "string" || !absolute(value.world)) return null;
  if (value.cwd !== undefined && !absolute(value.cwd)) return null;
  try {
    archetypeName(value.archetype as string);
  } catch { return null; }
  const recipe = decodeRecipe(value.recipe, (value.cwd ?? value.world) as string);
  if (recipe === null) return null;
  return {
    id: value.id,
    world: value.world,
    archetype: value.archetype as string,
    body: value.body,
    recipe,
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
  };
}

function decodeReceipt(bytes: string, requestId: string): RequestReceipt | null {
  let decoded: unknown;
  try { decoded = JSON.parse(bytes); } catch { return null; }
  const value = object(decoded);
  if (value === null || value.id !== requestId) return null;
  if (value.state === "served" && exactKeys(value, ["child", "id", "state"])) {
    try { return { id: requestId, state: "served", child: parseAkuId(value.child as string).id }; }
    catch { return null; }
  }
  if (value.state === "refused" && exactKeys(value, ["diagnostic", "id", "state"])
    && typeof value.diagnostic === "string") {
    return { id: requestId, state: "refused", diagnostic: value.diagnostic };
  }
  if (value.state === "voided" && exactKeys(value, ["evidence", "id", "state"])
    && typeof value.evidence === "string") {
    return { id: requestId, state: "voided", evidence: value.evidence };
  }
  return null;
}

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

function receiptFor(fact: RequestFact): RequestReceipt | null {
  if (fact.state === "served") return { id: fact.id, state: fact.state, child: fact.child };
  if (fact.state === "refused") return { id: fact.id, state: fact.state, diagnostic: fact.diagnostic };
  if (fact.state === "voided") return { id: fact.id, state: fact.state, evidence: fact.evidence };
  return null;
}

function projectReceipt(directory: string, fact: RequestFact): void {
  const receipt = receiptFor(fact);
  if (receipt !== null) atomicJson(join(directory, `${fact.id}.receipt.json`), receipt);
}

export function injectedBodyRequests(): string | null {
  const directory = process.env[AKUMA_REQUESTS_ENV];
  if (directory === undefined) return null;
  if (!absolute(directory)) throw new Error(`${AKUMA_REQUESTS_ENV} must be an absolute normalized path`);
  return directory;
}

export async function requestBodyCall(input: RequestClaim & Readonly<{ directory: string }>): Promise<AkuId> {
  atomicJson(join(input.directory, `${input.id}.request.json`), {
    id: input.id,
    world: input.world,
    archetype: input.archetype,
    body: input.body,
    recipe: input.recipe,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  });
  const receiptPath = join(input.directory, `${input.id}.receipt.json`);
  for (;;) {
    try {
      const receipt = decodeReceipt(readFileSync(receiptPath, "utf8"), input.id);
      if (receipt === null) throw new Error(`Akuma body request ${input.id} has an invalid receipt`);
      if (receipt.state === "served") return receipt.child;
      if (receipt.state === "refused") throw new AkumaBodyRequestError("refused", receipt.diagnostic);
      throw new AkumaBodyRequestError("voided", receipt.evidence);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await wait(POLL_MS);
  }
}

async function serveClaim(input: Readonly<{
  directory: string;
  claim: RequestClaim;
  paths: AkumaPaths;
  parent: Soul;
  now(): string;
  spawn(launch: RequestChildLaunch): Promise<ProcessCollar>;
}>): Promise<void> {
  let fact = admitRequest(input.paths, { ...input.claim, admittedAt: input.now() });
  const existing = receiptFor(fact);
  if (existing !== null) { projectReceipt(input.directory, fact); return; }
  if (fact.state !== "admitted") throw new Error(`Akuma request ${fact.id} cannot be replayed from ${fact.state}`);
  const request = fact;
  const servingWorld = worldRootForAkumaPaths(input.paths);
  if (request.world !== servingWorld) {
    fact = refuseRequest(input.paths, request.id, `request world ${request.world} does not match ${servingWorld}`);
    projectReceipt(input.directory, fact);
    return;
  }
  const cwd = resolve(request.cwd ?? servingWorld);
  let child: AkuId;
  try {
    const published = await publishAkuma({
      worldPath: servingWorld,
      archetype: request.archetype,
      reserve: (allocated) => { fact = reserveRequest(input.paths, request.id, allocated.id); },
      launch: async (allocated) => await input.spawn({
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: allocated.archetype,
          ...(request.recipe.description === undefined ? {} : { description: request.recipe.description }),
          provider: request.recipe.provider,
          options: request.recipe.options,
          cwd,
          origin: { kind: "request", parentId: input.parent.id, requestId: request.id },
          confinement: request.recipe.confinement,
        },
        initialBody: request.body,
      }),
    });
    child = published.id;
  } catch (error) {
    const current = readRequest(input.paths, request.id);
    if (current === null) throw error;
    fact = current.state === "admitted" || current.state === "reserved"
      ? voidRequest(input.paths, request.id, diagnostic(error))
      : current;
    projectReceipt(input.directory, fact);
    return;
  }
  fact = serveRequest(input.paths, request.id, child);
  projectReceipt(input.directory, fact);
}

function requestFiles(directory: string): readonly string[] {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".request.json"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export class BodyRequestPump {
  readonly directory: string;
  readonly failure: Promise<never>;
  private closed = false;
  private readonly handled = new Set<string>();
  private readonly running: Promise<void>;

  constructor(private readonly input: Readonly<{
    paths: AkumaPaths;
    parent: Soul;
    bodySequence: number;
    now(): string;
    spawn(launch: RequestChildLaunch): Promise<ProcessCollar>;
  }>) {
    this.directory = join(input.paths.directory, "requests", String(input.bodySequence));
    mkdirSync(this.directory, { recursive: true });
    this.running = this.run();
    this.failure = this.running.then(
      () => new Promise<never>(() => {}),
      (error: unknown) => Promise.reject(error),
    );
  }

  private async run(): Promise<void> {
    while (!this.closed) {
      for (const name of requestFiles(this.directory)) {
        if (this.closed) return;
        const id = name.slice(0, -".request.json".length);
        if (this.handled.has(id)) continue;
        const claim = decodeClaim(readFileSync(join(this.directory, name), "utf8"), id);
        if (claim === null) { this.handled.add(id); continue; }
        if (this.closed) return;
        await serveClaim({ directory: this.directory, claim, ...this.input });
        this.handled.add(id);
      }
      await wait(POLL_MS);
    }
  }

  async close(): Promise<void> {
    this.stopAdmission();
    try { await this.running; }
    finally { rmSync(this.directory, { recursive: true, force: true }); }
  }

  stopAdmission(): void { this.closed = true; }
}

export function clearBodyRequestTransport(paths: AkumaPaths): void {
  rmSync(join(paths.directory, "requests"), { recursive: true, force: true });
}

function matchingRequestOrigin(soul: Soul, parent: AkuId, requestId: string): boolean {
  return soul.origin.kind === "request"
    && soul.origin.parentId === parent
    && soul.origin.requestId === requestId;
}

function settleObservedSoul(paths: AkumaPaths, parent: Soul, request: Extract<RequestFact, { state: "reserved" }>, soul: Soul): void {
  if (matchingRequestOrigin(soul, parent.id, request.id)) serveRequest(paths, request.id, request.child);
  else voidRequest(paths, request.id, "reserved child origin does not match the request");
}

async function settleReserved(
  paths: AkumaPaths,
  parent: Soul,
  request: Extract<RequestFact, { state: "reserved" }>,
  now: () => string,
): Promise<boolean> {
  const childPaths = pathsForAkuId(request.world, request.child);
  const deadline = performance.now() + BIRTH_TIMEOUT_MS;
  for (;;) {
    if (!existsSync(childPaths.directory)) {
      voidRequest(paths, request.id, "reserved child directory is absent");
      return true;
    }
    const childSoul = readSoul(childPaths);
    if (childSoul !== null) {
      settleObservedSoul(paths, parent, request, childSoul);
      return true;
    }
    const leash = HeldAkumaLeash.try(childPaths);
    if (leash !== null) {
      try {
        const settledSoul = readSoul(childPaths);
        if (settledSoul !== null) {
          settleObservedSoul(paths, parent, request, settledSoul);
        } else {
          leash.sealIfUnborn(childPaths, { evidence: "request settlement", at: now() });
          voidRequest(paths, request.id, "reserved child was sealed unborn");
        }
      } finally { leash.release(); }
      return true;
    }
    if (performance.now() >= deadline) return false;
    await wait(POLL_MS);
  }
}

export async function settleBodyRequests(
  paths: AkumaPaths,
  parent: Soul,
  now: () => string,
): Promise<"settled" | "pending"> {
  let pending = false;
  for (const request of readNonterminalRequests(paths)) {
    if (request.state === "admitted") {
      voidRequest(paths, request.id, "body died before serving the request");
    } else if (request.state === "reserved" && !await settleReserved(paths, parent, request, now)) pending = true;
  }
  return pending ? "pending" : "settled";
}
