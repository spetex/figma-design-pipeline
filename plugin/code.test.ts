import { afterEach, describe, expect, it, vi } from "vitest";
import { compileBatch } from "../src/plugin/batch-compiler.js";
import { ACTION_TYPES } from "../src/shared/action-parity.js";
import { actionSchema } from "../src/shared/actions.js";
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

function batch(actions: Array<Record<string, unknown>>, preloadFonts = false) {
  const compiled = compileBatch(actions.map((action) => actionSchema.parse(action)), {
    rollbackOnError: true,
  });
  return {
    batchId: "test-batch",
    ...compiled,
    requiredFonts: preloadFonts ? compiled.requiredFonts : [],
  };
}

function normalizeBridgeTransportFontPreloads(
  trace: readonly string[],
  actions: Array<Record<string, unknown>>
): string[] {
  const transportCalls = compileBatch(actions.map((action) => actionSchema.parse(action))).requiredFonts
    .map((font) => `call:figma.loadFontAsync:${JSON.stringify([font])}`);
  expect(trace.slice(0, transportCalls.length)).toEqual(transportCalls);
  return trace.slice(transportCalls.length);
}

async function runPlugin(
  figma: PluginFigma,
  actions: Array<Record<string, unknown>>,
  { preloadFonts = false }: { preloadFonts?: boolean } = {}
) {
  vi.resetModules();
  vi.stubGlobal("figma", figma);
  vi.stubGlobal("__html__", "");
  await import("./code.js");
  await figma.ui.onmessage!({ type: "bridge_message", data: { type: "batch", ...batch(actions, preloadFonts) } });
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

  it("rolls back a partial component-property write", async () => {
    const applied: Array<Record<string, string | boolean>> = [];
    const node = {
      id: "instance",
      type: "INSTANCE",
      parent: { id: "parent" },
      setProperties: (properties: Record<string, string | boolean>) => {
        applied.push(properties);
        if ("Second" in properties) throw new Error("Second rejected");
      },
    };
    const figma = baseFigma(async () => node);

    const result = await runPlugin(figma, [{
      type: "set_component_properties",
      nodeId: "instance",
      properties: { First: "Applied", Second: true },
    }]);

    expect(applied).toEqual([{ First: "Applied" }, { Second: true }]);
    expect(result.summary).toMatchObject({ applied: 0, failed: 1 });
    expect(result.rollbackApplied).toBe(true);
    expect(figma.triggerUndo).toHaveBeenCalledTimes(1);
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
};

const PAINT = { type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3, a: 0.4 } };
const EFFECT = { type: "DROP_SHADOW", visible: true, radius: 4, blendMode: "NORMAL", color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 1, y: 2 } };

const BEHAVIORAL_PARITY_CASES: ParityCase[] = [
  { type: "rename", action: { type: "rename", nodeId: "node", name: "Renamed" } },
  { type: "move", action: { type: "move", nodeId: "node", targetParentId: "parent", insertIndex: 0 } },
  { type: "create_text", action: { type: "create_text", parentId: "parent", characters: "Text", name: "Title", fontFamily: "Inter", fontWeight: 600, fontSize: 16, lineHeight: 20, letterSpacing: 1, fills: [PAINT], textCase: "UPPER", textAlignHorizontal: "CENTER", textAutoResize: "TRUNCATE", layoutSizingHorizontal: "FILL", layoutSizingVertical: "HUG", opacity: 0.5 } },
  { type: "create_frame", action: { type: "create_frame", name: "Frame", parentId: "parent", x: 1, y: 2, width: 100, height: 50 } },
  { type: "delete_node", action: { type: "delete_node", nodeId: "node", confirmed: true } },
  { type: "set_layout_mode", action: { type: "set_layout_mode", nodeId: "node", mode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED" } },
  { type: "set_spacing", action: { type: "set_spacing", nodeId: "node", itemSpacing: 8, paddingTop: 1, paddingRight: 2, paddingBottom: 3, paddingLeft: 4 } },
  { type: "resize", action: { type: "resize", nodeId: "node", width: 100, height: 50 } },
  { type: "create_component_from_node", action: { type: "create_component_from_node", nodeId: "source", name: "Component" } },
  { type: "create_component_set", action: { type: "create_component_set", componentIds: ["component"], name: "Variants" } },
  { type: "create_instance", action: { type: "create_instance", componentId: "component", parentId: "parent", x: 1, y: 2 } },
  { type: "swap_instance", action: { type: "swap_instance", instanceId: "instance", newComponentId: "component" } },
  { type: "set_fills", action: { type: "set_fills", nodeId: "node", fills: [PAINT] } },
  { type: "set_text_content", action: { type: "set_text_content", nodeId: "text", characters: "Updated" } },
  { type: "set_text_style", action: { type: "set_text_style", nodeId: "text", fontFamily: "Inter", fontWeight: 600, fontSize: 18, lineHeight: 24, letterSpacing: 1 } },
  { type: "set_corner_radius", action: { type: "set_corner_radius", nodeId: "node", radius: 8, radii: [1, 2, 3, 4] } },
  { type: "export_node", action: { type: "export_node", nodeId: "node", format: "PNG", scale: 2 } },
  { type: "set_position", action: { type: "set_position", nodeId: "node", x: 10, y: 20 } },
  { type: "set_layout_positioning", action: { type: "set_layout_positioning", nodeId: "node", positioning: "ABSOLUTE" } },
  { type: "set_visible", action: { type: "set_visible", nodeId: "node", visible: false } },
  { type: "set_opacity", action: { type: "set_opacity", nodeId: "node", opacity: 0.5 } },
  { type: "set_strokes", action: { type: "set_strokes", nodeId: "node", strokes: [PAINT], strokeWeight: 2 } },
  { type: "set_effects", action: { type: "set_effects", nodeId: "node", effects: [EFFECT] } },
  { type: "set_alignment", action: { type: "set_alignment", nodeId: "node", primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "BASELINE" } },
  { type: "duplicate_node", action: { type: "duplicate_node", nodeId: "node" } },
  { type: "set_component_properties", action: { type: "set_component_properties", nodeId: "instance", properties: { Variant: "Primary", Disabled: true } } },
  { type: "create_paint_style", action: { type: "create_paint_style", name: "Color/Primary", paints: [PAINT] } },
  { type: "create_text_style", action: { type: "create_text_style", name: "Text/Body", fontFamily: "Inter", fontWeight: 500, fontSize: 16, lineHeight: 20, letterSpacing: 1 } },
  { type: "create_effect_style", action: { type: "create_effect_style", name: "Effect/Shadow", effects: [EFFECT] } },
  { type: "set_child_layout_sizing", action: { type: "set_child_layout_sizing", nodeId: "node", layoutSizingHorizontal: "FILL", layoutSizingVertical: "HUG" } },
  { type: "set_constraints", action: { type: "set_constraints", nodeId: "node", horizontal: "SCALE", vertical: "STRETCH" } },
  { type: "set_min_max_size", action: { type: "set_min_max_size", nodeId: "node", minWidth: 1, maxWidth: 100, minHeight: 2, maxHeight: 200 } },
  { type: "create_page", action: { type: "create_page", name: "Page" } },
  { type: "switch_page", action: { type: "switch_page", pageId: "page" } },
  { type: "set_gradient_fill", action: { type: "set_gradient_fill", nodeId: "node", gradientType: "LINEAR", stops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } }], angle: 45 } },
  { type: "set_image_fill", action: { type: "set_image_fill", nodeId: "node", imageBase64: "AQID", scaleMode: "CROP" } },
  { type: "set_text_properties", action: { type: "set_text_properties", nodeId: "text", textAlignHorizontal: "CENTER", textAlignVertical: "BOTTOM", paragraphSpacing: 8, textCase: "TITLE", textDecoration: "UNDERLINE", textAutoResize: "HEIGHT" } },
  { type: "apply_style", action: { type: "apply_style", nodeId: "node", styleId: "style", property: "effect" } },
  { type: "set_description", action: { type: "set_description", nodeId: "component", description: "Description" } },
  { type: "define_component_property", action: { type: "define_component_property", nodeId: "component", propertyName: "Label", propertyType: "TEXT", defaultValue: "Default" } },
  { type: "create_variable_collection", action: { type: "create_variable_collection", name: "Tokens", modes: ["Light", "Dark"] } },
  { type: "create_variable", action: { type: "create_variable", collectionId: "collection", name: "spacing/md", resolvedType: "FLOAT", value: 8, scopes: ["ALL_SCOPES"] } },
  { type: "bind_variable", action: { type: "bind_variable", nodeId: "node", property: "fills", variableId: "variable", paintIndex: 0 } },
];

function createBehavioralFigma() {
  const trace: string[] = [];
  const nodes = new Map<string, Record<string, unknown>>();
  const nodeSnapshots = new Map<string, Record<string, unknown>>();
  const createdVariables: Record<string, unknown>[] = [];
  const observable = (value: unknown, seen = new WeakSet<object>()): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => observable(item, seen));
    if ("id" in value && typeof (value as { id?: unknown }).id === "string") {
      return { nodeId: (value as { id: string }).id };
    }
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) =>
        typeof item === "function" ? [] : [[key, observable(item, seen)]]
      )
    );
  };
  const snapshot = (value: Record<string, unknown>) => Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      typeof item === "function" ? [] : [[key, observable(item)]]
    )
  );
  const recordCall = (target: string, method: string, ...args: unknown[]) => {
    trace.push(`call:${target}.${method}:${JSON.stringify(args.map((arg) => observable(arg)))}`);
  };
  const recordSet = (target: string, property: PropertyKey, value: unknown) => {
    trace.push(`set:${target}.${String(property)}:${JSON.stringify(observable(value))}`);
  };
  const parent = makeParityNode("parent", "FRAME");
  const page = makeParityNode("page", "PAGE");
  page.selection = [];
  const collection = {
    id: "collection",
    name: "Collection",
    modes: [{ modeId: "mode", name: "Default" }],
    renameMode: (modeId: string, name: string) => {
      recordCall("collection", "renameMode", modeId, name);
      const mode = collection.modes.find((candidate) => candidate.modeId === modeId);
      if (mode) mode.name = name;
    },
    addMode: (name: string) => {
      recordCall("collection", "addMode", name);
      collection.modes.push({ modeId: `mode-${collection.modes.length}`, name });
    },
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
      appendChild: (child: unknown) => recordCall(id, "appendChild", child),
      insertChild: (index: number, child: unknown) => recordCall(id, "insertChild", index, child),
      remove: () => recordCall(id, "remove"),
      resize: (width: number, height: number) => recordCall(id, "resize", width, height),
      clone: () => { recordCall(id, "clone"); return makeParityNode("clone", "RECTANGLE"); },
      createInstance: () => { recordCall(id, "createInstance"); return makeParityNode("created-instance", "INSTANCE"); },
      swapComponent: (component: unknown) => recordCall(id, "swapComponent", component),
      setProperties: (properties: unknown) => recordCall(id, "setProperties", properties),
      getRangeFontName: () => ({ family: "Inter", style: "Regular" }),
      exportAsync: async (settings: unknown) => { recordCall(id, "exportAsync", settings); return new Uint8Array([1]); },
      addComponentProperty: (...args: unknown[]) => recordCall(id, "addComponentProperty", ...args),
      setBoundVariable: (...args: unknown[]) => recordCall(id, "setBoundVariable", ...args),
      setFillStyleIdAsync: async (...args: unknown[]) => recordCall(id, "setFillStyleIdAsync", ...args),
      setStrokeStyleIdAsync: async (...args: unknown[]) => recordCall(id, "setStrokeStyleIdAsync", ...args),
      setTextStyleIdAsync: async (...args: unknown[]) => recordCall(id, "setTextStyleIdAsync", ...args),
      setEffectStyleIdAsync: async (...args: unknown[]) => recordCall(id, "setEffectStyleIdAsync", ...args),
    };
    nodeSnapshots.set(id, node);
    return new Proxy(node, {
      set(target, property, value) {
        recordSet(id, property, value);
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
    loadFontAsync: async (...args: unknown[]) => recordCall("figma", "loadFontAsync", ...args),
    createFrame: () => { recordCall("figma", "createFrame"); return makeParityNode("frame", "FRAME"); },
    createText: () => { recordCall("figma", "createText"); return makeParityNode("created-text", "TEXT"); },
    createComponentFromNode: (...args: unknown[]) => { recordCall("figma", "createComponentFromNode", ...args); return makeParityNode("created-component", "COMPONENT"); },
    combineAsVariants: (...args: unknown[]) => { recordCall("figma", "combineAsVariants", ...args); return makeParityNode("component-set", "COMPONENT_SET"); },
    createPaintStyle: () => { recordCall("figma", "createPaintStyle"); return makeParityNode("paint-style", "PAINT_STYLE"); },
    createTextStyle: () => { recordCall("figma", "createTextStyle"); return makeParityNode("text-style", "TEXT_STYLE"); },
    createEffectStyle: () => { recordCall("figma", "createEffectStyle"); return makeParityNode("effect-style", "EFFECT_STYLE"); },
    createPage: () => {
      recordCall("figma", "createPage");
      const created = makeParityNode("created-page", "PAGE");
      nodes.set(created.id as string, created);
      return created;
    },
    setCurrentPageAsync: async (...args: unknown[]) => recordCall("figma", "setCurrentPageAsync", ...args),
    createImage: (...args: unknown[]) => { recordCall("figma", "createImage", ...args); return { hash: "image" }; },
    base64Decode: (...args: unknown[]) => { recordCall("figma", "base64Decode", ...args); return new Uint8Array([1]); },
    base64Encode: (...args: unknown[]) => { recordCall("figma", "base64Encode", ...args); return "AQ=="; },
    triggerUndo: vi.fn(),
    variables: {
      getVariableById: () => variable,
      getVariableCollectionById: () => collection,
      setBoundVariableForPaint: (...args: unknown[]) => {
        recordCall("variables", "setBoundVariableForPaint", ...args);
        return { ...(args[0] as Record<string, unknown>), boundVariable: variable.id };
      },
      createVariableCollection: (...args: unknown[]) => { recordCall("variables", "createVariableCollection", ...args); return collection; },
      createVariable: (name: string, targetCollection: unknown, resolvedType: string) => {
        recordCall("variables", "createVariable", name, targetCollection, resolvedType);
        const created = {
          id: "created-variable",
          name,
          resolvedType,
          scopes: [] as unknown[],
          values: {} as Record<string, unknown>,
          setValueForMode: (modeId: string, value: unknown) => {
            recordCall("created-variable", "setValueForMode", modeId, value);
            created.values[modeId] = value;
          },
        };
        createdVariables.push(created);
        return new Proxy(created, {
          set(target, property, value) {
            recordSet("created-variable", property, value);
            Reflect.set(target, property, value);
            return true;
          },
        });
      },
    },
  };
  trace.length = 0;
  return {
    figma,
    trace,
    nodes,
    state: () => ({
      nodes: Array.from(nodeSnapshots.entries()).map(([id, node]) => [id, snapshot(node)]),
      collection: snapshot(collection),
      variables: createdVariables.map((variableState) => snapshot(variableState)),
    }),
  };
}

describe("all-action behavioral parity", () => {
  it("has a full-field behavior case for every action schema", () => {
    expect(BEHAVIORAL_PARITY_CASES.map(({ type }) => type).sort()).toEqual([...ACTION_TYPES].sort());
    for (const { action } of BEHAVIORAL_PARITY_CASES) {
      const parsed = actionSchema.parse(action);
      const schema = actionSchema.options.find((option) => {
        const shape = (option as unknown as { shape: Record<string, unknown> }).shape;
        return (shape.type as { value: string }).value === parsed.type;
      });
      const shape = (schema as unknown as { shape: Record<string, unknown> }).shape;
      expect(Object.keys(action).sort()).toEqual(Object.keys(shape).sort());
    }
  });

  it.each(BEHAVIORAL_PARITY_CASES)("matches complete field-sensitive state and calls for $type", async ({ action }) => {
    const fallback = createBehavioralFigma();
    const generated = await handleExecute(null, { actions: [action] });
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: typeof fallback.figma) => Promise<Array<Record<string, unknown>>>;
    const fallbackResults = await new AsyncFunction("figma", generated.fallbackJs!)(fallback.figma);

    const connected = createBehavioralFigma();
    const pluginResult = await runPlugin(connected.figma as unknown as PluginFigma, [action], { preloadFonts: true });

    expect(fallbackResults).not.toEqual([expect.objectContaining({ status: "failed" })]);
    expect(pluginResult.summary).toMatchObject({ applied: 1, failed: 0 });
    // Strip only the compiler's known transport preloads. Any action-level
    // font call remains observable, exposing mismatched counts or arguments.
    expect(normalizeBridgeTransportFontPreloads(fallback.trace, [action]))
      .toEqual(normalizeBridgeTransportFontPreloads(connected.trace, [action]));
    expect(fallback.state()).toEqual(connected.state());
  });

  it("resolves create_page references before switch_page validation in both paths", async () => {
    const actions = [
      { type: "create_page", name: "Created page" },
      { type: "switch_page", pageId: "$ref:node-0" },
    ];
    const fallback = createBehavioralFigma();
    const generated = await handleExecute(null, { actions });
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: typeof fallback.figma) => Promise<Array<Record<string, unknown>>>;
    const fallbackResults = await new AsyncFunction("figma", generated.fallbackJs!)(fallback.figma);

    const connected = createBehavioralFigma();
    const pluginResult = await runPlugin(connected.figma as unknown as PluginFigma, actions, { preloadFonts: true });

    expect(fallbackResults).not.toEqual(expect.arrayContaining([expect.objectContaining({ status: "failed" })]));
    expect(pluginResult.summary).toMatchObject({ applied: 2, failed: 0 });
    expect(normalizeBridgeTransportFontPreloads(fallback.trace, actions))
      .toEqual(normalizeBridgeTransportFontPreloads(connected.trace, actions));
    expect(fallback.trace).toContain('call:figma.setCurrentPageAsync:[{"nodeId":"created-page"}]');
    expect(fallback.state()).toEqual(connected.state());
  });

  const PRECONDITION_PARITY_CASES: Array<{
    label: string;
    action: Record<string, unknown>;
    configure: (nodes: Map<string, Record<string, unknown>>) => void;
    forbidImageStoreMutation?: boolean;
  }> = [
    {
      label: "a protected page deletion",
      action: { type: "delete_node", nodeId: "page", confirmed: true },
      configure: () => {},
    },
    {
      label: "a missing destructive target",
      action: { type: "delete_node", nodeId: "node", confirmed: true },
      configure: (nodes) => { nodes.delete("node"); },
    },
    {
      label: "a missing move source",
      action: { type: "move", nodeId: "node", targetParentId: "parent", insertIndex: 0 },
      configure: (nodes) => { nodes.delete("node"); },
    },
    {
      label: "a non-container move target",
      action: { type: "move", nodeId: "node", targetParentId: "parent", insertIndex: 0 },
      configure: (nodes) => { delete nodes.get("parent")!.appendChild; },
    },
    {
      label: "a missing frame parent",
      action: { type: "create_frame", name: "Frame", parentId: "parent", x: 0, y: 0, width: 100, height: 100 },
      configure: (nodes) => { nodes.delete("parent"); },
    },
    {
      label: "a non-container text parent",
      action: { type: "create_text", parentId: "parent", characters: "Text", fontFamily: "Inter", fontWeight: 400 },
      configure: (nodes) => { delete nodes.get("parent")!.appendChild; },
    },
    {
      label: "a component source without a container parent",
      action: { type: "create_component_from_node", nodeId: "source", name: "Component" },
      configure: (nodes) => { nodes.get("source")!.parent = undefined; },
    },
    {
      label: "a non-component variant source",
      action: { type: "create_component_set", componentIds: ["component"], name: "Variants" },
      configure: (nodes) => { nodes.get("component")!.type = "RECTANGLE"; },
    },
    {
      label: "a non-component instance source",
      action: { type: "create_instance", componentId: "component", parentId: "parent", x: 0, y: 0 },
      configure: (nodes) => { nodes.get("component")!.type = "RECTANGLE"; },
    },
    {
      label: "a non-container instance parent",
      action: { type: "create_instance", componentId: "component", parentId: "parent", x: 0, y: 0 },
      configure: (nodes) => { delete nodes.get("parent")!.appendChild; },
    },
    {
      label: "a non-instance swap source",
      action: { type: "swap_instance", instanceId: "instance", newComponentId: "component" },
      configure: (nodes) => { nodes.get("instance")!.type = "RECTANGLE"; },
    },
    {
      label: "a non-component swap target",
      action: { type: "swap_instance", instanceId: "instance", newComponentId: "component" },
      configure: (nodes) => { nodes.get("component")!.type = "RECTANGLE"; },
    },
    {
      label: "a document page target",
      action: { type: "switch_page", pageId: "page" },
      configure: (nodes) => { nodes.get("page")!.type = "DOCUMENT"; },
    },
    {
      label: "a missing page target",
      action: { type: "switch_page", pageId: "page" },
      configure: (nodes) => { nodes.delete("page"); },
    },
    {
      label: "an unresolved page reference",
      action: { type: "switch_page", pageId: "$ref:node-0" },
      configure: () => {},
    },
    {
      label: "a missing image-fill target",
      action: { type: "set_image_fill", nodeId: "node", imageBase64: "AQID", scaleMode: "CROP" },
      configure: (nodes) => { nodes.delete("node"); },
      forbidImageStoreMutation: true,
    },
    {
      label: "an image-fill target without fills",
      action: { type: "set_image_fill", nodeId: "node", imageBase64: "AQID", scaleMode: "CROP" },
      configure: (nodes) => { delete nodes.get("node")!.fills; },
      forbidImageStoreMutation: true,
    },
    {
      label: "an unresolved image-fill target reference",
      action: { type: "set_image_fill", nodeId: "$ref:node-0", imageBase64: "AQID", scaleMode: "CROP" },
      configure: () => {},
      forbidImageStoreMutation: true,
    },
  ];

  it.each(PRECONDITION_PARITY_CASES)("fails without mutation for $label in both paths", async ({ action, configure, forbidImageStoreMutation }) => {
    const fallback = createBehavioralFigma();
    configure(fallback.nodes);
    fallback.trace.length = 0;
    const fallbackBefore = fallback.state();
    const generated = await handleExecute(null, { actions: [action], rollbackOnError: true });
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: typeof fallback.figma) => Promise<Array<Record<string, unknown>>>;
    const fallbackResults = await new AsyncFunction("figma", generated.fallbackJs!)(fallback.figma);
    const connected = createBehavioralFigma();
    configure(connected.nodes);
    connected.trace.length = 0;
    const connectedBefore = connected.state();
    const pluginResult = await runPlugin(connected.figma as unknown as PluginFigma, [action], { preloadFonts: true });

    expect(fallbackResults).toEqual([expect.objectContaining({ actionIndex: 0, status: "failed" })]);
    expect(pluginResult.summary).toMatchObject({ applied: 0, failed: 1 });
    expect(normalizeBridgeTransportFontPreloads(fallback.trace, [action]))
      .toEqual(normalizeBridgeTransportFontPreloads(connected.trace, [action]));
    expect(fallback.state()).toEqual(fallbackBefore);
    expect(connected.state()).toEqual(connectedBefore);
    expect(fallback.figma.triggerUndo).not.toHaveBeenCalled();
    expect(connected.figma.triggerUndo).not.toHaveBeenCalled();
    if (forbidImageStoreMutation) {
      for (const trace of [fallback.trace, connected.trace]) {
        expect(trace.some((entry) => entry.startsWith("call:figma.base64Decode:"))).toBe(false);
        expect(trace.some((entry) => entry.startsWith("call:figma.createImage:"))).toBe(false);
      }
    }
  });
});
