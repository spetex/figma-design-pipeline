import { describe, expect, it, vi } from "vitest";
import { SnapshotCache } from "../../pipeline/snapshot.js";
import type { ToolContext } from "../../shared/context.js";
import type { FigmaRawNode } from "../../shared/types.js";
import { handleFindNodes } from "./find-nodes.js";

function tree(buttonWidth: number): FigmaRawNode {
  return {
    id: "root",
    name: "Page",
    type: "FRAME",
    children: [{
      id: "button",
      name: "Primary button",
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: buttonWidth, height: 44 },
    }],
  };
}

describe("handleFindNodes freshness", () => {
  it("passes refresh controls through to its inspection tree and returns cache provenance", async () => {
    let document = tree(344);
    const getFileNodes = vi.fn(async () => ({ nodes: { root: { document } } }));
    const ctx = {
      rest: { defaultFileKey: "file-a", getFileNodes },
      snapshotCache: new SnapshotCache(),
    } as unknown as ToolContext;

    const initial = await handleFindNodes(ctx, {
      nodeId: "root",
      namePattern: "button",
      depth: 2,
    });
    document = tree(312);

    const cached = await handleFindNodes(ctx, {
      nodeId: "root",
      namePattern: "button",
      depth: 2,
    });
    const refreshed = await handleFindNodes(ctx, {
      nodeId: "root",
      namePattern: "button",
      depth: 2,
      refresh: true,
    });

    expect(initial).toMatchObject({ fromCache: false, cacheAgeMs: 0 });
    expect(cached).toMatchObject({ fromCache: true });
    expect(cached.matches[0]?.bounds?.width).toBe(344);
    expect(refreshed).toMatchObject({ fromCache: false, cacheAgeMs: 0 });
    expect(refreshed.matches[0]?.bounds?.width).toBe(312);
    expect(refreshed.snapshotAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(getFileNodes).toHaveBeenCalledTimes(2);
  });
});
