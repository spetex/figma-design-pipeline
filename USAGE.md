# Usage

This guide shows the most useful workflows. The installed design assistant skill (`figma-design-pipeline`) handles tool routing automatically when you describe what you want — you usually don't need to call tools by name.

For the full installation guide, see [INSTALL.md](INSTALL.md).

## Quick wins

Open Claude Code, Codex CLI, or Gemini CLI and type any of these:

```
Look at https://stripe.com and extract their design language into a new Figma file.

Create a dark-mode analytics dashboard with sidebar nav, four metric cards, and a line chart.

Audit https://figma.com/design/ABC123/My-File for naming, layout, and accessibility issues.

Export the design tokens from this Figma file as a Tailwind config:
https://figma.com/design/ABC123/Tokens

Generate Astro page templates from this Figma frame, matched to our components/ folder.
```

The skill picks the right tools. Read on if you want to drive specific tools yourself.

## Tool routing rules

| You want to… | Tool | Server |
|---|---|---|
| Create / modify / style any node | `figma_execute` | this package |
| Bounded node/tree/component inspection | `figma_get_tree`, `figma_find_nodes`, `figma_get_components` | this package |
| Other read-only JS queries | `use_figma` | official Figma MCP |
| Create a new Figma file | `create_new_file` | official Figma MCP |
| Take a screenshot | `get_screenshot` | official Figma MCP |
| Inspect / audit / extract tokens | `figma_get_tree`, `figma_audit`, etc. | this package |

**Never use `use_figma` to write.** Even when the plugin is disconnected, `figma_execute` returns fallback JavaScript you can feed back into `use_figma` — that's still the right entry point.

Always call `figma_plugin_status` first when starting a write-heavy task. It tells you whether the plugin bridge is live (30-60x faster) or whether the agent should plan around fallback JS.

## Inspect (read-only, plugin-first where supported)

`figma_get_tree`, `figma_find_nodes`, and `figma_get_components` accept
`source: "auto" | "plugin" | "rest"` (default `auto`). `auto` uses the
connected plugin only when its exact `figma.fileKey` matches the requested
file, then falls back to REST. `plugin` fails closed when disconnected or when
the file differs; `rest` always selects REST. Plugin inspection needs no
`FIGMA_ACCESS_TOKEN`. Other inspection tools still use REST and need the token
configured (see [INSTALL.md](INSTALL.md)).

Plugin-backed tools accept `root: "node" | "current-page" | "selection"`.
Traversal is bounded by `depth` and `limit`; searches and component discovery
also stop at `scanLimit` (default 1,000 nodes) even when matches are sparse or
absent. Responses distinguish `result_limit` from `scan_limit`. Current-page
context is included in plugin responses; selection metadata is collected only
for selection-root reads and is deterministically paged. Follow
`selectionMetadata.nextOffset` with `selectionMetadataOffset`; `total`,
`returned`, and `omitted` remain truthful even for a 50,000-node selection.
`figma_find_nodes` supports both an exact, case-sensitive `name` and a
case-insensitive RE2 `namePattern`. The pure-JavaScript matcher guarantees
linear-time work for nested and overlapping repetitions. Backreferences,
lookarounds, unsupported RE2 constructs, and patterns over 256 characters fail
closed with a validation error. Plugin trees return
the safe structural subset; choose `source: "rest"` when style/token enrichment
from `includeStyles` is required.

| Tool | What it does | When to use |
|---|---|---|
| `figma_get_tree` | Enriched node tree with explicit completeness metadata and an 80 KB complete-response cap. | First call when exploring any file. |
| `figma_audit` | Structural audit: naming, layout, components, tokens, accessibility. | Bounded list of issues before a cleanup pass. |
| `figma_extract_tokens` | Colors, fonts, spacing, radius, layered shadows, and opacity — with Tailwind mapping. | Token sync, theming, brand audits. |
| `figma_find_nodes` | Filter nodes by name / type / classification / text / size, with explicit limit and depth metadata. | "Where is the button styled like X?" |
| `figma_get_components` | Discover components and component sets under a root; omitting both root and node retains the paginated published-component REST listing. | Before mapping to your code components. |
| `figma_get_styles` | List published color/text/effect styles. | Token drift check. |
| `figma_diff_tokens` | Compare Figma styles vs your code tokens. | Sync workflow. Accepts style data directly — no REST call. |
| `figma_export_images` | Render nodes to PNG/JPG/SVG via REST. | Snapshots, before/after, docs. |

### Inspection freshness and cache provenance

The REST paths for `figma_get_tree` and `figma_find_nodes` cache inspection snapshots by
Figma file, root node ID, requested depth, and whether styles are included.
Every response reports `fromCache`, `snapshotAt` (ISO timestamp), and
`cacheAgeMs`, so callers can tell whether they received a reused snapshot and
how old it is.

- `refresh: true` always bypasses the inspection cache and makes a new Figma
  REST API request.
- `maxAgeMs` permits reuse only when a snapshot is no older than that many
  milliseconds. `maxAgeMs: 0` is equivalent to `refresh: true`.
- Without either option, snapshots can be reused for up to 15 minutes.

Plugin reads always inspect live plugin state: they neither read nor populate
the REST snapshot cache, and a read never invalidates it. On the REST path, a
refresh guarantees a new REST request, but cannot guarantee that Figma REST has
already observed a just-made plugin or editor mutation. Connected `figma_execute`
batches that apply changes, and plugin `documentchange` notifications, clear
the local inspection cache conservatively. If the plugin is disconnected while
someone else edits the file, request `refresh: true` or `maxAgeMs: 0` when the
latest REST view matters.

### Enumeration completeness

`figma_get_tree` preserves every direct child of the requested root whenever
the complete pretty-printed response fits its 80,000-byte budget. The budget
includes metadata and continuations, and `responseBytes` is the UTF-8 byte
length of the exact emitted text. Each node distinguishes the
source `childCount` from `returnedChildCount`, which counts real direct children
present in the response (synthetic `COLLAPSED` and `TRUNCATED` markers do not
count). A complete response has `truncated: false`, `omittedNodeCount: 0`, and
an empty `truncationReasons` array.

When descendant vector leaves are compacted or deeper nodes are removed to fit
the byte budget, the response sets `truncated: true`, reports the exact
`omittedNodeCount`, and includes `vector_compaction` and/or
`response_size_limit` in `truncationReasons`. `maxResponseBytes` appears when
the byte cap caused pruning. Each `continuations` entry gives a retrievable
`nodeId`, reason, and omitted count; call `figma_get_tree` on that node to drill
into the omitted subtree. Only a root whose direct-child records cannot fit
after descendant pruning is paginated. In that case, pass
`directChildren.nextOffset` back as `childOffset` to fetch the next page.
Every emitted `nextOffset` is strictly greater than the request's `childOffset`;
a response without `nextOffset` is terminal.

Every Figma-origin scalar in plugin inspection (including IDs, names, text,
component keys/descriptions, and page/selection context) is capped at 4,000
UTF-8 bytes. The response includes
`scalar_field_limit`, `truncatedFieldCount`, `omittedScalarBytes`, and per-node
`truncatedFields` byte counts. Scalar compaction does not change node counts or
`omittedNodeCount`.

For compatibility, `nodeCount` continues to count every serialized tree entry,
including synthetic `COLLAPSED` and `TRUNCATED` markers. Use
`returnedNodeCount` for the number of real source nodes present and
`totalNodeCount` for the real source-node total before omissions. A
result-limited plugin tree cannot count the remaining tree without defeating
its work bound, so its node and omission counts are lower bounds with
`totalNodeCountExact: false` and `omittedNodeCountExact: false`;
selection responses separately include `selectionCount` and bounded
`selectionMetadata`. Size-limited responses retain the legacy `note` field
alongside the structured metadata.

`figma_find_nodes` echoes the requested relative traversal depth as `traversalDepth`
(the requested root is depth 0), its match cap as `matchLimit`, and plugin work
caps as `scanLimit` / `scanLimitReached`. Its `truncated` flag is true after an
additional match or an incomplete scan; `truncationReasons` says which bound
stopped the read. An exact-limit complete result is not mislabeled.

For the legacy whole-file published-component REST listing, omit both `root`
and `nodeId`. Follow `nextOffset` by passing it back as `offset`; a response
without `nextOffset` is terminal. Explicit `current-page` and `selection` roots
never fall back to this whole-file listing and therefore require a matching
plugin. An explicit `depth: 0` is preserved on REST node requests.

### Pattern: explore a file

```
1. figma_get_tree on the page frame, not the whole file
2. figma_audit to surface issues
3. figma_extract_tokens only if you actually need token detail
```

## Plan (analysis, no mutations)

These return *action arrays* — validated batches you can then run with `figma_execute`.

| Tool | What it plans |
|---|---|
| `figma_plan_naming` | Semantic renames for generic-named nodes (Rectangle 47 → Header/Logo). |
| `figma_plan_grouping` | Frame grouping for scattered elements. |
| `figma_plan_layout` | Auto-layout conversion from absolute positioning. |
| `figma_plan_components` | Component extraction from repeated patterns. |

Plans are reviewable: the agent inspects, edits, or filters before sending to `figma_execute`.

## Write (`figma_execute` — the fast path)

`figma_execute` batches up to 500 validated actions into a single round-trip. With the plugin connected, the bridge runs them in-process; without it, you get fallback JS for `use_figma`.

Fallback JavaScript preserves `dryRun`, `stopOnError`, and `rollbackOnError` semantics. Rollback requires the host runtime to expose both `figma.commitUndo` and `figma.triggerUndo`; successful and failed batches use explicit undo boundaries so a failed batch cannot undo an earlier successful one. When `rollbackOnError: true`, the tool returns a structured `fallbackLimitations` entry and fails closed before executing any action if either API is unavailable.

54 action types are available. Highlights:

- **Nodes**: `create_frame`, `create_text`, `create_component_from_node`, `create_instance`, `duplicate_node`, `delete_node`
- **Layout**: `set_layout_mode`, `set_child_layout_sizing` (FILL / HUG / FIXED), `set_constraints`, `move`, `resize`
- **Paint/assets**: `set_fills`, `set_strokes`, `set_gradient_fill`, `set_effects`, `set_image_fill`, `create_from_svg`
- **Type**: `set_text_content`, `set_text_style`, `set_text_properties`
- **Styles**: `create_paint_style`, `create_text_style`, `create_effect_style`, name-resolved `apply_style`, `update_style`
- **Variables**: `create_variable_collection`, `create_variable`, name-resolved `bind_variable`, `set_variable_value`
- **Pages**: `create_page`, `switch_page`
- **Components**: component-set properties/references, `set_component_properties`, and nested text/visibility/swap overrides
- **Boards/prototypes**: `create_section`, `resize_section`, `move_to_section`, bounded `set_reaction`

`create_frame` creates a transparent frame (`fills: []`) by default, making it suitable for structural and auto-layout containers. Apply `set_fills` explicitly when the frame should render a background or other visual surface.

See the `figma://actions` MCP resource for the full schema.

### Example

```
figma_execute({
  actions: [
    { type: "create_page", name: "Dashboard", as: "dashboard" },
    { type: "create_frame", name: "Sidebar", parentId: "$dashboard", width: 240, height: 800, as: "sidebar" },
    { type: "create_text", parentId: "$sidebar", characters: "Analytics", fontSize: 24, name: "Sidebar/Title" }
  ],
  dryRun: false,
  stopOnError: true
})
```

Aliases use `as: "name"` and `$name`, and are the recommended stable reference form. `$ref:node-N` remains supported for migration compatibility. Duplicate, malformed, reserved, unknown, self, forward, and cyclic references fail whole-batch preflight before mutation.

Image fills accept exactly one of `imageBase64`, a server-local `path`, or a public HTTP(S) `url`. Local paths are disabled until `FIGMA_ASSET_ROOTS` explicitly lists allowed directories (platform-delimiter separated); roots and files are resolved through realpaths, so traversal and symlink escapes are rejected. The server fully validates PNG, JPEG, or GIF structure, checks the Figma API’s 4096×4096 dimension limit, and enforces a 10 MiB decoded limit before transport. WebP is rejected because the installed Plugin API contract does not support it. URL ingestion times out after 10 seconds, follows at most five redirects, and rejects private, loopback, link-local, and reserved destinations at every hop. SVG creation accepts at most 1 MiB of inert markup and rejects scripts, event handlers, and external resources.

`set_gradient_fill` accepts the legacy single-gradient fields or an ordered `gradients` array for layered linear/radial/angular fills. Each gradient may supply either `angle` or an explicit invertible `gradientTransform`. Text styles are applied after loading the resolved style font; on `create_text`, the style is applied first and explicit typography fields override it second. Section width and height must each be at least `0.01`.

Variable and style names are exact matches. Use `collectionName`/`collectionId` and `resolvedType` to disambiguate variables; duplicate matches are errors. Nested instance operations use `childPath`, where every segment must match exactly one direct child.

Same-batch read-back is intentionally not available yet. It depends on issue #30's plugin-native inspection transport; use a separate inspection call once that foundation lands.

### dryRun

Set `dryRun: true` to validate the action batch without applying it. Useful when an agent is composing a plan and wants to fail fast on schema issues before round-tripping to Figma.

## Codegen

| Tool | Output |
|---|---|
| `figma_map_components` | Match Figma nodes to your code components via signature. |
| `figma_generate_page` | Page template (defaults to Astro). |
| `figma_generate_schema` | CMS schema from Figma structure. |
| `figma_export_tokens` | Tokens as Tailwind config, CSS variables, JSON, or Style Dictionary. |

All token formats include extracted opacity and complete layered shadows. Plain JSON retains a
CSS-compatible `raw` shadow string and adds lossless structured `shadow` layers; Style Dictionary
uses DTCG 2025.10 composite values.

Set `COMPONENT_REGISTRY_DIR` to your code's registry directory so the agent knows what components exist on the code side.

## Common workflows

### 1. Create a design system from a website

```
"Look at https://linear.app and build a matching design system in a new Figma file."
```

Behind the scenes:
1. Browser tools capture the page (colors, fonts, spacing, components)
2. `create_new_file` makes the Figma file
3. `figma_execute` batch-creates paint styles, text styles, components
4. `figma_audit` verifies the result

### 2. Sync design tokens

```
"Sync design tokens from this Figma file to our Tailwind config."
```

1. `figma_get_styles` reads current Figma styles
2. `figma_diff_tokens` compares against your code's tokens
3. `figma_export_tokens` writes the format you want

### 3. Clean up a messy file

```
"Audit this Figma file and clean up naming and layout."
```

1. `figma_audit` finds issues
2. `figma_plan_naming` / `figma_plan_layout` produce action batches
3. `figma_execute` applies them (with the plugin) — or returns JS for `use_figma`
4. `figma_audit` confirms improvements

### 4. Generate code from a Figma page

```
"Generate Astro components from this Figma frame, mapped to our components/ folder."
```

1. `figma_get_tree` to understand structure
2. `figma_map_components` to match Figma nodes to your code
3. `figma_generate_page` to emit templates
4. `figma_export_tokens` to emit your token format

## Tips

- **Start with the plugin.** `figma_execute` is the only path to fast writes. If `figma_plugin_status` says disconnected, prompt to import the plugin before doing anything else write-heavy.
- **Stay focused with `figma_get_tree`.** It auto-truncates at 80KB. For deep files, drill into specific `nodeId`s rather than re-fetching the root.
- **Plans are reviewable.** `figma_plan_*` tools return action arrays — inspect them before piping to `figma_execute`.
- **Token sync without a token.** `figma_diff_tokens` accepts style data inline. You can paste data from the official Figma MCP and skip the REST API entirely.
