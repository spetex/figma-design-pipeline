import { describe, expect, it, vi } from "vitest";
import { SnapshotCache } from "../../pipeline/snapshot.js";
import type { ToolContext } from "../../shared/context.js";
import type { FigmaRawNode } from "../../shared/types.js";
import { handleGetTree } from "./get-tree.js";

function node(
  id: string,
  name: string,
  x: number,
  width: number,
  children: FigmaRawNode[] = []
): FigmaRawNode {
  return {
    id,
    name,
    type: "FRAME",
    absoluteBoundingBox: { x, y: 0, width, height: 100 },
    fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }],
    children,
  };
}

function makeContext(
  documents: Map<string, FigmaRawNode>,
  snapshotCache = new SnapshotCache()
) {
  const getFileNodes = vi.fn(async ([nodeId]: string[]) => ({
    nodes: documents.has(nodeId)
      ? { [nodeId]: { document: documents.get(nodeId)! } }
      : {},
  }));
  const rest = { defaultFileKey: "file-a", getFileNodes };
  const ctx = {
    rest,
    snapshotCache,
  } as unknown as ToolContext;
  return { ctx, getFileNodes, rest };
}

describe("handleGetTree freshness", () => {
  it("honors a caller's maximum acceptable snapshot age", async () => {
    let now = 1_000;
    const snapshotCache = new SnapshotCache({ now: () => now });
    const documents = new Map<string, FigmaRawNode>([
      ["root", node("root", "Page", 0, 1000)],
    ]);
    const { ctx, getFileNodes } = makeContext(documents, snapshotCache);

    await handleGetTree(ctx, { nodeId: "root", includeStyles: false });
    now += 101;
    const tooOld = await handleGetTree(ctx, {
      nodeId: "root",
      includeStyles: false,
      maxAgeMs: 100,
    });

    expect(tooOld).toMatchObject({ fromCache: false, cacheAgeMs: 0 });
    expect(getFileNodes).toHaveBeenCalledTimes(2);
  });

  it("keeps cached parent reads distinct from fresh child reads and exposes deletion, moves, and resizes", async () => {
    const initialChild = node("child", "Navigation", 100, 344);
    const documents = new Map<string, FigmaRawNode>([
      ["root", node("root", "Page", 0, 1000, [initialChild])],
      ["child", initialChild],
    ]);
    const { ctx, getFileNodes } = makeContext(documents);

    const initialParent = await handleGetTree(ctx, {
      nodeId: "root",
      depth: 2,
      includeStyles: false,
    });
    expect(initialParent.tree.children[0]?.bounds).toMatchObject({ x: 100, width: 344 });

    const movedAndResizedChild = node("child", "Navigation", 200, 312);
    documents.set("root", node("root", "Page", 0, 1000)); // child was deleted from the parent
    documents.set("child", movedAndResizedChild);

    const freshChild = await handleGetTree(ctx, {
      nodeId: "child",
      depth: 2,
      includeStyles: false,
      refresh: true,
    });
    expect(freshChild).toMatchObject({ fromCache: false, cacheAgeMs: 0 });
    expect(freshChild.tree.bounds).toMatchObject({ x: 200, width: 312 });

    const cachedParent = await handleGetTree(ctx, {
      nodeId: "root",
      depth: 2,
      includeStyles: false,
    });
    expect(cachedParent.fromCache).toBe(true);
    expect(cachedParent.tree.children[0]?.bounds).toMatchObject({ x: 100, width: 344 });

    const freshParent = await handleGetTree(ctx, {
      nodeId: "root",
      depth: 2,
      includeStyles: false,
      maxAgeMs: 0,
    });
    expect(freshParent).toMatchObject({ fromCache: false, cacheAgeMs: 0 });
    expect(freshParent.tree.children).toHaveLength(0);
    expect(getFileNodes).toHaveBeenCalledTimes(3);
  });

  it("isolates cache entries by file, root, depth, and style inclusion", async () => {
    const documents = new Map<string, FigmaRawNode>([
      ["root", node("root", "Page", 0, 1000, [node("child", "Card", 20, 200)])],
    ]);
    const { ctx, getFileNodes, rest } = makeContext(documents);

    const shallow = await handleGetTree(ctx, { nodeId: "root", depth: 1, includeStyles: false });
    const shallowAgain = await handleGetTree(ctx, { nodeId: "root", depth: 1, includeStyles: false });
    const deep = await handleGetTree(ctx, { nodeId: "root", depth: 2, includeStyles: false });
    const withStyles = await handleGetTree(ctx, { nodeId: "root", depth: 2, includeStyles: true });

    expect(shallow.fromCache).toBe(false);
    expect(shallowAgain.fromCache).toBe(true);
    expect(deep.fromCache).toBe(false);
    expect(withStyles.fromCache).toBe(false);
    expect(withStyles.snapshotAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(getFileNodes).toHaveBeenCalledTimes(3);

    rest.defaultFileKey = "file-b";
    const otherFile = await handleGetTree(ctx, { nodeId: "root", depth: 2, includeStyles: true });
    expect(otherFile.fromCache).toBe(false);
    expect(getFileNodes).toHaveBeenCalledTimes(4);
  });
});
