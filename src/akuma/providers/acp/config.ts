import { KeiyakuError } from "../../../errors.js";
import { z } from "zod";

/** One supplied native string, preserved byte-for-byte rather than normalized. */
const nonblank = z.string().refine((value) => value.trim() !== "", "must be a nonblank string");
const argv = z.array(nonblank);

const acpConfigSchema = z
  .strictObject({
    argvBefore: argv,
    argvAfter: argv,
    modelArg: nonblank.optional(),
    effortArg: nonblank.optional(),
    modelConfigId: nonblank.optional(),
    effortConfigId: nonblank.optional(),
    systemPromptArg: nonblank.optional(),
    systemPromptMode: z.enum(["append", "replace"], { error: "must be append or replace" }).optional(),
  })
  .superRefine((config, context) => {
    if (config.modelArg !== undefined && config.modelConfigId !== undefined)
      context.addIssue({ code: "custom", path: ["modelConfigId"], message: "conflicts with modelArg" });
    if (config.effortArg !== undefined && config.effortConfigId !== undefined)
      context.addIssue({ code: "custom", path: ["effortConfigId"], message: "conflicts with effortArg" });
    if (config.modelConfigId !== undefined && config.modelConfigId === config.effortConfigId)
      context.addIssue({ code: "custom", path: ["effortConfigId"], message: "must differ from modelConfigId" });
    if (config.systemPromptMode !== undefined && config.systemPromptArg === undefined)
      context.addIssue({ code: "custom", path: ["systemPromptMode"], message: "requires systemPromptArg" });
  })
  .transform((config) => {
    // An explicit undefined is absence, exactly as before this declaration: no invented own key.
    const members = config as Record<string, unknown>;
    for (const key of Object.keys(members)) if (members[key] === undefined) delete members[key];
    return Object.freeze({
      ...config,
      argvBefore: Object.freeze([...config.argvBefore]),
      argvAfter: Object.freeze([...config.argvAfter]),
    });
  });
export type AcpExecutionConfig = z.output<typeof acpConfigSchema>;

/** The one refused-configuration diagnostic: the schema's own issue, located. */
function admissionDiagnostic(error: z.ZodError): string {
  const [issue] = error.issues;
  if (issue === undefined) return "ACP provider config is invalid";
  const at = issue.path.join(".");
  return `ACP provider config ${at === "" ? issue.message : `${at} ${issue.message}`}`;
}

export function decodeAcpConfig(value: unknown): AcpExecutionConfig {
  const parsed = acpConfigSchema.safeParse(value);
  if (!parsed.success)
    throw new KeiyakuError("invalid-input", admissionDiagnostic(parsed.error), { cause: parsed.error });
  return parsed.data;
}
