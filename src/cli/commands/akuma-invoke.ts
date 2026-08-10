import {
  Akuma,
  type AkumaStatus,
  type ForkReceipt,
  type InterruptReceipt,
  type KillEvidence,
  type TellReceipt,
} from "../../akuma/index.js";
import type { ActivityHistory } from "../../akuma/index.js";
import type { Settings } from "../../settings.js";
import type { ParsedAkumaCommand } from "./akuma.js";

export type AkumaInvocationResult =
  | Readonly<{ kind: "akuma"; action: "call"; id: string }>
  | Readonly<{ kind: "akuma"; action: "status"; status: AkumaStatus }>
  | Readonly<{ kind: "akuma"; action: "wait"; status: AkumaStatus }>
  | Readonly<{ kind: "akuma"; action: "tell"; akuma: string; receipt: TellReceipt; status: AkumaStatus }>
  | Readonly<{ kind: "akuma"; action: "interrupt"; akuma: string; receipt: InterruptReceipt }>
  | Readonly<{ kind: "akuma"; action: "history"; akuma: string; history: ActivityHistory; answer?: string }>
  | Readonly<{ kind: "akuma"; action: "fork"; akuma: string; receipt: ForkReceipt }>
  | Readonly<{ kind: "akuma"; action: "kill"; id: string; evidence: KillEvidence }>;

export async function invokeAkuma(
  command: ParsedAkumaCommand,
  input: Readonly<{ path: string; settings: Settings; readStdin(): string }>,
): Promise<AkumaInvocationResult> {
  const world = Akuma.at({ path: input.path, settings: input.settings });
  switch (command.command) {
    case "call": {
      const handle = await world.call({
        persona: command.persona,
        body: input.readStdin(),
        ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
        ...(command.contract === undefined ? {} : { contract: command.contract }),
      });
      return { kind: "akuma", action: "call", id: handle.id };
    }
    case "wait": return {
      kind: "akuma",
      action: "wait",
      status: await world.of({ id: command.id }).wait(undefined, command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
    };
    case "tell": {
      const handle = world.of({ id: command.id });
      const receipt = await handle.tell(input.readStdin());
      return { kind: "akuma", action: "tell", akuma: command.id, receipt, status: handle.status() };
    }
    case "interrupt": return {
      kind: "akuma",
      action: "interrupt",
      akuma: command.id,
      receipt: await world.of({ id: command.id }).interrupt(input.readStdin()),
    };
    case "history": {
      const handle = world.of({ id: command.id });
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
      receipt: await world.of({ id: command.id }).fork({ at: command.at }),
    };
    case "kill": return { kind: "akuma", action: "kill", id: command.id, evidence: await world.of({ id: command.id }).kill() };
  }
}

export function invokeAkumaStatus(path: string, id: string): AkumaInvocationResult {
  return { kind: "akuma", action: "status", status: Akuma.at({ path }).of({ id }).status() };
}
