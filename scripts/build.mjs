import spawn from "cross-spawn";
import { chmodSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

/** @param {string} command @param {string[]} args */
function run(command, args) {
  return new Promise((resolveStatus) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", (error) => {
      console.error(error);
      resolveStatus(1);
    });
    child.once("close", (code) => resolveStatus(code ?? 1));
  });
}

rmSync(resolve(root, "build"), { recursive: true, force: true });
const product = (async () => {
  const source = await run("tsc", ["-p", "tsconfig.json"]);
  if (source !== 0) return source;
  return run("npm", ["run", "build", "--workspace", "@astrosheep/keiyaku-plugin-square"]);
})();
const [productStatus, launcherStatus] = await Promise.all([
  product,
  run(process.execPath, ["scripts/build-windows-launcher.js"]),
]);
if (productStatus !== 0 || launcherStatus !== 0) process.exit(productStatus || launcherStatus);
await import("./copy-integrations.js");
chmodSync(resolve(root, "build/src/cli/index.js"), 0o755);
