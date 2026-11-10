import type { WhoamiFacts } from "../../library/keiyaku-identity.js";
import { panelHead } from "./akuma-activity.js";
import { safeText } from "./terminal.js";

function callerText(caller: NonNullable<WhoamiFacts["birthCaller"]>): string {
  if (caller.kind === "unknown") return "unknown";
  return caller.kind === "akuma" ? `${caller.akumaId} · world ${caller.world}` : caller.id;
}

function selfHead(facts: WhoamiFacts): string[] {
  const self = facts.self;
  if (self.kind === "akuma") {
    const aliases = facts.aliases ?? [];
    const identity = `${self.akumaId}${aliases.length ? ` (${aliases.join(" · ")})` : ""}`;
    return panelHead(
      identity,
      undefined,
      facts.dispatchContract === undefined ? undefined : { kind: "associated", contractId: facts.dispatchContract },
      facts.workdir === undefined ? [] : [facts.workdir],
    ).map(safeText);
  }
  const value =
    self.kind === "none" ? "none" : self.kind === "invalid" ? `invalid · ${self.diagnostic}` : callerText(self);
  return [safeText(`${value} (not an akuma)`)];
}

function contextText(contract: WhoamiFacts["contextContract"]): string {
  if (contract === undefined) return "none";
  if (typeof contract === "string") return contract;
  return contract.kind === "unavailable" ? `unavailable · ${contract.diagnostic}` : contract.kind;
}

export function renderWhoami(facts: WhoamiFacts): string {
  const row = (label: string, value: string): string => `  ${label.padEnd(11)} ${safeText(value)}`;
  const self = facts.self;
  const lines = selfHead(facts);
  if (self.kind === "akuma") {
    const initiator = facts.initiator;
    lines.push(
      row("initiator", typeof initiator === "object" ? `unavailable · ${initiator.diagnostic}` : (initiator ?? "none")),
    );
    if (facts.birthCaller !== undefined) lines.push(row("parent", callerText(facts.birthCaller)));
  }
  lines.push(row("world", facts.world ?? (self.kind === "akuma" ? self.world : "none")));
  const context = contextText(facts.contextContract);
  if (context !== facts.dispatchContract) lines.push(row("context", context));
  if (self.kind === "akuma") {
    if (facts.profileUnavailable !== undefined) lines.push(row("profile", `unavailable · ${facts.profileUnavailable}`));
    else lines.push(row("runtime", `${facts.provider ?? "unknown"} · ${facts.model ?? "unknown"}`));
  }
  return lines.join("\n");
}
