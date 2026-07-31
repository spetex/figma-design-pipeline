import { describe, expect, it, vi } from "vitest";
import type { BridgeServer } from "../../plugin/bridge.js";
import { compileBatch, CREATE_TYPES } from "../../plugin/batch-compiler.js";
import { ACTION_PARITY, ACTION_TYPES } from "../../shared/action-parity.js";
import { handleExecute } from "./execute.js";
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
  const PARITY_CASES: Array<{
    type: keyof typeof ACTION_PARITY;
    action: unknown;
    expectedOperations: string[];
  }> = [
    { type: "rename", action: { type: "rename", nodeId: "node", name: "Renamed" }, expectedOperations: ['getNode("node").name = "Renamed"'] },
    { type: "move", action: { type: "move", nodeId: "node", targetParentId: "parent", insertIndex: 2 }, expectedOperations: ["p.insertChild(2, n)"] },
    { type: "create_text", action: { type: "create_text", parentId: "parent", characters: "Parity text", name: "Parity/Text", fontFamily: "Inter", fontWeight: 600, fontSize: 24, lineHeight: 28, letterSpacing: 1.5, fills: [{ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3, a: 0.4 }, opacity: 0.5 }], textCase: "UPPER", textAlignHorizontal: "CENTER", textAutoResize: "TRUNCATE", layoutSizingHorizontal: "FILL", layoutSizingVertical: "HUG", opacity: 0.6 }, expectedOperations: ['t.characters = "Parity text"', 't.textAutoResize = "TRUNCATE"', 't.layoutSizingHorizontal = "FILL"', 't.layoutSizingVertical = "HUG"'] },
    { type: "create_frame", action: { type: "create_frame", name: "Parity frame", parentId: "parent", x: 12, y: 34, width: 321, height: 123 }, expectedOperations: ["f.resize(321, 123)", "f.x = 12", "f.y = 34"] },
    { type: "delete_node", action: { type: "delete_node", nodeId: "node", confirmed: true }, expectedOperations: ['getNode("node").remove()'] },
    { type: "set_layout_mode", action: { type: "set_layout_mode", nodeId: "node", mode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" }, expectedOperations: ['n.primaryAxisSizingMode = "AUTO"', 'n.counterAxisSizingMode = "FIXED"'] },
    { type: "set_spacing", action: { type: "set_spacing", nodeId: "node", itemSpacing: 8, paddingTop: 1, paddingRight: 2, paddingBottom: 3, paddingLeft: 4 }, expectedOperations: ["n.itemSpacing = 8", "n.paddingLeft = 4"] },
    { type: "resize", action: { type: "resize", nodeId: "node", width: 200, height: 100 }, expectedOperations: ["n.resize(200, 100)"] },
    { type: "create_component_from_node", action: { type: "create_component_from_node", nodeId: "node", name: "Parity component" }, expectedOperations: ["figma.createComponentFromNode(getNode(\"node\"))"] },
    { type: "create_component_set", action: { type: "create_component_set", componentIds: ["component"], name: "Parity variants" }, expectedOperations: ['const comps = ["component"].map'] },
    { type: "create_instance", action: { type: "create_instance", componentId: "component", parentId: "parent", x: 14, y: 15 }, expectedOperations: ["inst.x = 14", "inst.y = 15"] },
    { type: "swap_instance", action: { type: "swap_instance", instanceId: "instance", newComponentId: "component" }, expectedOperations: ['getNode("instance").swapComponent(getNode("component"))'] },
    { type: "set_fills", action: { type: "set_fills", nodeId: "node", fills: [{ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3, a: 0.4 }, opacity: 0.5 }] }, expectedOperations: ["fills = sanitizePaints"] },
    { type: "set_text_content", action: { type: "set_text_content", nodeId: "node", characters: "New copy" }, expectedOperations: ["n.getRangeFontName", 'n.characters = "New copy"'] },
    { type: "set_text_style", action: { type: "set_text_style", nodeId: "node", fontFamily: "Roboto", fontSize: 16, fontWeight: 700, lineHeight: 20, letterSpacing: 0.25 }, expectedOperations: ['const family = "Roboto"', 'n.letterSpacing = { value: 0.25, unit: "PIXELS" }'] },
    { type: "set_corner_radius", action: { type: "set_corner_radius", nodeId: "node", radius: 5, radii: [1, 2, 3, 4] }, expectedOperations: ["n.cornerRadius = 5", "n.bottomLeftRadius=4"] },
    { type: "export_node", action: { type: "export_node", nodeId: "node", format: "PNG", scale: 3 }, expectedOperations: ['const format = "PNG"', "constraint: { type: \"SCALE\", value: scale }"] },
    { type: "set_position", action: { type: "set_position", nodeId: "node", x: 7, y: 9 }, expectedOperations: ["n.x = 7", "n.y = 9"] },
    { type: "set_layout_positioning", action: { type: "set_layout_positioning", nodeId: "node", positioning: "ABSOLUTE" }, expectedOperations: ['layoutPositioning = "ABSOLUTE"'] },
    { type: "set_visible", action: { type: "set_visible", nodeId: "node", visible: false }, expectedOperations: ["visible = false"] },
    { type: "set_opacity", action: { type: "set_opacity", nodeId: "node", opacity: 0.42 }, expectedOperations: ["opacity = 0.42"] },
    { type: "set_strokes", action: { type: "set_strokes", nodeId: "node", strokes: [{ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3, a: 0.4 }, opacity: 0.5 }], strokeWeight: 3 }, expectedOperations: ["strokes = sanitizePaints", "n.strokeWeight = 3"] },
    { type: "set_effects", action: { type: "set_effects", nodeId: "node", effects: [{ type: "DROP_SHADOW", visible: true, radius: 4, blendMode: "NORMAL", color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 1, y: 2 }, spread: 3, showShadowOnly: false }, { type: "LAYER_BLUR", visible: false, radius: 5 }] }, expectedOperations: ["effects = [{\"type\":\"DROP_SHADOW\""] },
    { type: "set_alignment", action: { type: "set_alignment", nodeId: "node", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "BASELINE" }, expectedOperations: ['primaryAxisAlignItems = "SPACE_BETWEEN"', 'counterAxisAlignItems = "BASELINE"'] },
    { type: "duplicate_node", action: { type: "duplicate_node", nodeId: "node" }, expectedOperations: ['getNode("node").clone()'] },
    { type: "set_component_properties", action: { type: "set_component_properties", nodeId: "node", properties: { Variant: "Primary", Disabled: true } }, expectedOperations: ['setProperties({"Variant":"Primary","Disabled":true})'] },
    { type: "create_paint_style", action: { type: "create_paint_style", name: "Parity/Color", paints: [{ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3, a: 0.4 }, opacity: 0.5 }] }, expectedOperations: ["s.paints = sanitizePaints"] },
    { type: "create_text_style", action: { type: "create_text_style", name: "Parity/Text", fontFamily: "Inter", fontWeight: 500, fontSize: 17, lineHeight: 22, letterSpacing: 0.75 }, expectedOperations: ['s.letterSpacing = { value: 0.75, unit: "PIXELS" }'] },
    { type: "create_effect_style", action: { type: "create_effect_style", name: "Parity/Effect", effects: [{ type: "BACKGROUND_BLUR", visible: true, radius: 8 }] }, expectedOperations: ["figma.createEffectStyle()"] },
    { type: "set_child_layout_sizing", action: { type: "set_child_layout_sizing", nodeId: "node", layoutSizingHorizontal: "FILL", layoutSizingVertical: "FIXED" }, expectedOperations: ['layoutSizingHorizontal = "FILL"', 'layoutSizingVertical = "FIXED"'] },
    { type: "set_constraints", action: { type: "set_constraints", nodeId: "node", horizontal: "SCALE", vertical: "STRETCH" }, expectedOperations: ['horizontal: "SCALE"', 'vertical: "STRETCH"'] },
    { type: "set_min_max_size", action: { type: "set_min_max_size", nodeId: "node", minWidth: 1, maxWidth: 2, minHeight: 3, maxHeight: 4 }, expectedOperations: ["n.minWidth = 1", "n.maxHeight = 4"] },
    { type: "create_page", action: { type: "create_page", name: "Parity page" }, expectedOperations: ["figma.createPage()"] },
    { type: "switch_page", action: { type: "switch_page", pageId: "page" }, expectedOperations: ['figma.setCurrentPageAsync(getNode("page"))'] },
    { type: "set_gradient_fill", action: { type: "set_gradient_fill", nodeId: "node", gradientType: "ANGULAR", stops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } }], angle: 45 }, expectedOperations: ["const angle = 45 * Math.PI / 180", "Math.cos(angle)"] },
    { type: "set_image_fill", action: { type: "set_image_fill", nodeId: "node", imageBase64: "AQID", scaleMode: "CROP" }, expectedOperations: ['figma.base64Decode("AQID")', 'scaleMode: "CROP"'] },
    { type: "set_text_properties", action: { type: "set_text_properties", nodeId: "node", textAlignHorizontal: "JUSTIFIED", textAlignVertical: "BOTTOM", paragraphSpacing: 6, textCase: "TITLE", textDecoration: "UNDERLINE", textAutoResize: "HEIGHT" }, expectedOperations: ['n.textAutoResize = "HEIGHT"', 'n.textDecoration = "UNDERLINE"'] },
    { type: "apply_style", action: { type: "apply_style", nodeId: "node", styleId: "style", property: "effect" }, expectedOperations: ["await n.setEffectStyleIdAsync(styleId)"] },
    { type: "set_description", action: { type: "set_description", nodeId: "node", description: "Parity description" }, expectedOperations: ['description = "Parity description"'] },
    { type: "define_component_property", action: { type: "define_component_property", nodeId: "node", propertyName: "Label", propertyType: "TEXT", defaultValue: "Default" }, expectedOperations: ['addComponentProperty("Label", "TEXT", "Default")'] },
    { type: "create_variable_collection", action: { type: "create_variable_collection", name: "Parity tokens", modes: ["Light", "Dark"] }, expectedOperations: ['const modes = ["Light","Dark"]', "c.renameMode", "c.addMode"] },
    { type: "create_variable", action: { type: "create_variable", collectionId: "collection", name: "color/primary", resolvedType: "COLOR", value: "#12345678", scopes: ["FRAME_FILL", "SHAPE_FILL"] }, expectedOperations: ['v.scopes = ["FRAME_FILL","SHAPE_FILL"]', 'parseVariableValue("COLOR", "#12345678")', "v.setValueForMode"] },
    { type: "bind_variable", action: { type: "bind_variable", nodeId: "node", property: "fills", variableId: "variable", paintIndex: 1 }, expectedOperations: ["figma.variables.setBoundVariableForPaint", "const paintIndex = 1", "n.fills = paints"] },
  ];

  it("defines an exhaustive shared parity contract for the action schemas", () => {
    expect(PARITY_CASES.map(({ type }) => type).sort()).toEqual([...ACTION_TYPES].sort());
  });

  it.each(PARITY_CASES)("emits $type operations with every declared schema parameter", async ({ type, action, expectedOperations }) => {
    const parsed = actionSchema.parse(action);
    expect(Object.keys(parsed).filter((key) => key !== "type").sort()).toEqual(
      [...ACTION_PARITY[type].schemaFields].sort()
    );

    const result = await handleExecute(null, { actions: [action] });
    for (const operation of expectedOperations) {
      expect(result.fallbackJs).toContain(operation);
    }
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => unknown;
    expect(() => new AsyncFunction("figma", result.fallbackJs!)).not.toThrow();
  });

  it("preserves the current font when set_text_style omits font fields", async () => {
    const node = {
      id: "text",
      fontName: { family: "Roboto", style: "Bold" },
      fontSize: 12,
    };
    const loadedFonts: Array<{ family: string; style: string }> = [];
    const figma = {
      mixed: Symbol("mixed"),
      getNodeById: () => node,
      loadFontAsync: async (font: { family: string; style: string }) => { loadedFonts.push(font); },
    };
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: typeof figma) => Promise<unknown>;

    const fallback = await handleExecute(null, {
      actions: [{ type: "set_text_style", nodeId: "text", fontSize: 18 }],
    });
    await new AsyncFunction("figma", fallback.fallbackJs!)(figma);

    expect(node.fontName).toEqual({ family: "Roboto", style: "Bold" });
    expect(node.fontSize).toBe(18);
    expect(loadedFonts).toEqual([{ family: "Roboto", style: "Bold" }]);
  });

  it("does not preload a replacement font when set_text_style omits font fields", () => {
    const action = actionSchema.parse({ type: "set_text_style", nodeId: "text", fontSize: 18 });
    expect(compileBatch([action]).requiredFonts).toEqual([]);
  });

  it("binds paint variables through setBoundVariableForPaint", async () => {
    const paint = { type: "SOLID", color: { r: 1, g: 0, b: 0 } };
    const node = { id: "node", fills: [paint] };
    const variable = { id: "variable" };
    const setBoundVariableForPaint = vi.fn().mockReturnValue({ ...paint, boundVariableId: variable.id });
    const figma = {
      getNodeById: () => node,
      variables: {
        getVariableById: () => variable,
        setBoundVariableForPaint,
      },
    };
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: typeof figma) => Promise<unknown>;

    const fallback = await handleExecute(null, {
      actions: [{ type: "bind_variable", nodeId: "node", property: "fills", variableId: "variable" }],
    });
    await new AsyncFunction("figma", fallback.fallbackJs!)(figma);

    expect(setBoundVariableForPaint).toHaveBeenCalledWith(paint, "color", variable);
    expect(node.fills).toEqual([{ ...paint, boundVariableId: variable.id }]);
  });

  it("implements dry-run, continuation, and rollback execution options", async () => {
    const dryRun = await handleExecute(null, {
      actions: [{ type: "rename", nodeId: "node", name: "Dry run" }],
      dryRun: true,
    });
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: unknown) => Promise<Array<Record<string, unknown>>>;
    await expect(new AsyncFunction("figma", dryRun.fallbackJs!)({})).resolves.toEqual([
      { actionIndex: 0, type: "rename", status: "planned", nodeId: "node" },
    ]);

    const node = { id: "node", name: "Before" };
    const triggerUndo = vi.fn();
    const fallback = await handleExecute(null, {
      actions: [
        { type: "rename", nodeId: "missing", name: "Fails" },
        { type: "rename", nodeId: "node", name: "Continues" },
      ],
      stopOnError: false,
      rollbackOnError: true,
    });
    expect(fallback.fallbackLimitations).toEqual([{
      option: "rollbackOnError",
      condition: "figma.triggerUndo_unavailable",
      message: expect.stringContaining("figma.triggerUndo"),
    }]);
    const result = await new AsyncFunction("figma", fallback.fallbackJs!)({
      getNodeById: (id: string) => id === "node" ? node : undefined,
      triggerUndo,
    });

    expect(node.name).toBe("Continues");
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionIndex: 0, status: "failed" }),
      expect.objectContaining({ type: "rename", nodeId: "node" }),
      { type: "rollback", status: "applied" },
    ]));
    expect(triggerUndo).toHaveBeenCalledTimes(1);
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
