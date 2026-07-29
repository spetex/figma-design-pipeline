import { describe, expect, it, vi } from "vitest";
import { SnapshotCache } from "../../pipeline/snapshot.js";
import { actionSchema } from "../../shared/actions.js";
import type { ToolContext } from "../../shared/context.js";
import type { FigmaRawNode } from "../../shared/types.js";
import { handlePlanLayout } from "./layout-plan.js";

describe("handlePlanLayout", () => {
  it("emits canonical, schema-valid spacing fields for inferred non-zero padding", async () => {
    const root: FigmaRawNode = {
      id: "1:1",
      name: "Vertical stack",
      type: "FRAME",
      absoluteBoundingBox: { x: 100, y: 100, width: 300, height: 300 },
      children: [
        {
          id: "1:2",
          name: "First",
          type: "RECTANGLE",
          absoluteBoundingBox: { x: 120, y: 120, width: 100, height: 40 },
        },
        {
          id: "1:3",
          name: "Second",
          type: "RECTANGLE",
          absoluteBoundingBox: { x: 120, y: 180, width: 100, height: 40 },
        },
      ],
    };
    const getFileNodes = vi.fn().mockResolvedValue({
      nodes: { "1:1": { document: root } },
    });
    const ctx = {
      rest: { getFileNodes },
      snapshotCache: new SnapshotCache(),
    } as unknown as ToolContext;

    const result = await handlePlanLayout(ctx, { nodeId: "1:1" });
    const spacingAction = result.actions.find(
      (action) => action.type === "set_spacing"
    );

    expect(spacingAction).toEqual({
      type: "set_spacing",
      nodeId: "1:1",
      itemSpacing: 20,
      paddingTop: 20,
      paddingRight: 180,
      paddingBottom: 180,
      paddingLeft: 20,
    });
    expect(spacingAction).not.toHaveProperty("top");
    expect(spacingAction).not.toHaveProperty("right");
    expect(spacingAction).not.toHaveProperty("bottom");
    expect(spacingAction).not.toHaveProperty("left");
    for (const action of result.actions) {
      expect(actionSchema.safeParse(action).success).toBe(true);
    }
  });
});
