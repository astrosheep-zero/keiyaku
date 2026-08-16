import { type AkuId, type ActivityHistory } from "../../akuma/index.js";
import {
  Keiyaku,
  type AkumaKillResult,
  type AkumaHistoryResult,
  type AkumaStatusView,
  type AkumaTellResult,
  type AkumaWaitResult,
  type CallResult,
  type ForkResult,
  type Keiyaku as KeiyakuContract,
  type Repo,
} from "../../index.js";
import type { Settings } from "../../settings.js";
import type { WorldRoot } from "../../world.js";
import type { AkumaPromptSource, ParsedAkumaCommand } from "./akuma.js";

export type AkumaInvocationResult =
  | Readonly<{ kind: "akuma"; action: "call"; result: CallResult }>
  | Readonly<{ kind: "akuma"; action: "status"; status: AkumaStatusView; alias?: string }>
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
  executionCwd: string;
  settings: Settings;
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

async function invokeWait(command: Extract<ParsedAkumaCommand, { command: "wait" }>, input: InvokeInput): Promise<AkumaInvocationResult> {
  const alias = command.akuma.length === 1 ? inputAlias(command.akuma[0]!) : undefined;
  return {
    kind: "akuma",
    action: "wait",
    result: await Keiyaku.wait({
      path: input.path,
      akuma: command.akuma,
      settings: input.settings,
      ...(input.repo === undefined ? {} : { repo: input.repo }),
      ...(command.completion === undefined ? {} : { completion: command.completion }),
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
    }),
    ...(alias === undefined ? {} : { alias }),
  };
}

async function invokeTell(command: ParsedAkumaCommand & Readonly<{ command: "tell"; akuma: string }>, input: InvokeInput): Promise<AkumaInvocationResult> {
  const body = await promptBody(command, input);
  if (command.interrupt) {
    const result = await Keiyaku.interrupt({ path: input.path, akuma: command.akuma, settings: input.settings, body, ...(input.repo === undefined ? {} : { repo: input.repo }) });
    const alias = inputAlias(command.akuma);
    return { kind: "akuma", action: "tell", mode: "interrupt", result, body, ...(alias === undefined ? {} : { alias }) };
  }
  const result = await Keiyaku.tell({ path: input.path, akuma: command.akuma, settings: input.settings, body, ...(input.repo === undefined ? {} : { repo: input.repo }) });
  const alias = inputAlias(command.akuma);
  return { kind: "akuma", action: "tell", mode: "ordinary", result, body, ...(alias === undefined ? {} : { alias }) };
}

async function invokeHistory(command: Extract<ParsedAkumaCommand, { command: "history" }>, input: InvokeInput): Promise<AkumaInvocationResult> {
  const result = await Keiyaku.history({
    path: input.path,
    akuma: command.akuma,
    settings: input.settings,
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(command.before === undefined ? {} : { before: command.before }),
    ...(command.since === undefined ? {} : { since: command.since }),
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

async function invokeFork(command: Extract<ParsedAkumaCommand, { command: "fork" }>, input: InvokeInput): Promise<AkumaInvocationResult> {
  return {
    kind: "akuma",
    action: "fork",
    receipt: await Keiyaku.fork({
      path: input.path,
      akuma: command.akuma,
      at: command.at,
      settings: input.settings,
      ...(input.repo === undefined ? {} : { repo: input.repo }),
    }),
  };
}

async function invokeKill(command: Extract<ParsedAkumaCommand, { command: "kill" }>, input: InvokeInput): Promise<AkumaInvocationResult> {
  const alias = command.akuma.length === 1 ? inputAlias(command.akuma[0]!) : undefined;
  return {
    kind: "akuma",
    action: "kill",
    result: await Keiyaku.kill({
      path: input.path,
      akuma: command.akuma,
      settings: input.settings,
      ...(input.repo === undefined ? {} : { repo: input.repo }),
    }),
    ...(alias === undefined ? {} : { alias }),
  };
}

export async function invokeAkuma(
  command: ParsedAkumaCommand,
  input: InvokeInput,
): Promise<AkumaInvocationResult> {
  switch (command.command) {
    case "call": {
      const body = await promptBody(command, input);
      const result = await Keiyaku.call({
        path: input.path,
        archetype: command.archetype,
        body,
        settings: input.settings,
        cwd: input.executionCwd,
        mode: command.mode,
        ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
        ...(input.contract === undefined ? {} : { contract: input.contract }),
        ...(command.alias === undefined ? {} : { alias: command.alias }),
      });
      return { kind: "akuma", action: "call", result };
    }
    case "wait": return await invokeWait(command, input);
    case "tell": return await invokeTell(command, input);
    case "history": return await invokeHistory(command, input);
    case "fork": return await invokeFork(command, input);
    case "kill": return await invokeKill(command, input);
  }
}

export async function invokeAkumaStatus(path: WorldRoot, akuma: string, settings: Settings, alias?: string, repo?: Repo): Promise<AkumaInvocationResult> {
  return {
    kind: "akuma",
    action: "status",
    status: await Keiyaku.status({ path, akuma, settings, ...(repo === undefined ? {} : { repo }) }),
    ...(alias === undefined ? {} : { alias }),
  };
}
