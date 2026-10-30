import { LineRpcProcess } from "../../../runtime/proc/line-rpc.js";
import { createProviderAttempt } from "../../provider.js";
import { decodeProviderRecipe, type ProviderExecution } from "../../provider-recipe.js";
import { akumaExecutionEnvironment } from "../execution-environment.js";
import { codexObject } from "./events.js";

export async function initializeCodex(server: LineRpcProcess): Promise<void> {
  await server.request("initialize", {
    clientInfo: { name: "keiyaku", title: "keiyaku", version: "4" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  server.notify("initialized");
}

/** Native config precedence belongs to Codex, including profiles and dotted overrides. */
export async function withCodexWritableDirectories(
  execution: ProviderExecution,
  cwd: string,
  directories: readonly string[],
  signal?: AbortSignal,
): Promise<ProviderExecution> {
  const attempt = createProviderAttempt(signal, async (custody) => {
    custody.signal.throwIfAborted();
    const server = new LineRpcProcess({
      argv: [execution.executable ?? "codex", "app-server", "--listen", "stdio://"],
      cwd,
      env: akumaExecutionEnvironment(process.env, execution.env),
    });
    const closed = new Promise<void>((resolve) => server.onExit(() => resolve()));
    custody.own({ closed, forceDispose: () => server.close(true) });
    try {
      custody.signal.throwIfAborted();
      await initializeCodex(server);
      const response = codexObject(
        await server.request("thread/start", {
          cwd,
          ephemeral: true,
          ...(execution.config === undefined ? {} : { config: execution.config }),
        }),
      );
      custody.signal.throwIfAborted();
      const sandbox = codexObject(response?.sandbox);
      if (sandbox?.type !== "workspaceWrite" || response?.activePermissionProfile != null)
        throw new TypeError("writableDirectories requires Codex native workspace-write sandbox configuration");
      const roots = sandbox.writableRoots;
      if (
        !Array.isArray(roots) ||
        !roots.every((root) => typeof root === "string") ||
        typeof sandbox.networkAccess !== "boolean" ||
        typeof sandbox.excludeTmpdirEnvVar !== "boolean" ||
        typeof sandbox.excludeSlashTmp !== "boolean"
      )
        throw new TypeError("Codex did not return its effective workspace-write configuration");
      const config = { ...execution.config };
      // Remove conflicting spellings of only the fields this native snapshot owns.
      for (const key of ["writable_roots", "network_access", "exclude_tmpdir_env_var", "exclude_slash_tmp"])
        delete config[`sandbox_workspace_write.${key}`];
      return decodeProviderRecipe({
        ...execution,
        config: {
          ...config,
          sandbox_mode: "workspace-write",
          sandbox_workspace_write: {
            ...codexObject(config.sandbox_workspace_write),
            writable_roots: [...new Set([...roots, ...directories])],
            network_access: sandbox.networkAccess,
            exclude_tmpdir_env_var: sandbox.excludeTmpdirEnvVar,
            exclude_slash_tmp: sandbox.excludeSlashTmp,
          },
        },
      });
    } finally {
      await server.endInputAndDrain();
    }
  });
  try {
    return await attempt.result;
  } finally {
    await attempt.closed;
  }
}
