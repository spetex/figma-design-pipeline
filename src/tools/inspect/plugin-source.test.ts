import { describe, expect, it, vi } from "vitest";
import { SnapshotCache } from "../../pipeline/snapshot.js";
import type { PluginReadResponse } from "../../shared/plugin-read.js";
import { handleGetTreeFromSource, serializeGetTreeResponse } from "./get-tree.js";
import { handleFindNodesFromSource } from "./find-nodes.js";
import { handleGetComponentsFromSource } from "./get-components.js";
import type { InspectionContext } from "./source.js";
import { getComponentsInputSchema } from "../../shared/types.js";

function pluginResponse(overrides: Partial<PluginReadResponse> = {}): PluginReadResponse {
  return {
    type: "read_response",
    requestId: "request",
    operation: "tree",
    fileKey: "file-a",
    success: true,
    roots: [{
      id: "root",
      name: "Root",
      type: "FRAME",
      classification: "container",
      depth: 0,
      visible: false,
      bounds: { x: 1, y: 2, width: 300, height: 200 },
      childCount: 1,
      children: [{
        id: "child",
        name: "Primary",
        type: "COMPONENT",
        classification: "button",
        depth: 1,
        visible: true,
        childCount: 0,
        children: [],
      }],
    }],
    matches: [],
    components: [],
    totalScanned: 2,
    returnedCount: 2,
    totalNodeCount: 2,
    truncated: false,
    truncationReasons: [],
    traversalDepth: 2,
    resultLimit: 50,
    scanLimit: 1000,
    scanLimitReached: false,
    truncatedFieldCount: 0,
    omittedScalarBytes: 0,
    currentPage: { id: "page", name: "Page", type: "PAGE" },
    selection: [{ id: "child", name: "Primary", type: "COMPONENT" }],
    selectionCount: 1,
    ...overrides,
  };
}

function context({
  connected = true,
  openFile = "file-a",
  response = pluginResponse(),
  withRest = false,
}: {
  connected?: boolean;
  openFile?: string;
  response?: PluginReadResponse;
  withRest?: boolean;
} = {}) {
  const read = vi.fn(async () => response);
  const getFileNodes = vi.fn(async ([nodeId]: string[]) => ({
    nodes: {
      [nodeId]: {
        document: { id: nodeId, name: "REST root", type: "FRAME", children: [] },
      },
    },
  }));
  const getFileComponents = vi.fn(async () => ({
    meta: {
      components: Array.from({ length: 5 }, (_, index) => ({
        key: `key-${index}`,
        name: `Component ${index}`,
        description: "",
        node_id: `component-${index}`,
      })),
    },
  }));
  const rest = withRest ? { defaultFileKey: "file-a", getFileNodes, getFileComponents } : null;
  const snapshotCache = new SnapshotCache();
  const bridge = {
    isConnected: () => connected,
    canReadFile: (fileKey: string) => connected && fileKey === openFile,
    getStatus: () => ({ fileKey: openFile }),
    read,
  };
  return {
    ctx: { rest, snapshotCache, bridge } as unknown as InspectionContext,
    read,
    getFileNodes,
    getFileComponents,
    snapshotCache,
  };
}

describe("plugin inspection source routing", () => {
  it("keeps an omitted component root distinct from an explicit root", () => {
    expect(getComponentsInputSchema.parse({})).toMatchObject({ offset: 0, scanLimit: 1000 });
    expect(getComponentsInputSchema.parse({}).root).toBeUndefined();
    expect(getComponentsInputSchema.parse({ root: "current-page" }).root).toBe("current-page");
  });

  it("uses an exactly matching plugin without a token and never writes inspection snapshots", async () => {
    const { ctx, read, snapshotCache } = context();
    const cacheGet = vi.spyOn(snapshotCache, "get");
    const cacheSet = vi.spyOn(snapshotCache, "set");
    const cacheInvalidate = vi.spyOn(snapshotCache, "invalidateAll");

    const result = await handleGetTreeFromSource(ctx, {
      fileKey: "file-a",
      nodeId: "root",
      source: "auto",
      depth: 2,
      limit: 50,
    });
    const serialized = serializeGetTreeResponse(result);

    expect(result).toMatchObject({ source: "plugin", fromCache: false });
    expect(serialized.payload).toMatchObject({
      source: "plugin",
      traversalDepth: 2,
      tree: { id: "root", visible: false, children: [{ visible: true }] },
    });
    expect(read).toHaveBeenCalledWith(expect.objectContaining({
      operation: "tree",
      fileKey: "file-a",
      nodeId: "root",
    }), undefined);
    expect(cacheGet).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
    expect(cacheInvalidate).not.toHaveBeenCalled();
  });

  it("propagates deterministic plugin result-limit truncation into tree metadata", async () => {
    const { ctx } = context({ response: pluginResponse({
      returnedCount: 2,
      totalNodeCount: 5,
      totalScanned: 5,
      truncated: true,
      resultLimit: 2,
    }) });
    const result = await handleGetTreeFromSource(ctx, {
      fileKey: "file-a",
      nodeId: "root",
      source: "plugin",
      depth: 2,
      limit: 2,
    });
    const payload = serializeGetTreeResponse(result).payload;
    expect(payload).toMatchObject({
      source: "plugin",
      resultLimit: 2,
      truncated: true,
      omittedNodeCount: 3,
      totalNodeCount: 5,
      truncationReasons: ["result_limit"],
    });
  });

  it("preserves plugin scalar truncation metadata in the serialized tree", async () => {
    const truncation = { originalBytes: 20_000, returnedBytes: 3_999 };
    const root = {
      ...pluginResponse().roots[0]!,
      name: `${"😀".repeat(999)}…`,
      truncatedFields: { name: truncation },
    };
    const { ctx } = context({ response: pluginResponse({
      roots: [root],
      returnedCount: 2,
      totalNodeCount: 2,
      truncated: true,
      truncationReasons: ["scalar_field_limit"],
      truncatedFieldCount: 1,
      omittedScalarBytes: 16_001,
    }) });

    const result = await handleGetTreeFromSource(ctx, {
      fileKey: "file-a",
      nodeId: "root",
      source: "plugin",
      depth: 2,
      limit: 50,
    });
    const payload = serializeGetTreeResponse(result).payload;

    expect(payload).toMatchObject({
      truncated: true,
      truncationReasons: ["scalar_field_limit"],
      truncatedFieldCount: 1,
      omittedScalarBytes: 16_001,
      tree: { truncatedFields: { name: truncation } },
    });
  });

  it.each([
    { label: "disconnected plugin", connected: false, openFile: "file-a" },
    { label: "different open file", connected: true, openFile: "file-b" },
  ])("falls back to REST in auto mode for $label", async ({ connected, openFile }) => {
    const { ctx, read, getFileNodes } = context({ connected, openFile, withRest: true });
    const result = await handleGetTreeFromSource(ctx, {
      fileKey: "file-a",
      nodeId: "root",
      source: "auto",
    });
    expect(result.source).toBe("rest");
    expect(getFileNodes).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });

  it("fails closed on an explicit plugin file mismatch", async () => {
    const { ctx, read, getFileNodes } = context({ openFile: "file-b", withRest: true });
    await expect(handleGetTreeFromSource(ctx, {
      fileKey: "file-a",
      nodeId: "root",
      source: "plugin",
    })).rejects.toThrow("Plugin file mismatch: requested file-a, open file-b");
    expect(read).not.toHaveBeenCalled();
    expect(getFileNodes).not.toHaveBeenCalled();
  });

  it("honors an explicit REST source even when the plugin matches", async () => {
    const { ctx, read, getFileNodes } = context({ withRest: true });
    const result = await handleGetTreeFromSource(ctx, {
      fileKey: "file-a",
      nodeId: "root",
      source: "rest",
    });
    expect(result.source).toBe("rest");
    expect(getFileNodes).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects an explicit REST source when no token is configured", async () => {
    const { ctx, read } = context();
    await expect(handleGetTreeFromSource(ctx, {
      fileKey: "file-a",
      nodeId: "root",
      source: "rest",
    })).rejects.toThrow("FIGMA_ACCESS_TOKEN is not set");
    expect(read).not.toHaveBeenCalled();
  });

  it("supports plugin find results, context, and component-set discovery", async () => {
    const findResponse = pluginResponse({
      operation: "find",
      roots: [],
      matches: [pluginResponse().roots[0]!.children[0]!],
      returnedCount: 1,
      totalNodeCount: undefined,
    });
    const findContext = context({ response: findResponse });
    const found = await handleFindNodesFromSource(findContext.ctx, {
      fileKey: "file-a",
      nodeId: "root",
      source: "plugin",
      name: "Primary",
      namePattern: "^Primary$",
      type: "COMPONENT",
    });
    expect(found).toMatchObject({
      source: "plugin",
      matches: [{ id: "child", classification: "button" }],
      currentPage: { id: "page" },
      selection: [{ id: "child" }],
    });
    expect(findContext.read).toHaveBeenCalledWith(expect.objectContaining({
      filters: expect.objectContaining({ name: "Primary", namePattern: "^Primary$", type: "COMPONENT" }),
    }), undefined);

    const componentsContext = context({ response: pluginResponse({
      operation: "components",
      roots: [],
      components: [{ id: "set", name: "Buttons", type: "COMPONENT_SET", key: "set-key" }],
      returnedCount: 1,
      totalNodeCount: undefined,
    }) });
    const components = await handleGetComponentsFromSource(componentsContext.ctx, {
      fileKey: "file-a",
      nodeId: "root",
      source: "plugin",
    });
    expect(components).toMatchObject({
      source: "plugin",
      components: [{ nodeId: "set", name: "Buttons", type: "COMPONENT_SET", key: "set-key" }],
    });
  });

  it("rejects unsafe regexes before either plugin or REST traversal", async () => {
    const pluginContext = context();
    await expect(handleFindNodesFromSource(pluginContext.ctx, {
      fileKey: "file-a",
      nodeId: "root",
      source: "plugin",
      namePattern: "^(a+)\\1$",
    })).rejects.toThrow("Unsafe namePattern regex");
    expect(pluginContext.read).not.toHaveBeenCalled();

    const restContext = context({ withRest: true });
    await expect(handleFindNodesFromSource(restContext.ctx, {
      fileKey: "file-a",
      nodeId: "root",
      source: "rest",
      namePattern: "(?=unsafe)",
    })).rejects.toThrow("Unsafe namePattern regex");
    expect(restContext.getFileNodes).not.toHaveBeenCalled();
  });

  it("preserves explicit current-page semantics instead of falling back to a whole-file REST list", async () => {
    const { ctx, getFileComponents } = context({ connected: false, withRest: true });

    await expect(handleGetComponentsFromSource(ctx, {
      fileKey: "file-a",
      source: "auto",
      root: "current-page",
    })).rejects.toThrow("current-page is available only with plugin inspection");
    expect(getFileComponents).not.toHaveBeenCalled();
  });

  it("paginates the legacy whole-file REST component listing with a deterministic offset", async () => {
    const { ctx, read, getFileComponents } = context({ withRest: true });

    const first = await handleGetComponentsFromSource(ctx, {
      fileKey: "file-a",
      source: "auto",
      limit: 2,
      offset: 0,
    });
    const second = await handleGetComponentsFromSource(ctx, {
      fileKey: "file-a",
      source: "rest",
      limit: 2,
      offset: first.nextOffset,
    });

    expect(first).toMatchObject({
      source: "rest",
      totalCount: 5,
      totalCountExact: true,
      returnedCount: 2,
      offset: 0,
      nextOffset: 2,
      truncated: true,
      components: [{ nodeId: "component-0" }, { nodeId: "component-1" }],
    });
    expect(second).toMatchObject({
      offset: 2,
      nextOffset: 4,
      components: [{ nodeId: "component-2" }, { nodeId: "component-3" }],
    });
    const terminal = await handleGetComponentsFromSource(ctx, {
      fileKey: "file-a",
      source: "rest",
      limit: 2,
      offset: second.nextOffset,
    });
    expect(terminal).toMatchObject({
      offset: 4,
      returnedCount: 1,
      truncated: false,
      components: [{ nodeId: "component-4" }],
    });
    expect(terminal).not.toHaveProperty("nextOffset");
    expect(getFileComponents).toHaveBeenCalledTimes(3);
    expect(read).not.toHaveBeenCalled();
  });

  it("retains truthful bounded selection metadata when result-limited roots are omitted", async () => {
    const selected = [
      { id: "child", name: "Primary", type: "COMPONENT" },
      { id: "second", name: "Secondary", type: "COMPONENT" },
      { id: "third", name: "Tertiary", type: "FRAME" },
    ];
    const { ctx } = context({ response: pluginResponse({
      roots: [pluginResponse().roots[0]!.children[0]!],
      returnedCount: 1,
      totalScanned: 1,
      totalNodeCount: undefined,
      truncated: true,
      truncationReasons: ["result_limit"],
      resultLimit: 1,
      selection: selected,
      selectionCount: 3,
      selectionMetadata: { offset: 0, returned: 1, total: 3, omitted: 2, nextOffset: 1 },
    }) });

    const result = await handleGetTreeFromSource(ctx, {
      fileKey: "file-a",
      source: "plugin",
      root: "selection",
      depth: 2,
      limit: 1,
    });
    const payload = serializeGetTreeResponse(result).payload;

    expect(payload).toMatchObject({
      selectionCount: 3,
      totalNodeCountExact: false,
      omittedNodeCountExact: false,
      omittedNodeCount: 2,
      selectionMetadata: { offset: 0, returned: 1, total: 3, omitted: 2, nextOffset: 1 },
      tree: { id: "selection", childCount: 3, returnedChildCount: 1 },
    });
  });

  it("reports missing plugin nodes without falling through to REST", async () => {
    const { ctx, read, getFileNodes } = context({ withRest: true });
    read.mockRejectedValueOnce(new Error("Node not found: missing"));
    await expect(handleGetTreeFromSource(ctx, {
      fileKey: "file-a",
      nodeId: "missing",
      source: "auto",
    })).rejects.toThrow("Node not found: missing");
    expect(getFileNodes).not.toHaveBeenCalled();
  });
});
