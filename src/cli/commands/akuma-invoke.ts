import { resolve } from "node:path";
import {
  type AkuId,
  type ActivityHistory,
  type AkumaStatus,
  type InterruptReceipt,
} from "../../akuma/index.js";
import {
  Keiyaku,
  type AkumaKillResult,
  type AkumaTellResult,
  type AkumaWaitResult,
  type CallResult,
  type ForkResult,
  type Keiyaku as KeiyakuContract,
  type Repo,
} from "../../index.js";
import type { Settings } from "../../settings.js";
import type { WorldRoot } from "../../world.js";
import type { ParsedAkumaCommand } from "./akuma.js";

export type AkumaInvocationResult =
  | Readonly<{ kind: "akuma"; action: "call"; result: CallResult }>
  | Readonly<{ kind: "akuma"; action: "status"; status: AkumaStatus }>
  | Readonly<{ kind: "akuma"; action: "wait"; result: AkumaWaitResult }>
  | Readonly<{ kind: "akuma"; action: "tell"; result: AkumaTellResult; body: string }>
  | Readonly<{ kind: "akuma"; action: "interrupt"; akuma: AkuId; receipt: InterruptReceipt }>
  | Readonly<{ kind: "akuma"; action: "history"; akuma: AkuId; history?: ActivityHistory; answer?: string }>
  | Readonly<{ kind: "akuma"; action: "fork"; receipt: ForkResult }>
  | Readonly<{ kind: "akuma"; action: "kill"; result: AkumaKillResult }>;

type InvokeInput = Readonly<{
  path: WorldRoot;
  executionCwd: string;
  settings: Settings;
  contract?: KeiyakuContract;
  repo?: Repo;
  readStdin(): string;
}>;

async function invokeWait(command: Extract<ParsedAkumaCommand, { command: "wait" }>, input: InvokeInput): Promise<AkumaInvocationResult> {
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
  };
}

async function invokeTell(command: ParsedAkumaCommand & Readonly<{ command: "tell"; akuma: string }>, input: InvokeInput): Promise<AkumaInvocationResult> {
  const body = input.readStdin();
  const result = await Keiyaku.tell({ path: input.path, akuma: command.akuma, settings: input.settings, body });
  return { kind: "akuma", action: "tell", result, body };
}

async function invokeInterrupt(command: ParsedAkumaCommand & Readonly<{ command: "interrupt"; akuma: string }>, input: InvokeInput): Promise<AkumaInvocationResult> {
  const result = await Keiyaku.interrupt({ path: input.path, akuma: command.akuma, settings: input.settings, body: input.readStdin() });
  return {
    kind: "akuma",
    action: "interrupt",
    akuma: result.id,
    receipt: result.receipt,
  };
}

function invokeHistory(command: Extract<ParsedAkumaCommand, { command: "history" }>, input: InvokeInput): AkumaInvocationResult {
  const result = Keiyaku.history({
    path: input.path,
    akuma: command.akuma,
    settings: input.settings,
    ...(command.before === undefined ? {} : { before: command.before }),
    ...(command.since === undefined ? {} : { since: command.since }),
    last: command.last,
  });
  return {
    kind: "akuma",
    action: "history",
    akuma: result.id,
    ...(result.kind === "history" ? { history: result.history } : {}),
    ...(result.kind === "last" && result.answer !== undefined ? { answer: result.answer } : {}),
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
  return {
    kind: "akuma",
    action: "kill",
    result: await Keiyaku.kill({
      path: input.path,
      akuma: command.akuma,
      settings: input.settings,
      ...(input.repo === undefined ? {} : { repo: input.repo }),
    }),
  };
}

export async function invokeAkuma(
  command: ParsedAkumaCommand,
  input: InvokeInput,
): Promise<AkumaInvocationResult> {
  switch (command.command) {
    case "call": {
      const result = await Keiyaku.call({
        path: input.path,
        archetype: command.archetype,
        body: input.readStdin(),
        settings: input.settings,
        cwd: command.workdir === undefined
          ? input.executionCwd
          : resolve(input.executionCwd, command.workdir),
        mode: command.mode,
        ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
        ...(input.contract === undefined ? {} : { contract: input.contract }),
        ...(command.alias === undefined ? {} : { alias: command.alias }),
      });
      return { kind: "akuma", action: "call", result };
    }
    case "wait": return await invokeWait(command, input);
    case "tell": return await invokeTell(command, input);
    case "interrupt": return await invokeInterrupt(command, input);
    case "history": return invokeHistory(command, input);
    case "fork": return await invokeFork(command, input);
    case "kill": return await invokeKill(command, input);
  }
}

export function invokeAkumaStatus(path: WorldRoot, akuma: string, settings: Settings): AkumaInvocationResult {
  return { kind: "akuma", action: "status", status: Keiyaku.status({ path, akuma, settings }) };
}
