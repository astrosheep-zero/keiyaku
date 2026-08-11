import { resolve } from "node:path";
import {
  Akuma,
  type AkuId,
  type AkumaStatus,
  type InterruptReceipt,
  type KillEvidence,
  type TellReceipt,
} from "../../akuma/index.js";
import type { ActivityHistory } from "../../akuma/index.js";
import { Keiyaku, type CallResult, type ForkResult, type Keiyaku as KeiyakuContract, type Repo } from "../../index.js";
import type { Settings } from "../../settings.js";
import type { ParsedAkumaCommand } from "./akuma.js";

export type AkumaInvocationResult =
  | Readonly<{ kind: "akuma"; action: "call"; result: CallResult }>
  | Readonly<{ kind: "akuma"; action: "status"; status: AkumaStatus }>
  | Readonly<{ kind: "akuma"; action: "wait"; status: AkumaStatus }>
  | Readonly<{ kind: "akuma"; action: "tell"; akuma: AkuId; receipt: TellReceipt; status: AkumaStatus }>
  | Readonly<{ kind: "akuma"; action: "interrupt"; akuma: AkuId; receipt: InterruptReceipt }>
  | Readonly<{ kind: "akuma"; action: "history"; akuma: AkuId; history: ActivityHistory; answer?: string }>
  | Readonly<{ kind: "akuma"; action: "fork"; akuma: AkuId; receipt: ForkResult }>
  | Readonly<{ kind: "akuma"; action: "kill"; id: AkuId; evidence: KillEvidence }>;

export async function invokeAkuma(
  command: ParsedAkumaCommand,
  input: Readonly<{
    path: string;
    settings: Settings;
    contract?: KeiyakuContract;
    repo?: Repo;
    readStdin(): string;
  }>,
): Promise<AkumaInvocationResult> {
  const world = (): Akuma => Akuma.at({ path: input.path, settings: input.settings });
  switch (command.command) {
    case "call": {
      const result = await Keiyaku.call({
        path: input.path,
        archetype: command.archetype,
        body: input.readStdin(),
        settings: input.settings,
        ...(command.workdir === undefined ? {} : { cwd: resolve(input.path, command.workdir) }),
        mode: command.mode,
        ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
        ...(input.contract === undefined ? {} : { contract: input.contract }),
        ...(command.alias === undefined ? {} : { alias: command.alias }),
      });
      return { kind: "akuma", action: "call", result };
    }
    case "wait": return {
      kind: "akuma",
      action: "wait",
      status: await world().of({ id: command.id }).wait(undefined, command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
    };
    case "tell": {
      const handle = world().of({ id: command.id });
      const receipt = await handle.tell(input.readStdin());
      return { kind: "akuma", action: "tell", akuma: command.id, receipt, status: handle.status() };
    }
    case "interrupt": return {
      kind: "akuma",
      action: "interrupt",
      akuma: command.id,
      receipt: await world().of({ id: command.id }).interrupt(input.readStdin()),
    };
    case "history": {
      const handle = world().of({ id: command.id });
      const history = handle.history({
        ...(command.before === undefined ? {} : { before: command.before }),
        ...(command.since === undefined ? {} : { since: command.since }),
      });
      return {
        kind: "akuma",
        action: "history",
        akuma: command.id,
        history,
        ...(command.last ? { answer: handle.lastAnswer() } : {}),
      };
    }
    case "fork": return {
      kind: "akuma",
      action: "fork",
      akuma: command.id,
      receipt: await Keiyaku.fork({
        path: input.path,
        akuma: command.id,
        at: command.at,
        settings: input.settings,
        ...(input.repo === undefined ? {} : { repo: input.repo }),
      }),
    };
    case "kill": return { kind: "akuma", action: "kill", id: command.id, evidence: await world().of({ id: command.id }).kill() };
  }
}

export function invokeAkumaStatus(path: string, id: string): AkumaInvocationResult {
  return { kind: "akuma", action: "status", status: Akuma.at({ path }).of({ id }).status() };
}
