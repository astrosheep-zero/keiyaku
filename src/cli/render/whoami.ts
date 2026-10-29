import type { AkumaCaller, AkumaOrigin } from "../../index.js";
import type { WhoamiFacts } from "../commands/whoami.js";
import { safeText } from "./terminal.js";

function callerText(caller: AkumaCaller | Readonly<{ kind: "unknown" }>): string {
  if (caller.kind === "unknown") return "unknown";
  return caller.kind === "akuma" ? `${caller.akuId} · world ${caller.world}` : `${caller.integration}:${caller.id}`;
}

function originText(origin: AkumaOrigin): string {
  switch (origin.kind) {
    case "direct":
      return "direct";
    case "request":
      return `request · ${origin.parent} · ${origin.requestId}`;
    case "fork":
      return `fork · ${origin.parent} · ${origin.at}`;
  }
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(" · ");
}

function selfText(facts: WhoamiFacts): string {
  const self = facts.self;
  if (self.kind === "akuma") {
    const aliases = facts.profile?.kind === "available" ? facts.profile.aliases : [];
    return `${self.akuId}${aliases.length ? ` (${aliases.join(" · ")})` : ""}`;
  }
  const value = self.kind === "none" ? "none" : self.kind === "invalid" ? `invalid · ${self.reason}` : callerText(self);
  return `${value} (not an akuma)`;
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
  const lines = [safeText(selfText(facts))];
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
  if (profile !== undefined) lines.push(row("workdir", profile.workdir ?? "unknown"));
  lines.push(row("context", contextText(facts.contract)));
  if (profile !== undefined) lines.push(row("dispatch", list(profile.contracts)));
  lines.push(row("requests", facts.requests));
  if (self.kind === "akuma" && facts.profile?.kind === "unavailable")
    lines.push(row("profile", `unavailable · ${facts.profile.reason}`));
  if (profile !== undefined) {
    lines.push(
      row("archetype", profile.archetype),
      row("provider", profile.provider ?? "unknown"),
      row("model", profile.model ?? "unknown"),
      row("origin", originText(profile.birth.origin)),
      row("born", profile.bornAt ?? "unknown"),
      row("allowed", list(profile.allowed)),
    );
  }
  return lines.join("\n");
}
