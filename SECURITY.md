# Security Policy

## Credential Handling

This project requires API tokens to function. Follow these rules to keep them safe:

### Where to Store Tokens

**Do:** Pass tokens via your MCP client's environment configuration.

```json
{
  "mcpServers": {
    "figma-design-pipeline": {
      "command": "node",
      "args": ["/path/to/dist/index.js"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_your_token_here"
      }
    }
  }
}
```

Common MCP config locations:
- **Claude Code**: `.mcp.json` (project) or `~/.claude/mcp.json` (global)
- **Cursor**: `.cursor/mcp.json` or Settings > MCP Servers
- **Windsurf**: `~/.codeium/windsurf/mcp_config.json`
- **Cline**: `cline_mcp_settings.json`

**Don't:**
- Commit `.env` files with real tokens
- Hardcode tokens in source code
- Share tokens in GitHub Issues or PRs
- Store tokens in skill SKILL.md files

### Token Scopes

The Figma personal access token needs **File content** read access. If you use mutation tools (plugin), it also needs to be from an account with edit access to the target Figma file.

Generate tokens at: https://www.figma.com/developers/api#access-tokens

### Revoking Compromised Tokens

If a token is accidentally exposed:
1. Go to Figma > Account Settings > Personal Access Tokens
2. Delete the compromised token immediately
3. Generate a new token
4. Update your MCP client configuration

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public GitHub Issue
2. Email the maintainers directly (see repo owner profile)
3. Include steps to reproduce the issue
4. Allow reasonable time for a fix before public disclosure

## Open Source Release Checklist

Before making the repo public or publishing a release:

1. Run a repo-wide secret scan for tokens, credentials, and private keys
2. Verify `.env*` and other local config files are ignored and untracked
3. Inspect package tarballs before publish to confirm only intended files ship
4. Redact tokens from logs, screenshots, and issue reports
5. Review [docs/RELEASE-HARDENING.md](docs/RELEASE-HARDENING.md)

## Dependency Security

The npm release workflow runs `npm audit --omit=dev` after `npm ci` and blocks
publishing if the production dependency tree has a reported vulnerability.
This network-dependent check stays in release CI; normal local development and
tests do not require audit service availability.

### Issue #11 audit record

On 2026-07-29, `npm audit --omit=dev` against the untouched lockfile reported
11 production vulnerabilities: 1 low, 4 moderate, and 6 high. After refreshing
the direct dependencies and affected transitive resolutions, the same command
reported 0 vulnerabilities.

The baseline dependency and bundle review found:

- `@spetex/figma-design-pipeline -> ws@8.20.0` was directly reachable from
  `src/plugin/bridge.ts` and included in `dist/index.js`. It is now locked to
  `ws@8.21.1`.
- `@spetex/figma-design-pipeline -> @modelcontextprotocol/sdk@1.29.0 ->
  ajv@8.20.0 -> fast-uri@3.1.2` was included in the stdio bundle through the
  SDK validation provider. `fast-uri` is now locked to 3.1.4.
- `@spetex/figma-design-pipeline -> @modelcontextprotocol/sdk@1.29.0 ->
  @hono/node-server@1.19.14 -> hono@4.12.18` and
  `@modelcontextprotocol/sdk@1.29.0 -> express@5.2.1 ->
  body-parser@2.2.2 / qs@6.15.1` were installed but absent from the esbuild
  input graph for `src/index.ts`. The published server imports the SDK's MCP
  and stdio modules, not its HTTP transports. These paths were not reachable
  in the bundled stdio runtime, but were still refreshed to
  `@hono/node-server@2.0.12`, `hono@4.12.32`, `body-parser@2.3.0`, and
  `qs@6.15.3`.

There are no remaining production advisories requiring a reachability
exception. The bundle result can be checked after `npm run build` by searching
the source comments in `dist/index.js` for the package names above.

## Figma Plugin Security

The Figma plugin communicates with the MCP server via a local WebSocket connection (`127.0.0.1`). This is intentionally localhost-only — the bridge does not accept remote connections.

The bridge keeps one active plugin connection, limits inbound WebSocket
messages to 16 MiB, and disables per-message compression. Messages above the
limit are closed with WebSocket status 1009.

The plugin runs inside Figma's sandboxed environment and can only access the current file's scene graph through the official Plugin API.

### Asset ingestion

`set_image_fill` rejects local paths unless `FIGMA_ASSET_ROOTS` explicitly
allowlists one or more directories (using the platform path delimiter). Both
roots and candidate files are resolved with `realpath`; traversal and symlink
escapes are rejected before reading. HTTP(S) ingestion pins
each connection to DNS answers checked immediately beforehand and rejects
loopback, private, link-local, multicast, and reserved addresses on the initial
request and every redirect. Requests have a 10-second deadline and five-
redirect maximum. Decoded PNG, JPEG, and GIF payloads are structurally
validated, capped at 10 MiB and 4096×4096 pixels, and checked against declared
HTTP content types before plugin transport. WebP is rejected because the
installed Figma Plugin API contract only accepts PNG, JPEG, and GIF.

`create_from_svg` accepts at most 1 MiB of UTF-8 markup and rejects document
types/entities, scripts, event handlers, foreign content, CSS imports, and
non-fragment resource references before the batch is sent. These checks are a
bounded ingestion policy, not a general-purpose SVG sanitizer.
