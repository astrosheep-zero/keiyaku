import { defaultWaitComplete, bornStatus, readWaitComplete, waitForObservation } from "./akuma-observe.js";
import { recordTell, type TellFact, type TellRow } from "./heart/index.js";
import { pathsForAkuId, type AkuId } from "./identity.js";
import { BIRTH_TIMEOUT_MS } from "./publication.js";
import type { WorldRoot } from "../world.js";

export type CallInitialTell = Readonly<{
  tellId: string;
  body: string;
  schemaJson?: string;
  initiator?: string;
}>;

export type TellWake =
  | Readonly<{ kind: "told" }>
  | Readonly<{ kind: "pursuing"; bodySequence: number }>
  | Readonly<{ kind: "held" }>
  | Readonly<{
      kind: "failed";
      diagnostic: string;
      child?: Readonly<{
        code: number | null;
        signal: string | null;
        log: Readonly<{ path: string; from: number; to: number }>;
      }>;
    }>;

export type TellResult = Readonly<{
  admission: Readonly<{ tellId: string; fact: "recorded" }>;
  row: TellRow;
  wake: TellWake;
}>;

export type CallInitialTellAdmission =
  | Readonly<{ kind: "admitted"; tell: TellFact; wake: Promise<TellResult> }>
  | Readonly<{ kind: "not-born" }>
  | Readonly<{ kind: "birth-failed"; diagnostic: string }>;

export async function admitCallInitialTell(
  input: Readonly<{
    world: WorldRoot;
    id: AkuId;
    initialTell: CallInitialTell;
    signal?: AbortSignal;
    now?: () => string;
    wake(tell: TellFact): Promise<TellResult>;
  }>,
): Promise<CallInitialTellAdmission> {
  const paths = pathsForAkuId(input.world, input.id);
  const birth = await waitForObservation({
    timeoutMs: BIRTH_TIMEOUT_MS,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    probe: async () => await readWaitComplete(input.world, input.id),
    observe: async () => (await bornStatus(paths, input.id, { aperture: "receipt" })).status,
    complete: defaultWaitComplete,
  });
  if (birth.reason !== "completed" || birth.value.life !== "asleep") {
    return {
      kind: "birth-failed",
      diagnostic: `Akuma ${input.id} prompt-free birth did not settle cleanly`,
    };
  }
  input.signal?.throwIfAborted();
  const recorded = await recordTell(paths, {
    kind: "tell",
    id: input.initialTell.tellId,
    body: input.initialTell.body,
    recordedAt: input.now?.() ?? new Date().toISOString(),
    ...(input.initialTell.schemaJson === undefined ? {} : { schemaJson: input.initialTell.schemaJson }),
    ...(input.initialTell.initiator === undefined ? {} : { initiator: input.initialTell.initiator }),
  });
  if (recorded.kind === "not-born") return recorded;
  return { kind: "admitted", tell: recorded.tell, wake: input.wake(recorded.tell) };
}
