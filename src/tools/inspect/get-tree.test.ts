import { describe, expect, it, vi } from "vitest";
import { SnapshotCache } from "../../pipeline/snapshot.js";
import type { ToolContext } from "../../shared/context.js";
import type { FigmaRawNode } from "../../shared/types.js";
import {
  compactTree,
  handleGetTree,
  serializeGetTreeResponse,
  truncateTree,
} from "./get-tree.js";

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

describe("tree completeness reporting", () => {
  it("preserves all 39 direct children when the requested root is vector-heavy", async () => {
    const children = Array.from({ length: 39 }, (_, index): FigmaRawNode => ({
      id: `shape-${index}`,
      name: `Shape ${index}`,
      type: "RECTANGLE",
    }));
    const documents = new Map<string, FigmaRawNode>([
      ["root", node("root", "Observed section", 0, 1000, children)],
    ]);
    const { ctx } = makeContext(documents);

    const result = await handleGetTree(ctx, { nodeId: "root", depth: 1, includeStyles: false });
    const report = truncateTree(compactTree(result.tree), 80_000);

    expect(report.tree.childCount).toBe(39);
    expect(report.tree.returnedChildCount).toBe(39);
    expect(report.tree.children).toHaveLength(39);
    expect(report).toMatchObject({
      truncated: false,
      omittedNodeCount: 0,
      truncationReasons: [],
      nodeCount: 40,
      totalNodeCount: 40,
    });
  });

  it("reports descendant vector compaction and the exact omitted count", async () => {
    const vectors = Array.from({ length: 5 }, (_, index): FigmaRawNode => ({
      id: `vector-${index}`,
      name: `Vector ${index}`,
      type: "VECTOR",
    }));
    const documents = new Map<string, FigmaRawNode>([
      ["root", node("root", "Page", 0, 1000, [node("icon", "Icon", 0, 24, vectors)])],
    ]);
    const { ctx } = makeContext(documents);

    const result = await handleGetTree(ctx, { nodeId: "root", depth: 3, includeStyles: false });
    const report = truncateTree(compactTree(result.tree), 80_000);

    expect(report).toMatchObject({
      truncated: true,
      omittedNodeCount: 5,
      truncationReasons: ["vector_compaction"],
      nodeCount: 3,
      returnedNodeCount: 2,
      totalNodeCount: 7,
    });
    expect(report.tree.children[0]).toMatchObject({ childCount: 5, returnedChildCount: 0 });
    expect(report.continuations).toContainEqual({
      reason: "vector_compaction",
      nodeId: "icon",
      omittedNodeCount: 5,
    });
  });

  it("makes byte-limit pruning explicit while preserving direct root children", async () => {
    const branch = (id: string) => node(
      id,
      `Direct child ${id}`,
      0,
      100,
      Array.from({ length: 8 }, (_, index) =>
        node(`${id}-${index}`, `Verbose descendant ${"x".repeat(120)} ${index}`, 0, 50)
      )
    );
    const documents = new Map<string, FigmaRawNode>([
      ["root", node("root", "Page", 0, 1000, [branch("a"), branch("b"), branch("c")])],
    ]);
    const { ctx } = makeContext(documents);

    const result = await handleGetTree(ctx, { nodeId: "root", depth: 3, includeStyles: false });
    const report = truncateTree(compactTree(result.tree), 2_500);

    expect(report.truncated).toBe(true);
    expect(report.truncationReasons).toContain("response_size_limit");
    expect(report.maxResponseBytes).toBe(2_500);
    expect(report.responseBytes).toBeLessThanOrEqual(2_500);
    expect(report.tree.children.map(child => child.id)).toEqual(["a", "b", "c"]);
    expect(report.tree.returnedChildCount).toBe(3);
    expect(report.omittedNodeCount).toBe(24);
    expect(report.continuations).toEqual(expect.arrayContaining([
      { reason: "response_size_limit", nodeId: "a", omittedNodeCount: 8 },
      { reason: "response_size_limit", nodeId: "b", omittedNodeCount: 8 },
      { reason: "response_size_limit", nodeId: "c", omittedNodeCount: 8 },
    ]));
  });

  it("returns direct-child continuations when an unusually wide root cannot fit", async () => {
    const children = Array.from({ length: 12 }, (_, index) =>
      node(`wide-${index}`, `Direct child ${"wide ".repeat(20)}${index}`, index * 100, 100)
    );
    const documents = new Map<string, FigmaRawNode>([
      ["root", node("root", "Wide page", 0, 1200, children)],
    ]);
    const { ctx } = makeContext(documents);

    const result = await handleGetTree(ctx, { nodeId: "root", depth: 1, includeStyles: false });
    const report = truncateTree(compactTree(result.tree), 1_400);

    expect(report.responseBytes).toBeLessThanOrEqual(1_400);
    expect(report.tree.returnedChildCount).toBeLessThan(12);
    expect(report.tree.childCount).toBe(12);
    expect(report.truncationReasons).toEqual(["response_size_limit"]);
    expect(report.continuations.length).toBe(12 - report.tree.returnedChildCount);
    expect(report.continuations.every(entry => entry.nodeId.startsWith("wide-"))).toBe(true);
  });

  it("budgets the exact final emitted text including Unicode metadata and continuations", async () => {
    const children = Array.from({ length: 320 }, (_, index) =>
      node(
        `wide-${index}`,
        `🎨 Direct child ${index} ${"界".repeat(120)}`,
        index * 100,
        100,
        [node(`wide-${index}-child`, `Descendant ${"é".repeat(80)}`, 0, 50)]
      )
    );
    const documents = new Map<string, FigmaRawNode>([
      ["root", node("root", "Unicode wide page", 0, 32_000, children)],
    ]);
    const { ctx } = makeContext(documents);
    const result = await handleGetTree(ctx, { nodeId: "root", depth: 2, includeStyles: false });

    const firstPage = serializeGetTreeResponse(result);

    expect(Buffer.byteLength(firstPage.text, "utf8")).toBeLessThanOrEqual(80_000);
    expect(firstPage.payload.responseBytes).toBe(Buffer.byteLength(firstPage.text, "utf8"));
    expect(JSON.parse(firstPage.text)).toEqual(firstPage.payload);
    expect(firstPage.payload).toMatchObject({
      truncated: true,
      maxResponseBytes: 80_000,
      note: "Tree exceeded 80KB — deeper children omitted. Use figma_get_tree on specific nodeIds to drill down.",
    });
    expect(firstPage.payload.nodeCount).toBeGreaterThan(firstPage.payload.returnedNodeCount);
    expect(firstPage.payload.continuations.length).toBeGreaterThan(1);
    const nextOffset = firstPage.payload.directChildren?.nextOffset;
    expect(nextOffset).toBeTypeOf("number");
    expect(nextOffset).toBeGreaterThan(0);
    expect(firstPage.payload.continuations).toContainEqual(expect.objectContaining({
      reason: "response_size_limit",
      nodeId: "root",
      childOffset: nextOffset,
    }));

    const nextPage = serializeGetTreeResponse(result, { childOffset: nextOffset });
    expect(Buffer.byteLength(nextPage.text, "utf8")).toBeLessThanOrEqual(80_000);
    expect(nextPage.payload.responseBytes).toBe(Buffer.byteLength(nextPage.text, "utf8"));
    expect(nextPage.payload.directChildren?.offset).toBe(nextOffset);
  });

  it("terminates with exact coverage when one direct child has an oversized Unicode field", async () => {
    const oversizedName = "界".repeat(30_000);
    const oversizedChild = node("oversized-child", oversizedName, 0, 100);
    const documents = new Map<string, FigmaRawNode>([
      ["root", node("root", "Page", 0, 1000, [oversizedChild])],
      ["oversized-child", oversizedChild],
    ]);
    const { ctx } = makeContext(documents);
    const result = await handleGetTree(ctx, { nodeId: "root", depth: 1, includeStyles: false });

    const seenPages = new Set<string>();
    const returnedIds = new Set<string>();
    let childOffset = 0;
    let terminalPayload: ReturnType<typeof serializeGetTreeResponse>["payload"] | undefined;

    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = serializeGetTreeResponse(result, { childOffset });
      expect(page.payload.responseBytes).toBe(Buffer.byteLength(page.text, "utf8"));
      expect(page.payload.responseBytes).toBeLessThanOrEqual(80_000);
      expect(seenPages.has(page.text)).toBe(false);
      seenPages.add(page.text);
      page.payload.tree.children.forEach(child => returnedIds.add(child.id));

      const nextOffset = page.payload.directChildren?.nextOffset;
      if (nextOffset === undefined) {
        terminalPayload = page.payload;
        break;
      }
      expect(nextOffset).toBeGreaterThan(childOffset);
      childOffset = nextOffset;
    }

    expect(terminalPayload).toBeDefined();
    expect([...returnedIds]).toEqual(["oversized-child"]);
    expect(seenPages.size).toBe(1);
    expect(terminalPayload).toMatchObject({
      truncated: true,
      omittedNodeCount: 0,
      truncatedFieldCount: 1,
      truncationReasons: ["scalar_field_limit"],
      nodeCount: 2,
      returnedNodeCount: 2,
      totalNodeCount: 2,
    });
    const returnedChild = terminalPayload!.tree.children[0]!;
    expect(returnedChild.id).toBe("oversized-child");
    expect(returnedChild.truncatedFields?.name?.originalBytes).toBe(
      Buffer.byteLength(oversizedName, "utf8")
    );
    expect(terminalPayload!.omittedScalarBytes).toBe(
      returnedChild.truncatedFields!.name!.originalBytes -
      returnedChild.truncatedFields!.name!.returnedBytes
    );

    const focused = await handleGetTree(ctx, {
      nodeId: "oversized-child",
      depth: 1,
      includeStyles: false,
    });
    const focusedResponse = serializeGetTreeResponse(focused);
    expect(focusedResponse.payload.nodeId).toBe("oversized-child");
    expect(focusedResponse.payload.responseBytes).toBeLessThanOrEqual(80_000);
  });
});
