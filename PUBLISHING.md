# Publishing

This maintained fork will be published on **npmjs.com** as `@spetex/figma-design-pipeline`.

After the package is bootstrapped, releases are made by the GitHub Actions trusted-publisher workflow (`.github/workflows/publish-npm.yml`), triggered by tag push.

## What Ships

- `dist/index.js` — standalone MCP server bundle (includes WebSocket bridge)
- `plugin/dist/` — Figma plugin (code.js, ui.html, manifest.json)
- `skill/` — design assistant skill
- `scripts/install.mjs` — client installer + plugin deployer
- `scripts/build-server.mjs`, `scripts/build-plugin.mjs` — build scripts (for source installs)
- `bin/` — entry shims
- `LICENSE`, `README.md`, `PUBLISHING.md`

## Runtime

- Requires Node 24 LTS or newer (`engines.node: ">=24.0.0"`).
- Server bundle targets `node24` via esbuild.

## Before Publishing

```bash
npm install
npm run check          # tsc --noEmit
npm test               # vitest
npm run build          # builds server + plugin
npm pack               # verify package contents
```

Verify the plugin dist is included:
```bash
tar tzf *.tgz | grep plugin
```

## First-Publish Bootstrap

An npm package is created by its first publish. The first release of
`@spetex/figma-design-pipeline` therefore requires an npm account that owns the
`@spetex` scope:

```bash
npm login
npm whoami
npm publish --access public
```

Run this only from the reviewed release commit after the version and changelog
have been finalized. The initial publish cannot use trusted publishing because
the package does not yet have npm settings where the GitHub publisher can be
configured.

After the first publish, configure npm trusted publishing for:

- Package: `@spetex/figma-design-pipeline`
- GitHub: `spetex/figma-design-pipeline`
- Workflow: `.github/workflows/publish-npm.yml`
- Trigger: tag push `figma-design-pipeline-v*` or manual dispatch

`prepack` runs `npm run build` (server + plugin) automatically.

## Release

```bash
npm version <next-version> --no-git-tag-version
git add package.json package-lock.json
git commit -m "Release <next-version>"
git push origin main
git tag figma-design-pipeline-v<next-version>
git push origin figma-design-pipeline-v<next-version>
```

## Install Command

```bash
npx -y -p @spetex/figma-design-pipeline spetex-figma-design-pipeline-install --client all
```

This installs stable local assets under `~/.figma-design-pipeline/`, registers the MCP server, creates the client skill symlink, and deploys the Figma plugin to `~/.figma-design-pipeline/plugin/`.

## Verification

```bash
cd /tmp
npx -y -p @spetex/figma-design-pipeline spetex-figma-design-pipeline-install --help
```

Clean-home test:
```bash
TMP_HOME="$(mktemp -d)"
cd /tmp
HOME="$TMP_HOME" npx -y -p @spetex/figma-design-pipeline spetex-figma-design-pipeline-install --client all
sed -n '1,120p' "$TMP_HOME/.codex/config.toml"
ls "$TMP_HOME/.figma-design-pipeline/plugin/manifest.json"
```

Confirm the generated Codex config points to `$TMP_HOME/.figma-design-pipeline/server/index.js` and not an `.npm/_npx/...` cache path.
