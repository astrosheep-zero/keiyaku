export const MCP_HELP = `keiyaku-mcp — standalone Keiyaku MCP server over stdio

usage  keiyaku-mcp [--help]

Each tool accepts { cwd?, repo?, ...businessFields } as one object.
Kanshi has no business fields; status requires id. Unknown fields and incompatible
options are usage errors. Relative cwd is resolved from the server startup
directory; repo independently selects the Contract repository. Tool results share
Keiyaku's CLI text. Tools publish native JSON facts when their result selects a
next call; other tools return text only. Errors return text led by their
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
