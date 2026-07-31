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
});
