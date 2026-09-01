import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type PackageJson = {
  keywords?: unknown;
  pi?: { extensions?: unknown; skills?: unknown };
};

const rootUrl = new URL("../", import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL("package.json", rootUrl), "utf8")) as PackageJson;
const piExtension = packageJson.pi?.extensions;
if (!Array.isArray(piExtension) || typeof piExtension[0] !== "string") {
  throw new Error("Pi package extension is missing");
}
execFileSync("npm", ["run", "build"], { cwd: fileURLToPath(rootUrl), stdio: "inherit" });
const { default: keiyakuExtension } = (await import(new URL(piExtension[0], rootUrl).href)) as {
  default: (pi: ExtensionAPI) => void;
};

test("npm root package declares its Pi resources", () => {
  assert.equal(Array.isArray(packageJson.keywords) && packageJson.keywords.includes("pi-package"), true);
  assert.deepEqual(packageJson.pi, {
    extensions: ["./build/integrations/pi/keiyaku.ts"],
    skills: ["./build/integrations/marketplace/plugins/keiyaku/skills"],
  });
});

type Handler = (event: unknown, context: ExtensionContext) => unknown;

type CommandHandler = (args: string, context: ExtensionContext) => Promise<void>;
type Overlay = Readonly<{ handleInput(data: string): void; render(width: number): string[] }>;
type ExecResult = Readonly<{ stdout: string; stderr: string; code: number; killed: boolean }>;

function install(execute: (command: string, args: string[]) => Promise<ExecResult>) {
  const handlers = new Map<string, Handler>();
  let command: CommandHandler | undefined;
  const pi = {
    on(event: string, handler: Handler): void {
      handlers.set(event, handler);
    },
    registerCommand(name: string, options: { handler: CommandHandler }): void {
      assert.equal(name, "keiyaku");
      command = options.handler;
    },
    exec(commandName: string, args: string[]): Promise<ExecResult> {
      return execute(commandName, args);
    },
  } as unknown as ExtensionAPI;

  keiyakuExtension(pi);
  assert.ok(command);
  return { command, handlers };
}

test("Pi registers only the explicit Keiyaku command", () => {
  const { handlers } = install(async () => {
    throw new Error("status must not run while loading");
  });

  assert.deepEqual([...handlers.keys()], []);
});

test("Pi command runs one text status and does not refresh when dismissed", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const { command } = install(async (commandName, args) => {
    calls.push({ command: commandName, args });
    return { stdout: "Contract status\nAkuma status\n", stderr: "", code: 0, killed: false };
  });
  let overlay: Overlay | undefined;
  let closeOverlay!: () => void;
  const closed = new Promise<void>((resolve) => {
    closeOverlay = resolve;
  });
  const context = {
    hasUI: true,
    ui: {
      custom(factory: unknown): Promise<void> {
        overlay = (
          factory as (
            tui: unknown,
            theme: { fg(role: string, value: string): string },
            keybindings: unknown,
            done: () => void,
          ) => Overlay
        )(undefined, { fg: (_role, value) => value }, undefined, closeOverlay);
        return closed;
      },
    },
  } as unknown as ExtensionContext;

  const invocation = command("", context);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, process.execPath);
  assert.equal(calls[0]?.args[0], fileURLToPath(new URL("build/src/cli/index.js", rootUrl)));
  assert.equal(calls[0]?.args.at(-1), "status");
  assert.equal(calls[0]?.args.includes("--json"), false);
  assert.ok(overlay);
  assert.equal(overlay.render(80).some((line) => line.includes("Contract status")), true);
  overlay.handleInput("\r");
  await invocation;
  assert.equal(calls.length, 1);
});

test("Pi command skips no-UI calls and preserves status diagnostics", async () => {
  let calls = 0;
  const noUi = install(async () => {
    calls++;
    return { stdout: "", stderr: "", code: 0, killed: false };
  });
  await noUi.command("", { hasUI: false } as ExtensionContext);
  assert.equal(calls, 0);

  for (const [stderr, expected] of [
    ["database unreachable", "database unreachable"],
    ["", "status unavailable"],
  ] as const) {
    let displayed: string[] = [];
    const { command } = install(async () => ({ stdout: "", stderr, code: 1, killed: false }));
    await command("", {
      hasUI: true,
      ui: {
        custom(factory: unknown): Promise<void> {
          const component = (
            factory as (
              tui: unknown,
              theme: { fg(role: string, value: string): string },
              keybindings: unknown,
              done: () => void,
            ) => Overlay
          )(undefined, { fg: (_role, value) => value }, undefined, () => undefined);
          displayed = component.render(100);
          return Promise.resolve();
        },
      },
    } as ExtensionContext);
    assert.equal(displayed.some((line) => line.includes(expected)), true);
  }
});
