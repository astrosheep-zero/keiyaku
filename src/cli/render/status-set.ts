import type { InvocationResult } from "../result.js";
import { renderAkumaText } from "./akuma.js";
import { renderKanshiText } from "./kanshi.js";
import type { TextRenderContext } from "./terminal.js";

export function renderStatusSetText(
  result: Extract<InvocationResult, { kind: "status-set" }>,
  context?: TextRenderContext,
): string {
  if (result.entries.length === 0) return "status  none";
  return result.entries
    .map((entry) => {
      const body =
        entry.kind === "contract"
          ? renderKanshiText(entry.report, context, "contract")
          : renderAkumaText(
              { command: "status", contract: entry.selector, akuma: true, output: "text" },
              {
                kind: "akuma",
                action: "status",
                status: entry.status,
                ...(entry.alias === undefined ? {} : { alias: entry.alias }),
              },
              context,
            );
      return [`status  ${entry.selector}`, body].join("\n");
    })
    .join("\n\n");
}
