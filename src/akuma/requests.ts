import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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
import { abortableDelay } from "./abort.js";
import { AKUMA_REQUESTS_ENV } from "./provider.js";
import { decodeProviderOptions, decodeReadonlyRestraint } from "./provider-recipe.js";
import { resolveProviderExecution } from "./providers/index.js";

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
    ...(recipe.readonly === undefined ? [] : ["readonly"]),
  ];
  if (!exactKeys(recipe, expectedKeys)) return null;
  if (recipe.description !== undefined
    && (typeof recipe.description !== "string" || recipe.description.trim().length === 0)) return null;
  try {
    const selected = resolveProviderExecution(recipe.provider);
    const provider = selected.execution;
    const adapter = selected.adapter;
    const decodedOptions = decodeProviderOptions(recipe.options);
    const readonly = recipe.readonly === undefined ? undefined : decodeReadonlyRestraint(recipe.readonly);
    if ((decodedOptions.readonly === true) !== (readonly !== undefined)) return null;
    const confinement = adapter.confinement({ cwd, options: decodedOptions });
    if (!matchingConfinement(recipe.confinement, confinement)) return null;
    return Object.freeze({
      ...(recipe.description === undefined ? {} : { description: recipe.description }),
      provider,
      options: decodedOptions,
      ...(readonly === undefined ? {} : { readonly }),
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

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

function receiptFor(fact: RequestFact): RequestReceipt | null {
  if (fact.state === "served") return { id: fact.id, state: fact.state, child: fact.child };
  if (fact.state === "refused") return { id: fact.id, state: fact.state, diagnostic: fact.diagnostic };
  if (fact.state === "voided") return { id: fact.id, state: fact.state, evidence: fact.evidence };
  return null;
}

async function projectReceipt(directory: string, fact: RequestFact): Promise<void> {
  const receipt = receiptFor(fact);
  if (receipt !== null) await atomicJson(join(directory, `${fact.id}.receipt.json`), receipt);
}

export function injectedBodyRequests(): string | null {
  const directory = process.env[AKUMA_REQUESTS_ENV];
  if (directory === undefined) return null;
  if (!absolute(directory)) throw new Error(`${AKUMA_REQUESTS_ENV} must be an absolute normalized path`);
  return directory;
}

export async function requestBodyCall(input: RequestClaim & Readonly<{ directory: string }>): Promise<AkuId> {
  await atomicJson(join(input.directory, `${input.id}.request.json`), {
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
      const receipt = decodeReceipt(await readFile(receiptPath, "utf8"), input.id);
      if (receipt === null) throw new Error(`Akuma body request ${input.id} has an invalid receipt`);
      if (receipt.state === "served") return receipt.child;
      if (receipt.state === "refused") throw new AkumaBodyRequestError("refused", receipt.diagnostic);
      throw new AkumaBodyRequestError("voided", receipt.evidence);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await abortableDelay(POLL_MS);
  }
}

async function serveClaim(input: Readonly<{
  directory: string;
  claim: RequestClaim;
  paths: AkumaPaths;
  parent: Soul;
  now(): string;
  spawn(launch: RequestChildLaunch): Promise<void>;
  signal: AbortSignal;
}>): Promise<void> {
  input.signal.throwIfAborted();
  let fact = await admitRequest(input.paths, { ...input.claim, admittedAt: input.now() });
  const existing = receiptFor(fact);
  if (existing !== null) {
    if (!input.signal.aborted) await projectReceipt(input.directory, fact);
    return;
  }
  if (fact.state !== "admitted") throw new Error(`Akuma request ${fact.id} cannot be replayed from ${fact.state}`);
  const request = fact;
  const servingWorld = worldRootForAkumaPaths(input.paths);
  if (request.world !== servingWorld) {
    fact = await refuseRequest(input.paths, request.id, `request world ${request.world} does not match ${servingWorld}`);
    await projectReceipt(input.directory, fact);
    return;
  }
  const cwd = resolve(request.cwd ?? servingWorld);
  let child: AkuId;
  try {
    input.signal.throwIfAborted();
    const published = await publishAkuma({
      worldPath: servingWorld,
      archetype: request.archetype,
      reserve: async (allocated) => { fact = await reserveRequest(input.paths, request.id, allocated.id); },
      signal: input.signal,
      launch: async (allocated) => await input.spawn({
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: allocated.archetype,
          ...(request.recipe.description === undefined ? {} : { description: request.recipe.description }),
          provider: request.recipe.provider,
          options: request.recipe.options,
          ...(request.recipe.readonly === undefined ? {} : { readonly: request.recipe.readonly }),
          cwd,
          origin: { kind: "request", parent: input.parent.id, requestId: request.id },
          confinement: request.recipe.confinement,
        },
        initialBody: request.body,
      }),
    });
    child = published.id;
  } catch (error) {
    if (input.signal.aborted) return;
    const current = await readRequest(input.paths, request.id);
    if (current === null) throw error;
    fact = current.state === "admitted" || current.state === "reserved"
      ? await voidRequest(input.paths, request.id, diagnostic(error))
      : current;
    await projectReceipt(input.directory, fact);
    return;
  }
  fact = await serveRequest(input.paths, request.id, child);
  await projectReceipt(input.directory, fact);
}

async function requestFiles(directory: string): Promise<readonly string[]> {
  try {
    return (await readdir(directory))
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
  private readonly closeSignal = new AbortController();
  private readonly handled = new Set<string>();
  private readonly running: Promise<void>;
  private readonly cancelAdmission: () => void;

  private constructor(private readonly input: Readonly<{
    paths: AkumaPaths;
    parent: Soul;
    bodySequence: number;
    now(): string;
    spawn(launch: RequestChildLaunch): Promise<void>;
    signal: AbortSignal;
  }>) {
    this.directory = join(input.paths.directory, "requests", String(input.bodySequence));
    this.cancelAdmission = () => this.stopAdmission();
    input.signal.addEventListener("abort", this.cancelAdmission, { once: true });
    if (input.signal.aborted) this.cancelAdmission();
    this.running = this.run();
    this.failure = this.running.then(
      () => new Promise<never>(() => {}),
      (error: unknown) => Promise.reject(error),
    );
  }

  static async open(input: Readonly<{
    paths: AkumaPaths;
    parent: Soul;
    bodySequence: number;
    now(): string;
    spawn(launch: RequestChildLaunch): Promise<void>;
    signal: AbortSignal;
  }>): Promise<BodyRequestPump> {
    const directory = join(input.paths.directory, "requests", String(input.bodySequence));
    await mkdir(directory, { recursive: true });
    return new BodyRequestPump(input);
  }

  private async run(): Promise<void> {
    while (!this.closeSignal.signal.aborted) {
      for (const name of await requestFiles(this.directory)) {
        if (this.closeSignal.signal.aborted) return;
        const id = name.slice(0, -".request.json".length);
        if (this.handled.has(id)) continue;
        const claim = decodeClaim(await readFile(join(this.directory, name), "utf8"), id);
        if (claim === null) { this.handled.add(id); continue; }
        await serveClaim({ directory: this.directory, claim, ...this.input, signal: this.closeSignal.signal });
        this.handled.add(id);
      }
      try { await abortableDelay(POLL_MS, this.closeSignal.signal); }
      catch { return; }
    }
  }

  async close(): Promise<void> {
    this.stopAdmission();
    try { await this.running; }
    finally {
      this.input.signal.removeEventListener("abort", this.cancelAdmission);
      await rm(this.directory, { recursive: true, force: true });
    }
  }

  stopAdmission(): void {
    if (!this.closeSignal.signal.aborted) this.closeSignal.abort(new Error("Body request pump closed"));
  }
}

export async function clearBodyRequestTransport(paths: AkumaPaths): Promise<void> {
  await rm(join(paths.directory, "requests"), { recursive: true, force: true });
}

function matchingRequestOrigin(soul: Soul, parent: AkuId, requestId: string): boolean {
  return soul.origin.kind === "request"
    && soul.origin.parent === parent
    && soul.origin.requestId === requestId;
}

async function settleObservedSoul(paths: AkumaPaths, parent: Soul, request: Extract<RequestFact, { state: "reserved" }>, soul: Soul): Promise<void> {
  if (matchingRequestOrigin(soul, parent.id, request.id)) await serveRequest(paths, request.id, request.child);
  else await voidRequest(paths, request.id, "reserved child origin does not match the request");
}

async function settleReserved(
  paths: AkumaPaths,
  parent: Soul,
  request: Extract<RequestFact, { state: "reserved" }>,
  now: () => string,
  signal?: AbortSignal,
): Promise<boolean> {
  const childPaths = pathsForAkuId(request.world, request.child);
  const deadline = performance.now() + BIRTH_TIMEOUT_MS;
  for (;;) {
    signal?.throwIfAborted();
    if (!await access(childPaths.directory).then(() => true, () => false)) {
      await voidRequest(paths, request.id, "reserved child directory is absent");
      return true;
    }
    const childSoul = await readSoul(childPaths);
    if (childSoul !== null) {
      await settleObservedSoul(paths, parent, request, childSoul);
      return true;
    }
    const leash = await HeldAkumaLeash.try(childPaths);
    if (leash !== null) {
      try {
        const settledSoul = await readSoul(childPaths);
        if (settledSoul !== null) {
          await settleObservedSoul(paths, parent, request, settledSoul);
        } else {
          await leash.sealIfUnborn(childPaths, { evidence: "request settlement", at: now() });
          await voidRequest(paths, request.id, "reserved child was sealed unborn");
        }
      } finally { leash.release(); }
      return true;
    }
    if (performance.now() >= deadline) return false;
    await abortableDelay(POLL_MS, signal);
  }
}

export async function settleBodyRequests(
  paths: AkumaPaths,
  parent: Soul,
  now: () => string,
  signal?: AbortSignal,
): Promise<"settled" | "pending"> {
  let pending = false;
  for (const request of await readNonterminalRequests(paths)) {
    signal?.throwIfAborted();
    if (request.state === "admitted") {
      await voidRequest(paths, request.id, "body died before serving the request");
    } else if (request.state === "reserved" && !await settleReserved(paths, parent, request, now, signal)) pending = true;
  }
  return pending ? "pending" : "settled";
}
