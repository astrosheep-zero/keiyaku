import { readFile } from "node:fs/promises";
import { z } from "zod";
import { abortableDelay } from "./abort.js";
import { atomicJson } from "./request-wire.js";

export const REQUEST_PROGRESS_WINDOW = 64;

const OBSERVATION_POLL_MS = 25;
const sequenceSchema = z.number().int().nonnegative();
const nextSequenceSchema = z.number().int().positive();
const progressSnapshotSchema = z
  .object({
    id: z.string(),
    action: z.string(),
    nextSequence: nextSequenceSchema,
    events: z.array(z.object({ sequence: sequenceSchema, value: z.unknown() }).strict()).max(REQUEST_PROGRESS_WINDOW),
  })
  .strict()
  .superRefine((snapshot, context) => {
    for (let index = 1; index < snapshot.events.length; index += 1) {
      if (snapshot.events[index]!.sequence !== snapshot.events[index - 1]!.sequence + 1) {
        context.addIssue({ code: "custom", message: "progress sequences must be contiguous" });
        return;
      }
    }
    if (snapshot.events.at(-1)?.sequence !== undefined && snapshot.events.at(-1)!.sequence >= snapshot.nextSequence) {
      context.addIssue({ code: "custom", message: "progress sequence exceeds its snapshot" });
    }
  });
const cancellationSchema = z.object({ id: z.string(), action: z.string() }).strict();

export type RequestProgressSnapshot = Readonly<{
  nextSequence: number;
  events: readonly Readonly<{ sequence: number; value: unknown }>[];
}>;

export function progressPath(directory: string, transportId: string): string {
  return `${directory}/${transportId}.progress.json`;
}

export function cancellationPath(directory: string, transportId: string): string {
  return `${directory}/${transportId}.cancel.json`;
}

/**
 * The snapshot is a bounded, replaceable observation window. It is deliberately
 * not a progress log: a slow observer receives an explicit sequence gap.
 */
export function publishRequestProgress(
  input: Readonly<{
    directory: string;
    transportId: string;
    id: string;
    action: string;
  }>,
): Readonly<{ progress(value: unknown): void; flush(): Promise<void>; close(): Promise<void> }> {
  let nextSequence = 1;
  let events: Readonly<{ sequence: number; value: unknown }>[] = [];
  let dirty = false;
  let closed = false;
  let writer: Promise<void> | undefined;

  const snapshot = (): RequestProgressSnapshot => ({ nextSequence, events });

  const write = async (): Promise<void> => {
    while (dirty && !closed) {
      dirty = false;
      try {
        await atomicJson(progressPath(input.directory, input.transportId), {
          id: input.id,
          action: input.action,
          ...snapshot(),
        });
      } catch {
        // Observation is never allowed to impede service or its durable outcome.
      }
    }
  };

  const startWriter = (): void => {
    if (writer !== undefined) return;
    writer = write().finally(() => {
      writer = undefined;
      if (dirty && !closed) startWriter();
    });
  };

  const flush = async (): Promise<void> => {
    while (writer !== undefined) await writer;
  };

  return {
    progress(value): void {
      if (closed) return;
      const sequence = nextSequence++;
      try {
        const encoded = JSON.stringify({ value });
        if (encoded === undefined || !Object.hasOwn(JSON.parse(encoded), "value"))
          throw new Error("not JSON transport data");
      } catch {
        dirty = true;
        startWriter();
        return;
      }
      if (events.length === REQUEST_PROGRESS_WINDOW) {
        events = events.slice(1);
      }
      events = [...events, { sequence, value }];
      dirty = true;
      startWriter();
    },
    flush,
    async close(): Promise<void> {
      await flush();
      closed = true;
    },
  };
}

export async function readRequestProgress(
  input: Readonly<{
    directory: string;
    transportId: string;
    id: string;
    action: string;
  }>,
): Promise<RequestProgressSnapshot | undefined> {
  let bytes: string;
  try {
    bytes = await readFile(progressPath(input.directory, input.transportId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
  try {
    const parsed = progressSnapshotSchema.safeParse(JSON.parse(bytes));
    if (!parsed.success || parsed.data.id !== input.id || parsed.data.action !== input.action) return undefined;
    return { nextSequence: parsed.data.nextSequence, events: parsed.data.events };
  } catch {
    return undefined;
  }
}

export async function publishRequestCancellation(
  input: Readonly<{
    directory: string;
    transportId: string;
    id: string;
    action: string;
  }>,
): Promise<void> {
  try {
    await atomicJson(cancellationPath(input.directory, input.transportId), { id: input.id, action: input.action });
  } catch {
    // The channel may have disappeared; rendezvous will report the truthful unknown outcome.
  }
}

export function observeRequestCancellation(
  input: Readonly<{
    directory: string;
    transportId: string;
    id: string;
    action: string;
  }>,
): Readonly<{ signal: AbortSignal; close(): Promise<void> }> {
  const local = new AbortController();
  const stop = new AbortController();
  const run = (async (): Promise<void> => {
    while (!stop.signal.aborted && !local.signal.aborted) {
      try {
        const parsed = cancellationSchema.safeParse(
          JSON.parse(await readFile(cancellationPath(input.directory, input.transportId), "utf8")),
        );
        if (parsed.success && parsed.data.id === input.id && parsed.data.action === input.action) {
          local.abort(new Error("request cancelled by caller"));
          return;
        }
      } catch {
        // An absent or malformed cancellation notice has no authority.
      }
      try {
        await abortableDelay(OBSERVATION_POLL_MS, stop.signal);
      } catch {
        return;
      }
    }
  })();
  return {
    signal: local.signal,
    async close(): Promise<void> {
      if (!stop.signal.aborted) stop.abort();
      await run;
    },
  };
}
