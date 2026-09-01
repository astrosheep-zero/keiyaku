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

type LocalArchetype = Readonly<{
  name: string;
  path: string;
  base?: string;
  provider?: string;
  description?: string;
  options: ProviderOptions;
  readonly?: true;
  allowed?: AllowedActions;
  allowedPresent: boolean;
}>;

type DecodedArchetype = Readonly<{
  name: string;
  path: string;
  provider: string;
  description?: string;
  options: ProviderOptions;
  readonly?: true;
  allowed: AllowedActions;
}>;

export type ArchetypeCatalogRow = Readonly<{
  name: string;
  model?: string;
  description?: string;
}>;

type ArchetypeDefinition = DecodedArchetype & Readonly<{ adapter: ProviderAdapter }>;
type AdmittedArchetype = Omit<ArchetypeDefinition, "provider" | "readonly"> &
  Readonly<{
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

type ArchetypeCoordinates = Readonly<{ project?: string; home?: string }>;

function projectArchetypeDirectory(project?: string): string | undefined {
  return project === undefined ? undefined : join(project, ".keiyaku", "akuma");
}

function homeArchetypeDirectory(home?: string): string {
  return join(home ?? join(homedir(), ".keiyaku"), "akuma");
}

function archetypeDirectories(input: ArchetypeCoordinates): readonly string[] {
  return [projectArchetypeDirectory(input.project), homeArchetypeDirectory(input.home)].filter(
    (directory): directory is string => directory !== undefined,
  );
}

async function pathsInDirectory(directory: string): Promise<readonly Readonly<{ name: string; path: string }>[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .flatMap((entry) => {
        if (!entry.isFile() || !entry.name.endsWith(".md")) return [];
        const name = entry.name.slice(0, -3);
        try {
          return [{ name: archetypeName(name), path: join(directory, entry.name) }];
        } catch {
          return [];
        }
      })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function archetypePaths(
  input: ArchetypeCoordinates = {},
): Promise<readonly Readonly<{ name: string; path: string }>[]> {
  const scopes = await Promise.all(archetypeDirectories(input).map(pathsInDirectory));
  const selected = new Map<string, Readonly<{ name: string; path: string }>>();
  for (const scope of scopes) {
    for (const entry of scope) if (!selected.has(entry.name)) selected.set(entry.name, entry);
  }
  return [...selected.values()].sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
}

type ArchetypeSource = "project" | "home";
type ArchetypeLookup = Readonly<{ path: string; source: ArchetypeSource }>;

function sourceLookups(name: string, input: ArchetypeCoordinates, source: ArchetypeSource): readonly ArchetypeLookup[] {
  if (source === "home" || input.project === undefined) {
    return [{ path: join(homeArchetypeDirectory(input.home), `${name}.md`), source: "home" }];
  }
  return [
    { path: join(projectArchetypeDirectory(input.project)!, `${name}.md`), source: "project" },
    { path: join(homeArchetypeDirectory(input.home), `${name}.md`), source: "home" },
  ];
}

function rootLookups(name: string, input: ArchetypeCoordinates): readonly ArchetypeLookup[] {
  return input.project === undefined ? sourceLookups(name, input, "home") : sourceLookups(name, input, "project");
}

function chainText(chain: readonly string[]): string {
  return chain.join(" -> ");
}

function archetypeError(
  name: string,
  searched: readonly string[],
  reason: string,
  chain: readonly string[],
  guidance?: string,
): AkumaArchetypeError {
  const withChain = chain.length === 0 ? reason : `${reason} (base chain: ${chainText(chain)})`;
  return new AkumaArchetypeError(name, searched, withChain, guidance);
}

export async function listArchetypes(input: ArchetypeCoordinates = {}): Promise<readonly string[]> {
  return (await archetypePaths(input)).map(({ name }) => name);
}

function archetypeField(values: Readonly<Record<string, unknown>>, key: string, required = false): string | undefined {
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

function decodeArchetype(name: string, path: string, markdown: string): LocalArchetype {
  const lines = markdown.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") throw new TypeError("Akuma file must begin with YAML frontmatter");
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing < 0) throw new TypeError("Akuma frontmatter is not closed");
  const document = parseDocument(lines.slice(1, closing).join("\n"), { uniqueKeys: true });
  if (document.errors.length > 0) throw new TypeError(`Akuma frontmatter is invalid: ${document.errors[0]!.message}`);
  const decoded = document.toJS() as unknown;
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TypeError("Akuma frontmatter must be one mapping");
  }
  const values = decoded as Readonly<Record<string, unknown>>;
  const provider = archetypeField(values, "provider");
  const baseValue = archetypeField(values, "base");
  const base = baseValue === undefined ? undefined : archetypeName(baseValue);
  if ("access" in values) throw new TypeError("Akuma access is not supported; use readonly: true");
  const model = archetypeField(values, "model");
  const effort = archetypeField(values, "effort");
  const readonly = archetypeReadonly(values);
  const network = archetypeEnum(values, "network", ["disabled", "enabled"] as const);
  const description = archetypeField(values, "description");
  const allowedPresent = "allowed" in values;
  const allowed = allowedPresent ? effectiveAllowedActions(values.allowed) : undefined;
  const systemPromptMode = archetypeEnum(values, "systemPromptMode", ["append", "replace"] as const);
  const systemPrompt = lines.slice(closing + 1).join("\n");
  if (systemPromptMode !== undefined && systemPrompt.length === 0) {
    throw new TypeError("Akuma systemPromptMode requires a nonempty Markdown body");
  }
  return Object.freeze({
    name,
    path,
    ...(base === undefined ? {} : { base }),
    ...(provider === undefined ? {} : { provider }),
    ...(description === undefined ? {} : { description }),
    options: decodeProviderOptions({
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(network === undefined ? {} : { network }),
      ...(systemPrompt.length === 0
        ? {}
        : {
            systemPrompt,
            systemPromptMode: systemPromptMode ?? "append",
          }),
    }),
    ...(readonly === undefined ? {} : { readonly }),
    ...(allowed === undefined ? {} : { allowed }),
    allowedPresent,
  });
}

function mergeArchetype(base: DecodedArchetype | undefined, local: LocalArchetype): DecodedArchetype {
  const provider = local.provider ?? base?.provider;
  if (provider === undefined) throw new TypeError("Akuma provider must be a nonblank string");
  const options = decodeProviderOptions({ ...(base?.options ?? {}), ...local.options });
  const allowed = local.allowedPresent ? local.allowed! : (base?.allowed ?? effectiveAllowedActions(undefined));
  return Object.freeze({
    name: local.name,
    path: local.path,
    provider,
    ...(local.description === undefined
      ? base?.description === undefined
        ? {}
        : { description: base.description }
      : { description: local.description }),
    options,
    ...(local.readonly === true || base?.readonly === true ? { readonly: true as const } : {}),
    allowed,
  });
}

async function resolveArchetype(
  name: string,
  input: ArchetypeCoordinates,
  source: ArchetypeSource | undefined,
  chain: readonly string[] = [],
): Promise<DecodedArchetype> {
  if (chain.includes(name)) {
    const lookups = source === undefined ? rootLookups(name, input) : sourceLookups(name, input, source);
    throw archetypeError(
      name,
      lookups.map(({ path }) => path),
      "has a cyclic base reference",
      [...chain, name],
    );
  }
  const lookups = source === undefined ? rootLookups(name, input) : sourceLookups(name, input, source);
  const searched = lookups.map(({ path }) => path);
  for (const lookup of lookups) {
    let markdown: string;
    try {
      markdown = await readFile(lookup.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw archetypeError(
        name,
        [lookup.path],
        `could not be read: ${error instanceof Error ? error.message : String(error)}`,
        chain,
      );
    }
    let local: LocalArchetype;
    try {
      local = decodeArchetype(name, lookup.path, markdown);
    } catch (error) {
      throw archetypeError(
        name,
        [lookup.path],
        `is invalid: ${error instanceof Error ? error.message : String(error)}`,
        chain,
      );
    }
    let inherited: DecodedArchetype | undefined;
    if (local.base !== undefined) {
      inherited = await resolveArchetype(local.base, input, lookup.source, [...chain, name]);
    }
    try {
      return mergeArchetype(inherited, local);
    } catch (error) {
      throw archetypeError(
        name,
        [lookup.path],
        `is invalid: ${error instanceof Error ? error.message : String(error)}`,
        chain,
      );
    }
  }
  const missingChain = chain.length === 0 ? chain : [...chain, name];
  throw archetypeError(
    name,
    searched,
    "was not found",
    missingChain,
    chain.length === 0 ? "use `keiyaku ls aku/` to list available Akuma" : undefined,
  );
}

export async function listArchetypeDefinitions(
  input: ArchetypeCoordinates = {},
): Promise<readonly ArchetypeCatalogRow[]> {
  // Reads still run concurrently, but the reported failure is the first invalid
  // definition in catalog byte order, not whichever read happened to finish first.
  const settled = await Promise.allSettled(
    (await archetypePaths(input)).map(async ({ name, path }) => {
      try {
        const definition = await resolveArchetype(name, input, undefined);
        return Object.freeze({
          name: definition.name,
          ...(definition.options.model === undefined ? {} : { model: definition.options.model }),
          ...(definition.description === undefined ? {} : { description: definition.description }),
        });
      } catch (error) {
        if (error instanceof AkumaArchetypeError) throw error;
        throw new AkumaArchetypeError(
          name,
          [path],
          `is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );
  const firstInvalid = settled.find((result) => result.status === "rejected");
  if (firstInvalid !== undefined) throw firstInvalid.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<ArchetypeCatalogRow>).value);
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function optionalProviderText(
  value: Readonly<Record<string, unknown>>,
  name: string,
  field: "description",
): string | undefined {
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
  const unknown = Object.keys(value).find(
    (key) => !["kind", "description", "executable", "config", "env"].includes(key),
  );
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
  if (view.kind === "failed")
    throw new TypeError(view.failures.map((failure) => `${failure.scope}: ${failure.diagnostic}`).join("; "));
  const selected = view.entries.find((entry) => entry.name === name)?.value;
  if (selected !== undefined) return configuredProvider(name, selected);
  const builtin = BUILTIN_EXECUTIONS[name as keyof typeof BUILTIN_EXECUTIONS];
  if (builtin !== undefined) return decodeProviderRecipe({ name, ...builtin });
  throw new TypeError(`unknown provider ${name}`);
}

async function admitArchetype(
  archetype: DecodedArchetype,
  settings: Settings,
  callReadonly: true | undefined,
): Promise<AdmittedArchetype> {
  let selected: Awaited<ReturnType<typeof resolveProviderExecution>>;
  try {
    selected = await resolveProviderExecution(providerExecution(settings, archetype.provider));
  } catch (error) {
    if (error instanceof TypeError)
      throw new AkumaArchetypeError(archetype.name, [archetype.path], `uses ${error.message}`);
    throw error;
  }
  const execution = selected.execution;
  const adapter = selected.adapter;
  const effectiveReadonly = archetype.readonly === true || callReadonly === true;
  const admission = adapter.admitOptions({
    ...archetype.options,
    ...(effectiveReadonly ? { readonly: true } : {}),
  });
  if (admission.kind === "refused") {
    throw new AkumaArchetypeError(archetype.name, [archetype.path], `is unsupported: ${admission.diagnostic}`);
  }
  const { readonly: _readonly, ...definition } = archetype;
  return Object.freeze({
    ...definition,
    provider: execution,
    adapter,
    options: admission.options,
    ...(admission.readonly === undefined ? {} : { readonly: admission.readonly }),
  });
}

export async function loadArchetype(
  input: Readonly<{ name: string; project?: string; home?: string; settings: Settings; readonly?: true }>,
): Promise<AdmittedArchetype> {
  const name = archetypeName(input.name);
  const definition = await resolveArchetype(name, input, undefined);
  return await admitArchetype(definition, input.settings, input.readonly);
}
