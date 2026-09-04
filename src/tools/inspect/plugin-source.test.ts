import { describe, expect, it, vi } from "vitest";
import { SnapshotCache } from "../../pipeline/snapshot.js";
import type { PluginReadResponse } from "../../shared/plugin-read.js";
import { handleGetTreeFromSource, serializeGetTreeResponse } from "./get-tree.js";
import { handleFindNodesFromSource } from "./find-nodes.js";
import { handleGetComponentsFromSource } from "./get-components.js";
import type { InspectionContext } from "./source.js";

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
    traversalDepth: 2,
    resultLimit: 50,
    currentPage: { id: "page", name: "Page" },
    selection: [{ id: "child", name: "Primary", type: "COMPONENT" }],
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
  const rest = withRest ? { defaultFileKey: "file-a", getFileNodes } : null;
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
    snapshotCache,
  };
}

describe("plugin inspection source routing", () => {
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
