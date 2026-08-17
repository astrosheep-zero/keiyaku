import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import type { Settings } from "../settings.js";
import { archetypeName } from "./identity.js";
import type { ProviderAdapter } from "./provider.js";
import {
  decodeProviderOptions,
  decodeProviderRecipe,
  type ProviderExecution,
  type ProviderOptions,
  type ReadonlyRestraint,
} from "./provider-recipe.js";
import { resolveProviderExecution } from "./providers/index.js";
import { effectiveAllowedActions, type AllowedActions } from "./allowed.js";

type DecodedArchetype = Readonly<{
  name: string;
  path: string;
  provider: string;
  description?: string;
  options: ProviderOptions;
  allowed: AllowedActions;
}>;

export type ArchetypeCatalogRow = Readonly<{
  name: string;
  model?: string;
  description?: string;
}>;

type ArchetypeDefinition = DecodedArchetype & Readonly<{ adapter: ProviderAdapter }>;
type AdmittedArchetype = Omit<ArchetypeDefinition, "provider"> & Readonly<{
  provider: ProviderExecution;
  readonly?: ReadonlyRestraint;
}>;

export class AkumaArchetypeError extends Error {
  readonly kind = "akuma-archetype";
  constructor(
    readonly archetype: string,
    readonly searched: readonly string[],
    readonly reason: string,
    guidance?: string,
  ) {
    super([`\`${archetype}\` ${reason}`, ...(guidance === undefined ? [] : [guidance])].join("\n"));
    this.name = "AkumaArchetypeError";
  }
}

function archetypeDirectory(home?: string): string {
  return join(home ?? join(homedir(), ".keiyaku"), "akuma");
}

async function archetypePaths(home?: string): Promise<readonly Readonly<{ name: string; path: string }>[]> {
  const directory = archetypeDirectory(home);
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .flatMap((entry) => {
        if (!entry.isFile() || !entry.name.endsWith(".md")) return [];
        const name = entry.name.slice(0, -3);
        try { return [{ name: archetypeName(name), path: join(directory, entry.name) }]; }
        catch { return []; }
      })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function listArchetypes(input: Readonly<{ home?: string }> = {}): Promise<readonly string[]> {
  return (await archetypePaths(input.home)).map(({ name }) => name);
}

function archetypeField(
  values: Readonly<Record<string, unknown>>,
  key: string,
  required = false,
): string | undefined {
  const value = values[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Akuma ${key} must be a nonblank string`);
  }
  return value;
}

function archetypeEnum<T extends string>(
  values: Readonly<Record<string, unknown>>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = archetypeField(values, key);
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) throw new TypeError(`Akuma ${key} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function archetypeReadonly(values: Readonly<Record<string, unknown>>): true | undefined {
  if (!("readonly" in values)) return undefined;
  if (values.readonly !== true) throw new TypeError("Akuma readonly must be true");
  return true;
}

function decodeArchetype(name: string, path: string, markdown: string): DecodedArchetype {
  const lines = markdown.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") throw new TypeError("Akuma configuration must begin with YAML frontmatter");
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing < 0) throw new TypeError("Akuma frontmatter is not closed");
  const document = parseDocument(lines.slice(1, closing).join("\n"), { uniqueKeys: true });
  if (document.errors.length > 0) throw new TypeError(`Akuma frontmatter is invalid: ${document.errors[0]!.message}`);
  const decoded = document.toJS() as unknown;
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TypeError("Akuma frontmatter must be one mapping");
  }
  const values = decoded as Readonly<Record<string, unknown>>;
  const provider = archetypeField(values, "provider", true)!;
  if ("access" in values) throw new TypeError("Akuma access is not supported; use readonly: true");
  const model = archetypeField(values, "model");
  const effort = archetypeField(values, "effort");
  const readonly = archetypeReadonly(values);
  const network = archetypeEnum(values, "network", ["disabled", "enabled"] as const);
  const description = archetypeField(values, "description");
  const allowed = effectiveAllowedActions(values.allowed);
  const systemPrompt = lines.slice(closing + 1).join("\n");
  return Object.freeze({
    name,
    path,
    provider,
    ...(description === undefined ? {} : { description }),
    options: decodeProviderOptions({
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(readonly === undefined ? {} : { readonly }),
      ...(network === undefined ? {} : { network }),
      ...(systemPrompt.length === 0 ? {} : { systemPrompt }),
    }),
    allowed,
  });
}

export async function listArchetypeDefinitions(
  input: Readonly<{ home?: string }> = {},
): Promise<readonly ArchetypeCatalogRow[]> {
  // Reads still run concurrently, but the reported failure is the first invalid
  // definition in catalog byte order, not whichever read happened to finish first.
  const settled = await Promise.allSettled((await archetypePaths(input.home)).map(async ({ name, path }) => {
    try {
      const definition = decodeArchetype(name, path, await readFile(path, "utf8"));
      return Object.freeze({
        name: definition.name,
        ...(definition.options.model === undefined ? {} : { model: definition.options.model }),
        ...(definition.description === undefined ? {} : { description: definition.description }),
      });
    } catch (error) {
      throw new AkumaArchetypeError(
        name,
        [path],
        `is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }));
  const firstInvalid = settled.find((result) => result.status === "rejected");
  if (firstInvalid !== undefined) throw firstInvalid.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<ArchetypeCatalogRow>).value);
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}

function optionalProviderText(value: Readonly<Record<string, unknown>>, name: string, field: "description"): string | undefined {
  const selected = value[field];
  if (selected === undefined) return undefined;
  if (typeof selected !== "string" || selected.trim().length === 0) {
    throw new TypeError(`provider ${name} ${field} must be a nonblank string`);
  }
  return selected;
}

function configuredProvider(name: string, selected: unknown): ProviderExecution {
  const value = record(selected);
  if (value === null) throw new TypeError(`provider ${name} must be an object`);
  const unknown = Object.keys(value).find((key) => !["kind", "description", "executable", "config", "env"].includes(key));
  if (unknown !== undefined) throw new TypeError(`provider ${name} has unknown field ${unknown}`);
  optionalProviderText(value, name, "description");
  return decodeProviderRecipe({
    name,
    kind: value.kind,
    ...(value.executable === undefined ? {} : { executable: value.executable }),
    ...(value.config === undefined ? {} : { config: value.config }),
    ...(value.env === undefined ? {} : { env: value.env }),
  });
}

const BUILTIN_EXECUTIONS = {
  claude: { kind: "claude-agent-sdk" },
  "codex-app-server": { kind: "codex-app-server" },
  "opencode-sdk": { kind: "opencode-sdk" },
  pi: { kind: "pi" },
  "grok-build": {
    kind: "grok-build",
    executable: "grok",
  },
} as const satisfies Readonly<Record<string, Omit<ProviderExecution, "name">>>;

function providerExecution(settings: Settings, name: string): ProviderExecution {
  const view = settings.namespace("providers");
  if (view.kind === "failed") throw new TypeError(view.failures.map((failure) => `${failure.scope}: ${failure.diagnostic}`).join("; "));
  const selected = view.entries.find((entry) => entry.name === name)?.value;
  if (selected !== undefined) return configuredProvider(name, selected);
  const builtin = BUILTIN_EXECUTIONS[name as keyof typeof BUILTIN_EXECUTIONS];
  if (builtin !== undefined) return decodeProviderRecipe({ name, ...builtin });
  throw new TypeError(`unknown provider ${name}`);
}

function admitArchetype(archetype: DecodedArchetype, settings: Settings): AdmittedArchetype {
  let selected: ReturnType<typeof resolveProviderExecution>;
  try { selected = resolveProviderExecution(providerExecution(settings, archetype.provider)); }
  catch (error) {
    if (error instanceof TypeError) throw new AkumaArchetypeError(archetype.name, [archetype.path], `uses ${error.message}`);
    throw error;
  }
  const execution = selected.execution;
  const adapter = selected.adapter;
  const admission = adapter.admitOptions(archetype.options);
  if (admission.kind === "refused") {
    throw new AkumaArchetypeError(archetype.name, [archetype.path], `is unsupported: ${admission.diagnostic}`);
  }
  return Object.freeze({
    ...archetype,
    provider: execution,
    adapter,
    options: admission.options,
    ...(admission.readonly === undefined ? {} : { readonly: admission.readonly }),
  });
}

export async function loadArchetype(
  input: Readonly<{ name: string; home?: string; settings: Settings }>,
): Promise<AdmittedArchetype> {
  const name = archetypeName(input.name);
  const directory = archetypeDirectory(input.home);
  const path = join(directory, `${name}.md`);
  const missing = () => new AkumaArchetypeError(
    name,
    [path],
    "was not found",
    "use `keiyaku ls aku/` to list available Akuma",
  );
  let markdown: string;
  try {
    markdown = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw missing();
    throw new AkumaArchetypeError(name, [path], `could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return admitArchetype(decodeArchetype(name, path, markdown), input.settings);
  } catch (error) {
    if (error instanceof AkumaArchetypeError) throw error;
    throw new AkumaArchetypeError(name, [path], `is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}
