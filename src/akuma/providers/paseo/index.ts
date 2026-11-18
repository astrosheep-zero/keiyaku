import { KeiyakuError } from "../../../errors.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
// Pinned vendor CLI entry: the public SDK does not expose cancellation or selectors.
import { DaemonClient, type DaemonClientConfig } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { DaemonTransportFactory, WebSocketLike } from "@getpaseo/client/internal/daemon-client-transport-types";
import {
  bindWsHandler,
  createWebSocketTransportFactory,
  defaultWebSocketFactory,
} from "@getpaseo/client/internal/daemon-client-websocket-transport";
import { abortable } from "../../abort.js";
import {
  type AttemptCustody,
  type DriveInput,
  launchPrompt,
  modelEvent,
  type ProviderAdapter,
  type ProviderOptionAdmission,
  type Session,
} from "../../provider.js";
import type { ResumeCoordinate } from "../../coordinate.js";
import type { ProviderExecution, ProviderOptions } from "../../provider-recipe.js";
import { akumaExecutionEnvironment } from "../execution-environment.js";
import { PaseoTurn, paseoRuntimeModel } from "./events.js";
import { providerLifecycle } from "../lifecycle.js";

const configSchema = z
  .object({
    url: z.string().default("ws://127.0.0.1:6767/ws"),
    provider: z.string().trim().min(1).default("claude"),
  })
  .strict();

type PaseoConfig = z.infer<typeof configSchema>;
type PaseoClient = Pick<
  DaemonClient,
  | "connect"
  | "close"
  | "createAgent"
  | "fetchAgent"
  | "setAgentModel"
  | "listProviderModels"
  | "setAgentThinkingOption"
  | "sendMessage"
  | "cancelAgent"
  | "subscribeAgentTimeline"
  | "subscribeConnectionStatus"
>;
export type PaseoDependencies = Readonly<{ createClient?(config: DaemonClientConfig): PaseoClient }>;
type TimelineMessage = Parameters<Parameters<PaseoClient["subscribeAgentTimeline"]>[1]>[0];

function failures(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

/** Native disposal forgets sockets before their close event and swallows close errors. */
class PaseoSockets {
  private retiring = false;
  private readonly errors: unknown[] = [];
  private readonly sockets: Array<{ socket: WebSocketLike; closed: Promise<void>; observed: boolean }> = [];
  readonly factory: DaemonTransportFactory = (options) => {
    if (this.retiring) throw new Error("Paseo socket custody retired");
    const native = createWebSocketTransportFactory((url, settings) => {
      if (this.retiring) throw new Error("Paseo socket custody retired");
      const socket = defaultWebSocketFactory(url, settings);
      let proveClosed!: () => void;
      const closed = new Promise<void>((resolve) => {
        proveClosed = resolve;
      });
      const owned = { socket, closed, observed: false };
      const remove = bindWsHandler(socket, "close", () => {
        owned.observed = true;
        remove();
        proveClosed();
      });
      this.sockets.push(owned);
      return socket;
    })(options);
    return {
      ...native,
      close: (code, reason) => {
        try {
          native.close(code, reason);
        } catch (error) {
          this.errors.push(error);
          throw error;
        }
      },
    };
  };

  async retire(client: PaseoClient): Promise<void> {
    this.retiring = true;
    // Begin logical retirement, but independently close saved sockets even if
    // native disposal already forgot one after a rejected close code (1001).
    const logical = (async () => {
      try {
        await client.close();
      } catch (error) {
        this.errors.push(error);
      }
    })();
    const physical: Promise<void>[] = [];
    for (const owned of this.sockets) {
      try {
        if (!owned.observed) owned.socket.close(1000, "Paseo adapter retired");
        physical.push(owned.closed);
      } catch (error) {
        this.errors.push(error);
        // No success proof for this socket; the Body's existing custody policy
        // receives unsuccessful closure rather than a fabricated close event.
      }
    }
    await Promise.all([logical, ...physical]);
    failures(this.errors, "Paseo client/socket retirement failed");
  }
}

/** Check before invoking native work, not only after creating its promise. */
async function setup<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const result = await abortable(operation(), signal);
  signal.throwIfAborted();
  return result;
}

function configuration(execution: ProviderExecution): PaseoConfig {
  if (execution.executable !== undefined)
    throw new KeiyakuError("invalid-input", "Paseo connects to a local daemon, not an executable");
  const parsed = configSchema.safeParse(execution.config ?? {});
  if (!parsed.success)
    throw new KeiyakuError("invalid-input", `Paseo configuration: ${parsed.error.issues[0]?.message}`, {
      cause: parsed.error,
    });
  const config = parsed.data;
  const url = new URL(config.url);
  if (
    !["ws:", "wss:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/ws" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new KeiyakuError("invalid-input", "Paseo url must be a loopback WebSocket endpoint ending in /ws");
  }
  if (config.provider.includes("/"))
    throw new KeiyakuError(
      "invalid-input",
      "Paseo provider must be a bare native provider id; use the model option separately",
    );
  return config;
}

function optionAdmission(options: ProviderOptions): ProviderOptionAdmission {
  if (options.network !== undefined)
    return { kind: "refused", diagnostic: "Paseo does not support the network option" };
  if (options.systemPromptMode === "replace")
    return { kind: "refused", diagnostic: "Paseo does not support systemPrompt replacement" };
  return { kind: "admitted", options };
}

function usable(agent: AgentSnapshotPayload, input: DriveInput, config: PaseoConfig): void {
  if (agent.archivedAt != null || agent.providerUnavailable || agent.status === "closed")
    throw new Error(`Paseo agent ${agent.id} is unavailable`);
  if (agent.cwd !== input.cwd || agent.provider !== config.provider)
    throw new Error(`Paseo agent ${agent.id} no longer matches its execution recipe`);
  if (agent.activeTurn != null || agent.status === "running" || agent.status === "initializing")
    throw new Error(`Paseo agent ${agent.id} is busy; refusing to submit into another native execution`);
}

async function offeredModel(
  client: PaseoClient,
  agent: AgentSnapshotPayload,
  input: DriveInput,
  config: PaseoConfig,
): Promise<string | undefined> {
  const { model, effort } = input.options;
  if (model === undefined && effort === undefined) return undefined;
  const catalog = await setup(input.signal, () => client.listProviderModels(config.provider, { cwd: input.cwd }));
  if (catalog.error != null) throw new Error(`Paseo selector catalog unavailable: ${catalog.error}`);
  const requested = model ?? agent.runtimeInfo?.model ?? agent.model;
  const selected = catalog.models?.find(
    (choice) =>
      choice.isSelectable !== false &&
      (requested == null ? choice.isDefault : choice.id === requested || choice.aliases?.includes(requested)),
  );
  if (selected === undefined) throw new Error(`Paseo model is not available: ${requested ?? "native default"}`);
  if (effort !== undefined && !selected.thinkingOptions?.some((choice) => choice.id === effort)) {
    throw new Error(`Paseo effort is not available for ${selected.id}: ${effort}`);
  }
  return model === undefined ? undefined : selected.id;
}

async function applyOptions(
  client: PaseoClient,
  agent: AgentSnapshotPayload,
  input: DriveInput,
  config: PaseoConfig,
): Promise<string | undefined> {
  usable(agent, input, config);
  const model = await offeredModel(client, agent, input, config);
  const { effort } = input.options;
  if (model !== undefined) await setup(input.signal, () => client.setAgentModel(agent.id, model));
  if (effort !== undefined) {
    const notice = await setup(input.signal, () => client.setAgentThinkingOption(agent.id, effort));
    if (notice?.type === "error") throw new Error(`Paseo effort refused: ${notice.message}`);
  }
  const observed = await setup(input.signal, () => client.fetchAgent(agent.id));
  if (observed === null) throw new Error(`Paseo agent ${agent.id} is unavailable`);
  usable(observed.agent, input, config);
  if (model !== undefined && (observed.agent.runtimeInfo?.model ?? observed.agent.model) !== model) {
    throw new Error(`Paseo model selection was not confirmed: ${model}`);
  }
  if (
    effort !== undefined &&
    (observed.agent.effectiveThinkingOptionId ?? observed.agent.runtimeInfo?.thinkingOptionId) !== effort
  ) {
    throw new Error(`Paseo effort selection was not confirmed: ${effort}`);
  }
  // The runtime's own answer names the model this agent will run, whether or
  // not the caller requested one. The snapshot's top-level model may be a
  // configured fallback rather than what the runtime loaded, so it is never
  // runtime evidence; an unnamed runtime stays unknown and clears nothing.
  return paseoRuntimeModel(observed.agent.runtimeInfo);
}

class PaseoDrive {
  readonly turn = new PaseoTurn(randomUUID());
  private retainClosure!: (operation: Promise<void>) => void;
  private closure: Promise<void> | undefined;
  private removeConnectionListener: () => void = () => undefined;
  private agentId: string | undefined;
  private submitted = false;
  private admitted = false;
  private sequence: number | undefined;
  private epoch: string | undefined;

  constructor(
    private readonly client: PaseoClient,
    custody: AttemptCustody,
    private readonly environment: Readonly<Record<string, string | undefined>>,
    private readonly sockets: PaseoSockets,
  ) {
    const closed = new Promise<void>((resolve) => {
      this.retainClosure = resolve;
    });
    const stop = () => this.retire("requested");
    custody.own({ closed, abort: stop, forceDispose: stop });
    this.removeConnectionListener = client.subscribeConnectionStatus((state) => {
      if (this.closure !== undefined) return;
      if (state.status === "disconnected" || state.status === "disposed")
        this.fail(new Error("Paseo connection lost before own turn completion"));
    });
  }

  async establish(input: DriveInput, config: PaseoConfig, coordinate?: ResumeCoordinate): Promise<Session> {
    const systemPrompt = [input.options.systemPrompt, input.runtimeInstructions]
      .filter((part) => part !== undefined && part.length > 0)
      .join("\n\n");
    input.signal.throwIfAborted();
    await setup(input.signal, () => this.client.connect());
    const agent =
      coordinate === undefined
        ? await setup(input.signal, () =>
            this.client.createAgent({
              provider: config.provider,
              cwd: input.cwd,
              ...(systemPrompt === "" ? {} : { systemPrompt }),
              env: akumaExecutionEnvironment(process.env, this.environment, [], input.execution),
              autoArchive: false,
            }),
          )
        : await this.existingAgent(coordinate, input.signal);
    this.agentId = agent.id;
    const startupModel = await applyOptions(this.client, agent, input, config);
    input.signal.throwIfAborted();
    const subscription = this.client.subscribeAgentTimeline(agent.id, (message) => this.receive(message));
    await abortable(subscription.ready, input.signal);
    const { events, completion } = this.turn.outcome;
    events.emit({ type: "session", coordinate: { sessionId: agent.id } });
    if (startupModel !== undefined) events.emit(modelEvent(startupModel));
    // Native steer may still replace work if a human wins the check/send race.
    input.signal.throwIfAborted();
    if (this.turn.outcome.terminal) await completion;
    const prompt = launchPrompt(input.body, input.launchTells, input.schemaJson);
    await setup(input.signal, () => {
      this.submitted = true;
      return this.client.sendMessage(agent.id, prompt, { messageId: this.turn.messageId, activeTurnBehavior: "steer" });
    });
    const admissionSignal = AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]);
    const fence = await abortable(this.turn.admission, admissionSignal).catch((error: unknown) => {
      if (input.signal.aborted) throw error;
      throw new Error("Paseo canonical native admission was not observed", { cause: error });
    });
    this.admitted = true;
    this.retireSettledTurn();
    return { admission: { fence }, events, completion };
  }

  private async existingAgent(coordinate: ResumeCoordinate, signal: AbortSignal): Promise<AgentSnapshotPayload> {
    if (!("sessionId" in coordinate) || coordinate.sessionId === undefined || "sessionFile" in coordinate)
      throw new Error("Paseo resume requires an agent id");
    const found = await setup(signal, () => this.client.fetchAgent(coordinate.sessionId!));
    if (found === null) throw new Error(`Paseo agent ${coordinate.sessionId} is unavailable`);
    return found.agent;
  }

  private receive(message: TimelineMessage): void {
    if (this.turn.outcome.terminal || message.payload.agentId !== this.agentId) return;
    if (message.type === "agent_stream") {
      const { seq, epoch, event } = message.payload;
      if (this.epoch !== undefined && epoch !== undefined && epoch !== this.epoch)
        return this.fail(new Error("Paseo timeline epoch changed before own turn completion"));
      if (epoch !== undefined) this.epoch = epoch;
      if (seq !== undefined) {
        if (this.sequence !== undefined && seq > this.sequence + 1)
          return this.fail(new Error("Paseo timeline delivery gap before own turn completion"));
        if (this.sequence !== undefined && seq <= this.sequence) return;
        this.sequence = seq;
      }
      try {
        this.turn.receive(event);
      } catch (error) {
        return this.fail(error);
      }
      this.retireSettledTurn();
    } else
      this.fail(
        new Error(
          message.type === "agent.timeline.error"
            ? `Paseo timeline failed: ${message.payload.error}`
            : "Paseo timeline was invalidated before own turn completion",
        ),
      );
  }

  private fail(error: unknown): void {
    if (this.turn.fail(error)) void this.retire("observation-lost").catch(() => undefined);
  }

  private retireSettledTurn(): void {
    // A terminal broadcast may precede the native send acknowledgement.
    if (this.admitted && this.turn.outcome.terminal) void this.retire().catch(() => undefined);
  }

  private retire(control?: "requested" | "observation-lost"): Promise<void> {
    if (this.closure === undefined) {
      this.closure = Promise.resolve().then(() => this.close(control));
      this.retainClosure(this.closure);
    }
    return this.closure;
  }

  private async close(control?: "requested" | "observation-lost"): Promise<void> {
    const errors: unknown[] = [];
    try {
      this.removeConnectionListener();
    } catch (error) {
      errors.push(error);
    }
    try {
      if (
        this.submitted &&
        this.agentId !== undefined &&
        (control === "observation-lost" || (control === "requested" && !this.turn.outcome.terminal))
      )
        await this.client.cancelAgent(this.agentId);
    } catch (error) {
      errors.push(error);
    }
    this.turn.fail(new Error("Paseo client retired"));
    try {
      await this.sockets.retire(this.client);
    } catch (error) {
      errors.push(error);
    }
    failures(errors, "Paseo native control and retirement failed");
  }
}

export function createPaseoProvider(
  execution: ProviderExecution,
  dependencies: PaseoDependencies = {},
): ProviderAdapter {
  const config = configuration(execution);
  return {
    admitOptions: optionAdmission,
    ...providerLifecycle(async (input, custody) => {
      custody.signal.throwIfAborted();
      const environment = akumaExecutionEnvironment(process.env, execution.env);
      const sockets = new PaseoSockets();
      const client = (dependencies.createClient ?? ((value) => new DaemonClient(value)))({
        url: config.url,
        clientId: randomUUID(),
        clientType: "cli",
        reconnect: { enabled: false },
        transportFactory: sockets.factory,
        connectTimeoutMs: 15_000,
        ...(environment.PASEO_PASSWORD === undefined ? {} : { password: environment.PASEO_PASSWORD }),
      });
      const drive = new PaseoDrive(client, custody, execution.env ?? {}, sockets);
      const signal = AbortSignal.any([custody.signal, AbortSignal.timeout(15_000)]);
      return await drive.establish(
        { ...input, signal },
        config,
        input.session.kind === "resume" ? input.session.coordinate : undefined,
      );
    }),
  };
}
