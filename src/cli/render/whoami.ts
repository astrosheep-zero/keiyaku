import type { AkumaCaller, AkumaOrigin, ContractId } from "../../index.js";
import type { WhoamiFacts } from "../commands/whoami.js";
import { panelHead } from "./akuma-activity.js";
import { safeText } from "./terminal.js";

function callerText(caller: AkumaCaller | Readonly<{ kind: "unknown" }>): string {
  if (caller.kind === "unknown") return "unknown";
  return caller.kind === "akuma" ? `${caller.akuId} · world ${caller.world}` : `${caller.integration}:${caller.id}`;
}

function originText(origin: Exclude<AkumaOrigin, { kind: "direct" }>): string {
  return origin.kind === "request"
    ? `request · ${origin.parent} · ${origin.requestId}`
    : `fork · ${origin.parent} · ${origin.at}`;
}

function selfHead(facts: WhoamiFacts, dispatch: ContractId | undefined, workdir: string | null | undefined): string[] {
  const self = facts.self;
  if (self.kind === "akuma") {
    const aliases = facts.profile?.kind === "available" ? facts.profile.aliases : [];
    const identity = `${self.akuId}${aliases.length ? ` (${aliases.join(" · ")})` : ""}`;
    return panelHead(
      identity,
      undefined,
      dispatch === undefined ? undefined : { kind: "associated", contractId: dispatch },
      workdir == null ? [] : [workdir],
    ).map(safeText);
  }
  const value = self.kind === "none" ? "none" : self.kind === "invalid" ? `invalid · ${self.reason}` : callerText(self);
  return [safeText(`${value} (not an akuma)`)];
}

function contextText(contract: WhoamiFacts["contract"]): string {
  if (contract.kind === "resolved") return contract.id;
  if (contract.kind === "unavailable") return `unavailable · ${contract.reason}`;
  return contract.kind;
}

export function renderWhoami(facts: WhoamiFacts): string {
  const row = (label: string, value: string): string => `  ${label.padEnd(11)} ${safeText(value)}`;
  const self = facts.self;
  const profile = self.kind === "akuma" && facts.profile?.kind === "available" ? facts.profile : undefined;
  const dispatch = profile?.contracts.length === 1 ? profile.contracts[0] : undefined;
  const lines = selfHead(facts, dispatch, profile?.workdir);
  if (self.kind === "akuma") {
    lines.push(
      row(
        "initiator",
        facts.initiatorUnavailable === undefined
          ? (facts.initiator ?? "none")
          : `unavailable · ${facts.initiatorUnavailable}`,
      ),
    );
    if (profile !== undefined) lines.push(row("parent", callerText(profile.birth.caller)));
  }
  lines.push(row("world", facts.world ?? "none"));
  const context = contextText(facts.contract);
  if (context !== dispatch) lines.push(row("context", context));
  lines.push(row("requests", facts.requests));
  if (self.kind === "akuma" && facts.profile?.kind === "unavailable")
    lines.push(row("profile", `unavailable · ${facts.profile.reason}`));
  if (profile !== undefined) {
    lines.push(row("runtime", `${profile.provider ?? "unknown"} · ${profile.model ?? "unknown"}`));
    if (profile.birth.origin.kind !== "direct") lines.push(row("origin", originText(profile.birth.origin)));
  }
  return lines.join("\n");
}
