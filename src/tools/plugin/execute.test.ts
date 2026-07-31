import { describe, expect, it, vi } from "vitest";
import type { BridgeServer } from "../../plugin/bridge.js";
import { CREATE_TYPES } from "../../plugin/batch-compiler.js";
import { SnapshotCache } from "../../pipeline/snapshot.js";
import type { EnrichedNode } from "../../shared/types.js";
import { handleExecute, invalidateSnapshotsAfterExecute } from "./execute.js";
import { actionSchema } from "../../shared/actions.js";

describe("actionSchema (zod v4)", () => {
  it("parses set_component_properties with the two-arg z.record signature", () => {
    const result = actionSchema.safeParse({
      type: "set_component_properties",
      nodeId: "1:2",
      properties: { Variant: "Primary", Disabled: false },
    });
    expect(result.success).toBe(true);
  });

  it("rejects set_component_properties with non-string/boolean values", () => {
    const result = actionSchema.safeParse({
      type: "set_component_properties",
      nodeId: "1:2",
      properties: { Variant: 42 },
    });
    expect(result.success).toBe(false);
  });
});

describe("handleExecute fallback generation", () => {
  it("keeps a planned grouping wrapper absolute in plugin and fallback execution paths", async () => {
    const actions = [
      {
        type: "create_frame" as const,
        name: "Grid/Cards",
        parentId: "parent",
        x: 20,
        y: 30,
        width: 320,
        height: 60,
      },
      {
        type: "set_layout_positioning" as const,
        nodeId: "$ref:node-0",
        positioning: "ABSOLUTE" as const,
      },
      {
        type: "set_position" as const,
        nodeId: "$ref:node-0",
        x: 20,
        y: 30,
      },
    ];
    const execute = vi.fn().mockResolvedValue({
      batchId: "test",
      dryRun: false,
      success: true,
      results: [],
      nodeIdMap: {},
      summary: { total: actions.length, applied: actions.length, failed: 0, skipped: 0 },
    });
    const bridge = {
      isConnected: () => true,
      execute,
    } as unknown as BridgeServer;

    await handleExecute(bridge, { actions });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: [
          expect.objectContaining({ type: "create_frame", _ref: "$ref:node-0" }),
          { type: "set_layout_positioning", nodeId: "$ref:node-0", positioning: "ABSOLUTE" },
          { type: "set_position", nodeId: "$ref:node-0", x: 20, y: 30 },
        ],
      }),
      undefined
    );

    const fallback = await handleExecute(null, { actions });
    const positioning = 'getNode("$ref:node-0").layoutPositioning = "ABSOLUTE";';
    const position = 'const n = getNode("$ref:node-0"); n.x = 20; n.y = 30;';
    expect(fallback.fallbackJs).toContain(positioning);
    expect(fallback.fallbackJs).toContain(position);
    expect(fallback.fallbackJs!.indexOf(positioning)).toBeLessThan(
      fallback.fallbackJs!.indexOf(position)
    );
  });

  it("resolves batch references in fallback JS when the plugin bridge is disconnected", async () => {
    const result = await handleExecute(null, {
      actions: [
        { type: "create_page", name: "Smoke Page" },
        { type: "create_frame", name: "Smoke Frame", parentId: "$ref:node-0", width: 400, height: 240, x: 0, y: 0 },
      ],
      dryRun: true,
      stopOnError: true,
      rollbackOnError: true,
      timeoutMs: 10_000,
    });

    expect(result.pluginConnected).toBe(false);
    expect(result.fallbackJs).toContain("const resolveRefId = (id) => {");
    expect(result.fallbackJs).toContain("const createdNodeIds = new Map();");
    expect(result.fallbackJs).toContain('const getNode = (id) => figma.getNodeById(resolveRefId(id));');
    expect(result.fallbackJs).toContain('getNode("$ref:node-0").appendChild(f);');
  });

  it("matches plugin create-order references for every create action type", async () => {
    const createActions: unknown[] = [
      { type: "create_frame", name: "Frame", parentId: "1:2" },
      { type: "create_text", parentId: "1:2", characters: "Text" },
      { type: "create_component_from_node", nodeId: "2:1", name: "Component" },
      { type: "create_component_set", componentIds: ["2:1"], name: "Variants" },
      { type: "create_instance", componentId: "2:1", parentId: "1:2" },
      { type: "duplicate_node", nodeId: "2:1" },
      {
        type: "create_paint_style",
        name: "Color/Primary",
        paints: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
      },
      {
        type: "create_text_style",
        name: "Type/Body",
        fontFamily: "Inter",
        fontSize: 16,
      },
      { type: "create_effect_style", name: "Effect/None", effects: [] },
      { type: "create_page", name: "Page" },
      { type: "create_variable_collection", name: "Tokens" },
      {
        type: "create_variable",
        collectionId: "VariableCollectionId:1",
        name: "spacing/md",
        resolvedType: "FLOAT",
        value: 16,
      },
    ];
    const actions = [
      { type: "rename", nodeId: "1:1", name: "Before creates" },
      ...createActions.flatMap((action, index) => [
        action,
        { type: "set_opacity", nodeId: "1:1", opacity: index / createActions.length },
      ]),
    ];
    const execute = vi.fn().mockResolvedValue({
      batchId: "test",
      dryRun: false,
      success: true,
      results: [],
      nodeIdMap: {},
      summary: { total: actions.length, applied: actions.length, failed: 0, skipped: 0 },
    });
    const bridge = {
      isConnected: () => true,
      execute,
    } as unknown as BridgeServer;

    await handleExecute(bridge, { actions });
    const pluginBatch = execute.mock.calls[0][0] as {
      actions: Array<Record<string, unknown>>;
    };
    const pluginReferences = pluginBatch.actions.flatMap((action) =>
      typeof action._ref === "string"
        ? [{ ref: action._ref, type: action.type }]
        : []
    );

    const fallback = await handleExecute(null, { actions });
    const fallbackReferences = Array.from(
      fallback.fallbackJs!.matchAll(
        /recordCreatedNode\("(\$ref:node-\d+)", \{ type: "([^"]+)"/g
      ),
      (match) => ({ ref: match[1], type: match[2] })
    );

    expect(createActions.map((action) => (action as { type: string }).type)).toEqual(
      Array.from(CREATE_TYPES)
    );
    expect(fallbackReferences).toEqual(pluginReferences);
    expect(pluginReferences.map(({ ref }) => ref)).toEqual(
      createActions.map((_, index) => `$ref:node-${index}`)
    );
  });

  it("resolves references by create order with ordinary actions before, between, and after creates", async () => {
    const actions = [
      { type: "rename", nodeId: "existing", name: "Renamed" },
      { type: "create_page", name: "Created page" },
      { type: "set_opacity", nodeId: "existing", opacity: 0.5 },
      {
        type: "create_frame",
        name: "Outer frame",
        parentId: "$ref:node-0",
        width: 200,
        height: 100,
      },
      { type: "set_visible", nodeId: "existing", visible: false },
      {
        type: "create_frame",
        name: "Inner frame",
        parentId: "$ref:node-1",
        width: 100,
        height: 50,
      },
      { type: "set_opacity", nodeId: "existing", opacity: 0.75 },
    ];
    type TestNode = {
      id: string;
      name: string;
      opacity: number;
      visible: boolean;
      children: TestNode[];
      parentId?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      appendChild: (child: TestNode) => void;
      resize: (width: number, height: number) => void;
    };
    const nodes = new Map<string, TestNode>();
    const makeNode = (id: string): TestNode => {
      const node: TestNode = {
        id,
        name: id,
        opacity: 1,
        visible: true,
        children: [],
        appendChild(child) {
          child.parentId = id;
          node.children.push(child);
        },
        resize(width, height) {
          node.width = width;
          node.height = height;
        },
      };
      nodes.set(id, node);
      return node;
    };
    const existing = makeNode("existing");
    let frameCounter = 0;
    const figma = {
      getNodeById: (id: string) => nodes.get(id),
      createPage: () => makeNode("page-1"),
      createFrame: () => makeNode(`frame-${++frameCounter}`),
    };
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: typeof figma) => Promise<unknown>;

    const fallback = await handleExecute(null, { actions });
    await new AsyncFunction("figma", fallback.fallbackJs!)(
      figma
    );

    expect(existing).toMatchObject({
      name: "Renamed",
      opacity: 0.75,
      visible: false,
    });
    expect(nodes.get("frame-1")?.parentId).toBe("page-1");
    expect(nodes.get("frame-2")?.parentId).toBe("frame-1");
  });

  it("supports create_text in fallback JS and sanitizes alpha into paint opacity", async () => {
    const result = await handleExecute(null, {
      actions: [
        {
          type: "create_text",
          parentId: "1:2",
          characters: "Hello",
          name: "Hero/Title",
          fontFamily: "Inter",
          fontWeight: 600,
          fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 0.5 } }],
          textAlignHorizontal: "CENTER",
          textAutoResize: "HEIGHT",
        },
      ],
      dryRun: true,
      stopOnError: true,
      rollbackOnError: true,
      timeoutMs: 10_000,
    });

    expect(result.pluginConnected).toBe(false);
    expect(result.fallbackJs).toContain("const sanitizePaints = (paints) =>");
    expect(result.fallbackJs).toContain('const t = figma.createText();');
    expect(result.fallbackJs).toContain('t.fills = sanitizePaints([{');
    expect(result.fallbackJs).toContain(
      'recordCreatedNode("$ref:node-0", { type: "create_text", nodeId: t.id });'
    );
  });
});

describe("inspection cache invalidation after execution", () => {
  it("clears inspection snapshots after a connected non-dry-run batch applies a mutation", () => {
    const snapshotCache = new SnapshotCache();
    snapshotCache.set("file/root", {} as EnrichedNode);

    const cacheInvalidated = invalidateSnapshotsAfterExecute(snapshotCache, {
      pluginConnected: true,
      result: {
        batchId: "batch-1",
        dryRun: false,
        success: true,
        results: [],
        nodeIdMap: {},
        summary: { total: 1, applied: 1, failed: 0, skipped: 0 },
      },
    });

    expect(cacheInvalidated).toBe(true);
    expect(snapshotCache.get("file/root", Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("does not invalidate for fallback, dry-run, or batches with no applied actions", () => {
    const makeExecution = (pluginConnected: boolean, dryRun: boolean, applied: number) => ({
      pluginConnected,
      result: {
        batchId: "batch-1",
        dryRun,
        success: true,
        results: [],
        nodeIdMap: {},
        summary: { total: 1, applied, failed: 0, skipped: 0 },
      },
    });

    for (const execution of [
      makeExecution(false, false, 1),
      makeExecution(true, true, 1),
      makeExecution(true, false, 0),
    ]) {
      const snapshotCache = new SnapshotCache();
      snapshotCache.set("file/root", {} as EnrichedNode);
      expect(invalidateSnapshotsAfterExecute(snapshotCache, execution)).toBe(false);
      expect(snapshotCache.get("file/root", Number.POSITIVE_INFINITY)).not.toBeNull();
    }
  });
});
