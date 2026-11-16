# Pi in-process experiment retired

The supported integration now ships in [`plugins/pi/keiyaku.ts`](../../plugins/pi/keiyaku.ts)
through the existing Pi package entry. It registers the Keiyaku MCP server,
adds a live status entry, and supplies the `/keiyaku` Kanshi overlay. There is
no separate experiment engine or standalone extension.

See [`plugins/pi/README.md`](../../plugins/pi/README.md) for loading, MCP
exposure, status refresh, and verification. The integration uses the official
package-root SDK and Pi's ordinary session extension lifecycle.
