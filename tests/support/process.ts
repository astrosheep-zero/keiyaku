import { rmSync } from "node:fs";

export async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (performance.now() >= deadline) throw new Error(`process ${pid} survived`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function removeTempDirectory(path: string): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (true) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      if (performance.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
