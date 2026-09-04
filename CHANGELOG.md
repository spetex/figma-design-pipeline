# Changelog

All notable changes to SPFR Figma Design Pipeline will be documented in this file.

## [Unreleased]

## [0.10.0] - 2026-09-04

### Added
- The plugin dashboard now reports its connected MCP harnesses, bridge and plugin versions, current Figma context, heartbeat, and the last 10 action states with timestamps and durations.
- Activity rows now identify the exact downstream harness that initiated each batch, using broker-authenticated MCP request metadata.

### Changed
- Connection details start collapsed behind a compact native disclosure row showing the live status indicator.
- The visible plugin name is now “Design Pipeline,” and a keyboard-accessible bottom drag handle allows vertical resizing between 360 and 900 pixels.

### Fixed
- Local development plugin manifests now enable Figma's private plugin API so `figma.fileKey` reaches the bridge handshake and exact-file plugin reads can use node, current-page, and selection roots.

## [0.9.0] - 2026-09-04

### Added
- `figma_get_tree`, `figma_find_nodes`, and `figma_get_components` now support bounded, token-free plugin inspection with exact file-key identity, node/current-page/selection roots, exact or regex name and type filtering, component-set discovery, correlated concurrent reads, and guarded chunked responses. `source: auto` prefers the matching plugin while preserving REST fallback; plugin reads never write or alter inspection caches.
- Expanded `figma_execute` from 43 to 54 actions for design-system construction: component-property references, exact-path nested instance text/visibility/swap overrides, variable value updates, style updates/copies, safe SVG creation, sections, and bounded ON_CLICK prototype reactions.
- Added stable `as` aliases (`$alias`) to every node-producing action while preserving `$ref:node-N`, plus whole-batch reference-graph preflight and alias entries in connected `nodeIdMap` results.
- Added exact-name variable/style resolution with explicit collection/type disambiguation, per-corner and counter-axis variable binding, and server-side local-path/HTTP(S) image ingestion with explicit asset-root containment, complete PNG/JPEG/GIF validation, 4096×4096 limits, timeout, redirect, and private-network protections.
- Added a 55th, read-only `inspect` batch action for immediate alias-addressed read-back after writes. Connected and fallback execution return the same bounded tree/property payload, including IDs, dimensions, text, visibility, paints, resolved CSS, style/variable bindings, and component state.

### Changed
- Extended targeted duplication with parent, insertion, and position controls; component-property definition to component sets; and text creation with style selection, truncation, and maximum-line controls.
- Extended auto-layout with wrapping and counter-axis spacing and added explicit precondition checks for wrapping, counter-axis spacing, and baseline alignment.
- Refreshed compatible direct, transitive, and development dependencies for the next release, including `ws`, `zod`, `fast-uri`, `hono`, `ip-address`, `qs`, and the build/test toolchain.
- Release verification now inspects and installs a locally packed candidate before registry checks, and the publish workflow publishes that tested tarball.

### Fixed
- The installer forwards `FIGMA_ASSET_ROOTS` to Codex and Gemini alongside the
  other allowlisted variables, and npm publication now requires the exact
  package-version release tag even for manual workflow retries.
- Plugin inspection now uses deterministic serialization and visited-node budgets instead of full-tree pre-counts or unbounded sparse searches. Selection metadata is independently bounded and paged with truthful total/omitted counts, every Figma-origin scalar is UTF-8 bounded with explicit truncation metrics, and the UI enforces aggregate byte/chunk limits before transport. Both read paths share the pure-JavaScript linear-time RE2 engine, which safely handles overlapping repetitions and rejects backreferences/lookarounds. REST preserves an explicit `depth: 0`, and whole-file REST component truncation provides advancing `offset` / `nextOffset` pagination without changing explicit current-page roots into whole-file reads.
- The direct `re2js` dependency has no runtime dependencies and adds no advisory findings; the combined release dependency refresh fixes the production findings in `fast-uri`, `hono`, `ip-address`, and `qs`.
- Newly created frames now start with transparent fills in both connected-plugin execution and disconnected fallback JavaScript, avoiding unintended white surfaces on structural containers.
- The dynamic-page plugin now loads all pages before registering its global document-change listener, preserving debounced cache invalidation while containing and logging initialization failures so bridge startup can continue.
- Rollback batches now establish explicit Figma undo boundaries so a later failed batch cannot undo an earlier successful batch.
- Name-resolved text styles load their fonts before application; `create_text` applies a style first and explicit typography overrides second in both execution paths.
- Gradients support ordered multi-fill scrims and explicit invertible transforms. Effects now use current Plugin API fields and defaults (`blurType`, shadow color/offset, and `showShadowBehindNode`).
- Image ingestion now rejects incomplete/corrupt/oversized content and unsupported WebP. Local paths require configured roots and cannot escape by traversal or symlink.
- Component property strings are treated as symbolic references only for resolved `INSTANCE_SWAP` definitions, and section creation/resizing enforces the Plugin API’s `0.01` minimum dimension before mutation.
- Gradient and per-corner-radius result snapshots no longer expose Figma mixed-value symbols through the bridge. Connected and fallback executors retain full schema/action behavior parity.
- Same-batch inspection uses the approved plugin serializer's depth/result/scan/scalar limits and a shared 80KB aggregate batch budget. Inspection actions do not count as mutations or invalidate caches; rollback redacts transient inspection trees and marks them `rolledBack`.
- Connected batches are FIFO-serialized at both bridge and plugin boundaries, use batch-local alias maps, and recover cleanly after batch errors, timeouts, disconnects, and reconnects so rollback cannot interfere with adjacent callers.
- GIF and JPEG ingestion now performs bounded full decode validation with exact `modern-gif` and `jpeg-js` runtime dependencies, rejecting empty LZW streams, malformed scan/table shells, corrupt/truncated content, excessive decoded frame data, and oversized dimensions.
- Same-batch inspection reports `omittedNodeCount` as an explicit lower bound with `omittedNodeCountExact: false` when result or scan budgets stop traversal; rollback now also scrubs transient action IDs, create maps, and post-mutation snapshots while preserving errors and summary accounting.

### Security
- Restored a zero-finding `npm audit --omit=dev` production dependency gate after fixes became available for four new advisories.

## [0.8.2] - 2026-08-02

### Changed
- Package publishing now uses GitHub Actions trusted publishing instead of a long-lived npm token.

### Fixed
- The installer now forwards optional Figma environment variables correctly for Codex, Claude Code, and Gemini, including `FIGMA_PLUGIN_PORT`, without writing literal placeholder values into Codex configuration.
- Inspection reads now offer explicit freshness controls and cache provenance, key snapshots by all result-shaping inputs, and invalidate cached data after connected writes or plugin document changes.
- Grouping plans now create real groups by moving every selected node into a correctly positioned parent-relative frame while preserving visible child positions and rejecting unsafe hierarchies.
- Remembered root nodes are now scoped to their Figma file, preventing a node from one file from being reused silently after switching to another file.
- Tree enumeration no longer silently compacts direct root children. Vector compaction, oversized scalar fields, and response-size pruning now report exact omission metrics, machine-readable reasons, serialized-response byte metrics, compatible node counts and notes, and focused or strictly advancing paginated continuations. Node searches now distinguish an exact-limit complete result from a genuinely truncated result and expose traversal depth and match limit.
- Disconnected-plugin fallback JavaScript now matches all 43 plugin action contracts, preserving layout, gradient, typography, variable, export, font, and paint-binding fields as well as dry-run, stop-on-error, and rollback semantics.
- Astro code generation now emits concrete props data types, preserves component registry names, paths, categories, props, and supported file extensions, and reports entries that cannot be represented instead of producing invalid imports.
- The live pipeline validation script now uses the current REST client and tool context, loads without stale imports, and is covered by Node-side script type checking.
- Design audits now receive distinct item-spacing and padding tokens, correctly classify non-auto-layout containers, and deduplicate repeated spacing violations.
- Token export now preserves arbitrary-size same-hue palettes, layered outer/inner shadow structure, full RGBA precision, alpha and spread, and opacity across Tailwind, CSS, JSON, and DTCG Style Dictionary output. Extracted Tailwind hints and exported theme keys share one deterministic projection, including collision-safe fractional opacity and repeated or distinct shadows. Existing JSON shadow consumers retain a complete CSS-compatible `raw` string alongside lossless `shadow` layers.

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
- `set_effects` and `create_effect_style` now accept detailed Figma effect payloads (blendMode, offset, spread, and drop/inner shadows plus layer/background blurs) so plugin writes can reproduce layered visual treatments.

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
