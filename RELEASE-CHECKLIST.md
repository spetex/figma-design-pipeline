# Release Checklist

Use this checklist for every public release of SPFR Figma Design Pipeline.

Confirm you are on **Node 24 LTS or newer** (`node --version`).

## 1. Local Verification

```bash
node --version       # must be >= 24.0.0
npm ci
npm audit --omit=dev # must report 0 production vulnerabilities
npm run check        # tsc --noEmit (TS 6)
npm test             # vitest; use the reported current test count
npm run build        # builds server + plugin
npm pack --ignore-scripts --dry-run --json > /tmp/figma-design-pipeline-pack.json
node scripts/verify-package.mjs /tmp/figma-design-pipeline-pack.json
```

Pack and verify the exact local release candidate before any registry checks:

```bash
CANDIDATE_DIR="$(mktemp -d)"
npm pack --ignore-scripts --json --pack-destination "$CANDIDATE_DIR" > "$CANDIDATE_DIR/npm-pack.json"
node scripts/verify-package.mjs "$CANDIDATE_DIR/npm-pack.json"
PACKAGE_FILENAME="$(node -e "const fs = require('node:fs'); console.log(JSON.parse(fs.readFileSync(process.argv[1], 'utf8'))[0].filename)" "$CANDIDATE_DIR/npm-pack.json")"
PACKAGE_TARBALL="$CANDIDATE_DIR/$PACKAGE_FILENAME"
npm exec --yes --package="$PACKAGE_TARBALL" -- spetex-figma-design-pipeline-install --help
```

Verify a clean-home install from that same local tarball:

```bash
TMP_HOME="$(mktemp -d)"
HOME="$TMP_HOME" npm exec --yes --package="$PACKAGE_TARBALL" -- spetex-figma-design-pipeline-install --client all
sed -n '1,120p' "$TMP_HOME/.codex/config.toml"
ls "$TMP_HOME/.figma-design-pipeline/plugin/manifest.json"
```

Confirm the generated Codex config points to `$TMP_HOME/.figma-design-pipeline/server/index.js` and does not reference `.npm/_npx/...`.

After the local candidate passes, verify the currently published registry package:

```bash
cd /tmp
npx -y -p @spetex/figma-design-pipeline spetex-figma-design-pipeline-install --help
```

## 2. Plugin Smoke Test

1. Open Figma Desktop
2. Plugins > Development > Import plugin from manifest
3. Select `~/.figma-design-pipeline/plugin/manifest.json`
4. Run the plugin — should show "Connected"

From any CLI:
```
figma_plugin_status → { connected: true, port: 4010 | 4011 | 4012 | ... }
```

Test a batch operation:
```
figma_execute({
  actions: [
    { type: "create_page", name: "Test Page" },
    { type: "create_frame", name: "Test Frame", parentId: "PAGE_ID", width: 400, height: 300 }
  ],
  dryRun: true
})
```

## 3. MCP Smoke Test

- Confirm `figma-design-pipeline` is registered as an MCP server
- `figma_get_tree` with a Figma URL
- `figma_audit` on a real file
- `figma_extract_tokens` → verify token output
- `figma_export_tokens` with format "tailwind" and "style-dictionary"
- Use `use_figma` or `figma_execute` to create a simple frame

For REST API tools:
```bash
export FIGMA_ACCESS_TOKEN=figd_...
```

## 4. npm Release

Releases use the GitHub Actions trusted publisher documented in
`PUBLISHING.md`:

```bash
npm version <next-version> --no-git-tag-version
git add package.json package-lock.json
git commit -m "Release <next-version>"
git push origin main
git tag figma-design-pipeline-v<next-version>
git push origin figma-design-pipeline-v<next-version>
```

Confirm:
- GitHub Actions publish workflow succeeds
- `npm view @spetex/figma-design-pipeline version` shows new version
- `npx` install from outside repo works

## 5. GitHub Release

Create release for the tag. Include:
- Changelog highlights
- Install command
- Links to docs and npm

## 6. Update

For end users:

```bash
npx -y -p @spetex/figma-design-pipeline spetex-figma-design-pipeline-install --client all
```
