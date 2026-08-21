import { cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = resolve(root, "build/integrations");
rmSync(target, { recursive: true, force: true });
mkdirSync(resolve(root, "build"), { recursive: true });
cpSync(resolve(root, "integrations"), target, { recursive: true });
