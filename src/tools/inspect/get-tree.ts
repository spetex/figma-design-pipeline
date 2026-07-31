import type { ToolContext } from "../../shared/context.js";
import type { EnrichedNode, FigmaRawNode } from "../../shared/types.js";
import type { SnapshotProvenance } from "../../pipeline/snapshot.js";
import { classifyNode } from "../../analysis/node-classifier.js";
import { extractNodeTokens } from "../../analysis/token-extractor.js";

export interface GetTreeParams {
  nodeId: string;
  depth?: number;
  includeStyles?: boolean;
  refresh?: boolean;
  maxAgeMs?: number;
}

/**
 * Compact node — stripped version for LLM consumption.
 * Removes tokens, componentProperties, variantProperties, and
 * collapses leaf vector/shape nodes to reduce context size.
 */
export interface CompactNode {
  id: string;
  name: string;
  type: string;
  classification: string;
  depth: number;
  /** Total direct children in the source tree. */
  childCount: number;
  /** Direct source children represented as nodes in this response. */
  returnedChildCount: number;
  bounds?: { x: number; y: number; width: number; height: number };
  layoutInfo?: EnrichedNode["layoutInfo"];
  textContent?: string;
  isComponent: boolean;
  isInstance: boolean;
  componentId?: string;
  omittedNodeCount?: number;
  continuationNodeId?: string;
  children: CompactNode[];
}

export const DEFAULT_MAX_RESPONSE_BYTES = 80_000;

export type TreeTruncationReason = "vector_compaction" | "response_size_limit";

export interface TreeContinuation {
  reason: TreeTruncationReason;
  nodeId: string;
  omittedNodeCount: number;
}

export interface TruncatedTree {
  tree: CompactNode;
  truncated: boolean;
  omittedNodeCount: number;
  truncationReasons: TreeTruncationReason[];
  continuations: TreeContinuation[];
  /** Number of source nodes actually returned; synthetic markers are excluded. */
  nodeCount: number;
  totalNodeCount: number;
  responseBytes: number;
  maxResponseBytes?: number;
}

export async function handleGetTree(
  ctx: ToolContext,
  params: GetTreeParams
): Promise<{ nodeId: string; tree: EnrichedNode; fromCache: boolean } & SnapshotProvenance> {
  const { nodeId, depth = 10, includeStyles = true, refresh = false, maxAgeMs } = params;
  const cacheKey = snapshotKey(ctx, { nodeId, depth, includeStyles });

  // refresh and maxAgeMs: 0 are explicit cache bypasses.
  const cached = !refresh && maxAgeMs !== 0
    ? ctx.snapshotCache.get(cacheKey, maxAgeMs)
    : null;
  if (cached) {
    return { nodeId, fromCache: true, ...cached };
  }

  // Fetch from REST API
  const data = (await ctx.rest.getFileNodes([nodeId], { depth })) as {
    nodes: Record<string, { document: FigmaRawNode }>;
  };

  const rawRoot = data?.nodes?.[nodeId]?.document;
  if (!rawRoot) {
    throw new Error(`Node ${nodeId} not found in Figma file`);
  }

  // Enrich the tree
  const enriched = enrichNode(rawRoot, 0, includeStyles);

  // Cache the result
  const provenance = ctx.snapshotCache.set(cacheKey, enriched);

  return { nodeId, tree: enriched, fromCache: false, ...provenance };
}

/** A tree snapshot changes with the file, root, REST depth, and enrichment mode. */
function snapshotKey(
  ctx: ToolContext,
  params: Required<Pick<GetTreeParams, "nodeId" | "depth" | "includeStyles">>
): string {
  return JSON.stringify({
    fileKey: ctx.rest.defaultFileKey ?? null,
    nodeId: params.nodeId,
    depth: params.depth,
    includeStyles: params.includeStyles,
  });
}

/**
 * Produce a compact tree for LLM consumption.
 * Strips tokens, componentProperties, variantProperties.
 * Collapses leaf vector/shape nodes (VECTOR, ELLIPSE, LINE, STAR, etc.)
 * into a single summary when there are many siblings.
 */
export function compactTree(node: EnrichedNode, isRequestedRoot = true): CompactNode {
  // Collapse vector-heavy children (e.g., icon SVG paths)
  let children: CompactNode[];
  const vectorTypes = new Set(["VECTOR", "BOOLEAN_OPERATION", "LINE", "ELLIPSE", "STAR", "RECTANGLE"]);
  const vectorChildren: EnrichedNode[] = [];
  const otherChildren: EnrichedNode[] = [];
  for (const c of node.children) {
    (vectorTypes.has(c.type) && c.childCount === 0 ? vectorChildren : otherChildren).push(c);
  }

  // The requested root is an enumeration boundary: never replace its direct
  // children with a synthetic vector summary.
  if (!isRequestedRoot && vectorChildren.length > 3) {
    // Collapse many vector leaves into one placeholder
    children = otherChildren.map(c => compactTree(c, false));
    children.push({
      id: `${node.id}:vectors`,
      name: `[${vectorChildren.length} vector shapes]`,
      type: "COLLAPSED",
      classification: "unknown",
      depth: node.depth + 1,
      childCount: 0,
      returnedChildCount: 0,
      isComponent: false,
      isInstance: false,
      omittedNodeCount: vectorChildren.length,
      continuationNodeId: node.id,
      children: [],
    });
  } else {
    children = node.children.map(c => compactTree(c, false));
  }

  return {
    id: node.id,
    name: node.name,
    type: node.type,
    classification: node.classification,
    depth: node.depth,
    childCount: node.childCount,
    returnedChildCount: countReturnedChildren(children),
    bounds: node.bounds,
    layoutInfo: node.layoutInfo,
    textContent: node.textContent,
    isComponent: node.isComponent,
    isInstance: node.isInstance,
    componentId: node.componentId,
    children,
  };
}

/**
 * Truncate tree to fit within byte budget.
 * Progressively removes deeper children until under limit.
 */
export function truncateTree(node: CompactNode, maxBytes: number): TruncatedTree {
  // pruneAtDepth builds a fresh tree from spreads — no clone needed
  let result = node;
  let responseBytes = byteLength(result);

  for (let maxDepth = 8; responseBytes > maxBytes && maxDepth >= 1; maxDepth--) {
    result = pruneAtDepth(node, maxDepth);
    responseBytes = byteLength(result);
  }

  // A very wide root can exceed the cap even after all descendants are
  // pruned. Only then omit direct children, retaining their IDs as explicit
  // continuations so each omitted subtree remains retrievable.
  const directChildContinuations: TreeContinuation[] = [];
  if (responseBytes > maxBytes) {
    const retainedChildren = [...result.children];
    while (responseBytes > maxBytes && retainedChildren.length > 0) {
      const omitted = retainedChildren.pop()!;
      directChildContinuations.unshift({
        reason: "response_size_limit",
        nodeId: omitted.id,
        omittedNodeCount: countSourceNodes(omitted),
      });
      result = {
        ...result,
        returnedChildCount: countReturnedChildren(retainedChildren),
        children: retainedChildren,
      };
      responseBytes = byteLength(result);
    }
  }

  const summary = summarizeOmissions(result);
  const continuations = [...summary.continuations, ...directChildContinuations];
  const omittedNodeCount = continuations.reduce((sum, entry) => sum + entry.omittedNodeCount, 0);
  const nodeCount = countReturnedNodes(result);
  const truncationReasons = Array.from(new Set(continuations.map(entry => entry.reason)));
  const hitResponseLimit = truncationReasons.includes("response_size_limit");

  return {
    tree: result,
    truncated: omittedNodeCount > 0,
    omittedNodeCount,
    truncationReasons,
    continuations,
    nodeCount,
    totalNodeCount: nodeCount + omittedNodeCount,
    responseBytes,
    ...(hitResponseLimit ? { maxResponseBytes: maxBytes } : {}),
  };
}

function pruneAtDepth(node: CompactNode, maxDepth: number, currentDepth = 0): CompactNode {
  if (currentDepth >= maxDepth && node.children.length > 0) {
    return {
      ...node,
      children: [{
        id: `${node.id}:truncated`,
        name: `[${node.childCount} children omitted — use figma_get_tree with this nodeId for details]`,
        type: "TRUNCATED",
        classification: "unknown",
        depth: currentDepth + 1,
        childCount: 0,
        returnedChildCount: 0,
        isComponent: false,
        isInstance: false,
        omittedNodeCount: node.children.reduce((sum, child) => sum + countSourceNodes(child), 0),
        continuationNodeId: node.id,
        children: [],
      }],
      returnedChildCount: 0,
    };
  }
  return {
    ...node,
    children: node.children.map(c => pruneAtDepth(c, maxDepth, currentDepth + 1)),
  };
}

function countReturnedChildren(children: CompactNode[]): number {
  return children.filter(child => child.type !== "COLLAPSED" && child.type !== "TRUNCATED").length;
}

function countReturnedNodes(node: CompactNode): number {
  if (node.type === "COLLAPSED" || node.type === "TRUNCATED") return 0;
  return 1 + node.children.reduce((sum, child) => sum + countReturnedNodes(child), 0);
}

function countSourceNodes(node: CompactNode): number {
  if (node.type === "COLLAPSED" || node.type === "TRUNCATED") {
    return node.omittedNodeCount ?? 0;
  }
  return 1 + node.children.reduce((sum, child) => sum + countSourceNodes(child), 0);
}

function summarizeOmissions(node: CompactNode): { continuations: TreeContinuation[] } {
  const continuations: TreeContinuation[] = [];
  const visit = (candidate: CompactNode): void => {
    if (candidate.type === "COLLAPSED" || candidate.type === "TRUNCATED") {
      continuations.push({
        reason: candidate.type === "COLLAPSED" ? "vector_compaction" : "response_size_limit",
        nodeId: candidate.continuationNodeId!,
        omittedNodeCount: candidate.omittedNodeCount ?? 0,
      });
      return;
    }
    candidate.children.forEach(visit);
  };
  visit(node);
  return { continuations };
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function enrichNode(
  raw: FigmaRawNode,
  depth: number,
  includeStyles: boolean,
  parentBounds?: { width: number; height: number },
  siblingIndex?: number,
  totalSiblings?: number
): EnrichedNode {
  const classification = classifyNode(raw, parentBounds, siblingIndex, totalSiblings);
  const tokens = includeStyles ? extractNodeTokens(raw) : [];

  const bounds = raw.absoluteBoundingBox;
  const children = (raw.children || []).map((child, i) =>
    enrichNode(
      child,
      depth + 1,
      includeStyles,
      bounds ? { width: bounds.width, height: bounds.height } : undefined,
      i,
      raw.children?.length
    )
  );

  return {
    id: raw.id,
    name: raw.name,
    type: raw.type,
    classification,
    depth,
    childCount: children.length,
    bounds,
    absoluteTransform: raw.absoluteTransform,
    tokens,
    layoutInfo: raw.layoutMode
      ? {
          mode:
            raw.layoutMode === "HORIZONTAL"
              ? "horizontal"
              : raw.layoutMode === "VERTICAL"
                ? "vertical"
                : raw.layoutMode === "GRID"
                  ? "grid"
                : "none",
          spacing: raw.itemSpacing,
          padding:
            raw.paddingTop !== undefined
              ? {
                  top: raw.paddingTop || 0,
                  right: raw.paddingRight || 0,
                  bottom: raw.paddingBottom || 0,
                  left: raw.paddingLeft || 0,
                }
              : undefined,
        }
      : bounds
        ? { mode: "absolute" }
        : undefined,
    textContent: raw.characters,
    isComponent: raw.type === "COMPONENT" || raw.type === "COMPONENT_SET",
    isInstance: raw.type === "INSTANCE",
    componentId: raw.componentId,
    ...(raw.componentProperties ? { componentProperties: raw.componentProperties } : {}),
    ...(raw.componentPropertyDefinitions ? {
      variantProperties: Object.fromEntries(
        Object.entries(raw.componentPropertyDefinitions).map(([k, v]) => [
          k,
          { type: v.type, defaultValue: v.defaultValue, ...(v.variantOptions ? { options: v.variantOptions } : {}) },
        ])
      ),
    } : {}),
    children,
  };
}
