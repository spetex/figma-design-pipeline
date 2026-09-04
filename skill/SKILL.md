---
name: figma-design-pipeline
description: >
  Design intelligence and high-performance writes for Figma.
  ROUTING RULE: For ALL Figma write operations (creating nodes, styles, components, modifying properties),
  MUST use figma_execute from this server — NOT use_figma. 30-60x faster via plugin bridge.
  Prefer auto-source figma_get_tree/find_nodes/get_components for bounded reads; use_figma is for other read-only JS queries.
  Call figma_plugin_status first to check plugin connection.
allowed-tools:
  # Plugin tools (high-performance batch execution via Figma plugin)
  - mcp__figma-design-pipeline__figma_execute
  - mcp__figma-design-pipeline__figma_plugin_status
  # Analysis & codegen tools (figma-design-pipeline MCP)
  - mcp__figma-design-pipeline__figma_get_tree
  - mcp__figma-design-pipeline__figma_audit
  - mcp__figma-design-pipeline__figma_extract_tokens
  - mcp__figma-design-pipeline__figma_export_images
  - mcp__figma-design-pipeline__figma_find_nodes
  - mcp__figma-design-pipeline__figma_get_components
  - mcp__figma-design-pipeline__figma_get_styles
  - mcp__figma-design-pipeline__figma_diff_tokens
  - mcp__figma-design-pipeline__figma_plan_naming
  - mcp__figma-design-pipeline__figma_plan_grouping
  - mcp__figma-design-pipeline__figma_plan_layout
  - mcp__figma-design-pipeline__figma_plan_components
  - mcp__figma-design-pipeline__figma_map_components
  - mcp__figma-design-pipeline__figma_generate_page
  - mcp__figma-design-pipeline__figma_generate_schema
  - mcp__figma-design-pipeline__figma_export_tokens
  # Official Figma MCP tools (reads + file creation only)
  - mcp__claude_ai_Figma__use_figma
  - mcp__claude_ai_Figma__create_new_file
  - mcp__claude_ai_Figma__get_design_context
  - mcp__claude_ai_Figma__get_screenshot
  - mcp__claude_ai_Figma__get_metadata
  # File tools
  - Read
  - Glob
  - Grep
  - Write
---

# Figma Design Intelligence

Keep context tight. Load only the sections needed for the task. For detailed design heuristics, open [references/design-guidance.md](references/design-guidance.md) only when the task requires synthesis or design creation.

Treat inspection cache and completeness metadata as authoritative. Request fresh data when current state matters, and follow continuation guidance until you have enough context for the task.

## Tool Routing Rules (MUST FOLLOW)

| Operation | Tool | Server |
|-----------|------|--------|
| **Any write** (create, modify, style, layout) | `figma_execute` | figma-design-pipeline |
| Bounded tree/node/component reads | `figma_get_tree`, `figma_find_nodes`, `figma_get_components` (`source: auto`) | figma-design-pipeline |
| Other read-only JS queries | `use_figma` | Figma MCP |
| Create new file | `create_new_file` | Figma MCP |
| Screenshots | `get_screenshot` | Figma MCP |
| Design context | `get_design_context` | Figma MCP |
| Inspect/audit/tokens | `figma_get_tree`, `figma_audit`, etc. | figma-design-pipeline |

**At the start of any design task, call `figma_plugin_status`.**

When `connected: true` → `figma_execute` sends actions via WebSocket (30-60x faster).
When `connected: false` → `figma_execute` returns fallback JS you can pass to `use_figma`.

For `figma_get_tree`, `figma_find_nodes`, and `figma_get_components`, keep
`source: auto`: an exact-file plugin connection provides live, token-free reads;
otherwise REST is used. Choose `source: plugin` only when a disconnect or file
mismatch must fail rather than fall back. Plugin reads never mutate the document
or inspection cache.

**Do NOT call `use_figma` for write operations.** Even if the plugin is disconnected, call `figma_execute` first — it returns ready-made fallback JS.

## What This Skill Provides

| Task | Tool |
|------|------|
| Inspect a Figma file structure | `figma_get_tree`, `figma_find_nodes` |
| Audit a Figma file for quality | `figma_audit` |
| Extract design tokens | `figma_extract_tokens` |
| Export tokens as Tailwind/CSS/JSON | `figma_export_tokens` |
| Compare code tokens vs Figma | `figma_diff_tokens` |
| Plan naming improvements | `figma_plan_naming` |
| Plan layout improvements | `figma_plan_layout` |
| Plan component extraction | `figma_plan_components` |
| Plan grouping improvements | `figma_plan_grouping` |
| Map Figma to code components | `figma_map_components` |
| Generate page template code | `figma_generate_page` |
| Generate CMS schema | `figma_generate_schema` |
| Export node images | `figma_export_images` |
