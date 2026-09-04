#!/usr/bin/env node
import "dotenv/config";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FigmaRestClient } from "./shared/figma-rest.js";
import { SnapshotCache } from "./pipeline/snapshot.js";
import { FigmaSession, type FileSelection } from "./shared/figma-session.js";
import { parseFigmaUrl } from "./shared/figma-url.js";
import { parseHarnessInitiator } from "./shared/harness.js";
import type { ToolContext } from "./shared/context.js";
import {
  getTreeInputSchema,
  auditInputSchema,
  extractTokensInputSchema,
  exportImagesInputSchema,
  planNamingInputSchema,
  planGroupingInputSchema,
  planLayoutInputSchema,
  planComponentsInputSchema,
  mapComponentsInputSchema,
  generatePageInputSchema,
  generateSchemaInputSchema,
  exportTokensInputSchema,
  findNodesInputSchema,
  getComponentsInputSchema,
  getStylesInputSchema,
  diffTokensInputSchema,
  executeInputSchema,
  pluginStatusInputSchema,
} from "./shared/types.js";

// ─── Inspect tools ───────────────────────────────────────────────────
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  handleGetTreeFromSource,
  serializeGetTreeResponse,
} from "./tools/inspect/get-tree.js";
import { handleAudit } from "./tools/inspect/audit.js";
import { handleExtractTokens } from "./tools/inspect/extract-tokens.js";
import { handleExportImages } from "./tools/inspect/export-images.js";
import { handleFindNodesFromSource } from "./tools/inspect/find-nodes.js";
import { handleGetComponentsFromSource } from "./tools/inspect/get-components.js";
import { handleGetStyles } from "./tools/inspect/get-styles.js";
import { handleDiffTokens } from "./tools/inspect/diff-tokens.js";

// ─── Plan tools ──────────────────────────────────────────────────────
import { handlePlanNaming } from "./tools/organize/rename-plan.js";
import { handlePlanGrouping } from "./tools/organize/group-plan.js";
import { handlePlanLayout } from "./tools/organize/layout-plan.js";
import { handlePlanComponents } from "./tools/organize/component-plan.js";

// ─── Codegen tools ──────────────────────────────────────────────────
import { handleMapComponents } from "./tools/codegen/map-components.js";
import { handleGeneratePage } from "./tools/codegen/generate-page.js";
import { handleGenerateSchema } from "./tools/codegen/generate-schema.js";
import { handleExportTokens } from "./tools/codegen/export-tokens.js";

// ─── Plugin tools ───────────────────────────────────────────────────
import { BridgeServer, type BridgeHarnessInfo } from "./plugin/bridge.js";
import { handleExecute, invalidateSnapshotsAfterExecute } from "./tools/plugin/execute.js";
import { handlePluginStatus } from "./tools/plugin/status.js";

// ─── Configuration ──────────────────────────────────────────────────

const FIGMA_ACCESS_TOKEN = process.env.FIGMA_ACCESS_TOKEN;
const FIGMA_FILE_KEY = process.env.FIGMA_FILE_KEY; // Optional — can be provided via figmaUrl
let activeFileKey = FIGMA_FILE_KEY;

// Token is optional — all major CLIs (Claude Code, Codex, Gemini) support the official
// Figma MCP via OAuth. The token is only needed for this server's REST API analysis tools.
let rest: FigmaRestClient | null = null;
if (FIGMA_ACCESS_TOKEN) {
  rest = new FigmaRestClient(FIGMA_ACCESS_TOKEN, FIGMA_FILE_KEY);
}

const snapshotCache = new SnapshotCache();
const BRIDGE_PORT = Number(process.env.FIGMA_PLUGIN_PORT || 4010);
const SERVER_VERSION = "0.10.0";
const bridge = new BridgeServer({
  serverVersion: SERVER_VERSION,
  onDocumentChange: () => snapshotCache.invalidateAll(),
});

const figmaSession = new FigmaSession();

function directHarnessFallback(): BridgeHarnessInfo | undefined {
  const harness = bridge.getStatus().harness;
  if (!harness || harness.name === "figma-pipeline-broker") return undefined;
  return harness;
}

function getContext(): ToolContext {
  if (!rest) {
    throw new Error(
      "FIGMA_ACCESS_TOKEN is not set. Set it in your MCP config for REST API access, " +
      "or use the official Figma MCP (available in Claude Code, Codex, and Gemini) which handles auth via OAuth."
    );
  }
  return { rest, snapshotCache };
}

function getInspectionContext() {
  return { rest, snapshotCache, bridge };
}

// ─── URL Resolution ─────────────────────────────────────────────────

function activateFile(selection: FileSelection): void {
  if (!selection.fileChanged) return;
  activeFileKey = selection.fileKey;
  if (rest) rest.defaultFileKey = selection.fileKey;
  snapshotCache.invalidateAll();
  console.error(`[mcp] Switched to Figma file: ${selection.fileKey}${selection.fileName ? ` (${selection.fileName})` : ""}`);
}

/** Update session file key if a new Figma URL is provided. No nodeId required. */
function applyFileKey(params: { figmaUrl?: string }): void {
  if (!params.figmaUrl) return;
  activateFile(figmaSession.applyFileKey(params.figmaUrl, activeFileKey));
}

/** Resolve figmaUrl + nodeId into a concrete nodeId. Throws if no nodeId can be determined. */
function resolveParams(params: { figmaUrl?: string; nodeId?: string }): { nodeId: string } {
  // Activate the URL's file before resolving so a missing node ID still leaves the
  // session on the requested file for a follow-up call with an explicit nodeId.
  applyFileKey(params);
  const resolved = figmaSession.resolveParams(params, activeFileKey);
  return { nodeId: resolved.nodeId };
}

function resolveInspectionFile(params: { figmaUrl?: string }): string {
  applyFileKey(params);
  const pluginFileKey = bridge.getStatus().fileKey;
  if (!activeFileKey && pluginFileKey) {
    activeFileKey = pluginFileKey;
    if (rest) rest.defaultFileKey = pluginFileKey;
  }
  const fileKey = activeFileKey;
  if (!fileKey) {
    throw new Error("No Figma file key is known. Pass figmaUrl or set FIGMA_FILE_KEY.");
  }
  return fileKey;
}

function jsonResponse(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

// ─── MCP Resources (workflow guides) ────────────────────────────────

const INSPECT_GUIDE = `# Figma Inspect Guide

Use this path when the goal is understanding a design, not modifying it.

## Start Small
- Prefer figma_get_tree on a focused node or page frame instead of the whole file.
- Use figma_find_nodes when you already know roughly what you are looking for.
- Use figma_audit when you want a bounded list of structural problems.

## Read Source
- figma_get_tree, figma_find_nodes, and figma_get_components accept source: auto | plugin | rest.
- auto prefers a connected plugin only when its exact figma.fileKey matches the requested file, then falls back to REST. plugin fails closed on disconnect or mismatch. rest always requires FIGMA_ACCESS_TOKEN.
- Plugin reads need no FIGMA_ACCESS_TOKEN, never write to the document or inspection cache, and support node, current-page, and selection roots. They return the safe structural subset rather than REST style/token detail; current-page and selection require the plugin path.
- Plugin traversal is deterministically bounded by depth, result limit, and a visited-node scan limit for searches. Responses distinguish result_limit from scan_limit; tree results retain the existing complete-response 80KB safeguard.

## Recommended Order
1. figma_get_tree
2. figma_audit
3. figma_extract_tokens
4. figma_export_images if you need visual snapshots

## Context Rules
- figma_get_tree preserves requested-root children when possible. Its 80KB cap covers the complete pretty-printed response, including metadata and continuations; responseBytes is the UTF-8 byte length of that exact text.
- Any vector compaction, size pruning, or oversized scalar compaction is explicit through truncated and truncationReasons. Scalar compaction reports truncatedFieldCount, omittedScalarBytes, and per-node truncatedFields.
- Follow directChildren.nextOffset using childOffset for another wide-root page; every emitted nextOffset is strictly greater than the current offset.
- childCount is the source total; returnedChildCount is the number of real direct children present. Follow continuation nodeIds with focused figma_get_tree calls.
- figma_find_nodes supports exact name, linear-time case-insensitive RE2 namePattern regex, and type filters (plus its existing filters). It echoes traversalDepth, matchLimit, and plugin scan-limit metadata.
- Omit both root and nodeId from figma_get_components for its legacy whole-file REST listing, then follow nextOffset with offset. Explicit current-page/selection roots remain plugin-only and never become whole-file fallbacks.
- figma_extract_tokens is the detailed style view. Do not request it unless token detail is actually needed.
- For very large files, keep drilling into specific nodeIds instead of repeating root fetches.
`;

const TOKEN_GUIDE = `# Figma Token Sync Guide

Use this path only for design-token work.

## Read Paths
- figma_extract_tokens: read tokens from the REST API view of the file
- figma_get_styles: read published styles via REST API

## Sync Paths
1. Use the official Figma MCP's use_figma to call figma.getLocalPaintStyles() / getLocalTextStyles() / getLocalEffectStyles()
2. Pass the result to figma_diff_tokens along with your code tokens
3. Use use_figma to create/update styles as needed

Alternative (REST API):
1. figma_get_styles to read published styles (requires FIGMA_ACCESS_TOKEN)
2. figma_diff_tokens to compare
3. Apply changes via the official Figma MCP's use_figma

## Export Paths
- figma_export_tokens with format "tailwind", "css", "json", or "style-dictionary"
`;

const CODEGEN_GUIDE = `# Figma Codegen Guide

Use this path when turning organized Figma structure into code or schema output.

## Recommended Order
1. figma_get_tree
2. figma_map_components
3. figma_generate_page
4. figma_generate_schema

## Registry
- The component registry lives in the target project, not this package.
- Set COMPONENT_REGISTRY_DIR when using map-components or schema/page generation against a project registry.

## Scope
- figma_map_components currently maps the root node and direct significant children.
- Keep generation scoped to a focused page or section node for cleaner output.
`;

const ACTION_REFERENCE = `# figma_execute Action Reference — 55 Action Types

Use with figma_execute({ actions: [...] }) for batch execution via the plugin bridge.
Node-producing actions accept \`as\` (for example \`as: "card"\`); later ID fields can use \`$card\`. Legacy \`$ref:node-N\` references remain supported. The complete reference graph and asset payloads are validated before execution.

## Read-back
- **inspect: { nodeId, depth?, limit?, scanLimit? }** — read-only same-batch tree/property inspection; may reference an earlier alias. Returns bounded IDs, bounds, text, visibility, paints/resolved CSS, style/variable bindings, component state, and truncation/byte metadata. Defaults: depth 2, result limit 100, scan limit 1,000; hard caps: 20/1,000/10,000 plus 4KB per scalar/native property and 80KB aggregate inspection data per batch. \`omittedNodeCount\` is an exact count only when \`omittedNodeCountExact\` is true and otherwise is a nonzero lower bound for result/scan truncation. Rollback removes transient trees and identifiers and marks affected action/inspection metadata \`rolledBack\`.

## Scene Graph
- rename: { nodeId, name }
- move: { nodeId, targetParentId, insertIndex? }
- create_frame: { name, parentId, x?, y?, width?, height?, as? } → returns newNodeId; starts with transparent fills (fills: [])
- delete_node: { nodeId, confirmed: true }
- resize: { nodeId, width?, height? }
- set_position: { nodeId, x?, y? }
- duplicate_node: { nodeId, targetParentId?, insertIndex?, x?, y?, as? } → returns newNodeId
- set_visible: { nodeId, visible }
- set_opacity: { nodeId, opacity: 0-1 }

## Layout
- set_layout_mode: { nodeId, mode: "HORIZONTAL"|"VERTICAL"|"NONE", layoutWrap?: "NO_WRAP"|"WRAP" }
- set_layout_positioning: { nodeId, positioning: "AUTO"|"ABSOLUTE" }
- set_alignment: { nodeId, primaryAxisAlignItems?, counterAxisAlignItems? }
- set_spacing: { nodeId, itemSpacing?, paddingTop/Right/Bottom/Left?, counterAxisSpacing? }
- **set_child_layout_sizing: { nodeId, layoutSizingHorizontal?: "FILL"|"HUG"|"FIXED", layoutSizingVertical? }** — responsive stretching
- **set_constraints: { nodeId, horizontal?: "MIN"|"CENTER"|"MAX"|"STRETCH"|"SCALE", vertical? }** — responsive pinning
- **set_min_max_size: { nodeId, minWidth?, maxWidth?, minHeight?, maxHeight? }** — responsive boundaries

## Appearance
- set_fills: { nodeId, fills: [{ type: "SOLID", color: {r,g,b,a} }] }
- **set_gradient_fill: { nodeId, legacy gradientType/stops/(angle|gradientTransform), or gradients: [{gradientType, stops, angle?|gradientTransform?}] }** — ordered layered gradients
- **set_image_fill: { nodeId, exactly one of imageBase64|path|url, scaleMode? }** — PNG/JPEG/GIF, 4096×4096 and 10 MiB maximum; local paths require FIGMA_ASSET_ROOTS
- **create_from_svg: { parentId, svg, name?, x?, y?, as? }** — inert SVG only, 1 MiB maximum
- set_strokes: { nodeId, strokes, strokeWeight? }
- set_effects: { nodeId, effects }
- set_corner_radius: { nodeId, radius? | radii?: [tl,tr,br,bl] }

## Text
- create_text: { parentId, characters, ..., textTruncation?, maxLines?, textStyleId?|textStyleName?, as? } → returns newNodeId
- set_text_content: { nodeId, characters }
- set_text_style: { nodeId, fontFamily?, fontSize?, fontWeight?, lineHeight?, letterSpacing? }
- **set_text_properties: { nodeId, textAlignHorizontal?, textAlignVertical?, paragraphSpacing?, textCase?, textDecoration?, textAutoResize? }**

## Components
- create_component_from_node: { nodeId, name } → returns newNodeId
- create_component_set: { componentIds[], name } → returns newNodeId
- create_instance: { componentId, parentId, x?, y? } → returns newNodeId
- swap_instance: { instanceId, newComponentId }
- set_component_properties: { nodeId, properties: { "Prop": value } }
- **define_component_property: { nodeId, propertyName, propertyType: "TEXT"|"BOOLEAN"|"INSTANCE_SWAP"|"VARIANT", defaultValue }**
- **set_component_property_reference: { nodeId, property: "characters"|"visible"|"mainComponent", componentPropertyName }**
- **set_instance_text: { instanceId, childPath: [exact names...], characters }**
- **set_instance_visibility: { instanceId, childPath: [exact names...], visible }**
- **swap_nested_instance: { instanceId, childPath: [exact names...], newComponentId }**

## Styles
- create_paint_style: { name, paints } → returns newNodeId
- create_text_style: { name, fontFamily, fontSize, ... } → returns newNodeId
- create_effect_style: { name, effects } → returns newNodeId
- **apply_style: { nodeId, exactly one of styleId|styleName, property: "fill"|"stroke"|"text"|"effect" }**
- **update_style: { styleType, styleId|styleName, copyFromStyleId?|copyFromStyleName?, ...updates }** — update/copy paint, text, or effect styles
- **set_description: { nodeId, description }** — component documentation

## Pages
- **create_page: { name }** → returns newNodeId
- **switch_page: { pageId }** — navigate before creating on a specific page

## Sections and prototypes
- **create_section: { parentId, name, x?, y?, width?, height?, as? }**
- **resize_section: { sectionId, width, height }**
- **move_to_section: { nodeId, sectionId, insertIndex? }**
- **set_reaction: { nodeId, trigger: "ON_CLICK", destinationId, navigation: "NAVIGATE"|"OVERLAY"|"SWAP"|"SCROLL_TO", mode: "append"|"replace" }**

## Variables (Design Tokens)
- **create_variable_collection: { name, modes: ["Light", "Dark"] }** → returns newNodeId
- **create_variable: { collectionId, name, resolvedType: "COLOR"|"FLOAT"|"STRING"|"BOOLEAN", value, scopes? }** → returns newNodeId
- **bind_variable: { nodeId, property, exactly one of variableId|variableName, collectionId?|collectionName?, resolvedType?, paintIndex? }**
- **set_variable_value: { variableId|variableName, collectionId?|collectionName?, modeId|modeName, value }**

## Export
- export_node: { nodeId, format?, scale? }

All name resolution is exact and rejects ambiguity. Inspection actions count as applied but not as mutations; inspect-only batches do not invalidate cached snapshots.
`;

// ─── MCP Server ─────────────────────────────────────────────────────

const server = new McpServer({
  name: "figma-design-pipeline",
  version: SERVER_VERSION,
});

server.server.oninitialized = () => {
  const client = server.server.getClientVersion();
  bridge.setHarnessInfo(client ? { name: client.name, version: client.version } : undefined);
};

const brokerClientsChangedSchema = z.object({
  method: z.literal("notifications/figma_pipeline/clients_changed"),
  params: z.object({
    clients: z.array(z.object({
      name: z.string().min(1).max(128),
      version: z.string().max(64).optional(),
    })).max(32),
  }),
});

server.server.setNotificationHandler(brokerClientsChangedSchema, (notification) => {
  bridge.setHarnesses(notification.params.clients);
});

// ─── MCP Resources ──────────────────────────────────────────────────

server.resource(
  "action-reference",
  "figma://actions",
  { mimeType: "text/markdown", description: "Schema reference for all 55 figma_execute action types, including bounded same-batch inspection. Use with figma_execute({ actions: [...] }) for batch execution." },
  async () => ({
    contents: [{ uri: "figma://actions", mimeType: "text/markdown", text: ACTION_REFERENCE }],
  })
);

server.resource(
  "inspect-guide",
  "figma://inspect",
  { mimeType: "text/markdown", description: "Minimal workflow for read-only structure inspection without overloading context." },
  async () => ({
    contents: [{ uri: "figma://inspect", mimeType: "text/markdown", text: INSPECT_GUIDE }],
  })
);

server.resource(
  "tokens-guide",
  "figma://tokens",
  { mimeType: "text/markdown", description: "Token extraction, diff, export, and sync workflow." },
  async () => ({
    contents: [{ uri: "figma://tokens", mimeType: "text/markdown", text: TOKEN_GUIDE }],
  })
);

server.resource(
  "codegen-guide",
  "figma://codegen",
  { mimeType: "text/markdown", description: "Component mapping and codegen workflow, including registry usage." },
  async () => ({
    contents: [{ uri: "figma://codegen", mimeType: "text/markdown", text: CODEGEN_GUIDE }],
  })
);

// ─── Inspect tools (read-only, via plugin or REST API) ──────────────

server.tool(
  "figma_get_tree",
  "Fetch a bounded Figma node tree from source auto|plugin|rest. auto uses the connected plugin only for an exact file-key match and otherwise falls back to REST; plugin needs no FIGMA_ACCESS_TOKEN and supports node/current-page/selection roots. Results include IDs, names, types, bounds, visibility, children, source, and truncation metadata. The complete serialized response retains the 80KB safeguard; REST snapshots remain keyed by file, node, depth, and style inclusion, while plugin reads never populate or invalidate them.",
  getTreeInputSchema.shape,
  async (params) => {
    const fileKey = resolveInspectionFile(params);
    const root = params.root;
    const nodeId = root === "node" ? resolveParams(params).nodeId : params.nodeId;
    const result = await handleGetTreeFromSource(getInspectionContext(), { ...params, fileKey, nodeId });

    // Track the successful root read together with its file for session continuity.
    if (root === "node" && nodeId) {
      figmaSession.rememberRoot({ fileKey, nodeId });
    }

    const response = serializeGetTreeResponse(result, {
      maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
      childOffset: params.childOffset,
    });

    return {
      content: [{
        type: "text",
        text: response.text,
      }],
    };
  }
);

server.tool(
  "figma_audit",
  "Structural audit: naming, layout, components, tokens, accessibility checks.",
  auditInputSchema.shape,
  async (params) => {
    const { nodeId } = resolveParams(params);
    const result = await handleAudit(getContext(), { ...params, nodeId, maxViolations: params.maxViolations });
    return jsonResponse(result);
  }
);

server.tool(
  "figma_extract_tokens",
  "Extract design tokens (colors, fonts, spacing, radius, layered shadows, opacity) with Tailwind class mapping",
  extractTokensInputSchema.shape,
  async (params) => {
    const { nodeId } = resolveParams(params);
    const result = await handleExtractTokens(getContext(), { ...params, nodeId: nodeId! });
    return jsonResponse(result);
  }
);

server.tool(
  "figma_export_images",
  "Export node renders as images via REST API. Returns temporary Figma-hosted URLs.",
  exportImagesInputSchema.shape,
  async (params) => {
    applyFileKey(params);
    const result = await handleExportImages(getContext(), params);
    return jsonResponse(result);
  }
);

server.tool(
  "figma_find_nodes",
  "Search bounded descendants through source auto|plugin|rest by exact name, linear-time case-insensitive RE2 regex, type, classification, text content, component ID, children, or size. auto prefers an exact-file connected plugin and falls back to REST. Plugin reads need no token and support node/current-page/selection roots. traversalDepth, matchLimit, scanLimit, truncationReasons, and scanLimitReached expose the traversal bounds.",
  findNodesInputSchema.shape,
  async (params) => {
    const fileKey = resolveInspectionFile(params);
    const nodeId = params.root === "node" ? resolveParams(params).nodeId : params.nodeId;
    const result = await handleFindNodesFromSource(getInspectionContext(), { ...params, fileKey, nodeId });
    return jsonResponse(result);
  }
);

server.tool(
  "figma_get_components",
  "Discover COMPONENT and COMPONENT_SET names and node IDs under a bounded node/current-page/selection root through source auto|plugin|rest. auto prefers an exact-file connected plugin without requiring FIGMA_ACCESS_TOKEN. Omit both root and nodeId for the paginated whole-file REST listing and follow nextOffset with offset; explicit current-page/selection roots remain plugin-only.",
  getComponentsInputSchema.shape,
  async (params) => {
    const fileKey = resolveInspectionFile(params);
    const urlNodeId = params.figmaUrl ? parseFigmaUrl(params.figmaUrl).nodeId : undefined;
    const requestedNodeId = params.nodeId ?? urlNodeId;
    const root = params.root ?? (requestedNodeId ? "node" as const : undefined);
    const nodeId = root === "node" ? resolveParams(params).nodeId : requestedNodeId;
    const result = await handleGetComponentsFromSource(
      getInspectionContext(),
      { ...params, root, fileKey, nodeId }
    );
    return jsonResponse(result);
  }
);

server.tool(
  "figma_get_styles",
  "List all published styles (colors, text, effects, grids) in a Figma file. Uses REST API.",
  getStylesInputSchema.shape,
  async (params) => {
    applyFileKey(params);
    const result = await handleGetStyles(getContext());
    return jsonResponse(result);
  }
);

server.tool(
  "figma_diff_tokens",
  "Compare Figma styles vs provided tokens. Provide figmaStyles data (from official Figma MCP's use_figma or REST API). Reports drift: figmaOnly, codeOnly, changed, matched. No FIGMA_ACCESS_TOKEN needed.",
  diffTokensInputSchema.shape,
  async (params) => {
    applyFileKey(params);
    const result = handleDiffTokens(params);
    return jsonResponse(result);
  }
);

// ─── Plan tools ─────────────────────────────────────────────────────

server.tool(
  "figma_plan_naming",
  "Generate semantic rename plan for generic-named nodes. Returns actions array for use with the official Figma MCP's use_figma tool.",
  planNamingInputSchema.shape,
  async (params) => {
    const { nodeId } = resolveParams(params);
    const result = await handlePlanNaming(getContext(), { ...params, nodeId });
    return jsonResponse(result);
  }
);

server.tool(
  "figma_plan_grouping",
  "Plan semantic frame grouping for scattered elements. Returns actions array for use with the official Figma MCP's use_figma tool.",
  planGroupingInputSchema.shape,
  async (params) => {
    const { nodeId } = resolveParams(params);
    const result = await handlePlanGrouping(getContext(), { ...params, nodeId });
    return jsonResponse(result);
  }
);

server.tool(
  "figma_plan_layout",
  "Plan auto-layout conversion from absolute positioning. Returns actions array for use with the official Figma MCP's use_figma tool.",
  planLayoutInputSchema.shape,
  async (params) => {
    const { nodeId } = resolveParams(params);
    const result = await handlePlanLayout(getContext(), { ...params, nodeId });
    return jsonResponse(result);
  }
);

server.tool(
  "figma_plan_components",
  "Plan component extraction from repeated visual patterns. Returns actions array for use with the official Figma MCP's use_figma tool.",
  planComponentsInputSchema.shape,
  async (params) => {
    const { nodeId } = resolveParams(params);
    const result = await handlePlanComponents(getContext(), { ...params, nodeId });
    return jsonResponse(result);
  }
);

// ─── Codegen tools ──────────────────────────────────────────────────

server.tool(
  "figma_map_components",
  "Map Figma nodes to codebase components using signature matching and hints",
  mapComponentsInputSchema.shape,
  async (params) => {
    const { nodeId } = resolveParams(params);
    const result = await handleMapComponents(getContext(), { ...params, nodeId });
    return jsonResponse(result);
  }
);

server.tool(
  "figma_generate_page",
  "Generate an Astro page template from organized Figma design",
  generatePageInputSchema.shape,
  async (params) => {
    const { nodeId } = resolveParams(params);
    const result = await handleGeneratePage(getContext(), { ...params, nodeId });
    return jsonResponse(result);
  }
);

server.tool(
  "figma_generate_schema",
  "Generate a CMS ContentSchema definition from Figma design structure",
  generateSchemaInputSchema.shape,
  async (params) => {
    const { nodeId } = resolveParams(params);
    const result = await handleGenerateSchema(getContext(), { ...params, nodeId });
    return jsonResponse(result);
  }
);

server.tool(
  "figma_export_tokens",
  "Export extracted design tokens as Tailwind config, CSS variables, JSON, or DTCG Style Dictionary",
  exportTokensInputSchema.shape,
  async (params) => {
    const { nodeId } = resolveParams(params);
    const result = await handleExportTokens(getContext(), { ...params, nodeId });
    return jsonResponse(result);
  }
);

// ─── Plugin tools (high-performance batch execution) ────────────────

server.tool(
  "figma_execute",
  "PREFERRED TOOL for ALL Figma write operations. Execute a batch of validated actions via plugin bridge — 30-60x faster than use_figma. Do NOT use use_figma for writes; use this tool instead. Supports 55 action types including bounded same-batch inspect read-back, design-system components, nested overrides, name-resolved variables/styles, safe assets, sections, reactions, layout, and text. If plugin not connected, returns equivalent bounded fallback JavaScript for use_figma. Call figma_plugin_status to check connection.",
  executeInputSchema.shape,
  async (params, extra) => {
    const result = await handleExecute(bridge, {
      actions: params.actions,
      initiator: parseHarnessInitiator(extra._meta) ?? directHarnessFallback(),
      dryRun: params.dryRun,
      stopOnError: params.stopOnError,
      rollbackOnError: params.rollbackOnError,
      timeoutMs: params.timeoutMs,
    });
    const cacheInvalidated = invalidateSnapshotsAfterExecute(snapshotCache, result);
    return jsonResponse({ ...result, cacheInvalidated });
  }
);

server.tool(
  "figma_plugin_status",
  "Check if the Figma plugin is connected. Returns exact file key, plugin version, current page, pending batches, and pending reads.",
  pluginStatusInputSchema.shape,
  async () => {
    return jsonResponse(handlePluginStatus(bridge));
  }
);

// ─── Start ──────────────────────────────────────────────────────────

async function main() {
  // Start the plugin bridge (non-fatal if port is busy)
  try {
    const port = await bridge.start(BRIDGE_PORT);
    console.error(`[mcp] Plugin bridge listening on ws://127.0.0.1:${port}/plugin`);
  } catch (err) {
    console.error(`[mcp] Plugin bridge failed to start: ${err instanceof Error ? err.message : err}`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[mcp] Figma Design Pipeline MCP server running (stdio)");
  if (FIGMA_ACCESS_TOKEN) {
    if (FIGMA_FILE_KEY) {
      console.error(`[mcp] Default file key: ${FIGMA_FILE_KEY}`);
    } else {
      console.error("[mcp] No default file key — pass a Figma URL with any tool call");
    }
  } else {
    console.error("[mcp] No FIGMA_ACCESS_TOKEN — REST API tools require a token. All major CLIs support the official Figma MCP for OAuth-based access.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
