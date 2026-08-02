import { describe, expect, it, vi } from "vitest";
import { SnapshotCache } from "../../pipeline/snapshot.js";
import type { ToolContext } from "../../shared/context.js";
import type { FigmaRawNode } from "../../shared/types.js";
import { handleAudit } from "./audit.js";

function makeContext(document: FigmaRawNode): ToolContext {
  return {
    rest: {
      defaultFileKey: "file-a",
      getFileNodes: vi.fn(async ([nodeId]: string[]) => ({
        nodes: { [nodeId]: { document } },
      })),
    },
    snapshotCache: new SnapshotCache(),
  } as unknown as ToolContext;
}

function autoLayout(spacing: Pick<
  FigmaRawNode,
  "itemSpacing" | "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft"
>): FigmaRawNode {
  return {
    id: "root",
    name: "Auto layout",
    type: "FRAME",
    layoutMode: "HORIZONTAL",
    ...spacing,
  };
}

describe("handleAudit token checks", () => {
  it("reports off-grid item spacing and all four paddings", async () => {
    const result = await handleAudit(makeContext(autoLayout({
      itemSpacing: 5,
      paddingTop: 7,
      paddingRight: 9,
      paddingBottom: 11,
      paddingLeft: 13,
    })), { nodeId: "root", checks: ["tokens"] });

    expect(result.violations.map(violation => violation.message)).toEqual([
      "Spacing 5px is not on the 4px grid",
      "Spacing 7px is not on the 4px grid",
      "Spacing 9px is not on the 4px grid",
      "Spacing 11px is not on the 4px grid",
      "Spacing 13px is not on the 4px grid",
    ]);
    expect(result.summary.tokens).toEqual({ errors: 0, warnings: 0, info: 5 });
  });

  it("does not report on-grid spacing", async () => {
    const result = await handleAudit(makeContext(autoLayout({
      itemSpacing: 4,
      paddingTop: 8,
      paddingRight: 12,
      paddingBottom: 16,
      paddingLeft: 20,
    })), { nodeId: "root", checks: ["tokens"] });

    expect(result.violations).toEqual([]);
    expect(result.summary.tokens).toEqual({ errors: 0, warnings: 0, info: 0 });
  });

  it("reports a repeated off-grid value only once on one node", async () => {
    const result = await handleAudit(makeContext(autoLayout({
      itemSpacing: 7,
      paddingTop: 7,
      paddingRight: 7,
      paddingBottom: 7,
      paddingLeft: 7,
    })), { nodeId: "root", checks: ["tokens"] });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.message).toBe("Spacing 7px is not on the 4px grid");
  });
});
