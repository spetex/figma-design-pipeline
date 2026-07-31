import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTION_TYPES } from "../src/shared/action-parity.js";
import { handleExecute } from "../src/tools/plugin/execute.js";

type PluginFigma = {
  currentPage: { id: string; name: string; selection: unknown[] };
  root: { name: string };
  showUI: ReturnType<typeof vi.fn>;
  ui: { onmessage?: (message: { type: string; data?: unknown }) => Promise<void>; postMessage: ReturnType<typeof vi.fn> };
  on: ReturnType<typeof vi.fn>;
  getNodeByIdAsync: (id: string) => Promise<unknown>;
  triggerUndo: ReturnType<typeof vi.fn>;
  loadFontAsync?: (font: { family: string; style: string }) => Promise<void>;
  createFrame?: ReturnType<typeof vi.fn>;
  createText?: ReturnType<typeof vi.fn>;
};

function batch(actions: Array<Record<string, unknown>>) {
  return {
    batchId: "test-batch",
    dryRun: false,
    stopOnError: true,
    rollbackOnError: true,
    requiredFonts: [],
    actions,
  };
}

async function runPlugin(figma: PluginFigma, actions: Array<Record<string, unknown>>) {
  vi.resetModules();
  vi.stubGlobal("figma", figma);
  vi.stubGlobal("__html__", "");
  await import("./code.js");
  await figma.ui.onmessage!({ type: "bridge_message", data: { type: "batch", ...batch(actions) } });
  return figma.ui.postMessage.mock.calls.find(
    ([message]) => message.type === "send_to_bridge" && message.data.type === "batch_result"
  )?.[0].data;
}

function baseFigma(getNodeByIdAsync: PluginFigma["getNodeByIdAsync"]): PluginFigma {
  return {
    currentPage: { id: "page", name: "Page", selection: [] },
    root: { name: "Document" },
    showUI: vi.fn(),
    ui: { postMessage: vi.fn() },
    on: vi.fn(),
    getNodeByIdAsync,
    triggerUndo: vi.fn(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("connected plugin batch execution", () => {
  it("rejects delete_node for a page before calling remove", async () => {
    const remove = vi.fn();
    const figma = baseFigma(async () => ({ id: "page", type: "PAGE", parent: { id: "document" }, remove }));

    const result = await runPlugin(figma, [{ type: "delete_node", nodeId: "page", confirmed: true }]);

    expect(result.summary).toMatchObject({ applied: 0, failed: 1 });
    expect(remove).not.toHaveBeenCalled();
  });

  it("does not undo after a no-op set_position followed by a failed action", async () => {
    const node = { id: "node", x: 0, y: 0, parent: { id: "parent" } };
    const figma = baseFigma(async (id) => id === "node" ? node : null);

    const result = await runPlugin(figma, [
      { type: "set_position", nodeId: "node", x: 0, y: 0 },
      { type: "rename", nodeId: "missing", name: "Fails" },
    ]);

    expect(result.summary).toMatchObject({ applied: 1, failed: 1 });
    expect(result.rollbackApplied).toBeUndefined();
    expect(figma.triggerUndo).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "a non-container frame parent",
      actions: [{ type: "create_frame", name: "Frame", parentId: "parent" }],
      setup: () => {
        const figma = baseFigma(async () => ({ id: "parent" }));
        figma.createFrame = vi.fn();
        return { figma, factory: figma.createFrame };
      },
    },
    {
      label: "a rejected text font",
      actions: [{ type: "create_text", parentId: "parent", characters: "Text" }],
      setup: () => {
        const figma = baseFigma(async () => ({ id: "parent", appendChild: vi.fn() }));
        figma.loadFontAsync = async () => { throw new Error("font unavailable"); };
        figma.createText = vi.fn();
        return { figma, factory: figma.createText };
      },
    },
    {
      label: "an invalid instance parent",
      actions: [{ type: "create_instance", componentId: "component", parentId: "parent" }],
      setup: () => {
        const createInstance = vi.fn();
        const figma = baseFigma(async (id) => id === "component"
          ? { id, type: "COMPONENT", createInstance }
          : { id });
        return { figma, factory: createInstance };
      },
    },
    {
      label: "an invalid component source parent",
      actions: [{ type: "create_component_from_node", nodeId: "source", name: "Component" }],
      setup: () => {
        const figma = baseFigma(async () => ({ id: "source", type: "RECTANGLE", parent: { id: "parent" } }));
        const createComponentFromNode = vi.fn();
        Object.assign(figma, { createComponentFromNode });
        return { figma, factory: createComponentFromNode };
      },
    },
    {
      label: "a non-component variant source",
      actions: [{ type: "create_component_set", componentIds: ["source"], name: "Variants" }],
      setup: () => {
        const figma = baseFigma(async () => ({ id: "source", type: "RECTANGLE" }));
        const combineAsVariants = vi.fn();
        Object.assign(figma, { combineAsVariants });
        return { figma, factory: combineAsVariants };
      },
    },
  ])("preflights $label before connected-plugin factories run", async ({ actions, setup }) => {
    const { figma, factory } = setup();

    const result = await runPlugin(figma, actions);

    expect(result.summary).toMatchObject({ applied: 0, failed: 1 });
    expect(factory).not.toHaveBeenCalled();
  });
});

type ParityCase = {
  type: string;
  action: Record<string, unknown>;
  operation: string;
};

const PAINT = { type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3, a: 0.4 } };
const EFFECT = { type: "DROP_SHADOW", visible: true, radius: 4, blendMode: "NORMAL", color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 1, y: 2 } };

const BEHAVIORAL_PARITY_CASES: ParityCase[] = [
  { type: "rename", action: { type: "rename", nodeId: "node", name: "Renamed" }, operation: "set:node.name" },
  { type: "move", action: { type: "move", nodeId: "node", targetParentId: "parent", insertIndex: 0 }, operation: "call:parent.insertChild" },
  { type: "create_text", action: { type: "create_text", parentId: "parent", characters: "Text", name: "Title", fontFamily: "Inter", fontWeight: 600, fontSize: 16, lineHeight: 20, letterSpacing: 1, fills: [PAINT], textCase: "UPPER", textAlignHorizontal: "CENTER", textAutoResize: "TRUNCATE", layoutSizingHorizontal: "FILL", layoutSizingVertical: "HUG", opacity: 0.5 }, operation: "call:figma.createText" },
  { type: "create_frame", action: { type: "create_frame", name: "Frame", parentId: "parent", x: 1, y: 2, width: 100, height: 50 }, operation: "call:figma.createFrame" },
  { type: "delete_node", action: { type: "delete_node", nodeId: "node", confirmed: true }, operation: "call:node.remove" },
  { type: "set_layout_mode", action: { type: "set_layout_mode", nodeId: "node", mode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" }, operation: "set:node.layoutMode" },
  { type: "set_spacing", action: { type: "set_spacing", nodeId: "node", itemSpacing: 8, paddingTop: 1, paddingRight: 2, paddingBottom: 3, paddingLeft: 4 }, operation: "set:node.paddingLeft" },
  { type: "resize", action: { type: "resize", nodeId: "node", width: 100, height: 50 }, operation: "call:node.resize" },
  { type: "create_component_from_node", action: { type: "create_component_from_node", nodeId: "source", name: "Component" }, operation: "call:figma.createComponentFromNode" },
  { type: "create_component_set", action: { type: "create_component_set", componentIds: ["component"], name: "Variants" }, operation: "call:figma.combineAsVariants" },
  { type: "create_instance", action: { type: "create_instance", componentId: "component", parentId: "parent", x: 1, y: 2 }, operation: "call:component.createInstance" },
  { type: "swap_instance", action: { type: "swap_instance", instanceId: "instance", newComponentId: "component" }, operation: "call:instance.swapComponent" },
  { type: "set_fills", action: { type: "set_fills", nodeId: "node", fills: [PAINT] }, operation: "set:node.fills" },
  { type: "set_text_content", action: { type: "set_text_content", nodeId: "text", characters: "Updated" }, operation: "set:text.characters" },
  { type: "set_text_style", action: { type: "set_text_style", nodeId: "text", fontFamily: "Inter", fontWeight: 600, fontSize: 18, lineHeight: 24, letterSpacing: 1 }, operation: "set:text.letterSpacing" },
  { type: "set_corner_radius", action: { type: "set_corner_radius", nodeId: "node", radius: 8, radii: [1, 2, 3, 4] }, operation: "set:node.bottomLeftRadius" },
  { type: "export_node", action: { type: "export_node", nodeId: "node", format: "PNG", scale: 2 }, operation: "call:node.exportAsync" },
  { type: "set_position", action: { type: "set_position", nodeId: "node", x: 10, y: 20 }, operation: "set:node.y" },
  { type: "set_layout_positioning", action: { type: "set_layout_positioning", nodeId: "node", positioning: "ABSOLUTE" }, operation: "set:node.layoutPositioning" },
  { type: "set_visible", action: { type: "set_visible", nodeId: "node", visible: false }, operation: "set:node.visible" },
  { type: "set_opacity", action: { type: "set_opacity", nodeId: "node", opacity: 0.5 }, operation: "set:node.opacity" },
  { type: "set_strokes", action: { type: "set_strokes", nodeId: "node", strokes: [PAINT], strokeWeight: 2 }, operation: "set:node.strokeWeight" },
  { type: "set_effects", action: { type: "set_effects", nodeId: "node", effects: [EFFECT] }, operation: "set:node.effects" },
  { type: "set_alignment", action: { type: "set_alignment", nodeId: "node", primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "BASELINE" }, operation: "set:node.counterAxisAlignItems" },
  { type: "duplicate_node", action: { type: "duplicate_node", nodeId: "node" }, operation: "call:node.clone" },
  { type: "set_component_properties", action: { type: "set_component_properties", nodeId: "instance", properties: { Variant: "Primary", Disabled: true } }, operation: "call:instance.setProperties" },
  { type: "create_paint_style", action: { type: "create_paint_style", name: "Color/Primary", paints: [PAINT] }, operation: "call:figma.createPaintStyle" },
  { type: "create_text_style", action: { type: "create_text_style", name: "Text/Body", fontFamily: "Inter", fontWeight: 500, fontSize: 16, lineHeight: 20, letterSpacing: 1 }, operation: "call:figma.createTextStyle" },
  { type: "create_effect_style", action: { type: "create_effect_style", name: "Effect/Shadow", effects: [EFFECT] }, operation: "call:figma.createEffectStyle" },
  { type: "set_child_layout_sizing", action: { type: "set_child_layout_sizing", nodeId: "node", layoutSizingHorizontal: "FILL", layoutSizingVertical: "HUG" }, operation: "set:node.layoutSizingVertical" },
  { type: "set_constraints", action: { type: "set_constraints", nodeId: "node", horizontal: "SCALE", vertical: "STRETCH" }, operation: "set:node.constraints" },
  { type: "set_min_max_size", action: { type: "set_min_max_size", nodeId: "node", minWidth: 1, maxWidth: 100, minHeight: 2, maxHeight: 200 }, operation: "set:node.maxHeight" },
  { type: "create_page", action: { type: "create_page", name: "Page" }, operation: "call:figma.createPage" },
  { type: "switch_page", action: { type: "switch_page", pageId: "page" }, operation: "call:figma.setCurrentPageAsync" },
  { type: "set_gradient_fill", action: { type: "set_gradient_fill", nodeId: "node", gradientType: "LINEAR", stops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } }], angle: 45 }, operation: "set:node.fills" },
  { type: "set_image_fill", action: { type: "set_image_fill", nodeId: "node", imageBase64: "AQID", scaleMode: "CROP" }, operation: "set:node.fills" },
  { type: "set_text_properties", action: { type: "set_text_properties", nodeId: "text", textAlignHorizontal: "CENTER", textAlignVertical: "BOTTOM", paragraphSpacing: 8, textCase: "TITLE", textDecoration: "UNDERLINE", textAutoResize: "HEIGHT" }, operation: "set:text.textAutoResize" },
  { type: "apply_style", action: { type: "apply_style", nodeId: "node", styleId: "style", property: "effect" }, operation: "call:node.setEffectStyleIdAsync" },
  { type: "set_description", action: { type: "set_description", nodeId: "component", description: "Description" }, operation: "set:component.description" },
  { type: "define_component_property", action: { type: "define_component_property", nodeId: "component", propertyName: "Label", propertyType: "TEXT", defaultValue: "Default" }, operation: "call:component.addComponentProperty" },
  { type: "create_variable_collection", action: { type: "create_variable_collection", name: "Tokens", modes: ["Light", "Dark"] }, operation: "call:variables.createVariableCollection" },
  { type: "create_variable", action: { type: "create_variable", collectionId: "collection", name: "spacing/md", resolvedType: "FLOAT", value: 8, scopes: ["ALL_SCOPES"] }, operation: "call:variables.createVariable" },
  { type: "bind_variable", action: { type: "bind_variable", nodeId: "node", property: "fills", variableId: "variable", paintIndex: 0 }, operation: "set:node.fills" },
];

function createBehavioralFigma() {
  const trace: string[] = [];
  const nodes = new Map<string, Record<string, unknown>>();
  const parent = makeParityNode("parent", "FRAME");
  const page = makeParityNode("page", "PAGE");
  page.selection = [];
  const collection = {
    id: "collection",
    name: "Collection",
    modes: [{ modeId: "mode" }],
    renameMode: () => trace.push("call:collection.renameMode"),
    addMode: () => trace.push("call:collection.addMode"),
  };
  const variable = { id: "variable" };

  for (const [id, type] of [["node", "RECTANGLE"], ["text", "TEXT"], ["source", "RECTANGLE"], ["component", "COMPONENT"], ["instance", "INSTANCE"]] as const) {
    const node = makeParityNode(id, type);
    node.parent = parent;
    nodes.set(id, node);
  }
  nodes.set("parent", parent);
  nodes.set("page", page);

  function makeParityNode(id: string, type: string): Record<string, unknown> {
    const node = {
      id,
      type,
      name: id,
      description: "",
      parent: undefined as Record<string, unknown> | undefined,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      visible: true,
      opacity: 1,
      fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
      strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
      effects: [],
      layoutMode: "NONE",
      primaryAxisSizingMode: "FIXED",
      counterAxisSizingMode: "FIXED",
      primaryAxisAlignItems: "MIN",
      counterAxisAlignItems: "MIN",
      itemSpacing: 0,
      paddingTop: 0,
      paddingRight: 0,
      paddingBottom: 0,
      paddingLeft: 0,
      layoutPositioning: "AUTO",
      layoutSizingHorizontal: "FIXED",
      layoutSizingVertical: "FIXED",
      minWidth: 0,
      maxWidth: 0,
      minHeight: 0,
      maxHeight: 0,
      fontName: { family: "Inter", style: "Regular" },
      characters: "Text",
      constraints: { horizontal: "MIN", vertical: "MIN" },
      appendChild: () => trace.push(`call:${id}.appendChild`),
      insertChild: () => trace.push(`call:${id}.insertChild`),
      remove: () => trace.push(`call:${id}.remove`),
      resize: () => trace.push(`call:${id}.resize`),
      clone: () => { trace.push(`call:${id}.clone`); return makeParityNode("clone", "RECTANGLE"); },
      createInstance: () => { trace.push(`call:${id}.createInstance`); return makeParityNode("created-instance", "INSTANCE"); },
      swapComponent: () => trace.push(`call:${id}.swapComponent`),
      setProperties: () => trace.push(`call:${id}.setProperties`),
      getRangeFontName: () => ({ family: "Inter", style: "Regular" }),
      exportAsync: async () => { trace.push(`call:${id}.exportAsync`); return new Uint8Array([1]); },
      addComponentProperty: () => trace.push(`call:${id}.addComponentProperty`),
      setBoundVariable: () => trace.push(`call:${id}.setBoundVariable`),
      setFillStyleIdAsync: async () => trace.push(`call:${id}.setFillStyleIdAsync`),
      setStrokeStyleIdAsync: async () => trace.push(`call:${id}.setStrokeStyleIdAsync`),
      setTextStyleIdAsync: async () => trace.push(`call:${id}.setTextStyleIdAsync`),
      setEffectStyleIdAsync: async () => trace.push(`call:${id}.setEffectStyleIdAsync`),
    };
    return new Proxy(node, {
      set(target, property, value) {
        trace.push(`set:${id}.${String(property)}`);
        Reflect.set(target, property, value);
        return true;
      },
    }) as Record<string, unknown>;
  }

  const figma = {
    currentPage: page,
    root: { name: "Document" },
    showUI: vi.fn(),
    ui: { postMessage: vi.fn() },
    on: vi.fn(),
    mixed: Symbol("mixed"),
    getNodeById: (id: string) => nodes.get(id),
    getNodeByIdAsync: async (id: string) => nodes.get(id) ?? null,
    loadFontAsync: async () => trace.push("call:figma.loadFontAsync"),
    createFrame: () => { trace.push("call:figma.createFrame"); return makeParityNode("frame", "FRAME"); },
    createText: () => { trace.push("call:figma.createText"); return makeParityNode("created-text", "TEXT"); },
    createComponentFromNode: () => { trace.push("call:figma.createComponentFromNode"); return makeParityNode("created-component", "COMPONENT"); },
    combineAsVariants: () => { trace.push("call:figma.combineAsVariants"); return makeParityNode("component-set", "COMPONENT_SET"); },
    createPaintStyle: () => { trace.push("call:figma.createPaintStyle"); return makeParityNode("paint-style", "PAINT_STYLE"); },
    createTextStyle: () => { trace.push("call:figma.createTextStyle"); return makeParityNode("text-style", "TEXT_STYLE"); },
    createEffectStyle: () => { trace.push("call:figma.createEffectStyle"); return makeParityNode("effect-style", "EFFECT_STYLE"); },
    createPage: () => { trace.push("call:figma.createPage"); return makeParityNode("created-page", "PAGE"); },
    setCurrentPageAsync: async () => trace.push("call:figma.setCurrentPageAsync"),
    createImage: () => { trace.push("call:figma.createImage"); return { hash: "image" }; },
    base64Decode: () => new Uint8Array([1]),
    base64Encode: () => "AQ==",
    triggerUndo: vi.fn(),
    variables: {
      getVariableById: () => variable,
      getVariableCollectionById: () => collection,
      setBoundVariableForPaint: (paint: Record<string, unknown>) => ({ ...paint, boundVariable: variable.id }),
      createVariableCollection: () => { trace.push("call:variables.createVariableCollection"); return collection; },
      createVariable: () => {
        trace.push("call:variables.createVariable");
        return { id: "created-variable", name: "variable", scopes: [], setValueForMode: () => trace.push("call:variable.setValueForMode") };
      },
    },
  };
  return { figma, trace };
}

describe("all-action behavioral parity", () => {
  it("has one executable behavior case for every action schema", () => {
    expect(BEHAVIORAL_PARITY_CASES.map(({ type }) => type).sort()).toEqual([...ACTION_TYPES].sort());
  });

  it.each(BEHAVIORAL_PARITY_CASES)("executes $type with the same observable operation in fallback and connected plugin", async ({ action, operation }) => {
    const fallback = createBehavioralFigma();
    const generated = await handleExecute(null, { actions: [action] });
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: typeof fallback.figma) => Promise<Array<Record<string, unknown>>>;
    const fallbackResults = await new AsyncFunction("figma", generated.fallbackJs!)(fallback.figma);

    const connected = createBehavioralFigma();
    const pluginResult = await runPlugin(connected.figma as unknown as PluginFigma, [action]);

    expect(fallbackResults).not.toEqual([expect.objectContaining({ status: "failed" })]);
    expect(pluginResult.summary).toMatchObject({ applied: 1, failed: 0 });
    expect(fallback.trace).toContain(operation);
    expect(connected.trace).toContain(operation);
  });

  it("enforces the same delete_node safety precondition in both paths", async () => {
    const action = { type: "delete_node", nodeId: "page", confirmed: true };
    const fallback = createBehavioralFigma();
    const generated = await handleExecute(null, { actions: [action] });
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: typeof fallback.figma) => Promise<Array<Record<string, unknown>>>;
    const fallbackResults = await new AsyncFunction("figma", generated.fallbackJs!)(fallback.figma);
    const connected = createBehavioralFigma();
    const pluginResult = await runPlugin(connected.figma as unknown as PluginFigma, [action]);

    expect(fallbackResults).toEqual([expect.objectContaining({ actionIndex: 0, status: "failed" })]);
    expect(pluginResult.summary).toMatchObject({ applied: 0, failed: 1 });
    expect(fallback.trace).not.toContain("call:page.remove");
    expect(connected.trace).not.toContain("call:page.remove");
  });
});
