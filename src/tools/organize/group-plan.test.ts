import { describe, expect, it, vi } from "vitest";
import { compileBatch } from "../../plugin/batch-compiler.js";
import { SnapshotCache } from "../../pipeline/snapshot.js";
import { actionSchema, type Action } from "../../shared/actions.js";
import type { ToolContext } from "../../shared/context.js";
import type { FigmaRawNode } from "../../shared/types.js";
import { handlePlanGrouping } from "./group-plan.js";

const parentBounds = { x: 500, y: 300, width: 600, height: 400 };

function node(
  id: string,
  name: string,
  x: number,
  y: number,
  width = 80,
  height = 60
): FigmaRawNode {
  return {
    id,
    name,
    type: "FRAME",
    absoluteBoundingBox: { x, y, width, height },
  };
}

function contextFor(root: FigmaRawNode): ToolContext {
  return {
    rest: {
      getFileNodes: vi.fn().mockResolvedValue({
        nodes: { [root.id]: { document: root } },
      }),
    },
    snapshotCache: new SnapshotCache(),
  } as unknown as ToolContext;
}

function expectGroupingPlan(
  actions: Action[],
  expected: {
    name: string;
    memberIds: string[];
    frame: { x: number; y: number; width: number; height: number };
    positions: Record<string, { x: number; y: number }>;
  }
): void {
  const [create, ...rest] = actions;
  expect(create).toEqual({
    type: "create_frame",
    name: expected.name,
    parentId: "parent",
    ...expected.frame,
  });

  expect(rest.filter((action) => action.type === "move")).toEqual(
    expected.memberIds.map((nodeId) => ({
      type: "move",
      nodeId,
      targetParentId: "$ref:node-0",
    }))
  );
  expect(rest.filter((action) => action.type === "set_position")).toEqual(
    expected.memberIds.map((nodeId) => ({
      type: "set_position",
      nodeId,
      ...expected.positions[nodeId],
    }))
  );

  for (const action of actions) {
    expect(actionSchema.safeParse(action).success).toBe(true);
  }

  const compiled = compileBatch(actions);
  expect(compiled.actions[0]).toMatchObject({ _ref: "$ref:node-0" });
  expect(
    compiled.actions.filter((action) => action.type === "move")
  ).toEqual(
    expected.memberIds.map((nodeId) => ({
      type: "move",
      nodeId,
      targetParentId: "$ref:node-0",
    }))
  );
}

describe("handlePlanGrouping", () => {
  it("groups semantic members into a parent-relative frame without moving their visible positions", async () => {
    const root: FigmaRawNode = {
      id: "parent",
      name: "Dashboard",
      type: "FRAME",
      absoluteBoundingBox: parentBounds,
      children: [
        node("card-1", "Card one", 520, 330),
        node("card-2", "Card two", 640, 330),
        node("other-1", "Other one", 520, 430),
        node("other-2", "Other two", 640, 430),
        node("other-3", "Other three", 760, 330, 24, 24),
      ],
    };

    const result = await handlePlanGrouping(contextFor(root), {
      nodeId: root.id,
      strategy: "semantic",
    });

    expectGroupingPlan(result.actions, {
      name: "Section/Card",
      memberIds: ["card-1", "card-2"],
      frame: { x: 20, y: 30, width: 200, height: 60 },
      positions: {
        "card-1": { x: 0, y: 0 },
        "card-2": { x: 120, y: 0 },
      },
    });
  });

  it("groups nearby members into a parent-relative frame without moving their visible positions", async () => {
    const root: FigmaRawNode = {
      id: "parent",
      name: "Dashboard",
      type: "FRAME",
      absoluteBoundingBox: parentBounds,
      children: [
        node("item-1", "Item one", 520, 330),
        node("item-2", "Item two", 600, 330),
        node("far-away", "Far away", 980, 600),
      ],
    };

    const result = await handlePlanGrouping(contextFor(root), {
      nodeId: root.id,
      strategy: "spatial",
    });

    expectGroupingPlan(result.actions, {
      name: "Group/Cluster",
      memberIds: ["item-1", "item-2"],
      frame: { x: 20, y: 30, width: 160, height: 60 },
      positions: {
        "item-1": { x: 0, y: 0 },
        "item-2": { x: 80, y: 0 },
      },
    });
  });

  it("groups minimal card grids into a parent-relative frame without moving their visible positions", async () => {
    const root: FigmaRawNode = {
      id: "parent",
      name: "Dashboard",
      type: "FRAME",
      absoluteBoundingBox: parentBounds,
      children: [
        node("card-1", "Card one", 520, 330),
        node("card-2", "Card two", 640, 330),
        node("card-3", "Card three", 760, 330),
      ],
    };

    const result = await handlePlanGrouping(contextFor(root), {
      nodeId: root.id,
      strategy: "minimal",
    });

    expectGroupingPlan(result.actions, {
      name: "Grid/Cards",
      memberIds: ["card-1", "card-2", "card-3"],
      frame: { x: 20, y: 30, width: 320, height: 60 },
      positions: {
        "card-1": { x: 0, y: 0 },
        "card-2": { x: 120, y: 0 },
        "card-3": { x: 240, y: 0 },
      },
    });
  });

  it("uses compiler create-order references for multiple grouping frames", async () => {
    const root: FigmaRawNode = {
      id: "parent",
      name: "Dashboard",
      type: "FRAME",
      absoluteBoundingBox: parentBounds,
      children: [
        node("card-1", "Card one", 520, 330),
        node("card-2", "Card two", 640, 330),
        node("metric-1", "Metric one", 520, 430),
        node("metric-2", "Metric two", 640, 430),
        node("other", "Other", 760, 330),
      ],
    };

    const result = await handlePlanGrouping(contextFor(root), {
      nodeId: root.id,
      strategy: "semantic",
    });
    const compiled = compileBatch(result.actions);

    expect(
      compiled.actions
        .filter((action) => action.type === "create_frame")
        .map((action) => action._ref)
    ).toEqual(["$ref:node-0", "$ref:node-1"]);
    expect(
      result.actions
        .filter((action) => action.type === "move")
        .map((action) => action.targetParentId)
    ).toEqual(["$ref:node-0", "$ref:node-0", "$ref:node-1", "$ref:node-1"]);
  });

  it("makes grouping wrappers absolute and restores their coordinates under auto-layout parents", async () => {
    const root: FigmaRawNode = {
      id: "parent",
      name: "Horizontal dashboard",
      type: "FRAME",
      layoutMode: "HORIZONTAL",
      absoluteBoundingBox: parentBounds,
      children: [
        node("card-1", "Card one", 520, 330),
        node("card-2", "Card two", 640, 330),
        node("card-3", "Card three", 760, 330),
      ],
    };

    const result = await handlePlanGrouping(contextFor(root), {
      nodeId: root.id,
      strategy: "minimal",
    });

    expect(result.actions.slice(0, 3)).toEqual([
      {
        type: "create_frame",
        name: "Grid/Cards",
        parentId: "parent",
        x: 20,
        y: 30,
        width: 320,
        height: 60,
      },
      {
        type: "set_layout_positioning",
        nodeId: "$ref:node-0",
        positioning: "ABSOLUTE",
      },
      {
        type: "set_position",
        nodeId: "$ref:node-0",
        x: 20,
        y: 30,
      },
    ]);
    expect(result.actions.slice(3, 6)).toEqual([
      { type: "move", nodeId: "card-1", targetParentId: "$ref:node-0" },
      { type: "move", nodeId: "card-2", targetParentId: "$ref:node-0" },
      { type: "move", nodeId: "card-3", targetParentId: "$ref:node-0" },
    ]);
  });

  it("does not plan inside instance-owned subtrees for any grouping strategy", async () => {
    const root: FigmaRawNode = {
      id: "parent",
      name: "Dashboard",
      type: "FRAME",
      absoluteBoundingBox: parentBounds,
      children: [
        {
          id: "instance",
          name: "Card collection",
          type: "INSTANCE",
          absoluteBoundingBox: { x: 520, y: 330, width: 320, height: 180 },
          children: [
            node("card-1", "Card one", 520, 330),
            node("card-2", "Card two", 600, 330),
            node("card-3", "Card three", 680, 330),
            node("card-4", "Card four", 520, 430),
            node("card-5", "Card five", 600, 430),
          ],
        },
      ],
    };

    for (const strategy of ["semantic", "spatial", "minimal"] as const) {
      const result = await handlePlanGrouping(contextFor(root), {
        nodeId: root.id,
        strategy,
      });
      expect(result.actions).toEqual([]);
    }
  });

  it("filters unbounded spatial members before grouping the remaining members", async () => {
    const unboundedItem: FigmaRawNode = {
      id: "item-without-bounds",
      name: "Item without bounds",
      type: "FRAME",
    };
    const root: FigmaRawNode = {
      id: "parent",
      name: "Dashboard",
      type: "FRAME",
      absoluteBoundingBox: parentBounds,
      children: [
        node("item-1", "Item one", 520, 330),
        node("item-2", "Item two", 600, 330),
        unboundedItem,
      ],
    };

    const result = await handlePlanGrouping(contextFor(root), {
      nodeId: root.id,
      strategy: "spatial",
    });

    expectGroupingPlan(result.actions, {
      name: "Group/Cluster",
      memberIds: ["item-1", "item-2"],
      frame: { x: 20, y: 30, width: 160, height: 60 },
      positions: {
        "item-1": { x: 0, y: 0 },
        "item-2": { x: 80, y: 0 },
      },
    });
  });

  it("does not create or move incomplete semantic or minimal candidates with unbounded members", async () => {
    const unboundedCard: FigmaRawNode = {
      id: "card-without-bounds",
      name: "Card without bounds",
      type: "FRAME",
    };
    const scenarios: Array<{ strategy: "semantic" | "minimal"; root: FigmaRawNode }> = [
      {
        strategy: "semantic",
        root: {
          id: "parent",
          name: "Dashboard",
          type: "FRAME",
          absoluteBoundingBox: parentBounds,
          children: [
            node("card-1", "Card one", 520, 330),
            unboundedCard,
            node("other-1", "Other one", 520, 430),
            node("other-2", "Other two", 640, 430),
            node("other-3", "Other three", 760, 430),
          ],
        },
      },
      {
        strategy: "minimal",
        root: {
          id: "parent",
          name: "Dashboard",
          type: "FRAME",
          absoluteBoundingBox: parentBounds,
          children: [
            node("card-1", "Card one", 520, 330),
            node("card-2", "Card two", 640, 330),
            unboundedCard,
          ],
        },
      },
    ];

    for (const { strategy, root } of scenarios) {
      const result = await handlePlanGrouping(contextFor(root), {
        nodeId: root.id,
        strategy,
      });
      expect(result.actions).toEqual([]);
    }
  });
});
