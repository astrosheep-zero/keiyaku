import { createHash } from "node:crypto";
import { join } from "node:path";
import { Square, SquareError, createSquareResourceOwner, type Body } from "@astrosheep/square";
import type { WorldRoot } from "../world.js";

/**
 * The submitting-edge identity policy. Every Square read is rooted in the
 * submitted environment's actual Body, never this process's ambient identity.
 */

const HARNESS_SESSIONS = [
  { provider: "claude", channel: "claude-code", variable: "CLAUDE_CODE_SESSION_ID" },
  { provider: "codex", channel: "codex", variable: "CODEX_THREAD_ID" },
  { provider: "opencode", channel: "opencode", variable: "OPENCODE_SESSION_ID" },
  { provider: "pi", channel: "pi", variable: "PI_SESSION_ID" },
  { provider: undefined, channel: "paseo", variable: "PASEO_AGENT_ID" },
] as const;

const SEAT_PREFIX = "keiyaku-assigned-";
const SEAT_DIGEST_DOMAIN = "keiyaku/square-seat/v1";
const SEAT_DIGEST_LENGTH = 12;
const IDENTITY_BUDGET_MS = 5_000;

type SessionCoordinate = Readonly<{ provider?: string; channel: string; session: string }>;

function declared(environment: NodeJS.ProcessEnv, variable: string): string | undefined {
  const value = environment[variable]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function sessionCoordinates(environment: NodeJS.ProcessEnv): readonly SessionCoordinate[] {
  return HARNESS_SESSIONS.flatMap(({ variable, channel, provider }) => {
    const session = declared(environment, variable);
    return session === undefined ? [] : [{ channel, ...(provider === undefined ? {} : { provider }), session }];
  });
}

function squareBody(environment: NodeJS.ProcessEnv): Body | undefined {
  if (environment.CLAUDE_CODE_CHILD_SESSION === "1") return undefined;
  const coordinates = sessionCoordinates(environment);
  const native = coordinates.filter(({ provider }) => provider !== undefined);
  if (native.length > 1) return undefined;
  const coordinate = native[0] ?? coordinates.find(({ channel }) => channel === "paseo");
  return coordinate === undefined ? undefined : { channel: coordinate.channel, session: coordinate.session };
}

function squareSeatName(provider: string, session: string): string {
  const digest = createHash("sha256")
    .update(`${SEAT_DIGEST_DOMAIN}\u0000${provider}\u0000${session}`, "utf8")
    .digest("hex");
  return `${SEAT_PREFIX}${digest.slice(0, SEAT_DIGEST_LENGTH)}`;
}

function seatCandidate(environment: NodeJS.ProcessEnv): string | undefined {
  const candidates = sessionCoordinates(environment).flatMap(({ provider, session }) =>
    provider === undefined ? [] : [squareSeatName(provider, session)],
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function priorSeatNames(environment: NodeJS.ProcessEnv): readonly string[] {
  return sessionCoordinates(environment).flatMap(({ provider, session }) => {
    if (provider === undefined) return [];
    const legacy = createHash("sha256").update(session, "utf8").digest("hex").slice(0, 12);
    const assigned = squareSeatName(provider, session);
    return [`${provider}-${legacy}`, assigned, assigned.replace(SEAT_PREFIX, "keiyaku-seat-")];
  });
}

async function usableName(name: string): Promise<boolean> {
  try {
    await Square.inMemory({ markdown: "" }).participant(name);
    return true;
  } catch {
    return false;
  }
}

type Standing =
  | Readonly<{ kind: "standing"; name: string }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "indeterminate" }>;

async function selectStanding(
  square: Square,
  environment: NodeJS.ProcessEnv,
  recognized: readonly string[],
  signal: AbortSignal,
): Promise<Standing> {
  if (recognized.length === 1) return { kind: "standing", name: recognized[0]! };
  if (recognized.length > 1) return { kind: "indeterminate" };
  const known = new Set(priorSeatNames(environment));
  const participants = (await square.participants({}, { signal })).participants;
  if (participants.some(({ name, state }) => known.has(name) && state !== "not joined"))
    return { kind: "indeterminate" };
  return { kind: "absent" };
}

async function standingAt(
  location: string,
  environment: NodeJS.ProcessEnv,
  body: Body,
  signal: AbortSignal,
): Promise<Standing> {
  let square: Square;
  try {
    square = await Square.at({ path: location, env: environment, body }, { signal });
  } catch (error) {
    return error instanceof SquareError && error.code === "unavailable"
      ? { kind: "absent" }
      : { kind: "indeterminate" };
  }
  try {
    return await selectStanding(
      square,
      environment,
      (await square.recognize()).map(({ name }) => name),
      signal,
    );
  } catch {
    return { kind: "indeterminate" };
  } finally {
    await square.close().catch(() => undefined);
  }
}

/** Opening without a Body avoids Square's discovery publication; the artifact still recognizes that Body. */
async function standingReadOnlyAt(
  location: string,
  environment: NodeJS.ProcessEnv,
  body: Body,
  signal: AbortSignal,
): Promise<Standing> {
  const owner = createSquareResourceOwner();
  let square: Square | undefined;
  try {
    square = await Square.at({ path: location, env: environment, resources: owner }, { signal });
    const recognized = (await owner.artifact(location).read((facts) => facts.seatsForBody(body), signal)).value;
    return await selectStanding(
      square,
      environment,
      recognized.map(({ participant }) => participant),
      signal,
    );
  } catch (error) {
    return error instanceof SquareError && error.code === "unavailable"
      ? { kind: "absent" }
      : { kind: "indeterminate" };
  } finally {
    await square?.close().catch(() => undefined);
    await owner.close().catch(() => undefined);
  }
}

export type SquareSeatInput = Readonly<{ path: WorldRoot; environment: NodeJS.ProcessEnv }>;

export type SquareSeatControl = Readonly<{ signal?: AbortSignal; budgetMs?: number; readOnly?: boolean }>;
export type SubmittingInitiator = Readonly<{ name: string; source: "declared" | "square" }>;

/** The declared integration name outranks the optional, bounded Square selection. */
export async function submittingInitiator(
  input: Readonly<{ path?: WorldRoot; environment: NodeJS.ProcessEnv; signal?: AbortSignal; readOnly?: boolean }>,
): Promise<SubmittingInitiator | undefined> {
  const name = declared(input.environment, "KEIYAKU_INITIATOR");
  if (name !== undefined) return { name, source: "declared" };
  if (input.path === undefined) return undefined;
  try {
    const seat = await squareSeat(
      { path: input.path, environment: input.environment },
      {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.readOnly ? { readOnly: true } : {}),
      },
    );
    return seat === undefined ? undefined : { name: seat, source: "square" };
  } catch {
    return undefined;
  }
}

async function bounded<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  control: SquareSeatControl,
): Promise<T | undefined> {
  const budget = new AbortController();
  const timer = setTimeout(
    () => budget.abort(new Error("Square identity observation expired")),
    control.budgetMs ?? IDENTITY_BUDGET_MS,
  );
  const signal = control.signal === undefined ? budget.signal : AbortSignal.any([control.signal, budget.signal]);
  const pending = attempt(signal);
  pending.catch(() => undefined);
  try {
    return await Promise.race([pending, whenAborted(signal)]);
  } finally {
    clearTimeout(timer);
  }
}

function whenAborted(signal: AbortSignal): Promise<undefined> {
  return new Promise((settle) => {
    if (signal.aborted) settle(undefined);
    else signal.addEventListener("abort", () => settle(undefined), { once: true });
  });
}

export async function squareSeat(input: SquareSeatInput, control: SquareSeatControl = {}): Promise<string | undefined> {
  const name = declared(input.environment, "SQUARE_PARTICIPANT_NAME");
  if (name !== undefined) return (await usableName(name)) ? name : undefined;
  const body = squareBody(input.environment);
  const candidate = seatCandidate(input.environment);
  if (body === undefined) return undefined;
  const location = join(input.path, ".square", "KEIYAKU.square");
  const standing = await bounded(
    async (signal) =>
      await (control.readOnly ? standingReadOnlyAt : standingAt)(location, input.environment, body, signal),
    control,
  );
  if (standing?.kind === "standing") return standing.name;
  return standing?.kind === "absent" ? candidate : undefined;
}
