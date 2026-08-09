import {
  Akuma,
  type AgentEvent,
  type AkumaStatus,
  type ForkReceipt,
  type InterruptReceipt,
  type KillEvidence,
  type TellReceipt,
  type TurnFact,
} from "../../akuma/index.js";
import type { ParsedAkumaCommand } from "./akuma.js";

export type AkumaInvocationResult =
  | Readonly<{ kind: "akuma"; action: "call"; id: string }>
  | Readonly<{ kind: "akuma"; action: "status"; status: AkumaStatus }>
  | Readonly<{ kind: "akuma"; action: "follow"; id: string; events: readonly AgentEvent[] }>
  | Readonly<{ kind: "akuma"; action: "wait"; status: AkumaStatus }>
  | Readonly<{ kind: "akuma"; action: "tell"; akuma: string; receipt: TellReceipt; status: AkumaStatus }>
  | Readonly<{ kind: "akuma"; action: "interrupt"; akuma: string; receipt: InterruptReceipt }>
  | Readonly<{ kind: "akuma"; action: "history"; akuma: string; turns: readonly TurnFact[] }>
  | Readonly<{ kind: "akuma"; action: "fork"; akuma: string; receipt: ForkReceipt }>
  | Readonly<{ kind: "akuma"; action: "kill"; id: string; evidence: KillEvidence }>;

export async function invokeAkuma(
  command: ParsedAkumaCommand,
  input: Readonly<{ path: string; readStdin(): string }>,
): Promise<AkumaInvocationResult> {
  const world = Akuma.at({ path: input.path });
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
    case "follow": {
      const events: AgentEvent[] = [];
      for await (const event of world.of({ id: command.id }).follow()) events.push(event);
      return { kind: "akuma", action: "follow", id: command.id, events };
    }
    case "wait": return {
      kind: "akuma",
      action: "wait",
      status: await world.of({ id: command.id }).wait(undefined, command.deadline === undefined ? {} : { deadline: command.deadline }),
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
    case "history": return {
      kind: "akuma",
      action: "history",
      akuma: command.id,
      turns: world.of({ id: command.id }).history(),
    };
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
