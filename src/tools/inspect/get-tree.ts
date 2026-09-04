import type { ToolContext } from "../../shared/context.js";
import type { EnrichedNode, FigmaRawNode } from "../../shared/types.js";
import type { SnapshotProvenance } from "../../pipeline/snapshot.js";
import { classifyNode } from "../../analysis/node-classifier.js";
import { extractNodeTokens } from "../../analysis/token-extractor.js";
import type { InspectionSource, PluginReadNode, PluginReadRoot } from "../../shared/plugin-read.js";
import type { InspectionContext } from "./source.js";
import { requireRest, selectInspectionSource } from "./source.js";

export interface GetTreeParams {
  nodeId: string;
  depth?: number;
  includeStyles?: boolean;
  childOffset?: number;
  refresh?: boolean;
  maxAgeMs?: number;
}

export interface GetTreeSourceParams extends Omit<GetTreeParams, "nodeId"> {
  nodeId?: string;
  fileKey: string;
  source?: InspectionSource;
  root?: PluginReadRoot;
  limit?: number;
  timeoutMs?: number;
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
  visible?: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  layoutInfo?: EnrichedNode["layoutInfo"];
  textContent?: string;
  isComponent: boolean;
  isInstance: boolean;
  componentId?: string;
  omittedNodeCount?: number;
  continuationNodeId?: string;
  truncatedFields?: Partial<Record<"name" | "textContent", {
    originalBytes: number;
    returnedBytes: number;
  }>>;
  children: CompactNode[];
}

export const DEFAULT_MAX_RESPONSE_BYTES = 80_000;

export type TreeTruncationReason =
  | "vector_compaction"
  | "response_size_limit"
  | "scalar_field_limit"
  | "result_limit";

export interface TreeContinuation {
  reason: TreeTruncationReason;
  nodeId: string;
  omittedNodeCount: number;
  childOffset?: number;
}

export interface TruncatedTree {
  tree: CompactNode;
  truncated: boolean;
  omittedNodeCount: number;
  truncatedFieldCount: number;
  omittedScalarBytes: number;
  truncationReasons: TreeTruncationReason[];
  continuations: TreeContinuation[];
  /** Number of source nodes actually returned; synthetic markers are excluded. */
  returnedNodeCount: number;
  /** Serialized tree nodes, including COLLAPSED and TRUNCATED markers. */
  nodeCount: number;
  totalNodeCount: number;
  responseBytes: number;
  maxResponseBytes?: number;
}

export interface GetTreeResponsePayload {
  nodeId: string;
  fromCache: boolean;
  snapshotAt: string;
  cacheAgeMs: number;
  nodeCount: number;
  returnedNodeCount: number;
  totalNodeCount: number;
  truncated: boolean;
  omittedNodeCount: number;
  truncatedFieldCount: number;
  omittedScalarBytes: number;
  truncationReasons: TreeTruncationReason[];
  continuations: TreeContinuation[];
  responseBytes: number;
  maxResponseBytes?: number;
  source: "plugin" | "rest";
  traversalDepth: number;
  resultLimit?: number;
  note?: string;
  directChildren?: {
    offset: number;
    returned: number;
    total: number;
    nextOffset?: number;
  };
  tree: CompactNode;
}

export interface SerializedGetTreeResponse {
  payload: GetTreeResponsePayload;
  text: string;
}

export interface GetTreeResult extends SnapshotProvenance {
  nodeId: string;
  tree: EnrichedNode;
  fromCache: boolean;
  source: "plugin" | "rest";
  traversalDepth: number;
  resultLimit?: number;
  sourceOmittedNodeCount?: number;
}

export async function handleGetTree(
  ctx: ToolContext,
  params: GetTreeParams
): Promise<GetTreeResult> {
  const { nodeId, depth = 10, includeStyles = true, refresh = false, maxAgeMs } = params;
  const cacheKey = snapshotKey(ctx, { nodeId, depth, includeStyles });

  // refresh and maxAgeMs: 0 are explicit cache bypasses.
  const cached = !refresh && maxAgeMs !== 0
    ? ctx.snapshotCache.get(cacheKey, maxAgeMs)
    : null;
  if (cached) {
    return { nodeId, fromCache: true, source: "rest", traversalDepth: depth, ...cached };
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

  return { nodeId, tree: enriched, fromCache: false, source: "rest", traversalDepth: depth, ...provenance };
}

export async function handleGetTreeFromSource(
  ctx: InspectionContext,
  params: GetTreeSourceParams
): Promise<GetTreeResult> {
  const source = selectInspectionSource(ctx, params.source ?? "auto", params.fileKey);
  const depth = params.depth ?? 10;
  if (source === "rest") {
    if ((params.root ?? "node") !== "node") {
      throw new Error(`${params.root} is available only with plugin inspection`);
    }
    if (!params.nodeId) throw new Error("nodeId is required for REST tree inspection");
    const restResult = await handleGetTree(
      { rest: requireRest(ctx), snapshotCache: ctx.snapshotCache },
      { ...params, nodeId: params.nodeId }
    );
    return { ...restResult, source: "rest", traversalDepth: depth };
  }

  const limit = params.limit ?? 500;
  const response = await ctx.bridge.read({
    operation: "tree",
    fileKey: params.fileKey,
    root: params.root ?? "node",
    ...(params.nodeId ? { nodeId: params.nodeId } : {}),
    depth,
    limit,
  }, params.timeoutMs);
  const roots = response.roots.map(pluginNodeToEnriched);
  const root = (params.root ?? "node") === "selection"
    ? selectionRoot(roots)
    : roots[0];
  if (!root) {
    throw new Error((params.root ?? "node") === "selection"
      ? "Current selection is empty"
      : `Node ${params.nodeId ?? "root"} not found in Figma file`);
  }
  const syntheticCount = (params.root ?? "node") === "selection" ? 1 : 0;
  const returnedCount = response.returnedCount + syntheticCount;
  const totalNodeCount = (response.totalNodeCount ?? response.returnedCount) + syntheticCount;
  return {
    nodeId: root.id,
    tree: root,
    fromCache: false,
    snapshotAt: new Date().toISOString(),
    cacheAgeMs: 0,
    source: "plugin",
    traversalDepth: depth,
    resultLimit: limit,
    sourceOmittedNodeCount: Math.max(0, totalNodeCount - returnedCount),
  };
}

function selectionRoot(children: EnrichedNode[]): EnrichedNode {
  return {
    id: "selection",
    name: "Current selection",
    type: "SELECTION",
    classification: "container",
    depth: 0,
    childCount: children.length,
    visible: true,
    tokens: [],
    isComponent: false,
    isInstance: false,
    children: children.map((child) => rebaseDepth(child, 1)),
  };
}

function rebaseDepth(node: EnrichedNode, depth: number): EnrichedNode {
  return { ...node, depth, children: node.children.map((child) => rebaseDepth(child, depth + 1)) };
}

function pluginNodeToEnriched(node: PluginReadNode, depth = 0): EnrichedNode {
  const raw: FigmaRawNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    absoluteBoundingBox: node.bounds,
    characters: node.textContent,
    componentId: node.componentId,
    layoutMode: node.layoutMode,
    itemSpacing: node.itemSpacing,
    paddingLeft: node.paddingLeft,
    paddingRight: node.paddingRight,
    paddingTop: node.paddingTop,
    paddingBottom: node.paddingBottom,
    children: node.children.map(pluginNodeToRaw),
  };
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    classification: node.classification as EnrichedNode["classification"],
    depth: node.depth,
    childCount: node.childCount,
    visible: node.visible,
    bounds: node.bounds,
    tokens: [],
    layoutInfo: extractLayoutInfo(raw),
    textContent: node.textContent,
    isComponent: node.type === "COMPONENT" || node.type === "COMPONENT_SET",
    isInstance: node.type === "INSTANCE",
    componentId: node.componentId,
    children: node.children.map((child) => pluginNodeToEnriched(child, depth + 1)),
  };
}

function pluginNodeToRaw(node: PluginReadNode): FigmaRawNode {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    absoluteBoundingBox: node.bounds,
    characters: node.textContent,
    componentId: node.componentId,
    children: node.children.map(pluginNodeToRaw),
  };
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
    visible: node.visible,
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
  const returnedNodeCount = countReturnedNodes(result);
  const nodeCount = countSerializedNodes(result);
  const truncationReasons = Array.from(new Set(continuations.map(entry => entry.reason)));
  const hitResponseLimit = truncationReasons.includes("response_size_limit");

  return {
    tree: result,
    truncated: omittedNodeCount > 0,
    omittedNodeCount,
    truncatedFieldCount: 0,
    omittedScalarBytes: 0,
    truncationReasons,
    continuations,
    nodeCount,
    returnedNodeCount,
    totalNodeCount: returnedNodeCount + omittedNodeCount,
    responseBytes,
    ...(hitResponseLimit ? { maxResponseBytes: maxBytes } : {}),
  };
}

/**
 * Build the exact pretty-printed MCP text while enforcing the byte cap against
 * that complete serialization, including metadata and continuations.
 */
export function serializeGetTreeResponse(
  result: GetTreeResult,
  {
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    childOffset = 0,
  }: { maxResponseBytes?: number; childOffset?: number } = {}
): SerializedGetTreeResponse {
  if (childOffset > result.tree.children.length) {
    throw new Error(
      `childOffset ${childOffset} exceeds root childCount ${result.tree.children.length}`
    );
  }

  const precedingChildren = result.tree.children.slice(0, childOffset);
  const pageRoot: EnrichedNode = {
    ...result.tree,
    children: result.tree.children.slice(childOffset),
  };
  const compact = compactTree(pageRoot);
  const precedingOmittedNodeCount = precedingChildren.reduce(
    (sum, child) => sum + countEnrichedNodes(child),
    0
  );

  let outputTree = compact;
  let directContinuation: TreeContinuation | undefined;
  let serialized = serializeCandidate(
    result,
    outputTree,
    maxResponseBytes,
    childOffset,
    precedingOmittedNodeCount,
    directContinuation
  );

  for (let maxDepth = 8; serialized.payload.responseBytes > maxResponseBytes && maxDepth >= 1; maxDepth--) {
    outputTree = pruneAtDepth(compact, maxDepth);
    serialized = serializeCandidate(
      result,
      outputTree,
      maxResponseBytes,
      childOffset,
      precedingOmittedNodeCount,
      directContinuation
    );
  }

  if (serialized.payload.responseBytes > maxResponseBytes) {
    outputTree = pruneOversizedScalarFields(outputTree);
    serialized = serializeCandidate(
      result,
      outputTree,
      maxResponseBytes,
      childOffset,
      precedingOmittedNodeCount,
      directContinuation
    );
  }

  if (serialized.payload.responseBytes > maxResponseBytes) {
    const retainedChildren = [...outputTree.children];
    let omittedDirectNodeCount = 0;
    while (serialized.payload.responseBytes > maxResponseBytes && retainedChildren.length > 1) {
      const omitted = retainedChildren.pop()!;
      omittedDirectNodeCount += countSourceNodes(omitted);
      const nextOffset = childOffset + retainedChildren.length;
      if (nextOffset <= childOffset) {
        throw new Error("figma_get_tree pagination did not advance");
      }
      directContinuation = {
        reason: "response_size_limit",
        nodeId: result.nodeId,
        omittedNodeCount: omittedDirectNodeCount,
        childOffset: nextOffset,
      };
      outputTree = {
        ...outputTree,
        returnedChildCount: countReturnedChildren(retainedChildren),
        children: retainedChildren,
      };
      serialized = serializeCandidate(
        result,
        outputTree,
        maxResponseBytes,
        childOffset,
        precedingOmittedNodeCount,
        directContinuation
      );
    }
  }

  if (serialized.payload.responseBytes > maxResponseBytes) {
    throw new Error(
      `Unable to serialize figma_get_tree response within ${maxResponseBytes} bytes after omitting all child nodes`
    );
  }

  return serialized;
}

function serializeCandidate(
  result: GetTreeResult,
  tree: CompactNode,
  maxResponseBytes: number,
  childOffset: number,
  precedingOmittedNodeCount: number,
  directContinuation?: TreeContinuation
): SerializedGetTreeResponse {
  const summarized = summarizeOmissions(tree).continuations;
  const scalarSummary = summarizeScalarTruncations(tree);
  const continuations = directContinuation
    ? [...summarized, directContinuation]
    : summarized;
  const continuationOmissions = continuations.reduce(
    (sum, continuation) => sum + continuation.omittedNodeCount,
    0
  );
  const sourceOmittedNodeCount = result.sourceOmittedNodeCount ?? 0;
  const omittedNodeCount = precedingOmittedNodeCount + continuationOmissions + sourceOmittedNodeCount;
  const returnedNodeCount = countReturnedNodes(tree);
  const nodeCount = countSerializedNodes(tree);
  const responseSizeLimited = precedingOmittedNodeCount > 0 || continuations.some(
    continuation => continuation.reason === "response_size_limit"
  ) || scalarSummary.truncatedFieldCount > 0;
  const truncationReasons = Array.from(new Set([
    ...(precedingOmittedNodeCount > 0 ? ["response_size_limit" as const] : []),
    ...continuations.map(continuation => continuation.reason),
    ...(scalarSummary.truncatedFieldCount > 0 ? ["scalar_field_limit" as const] : []),
    ...(sourceOmittedNodeCount > 0 ? ["result_limit" as const] : []),
  ]));
  const nextOffset = directContinuation?.childOffset;
  const directChildren = childOffset > 0 || nextOffset !== undefined
    ? {
        offset: childOffset,
        returned: tree.returnedChildCount,
        total: tree.childCount,
        ...(nextOffset !== undefined ? { nextOffset } : {}),
      }
    : undefined;

  const withoutBytes = {
    nodeId: result.nodeId,
    source: result.source,
    traversalDepth: result.traversalDepth,
    ...(result.resultLimit !== undefined ? { resultLimit: result.resultLimit } : {}),
    fromCache: result.fromCache,
    snapshotAt: result.snapshotAt,
    cacheAgeMs: result.cacheAgeMs,
    nodeCount,
    returnedNodeCount,
    totalNodeCount: returnedNodeCount + omittedNodeCount,
    truncated: omittedNodeCount > 0 || scalarSummary.truncatedFieldCount > 0,
    omittedNodeCount,
    truncatedFieldCount: scalarSummary.truncatedFieldCount,
    omittedScalarBytes: scalarSummary.omittedScalarBytes,
    truncationReasons,
    continuations,
    ...(responseSizeLimited ? { maxResponseBytes } : {}),
    ...(responseSizeLimited || sourceOmittedNodeCount > 0 ? {
      note: sourceOmittedNodeCount > 0
        ? "Plugin result limit reached — use a focused nodeId or increase limit to continue."
        : "Tree exceeded 80KB — deeper children omitted. Use figma_get_tree on specific nodeIds to drill down.",
    } : {}),
    ...(directChildren ? { directChildren } : {}),
    tree,
  };

  let responseBytes = 0;
  let text = "";
  for (;;) {
    const payload: GetTreeResponsePayload = { ...withoutBytes, responseBytes };
    text = JSON.stringify(payload, null, 2);
    const measuredBytes = Buffer.byteLength(text, "utf8");
    if (measuredBytes === responseBytes) return { payload, text };
    responseBytes = measuredBytes;
  }
}

const MAX_SCALAR_FIELD_BYTES = 4_000;

function pruneOversizedScalarFields(node: CompactNode): CompactNode {
  const name = truncateUtf8(node.name, MAX_SCALAR_FIELD_BYTES);
  const textContent = node.textContent === undefined
    ? undefined
    : truncateUtf8(node.textContent, MAX_SCALAR_FIELD_BYTES);
  const truncatedFields: CompactNode["truncatedFields"] = {
    ...(name.truncated ? {
      name: { originalBytes: name.originalBytes, returnedBytes: name.returnedBytes },
    } : {}),
    ...(textContent?.truncated ? {
      textContent: {
        originalBytes: textContent.originalBytes,
        returnedBytes: textContent.returnedBytes,
      },
    } : {}),
  };

  return {
    ...node,
    name: name.value,
    ...(textContent ? { textContent: textContent.value } : {}),
    ...(Object.keys(truncatedFields).length > 0 ? { truncatedFields } : {}),
    children: node.children.map(pruneOversizedScalarFields),
  };
}

function truncateUtf8(value: string, maxBytes: number): {
  value: string;
  originalBytes: number;
  returnedBytes: number;
  truncated: boolean;
} {
  const originalBytes = Buffer.byteLength(value, "utf8");
  if (originalBytes <= maxBytes) {
    return { value, originalBytes, returnedBytes: originalBytes, truncated: false };
  }

  const suffix = "…";
  const contentBudget = maxBytes - Buffer.byteLength(suffix, "utf8");
  let returned = "";
  let returnedBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (returnedBytes + characterBytes > contentBudget) break;
    returned += character;
    returnedBytes += characterBytes;
  }
  returned += suffix;
  returnedBytes += Buffer.byteLength(suffix, "utf8");
  return { value: returned, originalBytes, returnedBytes, truncated: true };
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

function countSerializedNodes(node: CompactNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countSerializedNodes(child), 0);
}

function countEnrichedNodes(node: EnrichedNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countEnrichedNodes(child), 0);
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

function summarizeScalarTruncations(node: CompactNode): {
  truncatedFieldCount: number;
  omittedScalarBytes: number;
} {
  let truncatedFieldCount = 0;
  let omittedScalarBytes = 0;
  const visit = (candidate: CompactNode): void => {
    for (const field of Object.values(candidate.truncatedFields ?? {})) {
      if (!field) continue;
      truncatedFieldCount++;
      omittedScalarBytes += field.originalBytes - field.returnedBytes;
    }
    candidate.children.forEach(visit);
  };
  visit(node);
  return { truncatedFieldCount, omittedScalarBytes };
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function extractLayoutInfo(raw: FigmaRawNode): EnrichedNode["layoutInfo"] {
  if (
    raw.layoutMode === "HORIZONTAL" ||
    raw.layoutMode === "VERTICAL" ||
    raw.layoutMode === "GRID"
  ) {
    return {
      mode:
        raw.layoutMode === "HORIZONTAL"
          ? "horizontal"
          : raw.layoutMode === "VERTICAL"
            ? "vertical"
            : "grid",
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
    };
  }

  if (raw.type === "FRAME" || raw.type === "GROUP") {
    return { mode: "absolute" };
  }

  return raw.layoutMode === "NONE" ? { mode: "none" } : undefined;
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
    visible: raw.visible,
    bounds,
    absoluteTransform: raw.absoluteTransform,
    tokens,
    layoutInfo: extractLayoutInfo(raw),
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
