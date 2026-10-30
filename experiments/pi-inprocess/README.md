# Pi in-process experiment retired

The supported integration now ships in [`plugins/pi/keiyaku.ts`](../../plugins/pi/keiyaku.ts)
through the existing Pi package entry. It retains `/keiyaku` and all ten native
`akuma_*` tools. There is no separate experiment engine or standalone extension.

See [`plugins/pi/README.md`](../../plugins/pi/README.md) for loading, parameters,
host lifetime, permission scope and verification. The adapter uses the official
package-root SDK and its scoped in-process host, not private publication or
provider APIs.
