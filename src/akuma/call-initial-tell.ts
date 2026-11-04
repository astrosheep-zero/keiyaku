import type { WorldRoot } from "../world.js";
import { bornStatus, defaultWaitComplete, readWaitComplete, waitForObservation } from "./akuma-observe.js";
import { recordTell, type TellFact } from "./heart/index.js";
import { pathsForAkuId, type AkuId } from "./identity.js";
import type { TellRow } from "./heart/facts.js";
import { BIRTH_TIMEOUT_MS } from "./publication.js";

export type CallInitialTell = Readonly<{
  tellId: string;
  body: string;
  schemaJson?: string;
  initiator?: string;
}>;

export type InitialTellAdmissionInput = Readonly<{
  id: AkuId;
  initialTell: CallInitialTell;
  contractId?: string;
  signal?: AbortSignal;
}>;

export type TellWake =
  | Readonly<{ kind: "told" }>
  | Readonly<{ kind: "held" }>
  | Readonly<{ kind: "pursuing"; bodySequence: number }>
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
  admission: Readonly<{ fact: "recorded"; tellId: string }>;
  row: TellRow;
  wake: TellWake;
  interruption?:
    | Readonly<{ kind: "completed"; bodySequence: number; putDown: "was-idle" | "self-aborted" }>
    | Readonly<{ kind: "pending"; bodySequence: number }>
    | Readonly<{ kind: "unavailable"; bodySequence: number; evidence: "hung" | "untidy" }>;
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
    probe: async () => await readWaitComplete(input.world, [input.id], "all", input.signal),
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
