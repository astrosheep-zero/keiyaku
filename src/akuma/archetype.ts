import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isMap, parseDocument } from "yaml";
import { z } from "zod";
import { boundedListLimit } from "../bounded-list.js";
import { KeiyakuError } from "../errors.js";
import { validateAkumaName } from "../identity/normalize.js";
import type { Settings } from "../settings.js";
import { providerOptionsSchema, providerRecipeSchema, type ProviderExecution } from "./provider-recipe.js";

export const akumaNameCatalogRowSchema = z
  .strictObject({ name: z.string(), model: z.string().exactOptional(), description: z.string().exactOptional() })
  .readonly();
export const akumaNameCatalogSchema = z
  .strictObject({
    kind: z.literal("akuma-name-catalogue"),
    rows: z.array(akumaNameCatalogRowSchema).nonempty().readonly().exactOptional(),
    more: z.literal(true).exactOptional(),
  })
  .readonly();

export type AkumaNameCatalogRow = z.output<typeof akumaNameCatalogRowSchema>;
export type AkumaNameCatalog = z.output<typeof akumaNameCatalogSchema>;

/** Omitted cwd means no project scope, never ambient discovery. */
export type AkumaNameCatalogInput = Readonly<{
  cwd?: string;
  home?: string;
  limit?: number;
}>;

export class AkumaNameError extends KeiyakuError {
  readonly kind = "akuma-name";
  constructor(
    readonly akumaName: string,
    readonly searched: readonly string[],
    readonly reason: string,
    readonly absent = false,
    cause?: unknown,
  ) {
    super(absent ? "invalid-input" : "internal", `\`${akumaName}\` ${reason}`, {
      ...(absent ? { next: { verb: "ls", input: { selector: "aku/" } } as const } : {}),
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

function diagnostic(error: unknown): string {
  if (!(error instanceof z.ZodError)) return error instanceof Error ? error.message : String(error);
  const issue = error.issues[0]!;
  if (issue.code === "unrecognized_keys") return `unknown field: ${[...issue.path, issue.keys[0]].join(".")}`;
  const reason = issue.code === "invalid_value" ? `must be one of ${issue.values.join(", ")}` : issue.message;
  return issue.path.length === 0 ? reason : `${issue.path.join(".")} ${reason}`;
}

function definitionError(
  name: string,
  searched: readonly string[],
  reason: string,
  chain: ReadonlySet<string>,
  options: { absent?: boolean; cause?: unknown } = {},
): AkumaNameError {
  return new AkumaNameError(
    name,
    searched,
    chain.size === 0 ? reason : `${reason} (base chain: ${[...chain, name].join(" -> ")})`,
    options.absent,
    options.cause,
  );
}

const nonblank = z
  .string({ error: "must be a nonblank string" })
  .refine((value) => value.trim() !== "", "must be a nonblank string");
const absolute = nonblank.refine(isAbsolute, "must be absolute").optional();
const catalogueInputSchema = z.strictObject({
  cwd: absolute,
  home: absolute,
  limit: z
    .unknown()
    .transform((value, context) => {
      try {
        return boundedListLimit(value);
      } catch (error) {
        context.addIssue({ code: "custom", message: diagnostic(error).replace(/^limit /u, "") });
        return z.NEVER;
      }
    })
    .optional(),
});

const { model, effort, network, systemPromptMode } = providerOptionsSchema.in.shape;
const frontmatterSchema = z.strictObject({
  base: z
    .string()
    .transform((value, context) => {
      try {
        return validateAkumaName(value);
      } catch (error) {
        context.addIssue({ code: "custom", message: diagnostic(error) });
        return z.NEVER;
      }
    })
    .optional(),
  provider: nonblank.optional(),
  model,
  effort,
  network,
  description: nonblank.optional(),
  hidden: z.boolean().optional(),
  systemPromptMode,
});

function decodeDefinition(markdown: string) {
  const lines = markdown.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") throw new Error("Akuma file must begin with YAML frontmatter");
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing < 0) throw new Error("Akuma frontmatter is not closed");
  const yaml = parseDocument(lines.slice(1, closing).join("\n"), { uniqueKeys: true });
  if (yaml.errors[0] !== undefined) throw yaml.errors[0];
  const mapping: unknown = yaml.toJS({ mapAsMap: true });
  if (!isMap(yaml.contents) || !(mapping instanceof Map)) throw new Error("Akuma frontmatter must be one mapping");
  if ([...mapping.keys()].some((key) => typeof key !== "string"))
    throw new Error("Akuma frontmatter keys must be text");
  const { base, provider, description, hidden, systemPromptMode, ...options } = frontmatterSchema.parse(
    Object.fromEntries(mapping),
  );
  const body = lines.slice(closing + 1).join("\n");
  if (body.length === 0 && systemPromptMode !== undefined)
    throw new Error("Akuma systemPromptMode requires a nonempty Markdown body");
  return {
    base,
    provider,
    description,
    hidden,
    options:
      body.length === 0 ? options : { ...options, systemPrompt: body, systemPromptMode: systemPromptMode ?? "append" },
  };
}

type Coordinates = Readonly<{ cwd?: string | undefined; home?: string | undefined }>;
type Scope = "project" | "home";
type Location = Readonly<{ path: string; source: Scope }>;
type CataloguePaths = Readonly<Record<Scope, ReadonlyMap<string, Location>>>;
type Definition = Readonly<{
  name: string;
  path: string;
  base: Definition | undefined;
  provider: string;
  description: string | undefined;
  hidden: boolean;
  options: z.input<typeof providerOptionsSchema>;
}>;

function definitionDirectories({ cwd, home }: Coordinates): readonly Location[] {
  const user = { path: join(home ?? join(homedir(), ".keiyaku"), "akumas"), source: "home" } as const;
  return cwd === undefined ? [user] : [{ path: join(cwd, ".keiyaku", "akumas"), source: "project" }, user];
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function cataloguePaths(directories: readonly Location[]): Promise<CataloguePaths> {
  const paths = { project: new Map<string, Location>(), home: new Map<string, Location>() };
  for (const { path, source } of [...directories].reverse()) {
    const entries = await readdir(path, { withFileTypes: true }).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      let name: string;
      try {
        name = validateAkumaName(entry.name.slice(0, -3));
      } catch {
        continue;
      }
      const file = { path: join(path, entry.name), source };
      if (source === "home") paths.home.set(name, file);
      paths.project.set(name, file);
    }
  }
  return paths;
}

function mergeDefinition(
  name: string,
  path: string,
  local: ReturnType<typeof decodeDefinition>,
  base: Definition | undefined,
): Definition {
  const provider = local.provider ?? base?.provider;
  if (provider === undefined) throw new Error("Akuma provider must be a nonblank string");
  return {
    name,
    path,
    base,
    provider,
    description: local.description ?? base?.description,
    hidden: local.hidden === true,
    options: { ...base?.options, ...local.options },
  };
}

function fileFailure(name: string, path: string, chain: ReadonlySet<string>, cause: unknown): AkumaNameError {
  if (cause instanceof AkumaNameError) return cause;
  const detail = diagnostic(cause);
  const prefix = cause instanceof z.ZodError && cause.issues[0]?.path.length ? "Akuma " : "";
  const reason =
    cause instanceof Error && "syscall" in cause ? `could not be read: ${detail}` : `is invalid: ${prefix}${detail}`;
  return definitionError(name, [path], reason, chain, { cause });
}

function definitionResolver(directories: readonly Location[], paths?: CataloguePaths) {
  const memo = { project: new Map<string, Definition>(), home: new Map<string, Definition>() };
  const decoded = new Map<string, ReturnType<typeof decodeDefinition>>();

  return async function resolve(
    name: string,
    scope: Scope = "project",
    chain: ReadonlySet<string> = new Set(),
  ): Promise<Definition> {
    const lookups = directories
      .filter(({ source }) => scope === "project" || source === "home")
      .map(({ path, source }) => ({ path: join(path, `${name}.md`), source }));
    if (chain.has(name))
      throw definitionError(
        name,
        lookups.map(({ path }) => path),
        "has a cyclic base reference",
        chain,
      );

    const cached = memo[scope].get(name);
    if (cached !== undefined) {
      // A cached Home suffix may repeat a project ancestor. Rewalk it to report the full chain.
      let base = chain.size === 0 ? undefined : cached.base;
      while (base !== undefined && !chain.has(base.name)) base = base.base;
      if (base === undefined) return cached;
    }

    const winner = paths?.[scope].get(name);
    let missing: unknown;
    for (const { path, source } of paths === undefined ? lookups : winner === undefined ? [] : [winner]) {
      try {
        let local = decoded.get(path);
        if (local === undefined) {
          local = decodeDefinition(await readFile(path, "utf8"));
          decoded.set(path, local);
        }
        const base =
          local.base === undefined ? undefined : await resolve(local.base, source, new Set([...chain, name]));
        const result = mergeDefinition(name, path, local, base);
        memo[scope].set(name, result);
        return result;
      } catch (cause) {
        if (isMissing(cause) && paths === undefined) {
          missing = cause;
          continue;
        }
        throw fileFailure(name, path, chain, cause);
      }
    }
    throw definitionError(
      name,
      lookups.map(({ path }) => path),
      "was not found",
      chain,
      { absent: true, cause: missing },
    );
  };
}

export async function listAkumaNameDefinitions(input: AkumaNameCatalogInput = {}): Promise<AkumaNameCatalog> {
  const parsed = catalogueInputSchema.safeParse(input);
  if (!parsed.success)
    throw new KeiyakuError("invalid-input", `Akuma catalogue ${diagnostic(parsed.error)}`, { cause: parsed.error });
  const directories = definitionDirectories(parsed.data);
  const paths = await cataloguePaths(directories);
  const resolve = definitionResolver(directories, paths);
  const names = [...paths.project.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const definitions: Definition[] = [];
  for (const name of names) definitions.push(await resolve(name));
  const visible = definitions
    .filter(({ hidden }) => !hidden)
    .map(({ name, description, options }) =>
      Object.freeze({
        name,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(description === undefined ? {} : { description }),
      }),
    );
  const { limit } = parsed.data;
  const rows = visible.slice(0, limit);
  return {
    kind: "akuma-name-catalogue",
    ...(rows.length === 0 ? {} : { rows }),
    ...(limit !== undefined && visible.length > limit ? { more: true as const } : {}),
  };
}

const configuredProviderSchema = z.strictObject({
  kind: z.unknown(),
  description: nonblank.optional(),
  executable: z.unknown().optional(),
  config: z.unknown().optional(),
  env: z.unknown().optional(),
});

const BUILTIN_EXECUTIONS = {
  claude: { kind: "claude-agent-sdk" },
  "codex-app-server": { kind: "codex-app-server" },
  "opencode-sdk": { kind: "opencode-sdk" },
  kimi: {
    kind: "acp",
    executable: "kimi",
    config: { argvBefore: ["acp"], argvAfter: [], modelConfigId: "model", effortConfigId: "thinking" },
  },
  paseo: { kind: "paseo" },
  pi: { kind: "pi" },
  "grok-build": {
    kind: "grok-build",
    executable: "grok",
  },
} as const satisfies Readonly<Record<string, Omit<ProviderExecution, "name">>>;

function providerExecution(settings: Settings, name: string): ProviderExecution {
  const view = settings.namespace("providers");
  if (view.kind === "failed")
    throw new KeiyakuError(
      "invalid-input",
      view.failures
        .map((failure) => {
          const scope = settings.scopes[failure.scope];
          return `${failure.scope}: ${failure.diagnostic ?? (scope.kind === "failed" ? scope.diagnostic : "providers unavailable")}`;
        })
        .join("; "),
    );
  const selected = view.entries?.[name]?.value;
  if (selected !== undefined) {
    const { description: _description, ...recipe } = configuredProviderSchema.parse(selected);
    return providerRecipeSchema.parse({ name, ...recipe });
  }
  if (!Object.hasOwn(BUILTIN_EXECUTIONS, name)) throw new Error(`unknown provider ${name}`);
  return providerRecipeSchema.parse({ name, ...BUILTIN_EXECUTIONS[name as keyof typeof BUILTIN_EXECUTIONS] });
}

/** Resolve one akumaName and decode its provider execution, leaving option admission to the caller. */
export async function loadPreparedArchetype(input: Readonly<{ name: string; settings: Settings }> & Coordinates) {
  const name = validateAkumaName(input.name);
  const resolve = definitionResolver(definitionDirectories(input));
  const { path, description, hidden, provider, options } = await resolve(name);
  try {
    return Object.freeze({
      name,
      path,
      ...(description === undefined ? {} : { description }),
      ...(hidden ? { hidden: true as const } : {}),
      provider: providerExecution(input.settings, provider),
      options: providerOptionsSchema.parse(options),
    });
  } catch (cause) {
    if (cause instanceof AkumaNameError) throw cause;
    throw definitionError(name, [path], `uses ${diagnostic(cause)}`, new Set(), { cause });
  }
}
