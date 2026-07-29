# Figma Design Pipeline — Petr Sahula's maintained fork

> [!NOTE]
> This is Petr Sahula's maintained fork of
> [`spfr/figma-design-pipeline`](https://github.com/spfr/figma-design-pipeline).
> It is the canonical implementation used in Petr's environments and may carry
> fixes and features beyond the original upstream project.

AI design assistant for Figma. Analyze websites, create design systems, design pages and dashboards, sync tokens, and generate production code — all from your terminal.

Works with **Claude Code**, **Codex CLI**, and **Gemini CLI**. Uses the official Figma MCP for full read/write Figma access, plus a high-performance plugin for 30-60x faster writes.

## What you can do

```
"Look at stripe.com and create a design system based on their style"
"Design me an analytics dashboard with sidebar nav, metrics cards, and charts"
"Sync the design tokens from Figma to our Tailwind config"
"Generate React components from this Figma page"
"Audit https://figma.com/design/ABC/My-File for naming and accessibility issues"
```

## Quick start

```bash
npx -y -p @spetex/figma-design-pipeline spetex-figma-design-pipeline-install --client all
```

Then in Figma Desktop: **Plugins → Development → Import plugin from manifest →** `~/.figma-design-pipeline/plugin/manifest.json`.

Open Claude Code, Codex CLI, or Gemini CLI and start typing. The design assistant skill takes care of routing.

For prerequisites, per-CLI verification, manual config, and troubleshooting, see **[INSTALL.md](INSTALL.md)**.

For tool reference and end-to-end workflows, see **[USAGE.md](USAGE.md)**.

## How it works

```
AI Agent (Claude Code / Codex / Gemini)
    │
    ├─ Official Figma MCP ──→ Read & write Figma (OAuth, zero setup)
    │
    ├─ This MCP Server ─────→ Design intelligence (analysis, planning, codegen)
    │       ↕ WebSocket (ports 4010-4014)
    │   Figma plugin ─────→ Batch executor (43 action types, 30-60x faster)
    │
    └─ Browser tools ───────→ Website capture & analysis
```

The official Figma MCP handles Figma reads and file creation via OAuth — no personal access token needed. This MCP server adds design intelligence (inspection, auditing, planning, token sync, code generation) plus the plugin bridge for batched writes.

## What's new

**0.8.1** (2026-07-29)
- Published the maintained fork as `@spetex/figma-design-pipeline`, with new `spetex-*` commands and compatibility aliases for the previous `spfr-*` executable names.
- Refreshed production dependencies and added a release audit gate; `npm audit --omit=dev` now reports zero vulnerabilities.
- Hardened the plugin bridge with a 16 MiB per-message limit, disabled compression, and bounded chunk transport for large export results.
- Fixed fallback symbolic node references when create actions are interleaved with ordinary actions.
- Fixed inferred layout padding so `figma_plan_layout` emits schema-valid `set_spacing` actions.

See [CHANGELOG.md](CHANGELOG.md) for prior releases.

## MCP Tools

### Inspect (read-only)
`figma_get_tree`, `figma_audit`, `figma_extract_tokens`, `figma_find_nodes`, `figma_get_components`, `figma_get_styles`, `figma_diff_tokens`, `figma_export_images`

### Plan (analysis, returns action batches)
`figma_plan_naming`, `figma_plan_grouping`, `figma_plan_layout`, `figma_plan_components`

### Codegen
`figma_map_components`, `figma_generate_page`, `figma_generate_schema`, `figma_export_tokens`

### Write (high-performance batch execution)
`figma_execute`, `figma_plugin_status`

43 action types — frames, text, components, instances, paints, strokes, gradients, effects, auto-layout, constraints, variables, pages. See `figma://actions` MCP resource or [USAGE.md](USAGE.md) for the catalog.

## Documentation

- **[INSTALL.md](INSTALL.md)** — Prerequisites, install steps for Claude/Codex/Gemini, plugin setup, troubleshooting, uninstall.
- **[USAGE.md](USAGE.md)** — Tool reference, common workflows, tips.
- **[CHANGELOG.md](CHANGELOG.md)** — Version history.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — Development setup, scope, PR checklist.
- **[PUBLISHING.md](PUBLISHING.md)** — Release process.
- **[SECURITY.md](SECURITY.md)** — Credential handling, supported versions.

## Development

```bash
npm install
npm run dev          # tsx src/index.ts
npm run build        # build server + plugin
npm run check        # tsc --noEmit
npm test             # vitest run
npm run test:watch
```

## License

MIT
