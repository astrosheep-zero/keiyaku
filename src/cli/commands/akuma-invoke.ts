import {
  Akuma,
  type AgentEvent,
  type AkumaList,
  type AkumaStatus,
  type ForkReceipt,
  type InterruptReceipt,
  type KillEvidence,
  type TellReceipt,
} from "../../akuma/index.js";
import type { ParsedAkumaCommand } from "./akuma.js";

export type AkumaInvocationResult =
  | Readonly<{ kind: "akuma"; action: "call"; id: string }>
  | Readonly<{ kind: "akuma"; action: "list"; report: AkumaList }>
  | Readonly<{ kind: "akuma"; action: "status"; status: AkumaStatus }>
  | Readonly<{ kind: "akuma"; action: "follow"; id: string; events: readonly AgentEvent[] }>
  | Readonly<{ kind: "akuma"; action: "wait"; status: AkumaStatus }>
  | Readonly<{ kind: "akuma"; action: "tell"; akuma: string; receipt: TellReceipt }>
  | Readonly<{ kind: "akuma"; action: "interrupt"; akuma: string; receipt: InterruptReceipt }>
  | Readonly<{ kind: "akuma"; action: "fork"; akuma: string; receipt: ForkReceipt }>
  | Readonly<{ kind: "akuma"; action: "kill"; id: string; evidence: KillEvidence }>;

export async function invokeAkuma(
  command: ParsedAkumaCommand,
  input: Readonly<{ path: string; readStdin(): string }>,
): Promise<AkumaInvocationResult> {
  const world = Akuma.at({ path: input.path });
  switch (command.action) {
    case "call": {
      const handle = await world.call({ persona: command.persona, body: input.readStdin(), ...(command.cwd === undefined ? {} : { cwd: command.cwd }) });
      return { kind: "akuma", action: "call", id: handle.id };
    }
    case "list": return { kind: "akuma", action: "list", report: world.list() };
    case "status": return { kind: "akuma", action: "status", status: world.of({ id: command.id }).status() };
    case "follow": {
      const events: AgentEvent[] = [];
      for await (const event of world.of({ id: command.id }).follow()) events.push(event);
      return { kind: "akuma", action: "follow", id: command.id, events };
    }
    case "wait": return { kind: "akuma", action: "wait", status: await world.of({ id: command.id }).wait() };
    case "tell": return {
      kind: "akuma",
      action: "tell",
      akuma: command.id,
      receipt: await world.of({ id: command.id }).tell(input.readStdin()),
    };
    case "interrupt": return {
      kind: "akuma",
      action: "interrupt",
      akuma: command.id,
      receipt: await world.of({ id: command.id }).interrupt(input.readStdin()),
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
