# Changelog

All notable changes to SPFR Figma Design Pipeline will be documented in this file.

## [Unreleased]

### Fixed
- Tree enumeration no longer silently compacts direct root children. Vector compaction, oversized scalar fields, and response-size pruning now report exact omission metrics, machine-readable reasons, full serialized-response byte metrics, compatible node counts and notes, and focused or strictly advancing paginated continuations.
- Node searches now distinguish an exact-limit complete result from a genuinely truncated result and expose their traversal depth and match limit.

## [0.8.1] - 2026-07-29

### Changed
- Package publication and installation now target `@spetex/figma-design-pipeline`, with repository metadata and documentation pointing to the maintained fork. The previous `spfr-*` executable names remain available as compatibility aliases.

### Security
- Refreshed production dependencies to resolve all findings from `npm audit --omit=dev`, including the directly used `ws` package and MCP SDK transitive dependencies.
- Limited inbound plugin bridge messages to 16 MiB, explicitly disabled WebSocket compression, and added an oversized-message regression test.
- Large plugin batch results now use bounded chunked transport, preserving supported `export_node` responses while limiting reassembly to 64 MiB and 64 chunks and clearing incomplete assemblies on failure or shutdown.
- Added a production dependency audit gate to the npm release workflow.

### Fixed
- Fallback JavaScript now resolves symbolic node references by create-action order, matching compiled plugin batches even when non-create actions appear before or between creates.
- `figma_plan_layout` now emits canonical `paddingTop`, `paddingRight`, `paddingBottom`, and `paddingLeft` fields for inferred padding, producing schema-valid `set_spacing` actions.

## [0.8.0] - 2026-05-12

### Changed (breaking)
- **Node 24 LTS required.** `engines.node` is now `">=24.0.0"`. The server bundle's esbuild target moved from `node22` to `node24`. Older Node versions will get an npm install warning and may run, but are no longer supported.

### Changed
- **Zod 4.4** — internal schema validation migrated from zod 3.25 to zod 4. No tool/MCP surface change. Updated the one v3-only signature in `src/shared/actions.ts` (`z.record(z.union(...))` → `z.record(z.string(), z.union(...))`).
- **TypeScript 6.0** — dev toolchain bumped. `tsc --noEmit` clean.
- **esbuild 0.28**, **@types/node 24.12** — toolchain bumps.

### Added
- `INSTALL.md` and `USAGE.md` — full installation and usage guides separated from README.
- Schema-level vitest cases for the migrated `z.record` field, so a future zod-API regression fails CI.

### Notes
- Server bundle (`dist/index.js`) grew from ~1.0 MB to ~1.4 MB. The MCP SDK 1.29 explicitly bundles `zod/v3` alongside `zod/v4` for back-compat with v3 consumers; both are now included. No effect on tool latency or memory (local subprocess).
- All other deps stay where 0.7.5 left them: `@modelcontextprotocol/sdk ^1.29.0`, `dotenv ^17.4.2`, `ws ^8.20.0`, `@figma/plugin-typings ^1.125.0`, `tsx ^4.21.0`, `vitest ^4.1.6`.

## [0.7.5] - 2026-05-11

### Fixed
- `apply_style` now uses Figma's async setters (`setFillStyleIdAsync`, `setStrokeStyleIdAsync`, `setTextStyleIdAsync`, `setEffectStyleIdAsync`). The plugin runs under `documentAccess: dynamic-page`, which forbids the sync `node.fillStyleId = x` setters and was failing every style binding.

## [0.7.4] - 2026-05-11

### Fixed
- `create_paint_style` no longer fails when the action carries an `a` alpha channel. The plugin now runs paints through `sanitizePaints` so the alpha is folded into `opacity` and the color is stripped to the `{r,g,b}` triplet Figma expects.
- Zod schemas for `create_text` / `set_fills` / `set_strokes` / `create_paint_style` paint colors stopped injecting `a: 1` as a default, so on-the-wire actions stay clean when callers omit alpha. Gradient stops and shadow effect colors still default `a: 1` because Figma needs RGBA for those.

## [0.7.3] - 2026-03-31

### Added
- `set_effects` and `create_effect_style` now accept the full Figma effect payload (blendMode, offset, spread, showShadowOnly as well as drop/inner shadows and layer/background blurs) so plugin writes can reproduce Figma’s elite visual treatments.

### Fixed
- Drop-shadow batches no longer fail validation because the MCP schema now mirrors what the plugin expects to send.

## [0.5.0] - 2026-03-30

### Added
- Standalone public package structure for `@spfr/figma-design-pipeline`
- Cross-client installer for Claude, Gemini, Codex, and Claude Desktop
- Claude Desktop `.mcpb` packaging
- Figma Community submission bundle and listing assets
- GitHub Pages landing page and release-hardening docs
- On-demand workflow MCP resources for inspect, mutate, tokens, and codegen

### Changed
- Promoted the project from a multi-skill repo layout to a dedicated Figma pipeline package
- Reduced default skill context footprint by moving detailed guidance to MCP resources
- Made the server bundle self-contained for package installs
- Updated naming to `SPFR Figma Design Pipeline` and plugin id `co.spfr.figma-design-pipeline`

### Removed
- Legacy multi-skill repo content unrelated to the Figma pipeline
