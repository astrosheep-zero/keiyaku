import { access, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { abortableDelay } from "./abort.js";
import {
  HeldAkumaLeash,
  readNonterminalRequests,
  readSoul,
  serveRequest,
  voidRequest,
  type RequestFact,
  type Soul,
} from "./heart/index.js";
import { pathsForAkuId, worldRootForAkumaPaths, type AkuId, type AkumaPaths } from "./identity.js";
import { BIRTH_TIMEOUT_MS } from "./publication.js";
import { decodeEnvelope, type RequestEnvelope } from "./request-wire.js";

export type PumpInput = Readonly<{
  paths: AkumaPaths;
  allowed: readonly string[];
  bodySequence: number;
  now(): string;
  signal: AbortSignal;
}>;

type ServeClaim = (
  input: PumpInput &
    Readonly<{
      directory: string;
      transportId: string;
      claim: RequestEnvelope;
      signal: AbortSignal;
      admissionOpen(): boolean;
    }>,
) => Promise<boolean>;

const POLL_MS = 100;

export class BodyRequestPump {
  readonly directory: string;
  readonly failure: Promise<never>;
  private readonly closeSignal = new AbortController();
  private readonly executionSignal = new AbortController();
  private readonly handled = new Set<string>();
  private readonly running: Promise<void>;
  private readonly cancelBody: () => void;
  private admissionClosed = false;

  protected constructor(
    private readonly input: PumpInput,
    private readonly serveClaim: ServeClaim,
  ) {
    this.directory = join(input.paths.directory, "requests", String(input.bodySequence));
    this.cancelBody = () => {
      this.stopAdmission();
      if (!this.executionSignal.signal.aborted) this.executionSignal.abort(input.signal.reason);
    };
    input.signal.addEventListener("abort", this.cancelBody, { once: true });
    if (input.signal.aborted) this.cancelBody();
    this.running = this.run();
    this.failure = this.running.then(
      () => new Promise<never>(() => {}),
      (error: unknown) => Promise.reject(error),
    );
  }

  static async openWithService(input: PumpInput, serveClaim: ServeClaim): Promise<BodyRequestPump> {
    await mkdir(join(input.paths.directory, "requests", String(input.bodySequence)), { recursive: true });
    return new BodyRequestPump(input, serveClaim);
  }

  private async run(): Promise<void> {
    while (!this.closeSignal.signal.aborted) {
      for (const name of await requestFiles(this.directory)) {
        if (this.closeSignal.signal.aborted) return;
        const transportId = name.slice(0, -".request.json".length);
        if (this.handled.has(transportId)) continue;
        const path = join(this.directory, name);
        const claim = decodeEnvelope(await readFile(path, "utf8"), transportId);
        if (claim === null) {
          await rm(path, { force: true });
          this.handled.add(transportId);
          continue;
        }
        if (!this.admissionClosed) {
          const served = await this.serveClaim({
            directory: this.directory,
            transportId,
            claim,
            ...this.input,
            signal: this.executionSignal.signal,
            admissionOpen: () => !this.admissionClosed,
          });
          if (!served) await rm(path, { force: true });
        }
        this.handled.add(transportId);
      }
      try {
        await abortableDelay(POLL_MS, this.closeSignal.signal);
      } catch (error) {
        if (this.closeSignal.signal.aborted) return;
        throw error;
      }
    }
  }

  async close(): Promise<void> {
    this.stopAdmission();
    try {
      await this.running;
    } finally {
      this.input.signal.removeEventListener("abort", this.cancelBody);
      await rm(this.directory, { recursive: true, force: true });
    }
  }

  stopAdmission(): void {
    this.admissionClosed = true;
    if (!this.closeSignal.signal.aborted) this.closeSignal.abort(new Error("Body request pump closed"));
  }
}

export async function clearBodyRequestTransport(paths: AkumaPaths): Promise<void> {
  await rm(join(paths.directory, "requests"), { recursive: true, force: true });
}

async function requestFiles(directory: string): Promise<readonly string[]> {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith(".request.json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function matchingRequestOrigin(soul: Soul, parent: AkuId, id: string): boolean {
  return soul.origin.kind === "request" && soul.origin.parent === parent && soul.origin.requestId === id;
}

async function settleReservedSoul(
  paths: AkumaPaths,
  parent: Soul,
  request: Extract<RequestFact, { state: "reserved" }>,
  soul: Soul,
): Promise<void> {
  await (matchingRequestOrigin(soul, parent.id, request.id)
    ? serveRequest(paths, request.id, request.child)
    : voidRequest(paths, request.id, "reserved child origin does not match the request"));
}

async function settleReserved(
  paths: AkumaPaths,
  parent: Soul,
  request: Extract<RequestFact, { state: "reserved" }>,
  now: () => string,
  signal?: AbortSignal,
): Promise<boolean> {
  const childPaths = pathsForAkuId(worldRootForAkumaPaths(paths), request.child);
  const deadline = performance.now() + BIRTH_TIMEOUT_MS;
  for (;;) {
    signal?.throwIfAborted();
    if (
      !(await access(childPaths.directory).then(
        () => true,
        () => false,
      ))
    ) {
      await voidRequest(paths, request.id, "reserved child directory is absent");
      return true;
    }
    const soul = await readSoul(childPaths);
    if (soul !== null) {
      await settleReservedSoul(paths, parent, request, soul);
      return true;
    }
    const leash = await HeldAkumaLeash.try(childPaths);
    if (leash !== null) {
      try {
        const settled = await readSoul(childPaths);
        if (settled !== null) await settleReservedSoul(paths, parent, request, settled);
        else {
          await leash.sealIfUnborn(childPaths, { evidence: "request settlement", at: now() });
          await voidRequest(paths, request.id, "reserved child was sealed unborn");
        }
      } finally {
        leash.release();
      }
      return true;
    }
    if (performance.now() >= deadline) return false;
    await abortableDelay(Math.min(POLL_MS, Math.max(0, deadline - performance.now())), signal);
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
    if (request.state === "admitted") await voidRequest(paths, request.id, "body died before serving the request");
    else if (request.state === "reserved" && !(await settleReserved(paths, parent, request, now, signal)))
      pending = true;
  }
  return pending ? "pending" : "settled";
}
