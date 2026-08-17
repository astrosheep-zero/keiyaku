import { type AkuId, type ActivityHistory } from "../../akuma/index.js";
import {
  Keiyaku,
  type AkumaKillResult,
  type AkumaHistoryResult,
  type AkumaObservation,
  type AkumaTellResult,
  type AkumaWaitResult,
  type CallResult,
  type ForkResult,
  type Keiyaku as KeiyakuContract,
  type Repo,
} from "../../index.js";
import type { Settings } from "../../settings.js";
import type { WorldRoot } from "../../world.js";
import type { AkumaPromptSource, InvokedAkumaCommand } from "./akuma.js";

export type AkumaInvocationResult =
  | Readonly<{ kind: "akuma"; action: "call"; result: CallResult; world: WorldRoot }>
  | Readonly<{ kind: "akuma"; action: "status"; status: AkumaObservation; alias?: string }>
  | Readonly<{ kind: "akuma"; action: "wait"; result: AkumaWaitResult; alias?: string }>
  | Readonly<{ kind: "akuma"; action: "tell"; mode: "ordinary"; result: AkumaTellResult; body: string; alias?: string }>
  | Readonly<{ kind: "akuma"; action: "tell"; mode: "interrupt"; result: Awaited<ReturnType<typeof Keiyaku.interrupt>>; body: string; alias?: string }>
  | Readonly<{ kind: "akuma"; action: "history"; akuma: AkuId; mode: "page"; history: ActivityHistory; historyResult: AkumaHistoryResult; alias?: string }>
  | Readonly<{ kind: "akuma"; action: "history"; akuma: AkuId; mode: "last"; answer: string; historyResult: AkumaHistoryResult; alias?: string }>
  | Readonly<{ kind: "akuma"; action: "history"; akuma: AkuId; mode: "no-answer"; historyResult: AkumaHistoryResult; alias?: string }>
  | Readonly<{ kind: "akuma"; action: "fork"; receipt: ForkResult }>
  | Readonly<{ kind: "akuma"; action: "kill"; result: AkumaKillResult; alias?: string }>;

type InvokeInput = Readonly<{
  path: WorldRoot;
  statedCwd?: string;
  home?: string;
  settings?: Settings;
  contract?: KeiyakuContract;
  repo?: Repo;
  readStdin(): Promise<string>;
}>;

function inputAlias(selector: string): string | undefined {
  return selector.startsWith("@") ? selector : undefined;
}

async function promptBody(command: Readonly<{ prompt: AkumaPromptSource }>, input: InvokeInput): Promise<string> {
  return command.prompt.kind === "stdin" ? await input.readStdin() : command.prompt.value;
}

async function invokeWait(
  command: Extract<InvokedAkumaCommand, { command: "wait" }>,
  input: InvokeInput,
): Promise<AkumaInvocationResult> {
  const alias = command.akuma.length === 1 ? inputAlias(command.akuma[0]!) : undefined;
  return {
    kind: "akuma",
    action: "wait",
    result: await Keiyaku.wait({
      path: input.path,
      akuma: command.akuma,
      ...(input.repo === undefined ? {} : { repo: input.repo }),
      ...(command.completion === undefined ? {} : { completion: command.completion }),
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
    }),
    ...(alias === undefined ? {} : { alias }),
  };
}

async function invokeTell(
  command: Extract<InvokedAkumaCommand, { command: "tell" }>,
  input: InvokeInput,
): Promise<AkumaInvocationResult> {
  const body = await promptBody(command, input);
  if (command.interrupt) {
    const result = await Keiyaku.interrupt({
      path: input.path,
      akuma: command.akuma,
      body,
      ...(input.repo === undefined ? {} : { repo: input.repo }),
    });
    const alias = inputAlias(command.akuma);
    return { kind: "akuma", action: "tell", mode: "interrupt", result, body, ...(alias === undefined ? {} : { alias }) };
  }
  const result = await Keiyaku.tell({
    path: input.path,
    akuma: command.akuma,
    body,
    ...(input.repo === undefined ? {} : { repo: input.repo }),
  });
  const alias = inputAlias(command.akuma);
  return { kind: "akuma", action: "tell", mode: "ordinary", result, body, ...(alias === undefined ? {} : { alias }) };
}

async function invokeHistory(
  command: Extract<InvokedAkumaCommand, { command: "history" }>,
  input: InvokeInput,
): Promise<AkumaInvocationResult> {
  const result = await Keiyaku.history({
    path: input.path,
    akuma: command.akuma,
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(command.before === undefined ? {} : { before: command.before }),
    ...(command.since === undefined ? {} : { since: command.since }),
    ...(command.limit === undefined ? {} : { limit: command.limit }),
    last: command.last,
  });
  return {
    kind: "akuma",
    action: "history",
    akuma: result.id,
    historyResult: result,
    ...(inputAlias(command.akuma) === undefined ? {} : { alias: command.akuma }),
    ...(result.kind === "history"
      ? { mode: "page" as const, history: result.history }
      : result.kind === "last"
        ? { mode: "last" as const, answer: result.answer }
        : { mode: "no-answer" as const }),
  };
}

async function invokeFork(
  command: Extract<InvokedAkumaCommand, { command: "fork" }>,
  input: InvokeInput,
): Promise<AkumaInvocationResult> {
  return {
    kind: "akuma",
    action: "fork",
    receipt: await Keiyaku.fork({
      path: input.path,
      akuma: command.akuma,
      at: command.at,
      ...(input.repo === undefined ? {} : { repo: input.repo }),
    }),
  };
}

async function invokeKill(
  command: Extract<InvokedAkumaCommand, { command: "kill" }>,
  input: InvokeInput,
): Promise<AkumaInvocationResult> {
  const alias = command.akuma.length === 1 ? inputAlias(command.akuma[0]!) : undefined;
  return {
    kind: "akuma",
    action: "kill",
    result: await Keiyaku.kill({
      path: input.path,
      akuma: command.akuma,
      ...(input.repo === undefined ? {} : { repo: input.repo }),
    }),
    ...(alias === undefined ? {} : { alias }),
  };
}

export async function invokeAkuma(
  command: InvokedAkumaCommand,
  input: InvokeInput,
): Promise<AkumaInvocationResult> {
  switch (command.command) {
    case "call": {
      const body = await promptBody(command, input);
      const result = await Keiyaku.call({
        path: input.path,
        archetype: command.archetype,
        body,
        ...(input.home === undefined ? {} : { home: input.home }),
        ...(input.settings === undefined ? {} : { settings: input.settings }),
        ...(input.statedCwd === undefined ? {} : { cwd: input.statedCwd }),
        mode: command.mode,
        ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
        ...(input.contract === undefined ? {} : { contract: input.contract }),
        ...(command.alias === undefined ? {} : { alias: command.alias }),
      });
      return { kind: "akuma", action: "call", result, world: input.path };
    }
    case "wait": return await invokeWait(command, input);
    case "tell": return await invokeTell(command, input);
    case "history": return await invokeHistory(command, input);
    case "fork": return await invokeFork(command, input);
    case "kill": return await invokeKill(command, input);
  }
}

export async function invokeAkumaStatus(
  path: WorldRoot,
  akuma: string,
  alias?: string,
  repo?: Repo,
): Promise<AkumaInvocationResult> {
  return {
    kind: "akuma",
    action: "status",
    status: await Keiyaku.status({ path, akuma, ...(repo === undefined ? {} : { repo }) }),
    ...(alias === undefined ? {} : { alias }),
  };
}
