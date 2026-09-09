import type { ExecutionEvent } from "../../library/execution.js";
import { renderOpaqueBlock, safeText, type TextRenderContext } from "./terminal.js";

const LIVE_OUTPUT_BYTES = 4 * 1024;

function boundedUtf8Prefix(value: string): Readonly<{ text: string; truncated: boolean }> {
  let bytes = 0;
  let text = "";
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > LIVE_OUTPUT_BYTES) return { text, truncated: true };
    bytes += size;
    text += character;
  }
  return { text, truncated: false };
}

function phaseCoordinates(
  observation: Extract<ExecutionEvent, { kind: "verification" }>["observation"],
): readonly string[] {
  return [
    ...(observation.cwd === undefined ? [] : [`cwd=${safeText(observation.cwd)}`]),
    ...(observation.source === undefined ? [] : [`source=${safeText(observation.source)}`]),
    ...(observation.name === undefined ? [] : [`hook=${safeText(observation.name)}`]),
    ...(observation.index === undefined ? [] : [`declaration=${observation.index}/${observation.total ?? "?"}`]),
  ];
}

function renderVerification(
  event: Extract<ExecutionEvent, { kind: "verification" }>,
  context: TextRenderContext,
): readonly string[] {
  const observation = event.observation;
  const coordinates = phaseCoordinates(observation);
  if (observation.kind === "output") {
    const output = boundedUtf8Prefix(observation.text);
    return [
      `• verification ${observation.phase} ${observation.stream}${coordinates.length === 0 ? "" : `  ${coordinates.join(" ")}`}`,
      ...renderOpaqueBlock(output.text, "  ", context.columns),
      ...(output.truncated ? [`  [live output truncated at ${LIVE_OUTPUT_BYTES} bytes]`] : []),
    ];
  }
  const details = [
    ...coordinates,
    ...(observation.outcome === undefined ? [] : [`outcome=${safeText(observation.outcome)}`]),
    ...(observation.elapsedMs === undefined ? [] : [`elapsed=${Math.round(observation.elapsedMs)}ms`]),
  ];
  return [
    `• verification ${observation.phase} ${observation.state}${details.length === 0 ? "" : `  ${details.join(" ")}`}`,
  ];
}

/** Render one witnessed execution event for the CLI's ephemeral stderr stream. */
export function executionProgressLines(event: ExecutionEvent, context: TextRenderContext): readonly string[] {
  switch (event.kind) {
    case "admitted":
      return [`• admitted ${event.fact.kind}  ${event.contractId}`];
    case "verification":
      return renderVerification(event, context);
    case "stage":
      return [`• ${event.stage} ${event.state}  ${event.contractId}`];
    case "progress-dropped":
      return [`• progress dropped ${event.count} event${event.count === 1 ? "" : "s"}`];
  }
}
