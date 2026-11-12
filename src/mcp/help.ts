export const MCP_HELP = `keiyaku-mcp — standalone Keiyaku MCP server over stdio

usage  keiyaku-mcp [--help]

Each tool accepts coordinates and business fields as one object. World-only
Debt mutations and report accept cwd; other tools accept cwd and repo.
Kanshi has no business fields; status requires id. Unknown fields and incompatible
options are usage errors. Relative cwd is resolved from the server startup
directory; repo independently selects the Contract repository. Tool results share
Keiyaku's CLI text. Nine routing tools publish compact JSON decision facts;
other tools return text only. Show returns complete unclipped guidance or Debt
detail. Native calls and CLI --json retain complete owner answers. Errors return text led by their
classification. An unsatisfied verification verdict is a normal answer.
Administration and raw import stay on the CLI.

Pi has built-in MCP. Add a server to ~/.pi/agent/mcp.json or the project's
.pi/mcp.json, for example:

{
  "mcpServers": {
    "keiyaku": {
      "command": "keiyaku-mcp",
      "exposure": "direct",
      "timeout": 600
    }
  }
}

Exposure applies to the whole server. The client timeout is independent of Keiyaku
timeoutMs; ask, wait, or verify may need longer. Reload Pi after configuration changes.
`;
