export const MCP_HELP = `keiyaku-mcp — standalone Keiyaku MCP server over stdio

usage  keiyaku-mcp [--help]

Each tool accepts coordinates and business fields as one object. World-only
Debt mutations and report accept cwd; other tools accept cwd and repo.
Kanshi has no business fields; status requires selector (a complete Contract or
Akuma identity or @name). Unknown fields and incompatible options are usage errors.
Relative cwd is resolved from the server startup directory; repo independently
selects the Contract repository. Tool results share
Keiyaku's CLI text. Nine routing tools publish compact JSON decision facts;
other tools return text only. Show returns complete unclipped guidance or Debt
detail. Native calls and CLI --json retain complete owner answers. Errors return text led by their
classification. An unsatisfied verification verdict is a normal answer.
Administration and raw import stay on the CLI.

Pi uses the shipped Keiyaku extension's native keiyaku_* tools through codemode,
not this server. The extension activates codemode when loaded; SDK hosts must
load codemode themselves. No Keiyaku MCP configuration is needed in Pi.

Other MCP clients can launch the standalone server over stdio, for example:

{
  "mcpServers": {
    "keiyaku": {
      "command": "keiyaku-mcp",
      "exposure": "direct",
      "timeout": 600
    }
  }
}

Exposure applies to the whole server where supported by the client. The client timeout is independent of Keiyaku timeout; ask, wait, or verify may need longer.
`;
