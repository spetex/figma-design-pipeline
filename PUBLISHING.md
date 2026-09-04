# Publishing

This maintained fork is published on **npmjs.com** as `@spetex/figma-design-pipeline`.

Releases are made by the GitHub Actions trusted-publisher workflow
(`.github/workflows/publish-npm.yml`), triggered by tag push or manually rerun
only against the exact release tag described below.

## What Ships

- `dist/index.js` — standalone MCP server bundle (includes WebSocket bridge)
- `plugin/dist/` — Figma plugin (code.js, ui.html, manifest.json)
- `skill/` — design assistant skill
- `scripts/install.mjs` — client installer + plugin deployer
- `scripts/build-server.mjs`, `scripts/build-plugin.mjs` — build scripts (for source installs)
- `bin/` — entry shims
- `CHANGELOG.md`, `INSTALL.md`, `LICENSE`, `PUBLISHING.md`, `README.md`, `USAGE.md`

## Runtime

- Requires Node 24 LTS or newer (`engines.node: ">=24.0.0"`).
- Server bundle targets `node24` via esbuild.

## Before Publishing

```bash
npm ci
npm audit --omit=dev
npm run check          # type-check server source and Node-side scripts
npm test               # vitest
npm run build          # builds server + plugin
CANDIDATE_DIR="$(mktemp -d)"
npm pack --ignore-scripts --json --pack-destination "$CANDIDATE_DIR" > "$CANDIDATE_DIR/npm-pack.json"
node scripts/verify-package.mjs "$CANDIDATE_DIR/npm-pack.json"
git diff --check
```

The verifier opens the generated tarball, validates its package identity and
npm-reported SHA-1/SHA-512 digests, parses its tar headers, and requires its
regular-file entries to match both npm's JSON and the release allowlist exactly.
It rejects missing or linked candidates, unsafe or duplicate paths, links and
other unexpected archive types.

## npm Trusted Publisher

npm trusted publishing is configured with:

- Package: `@spetex/figma-design-pipeline`
- Provider: GitHub Actions
- Organization/user: `spetex`
- Repository: `figma-design-pipeline`
- Workflow filename: `publish-npm.yml`
- Environment: none
- Allowed action: `npm publish`
- Automatic trigger: tag push `figma-design-pipeline-v*`
- Required identity: `GITHUB_REF_TYPE` must be `tag`, and both `GITHUB_REF_NAME`
  and `GITHUB_REF` must exactly identify `figma-design-pipeline-v<package.version>`
- Manual dispatch: retained only to rerun publication against that exact release
  tag; dispatches against branches, a different tag, or a malformed ref fail
  immediately after checkout, before dependency installation, packing, or publish

The workflow runs on a GitHub-hosted runner with `id-token: write`, allowing npm
to exchange GitHub's OIDC identity for a short-lived publish credential. No
long-lived npm publish token is stored in GitHub.

The package-derived tag check is fail-closed for missing ref metadata, unexpected
event types, tag suffixes, and other non-exact values. A manual run is therefore
not a way to publish an untagged branch; it is only a safe retry mechanism for an
already-created tag matching the checked-out package version.

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

Before checking the registry, pack and test the exact local release candidate:

```bash
CANDIDATE_DIR="$(mktemp -d)"
npm pack --ignore-scripts --json --pack-destination "$CANDIDATE_DIR" > "$CANDIDATE_DIR/npm-pack.json"
node scripts/verify-package.mjs "$CANDIDATE_DIR/npm-pack.json"
PACKAGE_TARBALL="$(node scripts/verify-package.mjs "$CANDIDATE_DIR/npm-pack.json" --print-path)"
npm exec --yes --package="$PACKAGE_TARBALL" -- spetex-figma-design-pipeline-install --help
```

Run the clean-home install from that same tarball and confirm the generated
Codex config points to the stable installed server path:

```bash
TMP_HOME="$(mktemp -d)"
HOME="$TMP_HOME" npm exec --yes --package="$PACKAGE_TARBALL" -- spetex-figma-design-pipeline-install --client all
sed -n '1,120p' "$TMP_HOME/.codex/config.toml"
ls "$TMP_HOME/.figma-design-pipeline/plugin/manifest.json"
```

Only after the local candidate passes should registry verification run:

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

The publish workflow makes the verified candidate read-only, tests that exact
path, then reruns full verification immediately before publishing the same
tarball. It does not pack a second candidate.
