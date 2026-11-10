#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { installedPackageVersion } from "../cli/version.js";
import { createKeiyakuMcpServer } from "./adapter.js";
import { MCP_HELP } from "./help.js";

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  process.stdout.write(MCP_HELP);
} else if (args.length !== 0) {
  process.stderr.write("usage: keiyaku-mcp [--help]\n");
  process.exitCode = 64;
} else {
  const cwd = process.cwd();
  const environment = { ...process.env };
  try {
    const adapter = createKeiyakuMcpServer({ cwd, environment, version: await installedPackageVersion() });
    const shutdown = () => {
      process.stdin.off("end", shutdown);
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      void adapter.close().catch((error: unknown) => {
        console.error("keiyaku-mcp: shutdown failed", error);
        process.exitCode = 1;
      });
    };
    process.stdin.once("end", shutdown);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await adapter.server.connect(new StdioServerTransport());
  } catch (error) {
    console.error("keiyaku-mcp: startup failed", error);
    process.exitCode = 1;
  }
}
