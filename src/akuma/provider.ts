import type { Confinement, ProviderOptions, ResumeCoordinate } from "./heart/index.js";
export type { ProviderOptions, ResumeCoordinate } from "./heart/index.js";

export const AKUMA_REQUESTS_ENV = "AKUMA_REQUESTS";

export type AgentEvent =
  | Readonly<{ type: "session"; coordinate: ResumeCoordinate }>
  | Readonly<{ type: "assistant"; text: string }>
  | Readonly<{ type: "activity"; event: Readonly<Record<string, unknown>> }>;

type EventWaiter = Readonly<{ resolve(value: IteratorResult<AgentEvent>): void }>;

export class AgentEventChannel implements AsyncIterable<AgentEvent> {
  private readonly queued: AgentEvent[] = [];
  private readonly waiters: EventWaiter[] = [];
  private ended = false;

  emit(event: AgentEvent): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.queued.push(event);
    else waiter.resolve({ done: false, value: event });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: () => {
        const event = this.queued.shift();
        if (event !== undefined) return Promise.resolve({ done: false, value: event });
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push({ resolve }));
      },
    };
  }
}

export type TurnResult =
  | Readonly<{ kind: "answered"; answer: string; historyId: string }>
  | Readonly<{ kind: "failed"; diagnostic: string }>;

export type Drive = Readonly<{
  events: AsyncIterable<AgentEvent>;
  completion: Promise<TurnResult>;
  abort(): Promise<void>;
}>;

export type ProviderOptionAdmission =
  | Readonly<{ kind: "admitted"; options: ProviderOptions }>
  | Readonly<{ kind: "refused"; diagnostic: string }>;

export type ProviderAdapter = Readonly<{
  confinement(input: Readonly<{ cwd: string; options: ProviderOptions }>): Confinement;
  admitOptions(options: ProviderOptions): ProviderOptionAdmission;
  fork?(input: Readonly<{
    session: ResumeCoordinate;
    at: string;
    cwd: string;
  }>): Promise<Readonly<{ session: ResumeCoordinate }>>;
  start(input: Readonly<{
    prompt: string;
    cwd: string;
    options: ProviderOptions;
    session?: ResumeCoordinate;
    requests?: Readonly<{ dir: string }>;
  }>): Promise<Drive>;
}>;
