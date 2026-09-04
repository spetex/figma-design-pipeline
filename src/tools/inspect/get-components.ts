import type { ToolContext } from "../../shared/context.js";
import type { InspectionSource, PluginReadRoot } from "../../shared/plugin-read.js";
import type { InspectionContext } from "./source.js";
import { requireRest, selectInspectionSource } from "./source.js";
import { handleGetTree } from "./get-tree.js";
import type { EnrichedNode } from "../../shared/types.js";

export interface ComponentMeta {
  key?: string;
  name: string;
  description: string;
  nodeId: string;
  type?: "COMPONENT" | "COMPONENT_SET";
  componentSetId?: string;
  containingFrame?: { name: string; nodeId: string };
}

export interface GetComponentsResult {
  components: ComponentMeta[];
  totalCount: number;
  totalCountExact?: boolean;
  source: "plugin" | "rest";
  truncated?: boolean;
  traversalDepth?: number;
  resultLimit?: number;
  offset?: number;
  returnedCount?: number;
  nextOffset?: number;
  scanLimit?: number;
  scanLimitReached?: boolean;
  truncationReasons?: Array<"result_limit" | "scan_limit">;
  currentPage?: { id: string; name: string };
  selection?: Array<{ id: string; name: string; type: string }>;
}

export interface GetComponentsSourceParams {
  fileKey: string;
  nodeId?: string;
  source?: InspectionSource;
  root?: PluginReadRoot;
  depth?: number;
  limit?: number;
  timeoutMs?: number;
  offset?: number;
  scanLimit?: number;
}

/**
 * List all components in the Figma file via REST API.
 * Returns component keys, names, descriptions, node IDs, and containing frames.
 */
export async function handleGetComponents(
  ctx: ToolContext
): Promise<GetComponentsResult> {
  const data = (await ctx.rest.getFileComponents()) as {
    meta?: { components?: Array<{
      key: string;
      name: string;
      description: string;
      node_id: string;
      containing_frame?: { name: string; nodeId: string };
    }> };
  };

  const raw = data?.meta?.components || [];
  const components: ComponentMeta[] = raw.map((c) => ({
    key: c.key,
    name: c.name,
    description: c.description,
    nodeId: c.node_id,
    containingFrame: c.containing_frame
      ? { name: c.containing_frame.name, nodeId: c.containing_frame.nodeId }
      : undefined,
  }));

  return { components, totalCount: components.length, totalCountExact: true, source: "rest" };
}

export async function handleGetComponentsFromSource(
  ctx: InspectionContext,
  params: GetComponentsSourceParams
): Promise<GetComponentsResult> {
  const wholeFile = params.root === undefined && !params.nodeId;
  const requestedRoot = params.root ?? "node";
  const requestedSource = params.source ?? "auto";
  if (wholeFile && requestedSource === "plugin") {
    throw new Error("Whole-file published component listings are available only with REST inspection");
  }
  const source = wholeFile && requestedSource === "auto"
    ? "rest"
    : selectInspectionSource(ctx, requestedSource, params.fileKey);
  const depth = params.depth ?? 20;
  const limit = params.limit ?? 200;
  const offset = params.offset ?? 0;
  const scanLimit = params.scanLimit ?? 1_000;
  if (source === "rest") {
    const rest = requireRest(ctx);
    if (requestedRoot !== "node") {
      throw new Error(`${params.root} is available only with plugin inspection`);
    }
    if (wholeFile) {
      const result = await handleGetComponents({ rest, snapshotCache: ctx.snapshotCache });
      const components = result.components.slice(offset, offset + limit);
      const nextOffset = offset + components.length < result.components.length
        ? offset + components.length
        : undefined;
      return {
        ...result,
        components,
        truncated: nextOffset !== undefined,
        traversalDepth: depth,
        resultLimit: limit,
        offset,
        returnedCount: components.length,
        ...(nextOffset !== undefined ? { nextOffset } : {}),
      };
    }
    if (!params.nodeId) throw new Error("nodeId is required when root is 'node'");
    if (offset !== 0) {
      throw new Error("offset is supported only for whole-file REST component listings");
    }
    const tree = await handleGetTree(
      { rest, snapshotCache: ctx.snapshotCache },
      { nodeId: params.nodeId, depth, includeStyles: false }
    );
    const components: ComponentMeta[] = [];
    let additional = false;
    walk(tree.tree, (node) => {
      if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") return true;
      if (components.length >= limit) {
        additional = true;
        return false;
      }
      components.push({
        name: node.name,
        description: "",
        nodeId: node.id,
        type: node.type,
      });
      return true;
    });
    return {
      components,
      totalCount: components.length,
      source: "rest",
      truncated: additional,
      totalCountExact: !additional,
      traversalDepth: depth,
      resultLimit: limit,
      offset: 0,
      returnedCount: components.length,
    };
  }

  if (offset !== 0) {
    throw new Error("offset is supported only for whole-file REST component listings");
  }

  const response = await ctx.bridge.read({
    operation: "components",
    fileKey: params.fileKey,
    root: requestedRoot,
    ...(params.nodeId ? { nodeId: params.nodeId } : {}),
    depth,
    limit,
    scanLimit,
  }, params.timeoutMs);
  return {
    components: response.components.map((component) => ({
      key: component.key,
      name: component.name,
      description: component.description ?? "",
      nodeId: component.id,
      type: component.type,
      componentSetId: component.componentSetId,
    })),
    totalCount: response.components.length,
    totalCountExact: !response.truncated,
    source: "plugin",
    truncated: response.truncated,
    traversalDepth: response.traversalDepth,
    resultLimit: response.resultLimit,
    offset: 0,
    returnedCount: response.returnedCount,
    scanLimit: response.scanLimit,
    scanLimitReached: response.scanLimitReached,
    truncationReasons: response.truncationReasons,
    currentPage: response.currentPage,
    selection: response.selection,
  };
}

function walk(node: EnrichedNode, visit: (node: EnrichedNode) => boolean): boolean {
  if (!visit(node)) return false;
  for (const child of node.children) {
    if (!walk(child, visit)) return false;
  }
  return true;
}
