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
  source: "plugin" | "rest";
  truncated?: boolean;
  traversalDepth?: number;
  resultLimit?: number;
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

  return { components, totalCount: components.length, source: "rest" };
}

export async function handleGetComponentsFromSource(
  ctx: InspectionContext,
  params: GetComponentsSourceParams
): Promise<GetComponentsResult> {
  const source = selectInspectionSource(ctx, params.source ?? "auto", params.fileKey);
  const depth = params.depth ?? 20;
  const limit = params.limit ?? 200;
  if (source === "rest") {
    const rest = requireRest(ctx);
    if ((params.root ?? "node") !== "node"
      && !((params.root ?? "node") === "current-page" && !params.nodeId)) {
      throw new Error(`${params.root} is available only with plugin inspection`);
    }
    if (!params.nodeId) {
      const result = await handleGetComponents({ rest, snapshotCache: ctx.snapshotCache });
      return {
        ...result,
        components: result.components.slice(0, limit),
        truncated: result.components.length > limit,
        traversalDepth: depth,
        resultLimit: limit,
      };
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
      traversalDepth: depth,
      resultLimit: limit,
    };
  }

  const response = await ctx.bridge.read({
    operation: "components",
    fileKey: params.fileKey,
    root: params.root ?? "node",
    ...(params.nodeId ? { nodeId: params.nodeId } : {}),
    depth,
    limit,
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
    source: "plugin",
    truncated: response.truncated,
    traversalDepth: response.traversalDepth,
    resultLimit: response.resultLimit,
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
