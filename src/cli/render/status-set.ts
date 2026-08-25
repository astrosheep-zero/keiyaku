import type { InvocationResult } from "../result.js";
import { renderAkumaText } from "./akuma.js";
import { renderKanshiText } from "./kanshi.js";
import type { TextRenderContext } from "./terminal.js";

export function renderStatusSetText(
  result: Extract<InvocationResult, { kind: "status-set" }>,
  context?: TextRenderContext,
): string {
  return result.entries
    .map((entry) =>
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
          ),
    )
    .join("\n\n");
}
