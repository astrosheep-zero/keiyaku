import { abortableDelay } from "./abort.js";
import { isDeepStrictEqual } from "node:util";
import { createBodyHeartReader, type BodyControlSnapshot, type HeldAkumaLeash } from "./heart/index.js";
import type { AkumaPaths } from "./identity.js";

const BODY_CONTROL_OBSERVATION_MS = 100;
export const CONTROL_RESPONSE_MS = 1_000;

export class BodySupervisor {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly finished = new AbortController();
  private readonly observer: Promise<void>;
  private waiter: ((snapshot: BodyControlSnapshot) => void) | undefined;
  private observation: BodyControlSnapshot;
  private stopping?: "control" | "heart-gone" | "launch";
  private readonly cancelLaunch = (): void => this.cancel("launch");

  private constructor(
    private readonly body: Readonly<{ paths: AkumaPaths; sequence: number; leash: HeldAkumaLeash }>,
    private readonly reader: ReturnType<typeof createBodyHeartReader>,
    observation: BodyControlSnapshot,
    private readonly launchSignal?: AbortSignal,
    readonly forceSignal?: AbortSignal,
  ) {
    this.signal = this.controller.signal;
    this.observation = observation;
    launchSignal?.addEventListener("abort", this.cancelLaunch, { once: true });
    if (launchSignal?.aborted) this.cancelLaunch();
    this.observer = this.observe();
  }

  static async open(
    paths: AkumaPaths,
    bodySequence: number,
    leash: HeldAkumaLeash,
    signal?: AbortSignal,
    forceSignal?: AbortSignal,
  ): Promise<BodySupervisor> {
    const reader = createBodyHeartReader(paths);
    return new BodySupervisor(
      { paths, sequence: bodySequence, leash },
      reader,
      await reader.read(),
      signal,
      forceSignal,
    );
  }

  get reason(): "control" | "heart-gone" | "launch" | undefined {
    return this.stopping;
  }
  current(): BodyControlSnapshot {
    return this.observation;
  }

  async recordHung(diagnostic: string, at: string): Promise<void> {
    await this.body.leash.recordBodyHung(this.body.paths, { sequence: this.body.sequence, diagnostic, at });
  }

  async refresh(): Promise<BodyControlSnapshot> {
    const snapshot = await this.reader.read();
    if (!isDeepStrictEqual(snapshot, this.observation)) {
      this.observation = snapshot;
      this.waiter?.(snapshot);
      this.waiter = undefined;
    }
    return this.observation;
  }

  next(after: BodyControlSnapshot): Promise<BodyControlSnapshot> {
    if (this.observation !== after) return Promise.resolve(this.observation);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  cancel(reason: "control" | "heart-gone" | "launch"): void {
    if (this.stopping !== undefined) return;
    this.stopping = reason;
    this.controller.abort(new Error(reason === "heart-gone" ? "Akuma Heart disappeared" : "Akuma Body interrupted"));
    this.waiter?.(this.observation);
    this.waiter = undefined;
  }

  async close(): Promise<void> {
    this.finished.abort();
    this.launchSignal?.removeEventListener("abort", this.cancelLaunch);
    try {
      await this.observer;
    } finally {
      this.reader.clear();
      this.waiter = undefined;
    }
  }

  private async observe(): Promise<void> {
    for (;;) {
      const snapshot = this.observation;
      if (snapshot.soul === null) return this.cancel("heart-gone");
      if (snapshot.stop?.bodySequence === this.body.sequence || snapshot.pause?.bodySequence === this.body.sequence) {
        return this.cancel("control");
      }
      try {
        await abortableDelay(BODY_CONTROL_OBSERVATION_MS, this.finished.signal);
      } catch {
        return;
      }
      await this.refresh();
    }
  }
}
