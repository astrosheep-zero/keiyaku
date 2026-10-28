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

export function renderWhoami(facts: WhoamiFacts): string {
  const row = (label: string, value: string, indent = ""): string => `${indent}${label.padEnd(11)} ${safeText(value)}`;
  const caller = facts.caller;
  const callerValue =
    caller.kind === "none" ? "none" : caller.kind === "invalid" ? `invalid · ${caller.reason}` : callerText(caller);
  const lines = [row("world", facts.world ?? "none"), row("caller", callerValue)];
  if (facts.profile?.kind === "unavailable") lines.push(row("profile", `unavailable · ${facts.profile.reason}`, "  "));
  if (facts.profile?.kind === "available") {
    const profile = facts.profile;
    lines.push(
      row("archetype", profile.archetype, "  "),
      row("aliases", list(profile.aliases), "  "),
      row("provider", profile.provider ?? "unknown", "  "),
      row("model", profile.model ?? "unknown", "  "),
      row("workdir", profile.workdir ?? "unknown", "  "),
      row("origin", originText(profile.birth.origin), "  "),
      row("parent", callerText(profile.birth.caller), "  "),
      row("born", profile.bornAt ?? "unknown", "  "),
      row("allowed", list(profile.allowed), "  "),
      row("contracts", list(profile.contracts), "  "),
    );
  }
  const contract = facts.contract;
  lines.push(
    row("initiator", facts.initiator === null ? "none" : `${facts.initiator.name} · ${facts.initiator.source}`),
    row("requests", facts.requests),
    row(
      "contract",
      contract.kind === "resolved"
        ? contract.id
        : contract.kind === "unavailable"
          ? `unavailable · ${contract.reason}`
          : contract.kind,
    ),
  );
  return lines.join("\n");
}
