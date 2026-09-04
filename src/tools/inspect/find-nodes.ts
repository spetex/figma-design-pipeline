import type { ToolContext } from "../../shared/context.js";
import type { EnrichedNode, NodeClassification } from "../../shared/types.js";
import { handleGetTree } from "./get-tree.js";
import type { SnapshotProvenance } from "../../pipeline/snapshot.js";
import type { InspectionSource, PluginReadNode, PluginReadRoot } from "../../shared/plugin-read.js";
import type { InspectionContext } from "./source.js";
import { requireRest, selectInspectionSource } from "./source.js";
import { compileInspectionRegex } from "../../shared/safe-regex.js";

export interface FindNodesParams {
  nodeId: string;
  name?: string;
  namePattern?: string;
  type?: string;
  classification?: NodeClassification;
  textContent?: string;
  componentId?: string;
  hasChildren?: boolean;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  limit?: number;
  depth?: number;
  refresh?: boolean;
  maxAgeMs?: number;
}

export interface FindNodesSourceParams extends Omit<FindNodesParams, "nodeId"> {
  nodeId?: string;
  fileKey: string;
  source?: InspectionSource;
  root?: PluginReadRoot;
  timeoutMs?: number;
  scanLimit?: number;
}

export interface FoundNode {
  id: string;
  name: string;
  type: string;
  classification: NodeClassification;
  depth: number;
  childCount: number;
  visible?: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  textContent?: string;
  componentId?: string;
  isComponent: boolean;
  isInstance: boolean;
}

export interface FindNodesResult extends SnapshotProvenance {
  matches: FoundNode[];
  totalScanned: number;
  truncated: boolean;
  traversalDepth: number;
  matchLimit: number;
  scanLimit?: number;
  scanLimitReached?: boolean;
  truncationReasons?: Array<"result_limit" | "scan_limit">;
  fromCache: boolean;
  source: "plugin" | "rest";
  currentPage?: { id: string; name: string };
  selection?: Array<{ id: string; name: string; type: string }>;
}

/**
 * Search/filter nodes in a Figma tree by various criteria.
 * Uses the cached enriched tree to avoid re-fetching.
 */
export async function handleFindNodes(
  ctx: ToolContext,
  params: FindNodesParams
): Promise<FindNodesResult> {
  const { nodeId, limit = 50, depth = 10, refresh = false, maxAgeMs } = params;

  // Get enriched tree (uses cache if available)
  const { tree, fromCache, snapshotAt, cacheAgeMs } = await handleGetTree(ctx, {
    nodeId,
    depth,
    includeStyles: false,
    refresh,
    maxAgeMs,
  });

  const matches: FoundNode[] = [];
  let totalScanned = 0;
  let hasAdditionalMatch = false;

  const nameRegex = compileInspectionRegex(params.namePattern, "namePattern");
  const textRegex = compileInspectionRegex(params.textContent, "textContent");

  walkTree(tree, (node) => {
    totalScanned++;

    // Apply filters — all must match
    if (params.name !== undefined && node.name !== params.name) return true;
    if (nameRegex && !nameRegex.test(node.name)) return true;
    if (params.type && node.type.toUpperCase() !== params.type.toUpperCase()) return true;
    if (params.classification && node.classification !== params.classification) return true;
    if (textRegex && (!node.textContent || !textRegex.test(node.textContent))) return true;
    if (params.componentId && node.componentId !== params.componentId) return true;
    if (params.hasChildren !== undefined) {
      if (params.hasChildren && node.childCount === 0) return true;
      if (!params.hasChildren && node.childCount > 0) return true;
    }
    if (params.minWidth !== undefined && (!node.bounds || node.bounds.width < params.minWidth)) return true;
    if (params.maxWidth !== undefined && (!node.bounds || node.bounds.width > params.maxWidth)) return true;
    if (params.minHeight !== undefined && (!node.bounds || node.bounds.height < params.minHeight)) return true;
    if (params.maxHeight !== undefined && (!node.bounds || node.bounds.height > params.maxHeight)) return true;

    if (matches.length >= limit) {
      hasAdditionalMatch = true;
      return false;
    }

    matches.push({
      id: node.id,
      name: node.name,
      type: node.type,
      classification: node.classification,
      depth: node.depth,
      childCount: node.childCount,
      visible: node.visible,
      bounds: node.bounds,
      textContent: node.textContent,
      componentId: node.componentId,
      isComponent: node.isComponent,
      isInstance: node.isInstance,
    });
    return true;
  });

  return {
    matches,
    totalScanned,
    truncated: hasAdditionalMatch,
    traversalDepth: depth,
    matchLimit: limit,
    fromCache,
    source: "rest",
    snapshotAt,
    cacheAgeMs,
  };
}

export async function handleFindNodesFromSource(
  ctx: InspectionContext,
  params: FindNodesSourceParams
): Promise<FindNodesResult> {
  const source = selectInspectionSource(ctx, params.source ?? "auto", params.fileKey);
  const depth = params.depth ?? 10;
  const limit = params.limit ?? 50;
  const scanLimit = params.scanLimit ?? 1_000;
  compileInspectionRegex(params.namePattern, "namePattern");
  compileInspectionRegex(params.textContent, "textContent");
  if (source === "rest") {
    if ((params.root ?? "node") !== "node") {
      throw new Error(`${params.root} is available only with plugin inspection`);
    }
    if (!params.nodeId) throw new Error("nodeId is required for REST node search");
    return handleFindNodes(
      { rest: requireRest(ctx), snapshotCache: ctx.snapshotCache },
      { ...params, nodeId: params.nodeId }
    );
  }

  const response = await ctx.bridge.read({
    operation: "find",
    fileKey: params.fileKey,
    root: params.root ?? "node",
    ...(params.nodeId ? { nodeId: params.nodeId } : {}),
    depth,
    limit,
    scanLimit,
    filters: {
      name: params.name,
      namePattern: params.namePattern,
      type: params.type,
      classification: params.classification,
      textContent: params.textContent,
      componentId: params.componentId,
      hasChildren: params.hasChildren,
      minWidth: params.minWidth,
      maxWidth: params.maxWidth,
      minHeight: params.minHeight,
      maxHeight: params.maxHeight,
    },
  }, params.timeoutMs);
  return {
    matches: response.matches.map(pluginFoundNode),
    totalScanned: response.totalScanned,
    truncated: response.truncated,
    traversalDepth: response.traversalDepth,
    matchLimit: response.resultLimit,
    scanLimit: response.scanLimit,
    scanLimitReached: response.scanLimitReached,
    truncationReasons: response.truncationReasons,
    fromCache: false,
    source: "plugin",
    snapshotAt: new Date().toISOString(),
    cacheAgeMs: 0,
    currentPage: response.currentPage,
    selection: response.selection,
  };
}

function pluginFoundNode(node: PluginReadNode): FoundNode {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    classification: node.classification as NodeClassification,
    depth: node.depth,
    childCount: node.childCount,
    visible: node.visible,
    bounds: node.bounds,
    textContent: node.textContent,
    componentId: node.componentId,
    isComponent: node.type === "COMPONENT" || node.type === "COMPONENT_SET",
    isInstance: node.type === "INSTANCE",
  };
}

function walkTree(node: EnrichedNode, visit: (n: EnrichedNode) => boolean): boolean {
  if (!visit(node)) return false;
  for (const child of node.children) {
    if (!walkTree(child, visit)) return false;
  }
  return true;
}
