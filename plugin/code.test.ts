import { afterEach, describe, expect, it, vi } from "vitest";
import { compileBatch } from "../src/plugin/batch-compiler.js";
import { ACTION_TYPES } from "../src/shared/action-parity.js";
import { actionSchema } from "../src/shared/actions.js";
import { handleExecute } from "../src/tools/plugin/execute.js";

type PluginFigma = {
  fileKey?: string;
  currentPage: { id: string; name: string; selection: unknown[] };
  root: { name: string };
  showUI: ReturnType<typeof vi.fn>;
  ui: { onmessage?: (message: { type: string; data?: unknown }) => Promise<void>; postMessage: ReturnType<typeof vi.fn> };
  on: ReturnType<typeof vi.fn>;
  getNodeByIdAsync: (id: string) => Promise<unknown>;
  commitUndo: ReturnType<typeof vi.fn>;
  triggerUndo: ReturnType<typeof vi.fn>;
  loadAllPagesAsync: ReturnType<typeof vi.fn>;
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
    fileKey: "file-a",
    currentPage: { id: "page", name: "Page", selection: [] },
    root: { name: "Document" },
    showUI: vi.fn(),
    ui: { postMessage: vi.fn() },
    on: vi.fn(),
    getNodeByIdAsync,
    commitUndo: vi.fn(),
    triggerUndo: vi.fn(),
    loadAllPagesAsync: vi.fn().mockResolvedValue(undefined),
  };
}

async function runPluginRead(
  figma: PluginFigma,
  request: Record<string, unknown>
) {
  vi.resetModules();
  vi.stubGlobal("figma", figma);
  vi.stubGlobal("__html__", "");
  await import("./code.js");
  await figma.ui.onmessage!({
    type: "bridge_message",
    data: {
      type: "read_request",
      requestId: "read-1",
      operation: "tree",
      fileKey: "file-a",
      root: "node",
      nodeId: "root",
      depth: 2,
      limit: 50,
      scanLimit: 1000,
      ...request,
    },
  });
  return figma.ui.postMessage.mock.calls.find(
    ([message]) => message.type === "send_to_bridge" && message.data.type === "read_response"
  )?.[0].data;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("plugin startup", () => {
  it("loads all pages before registering the debounced document-change listener", async () => {
    vi.useFakeTimers();
    let finishLoading!: () => void;
    const figma = baseFigma(async () => null);
    figma.loadAllPagesAsync = vi.fn(() => new Promise<void>((resolve) => {
      finishLoading = resolve;
    }));

    vi.resetModules();
    vi.stubGlobal("figma", figma);
    vi.stubGlobal("__html__", "");
    await import("./code.js");

    expect(figma.loadAllPagesAsync).toHaveBeenCalledTimes(1);
    expect(figma.on).not.toHaveBeenCalledWith("documentchange", expect.any(Function));

    finishLoading();
    await vi.waitFor(() => {
      expect(figma.on).toHaveBeenCalledWith("documentchange", expect.any(Function));
    });

    const registrationIndex = figma.on.mock.calls.findIndex((call) => call[0] === "documentchange");
    expect(figma.loadAllPagesAsync.mock.invocationCallOrder[0]).toBeLessThan(
      figma.on.mock.invocationCallOrder[registrationIndex]
    );

    const listener = figma.on.mock.calls.find((call) => call[0] === "documentchange")![1] as () => void;
    listener();
    listener();
    expect(figma.ui.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      data: { type: "document_changed" },
    }));

    await vi.advanceTimersByTimeAsync(100);
    expect(figma.ui.postMessage).toHaveBeenCalledTimes(2);
    expect(figma.ui.postMessage).toHaveBeenLastCalledWith({
      type: "send_to_bridge",
      data: { type: "document_changed" },
    });
  });

  it("logs page-loading failures without interrupting plugin startup", async () => {
    const failure = new Error("pages unavailable");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const figma = baseFigma(async () => null);
    figma.loadAllPagesAsync = vi.fn().mockRejectedValue(failure);

    vi.resetModules();
    vi.stubGlobal("figma", figma);
    vi.stubGlobal("__html__", "");
    await expect(import("./code.js")).resolves.toBeDefined();
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith(
        "[plugin] Failed to register documentchange listener",
        failure
      );
    });

    expect(figma.showUI).toHaveBeenCalledTimes(1);
    expect(figma.ui.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "ui_status" }));
    expect(figma.on).not.toHaveBeenCalledWith("documentchange", expect.any(Function));
  });
});

describe("connected plugin read inspection", () => {
  function inspectionFigma() {
    const text = {
      id: "text",
      name: "Button label",
      type: "TEXT",
      visible: true,
      characters: Symbol("mixed"),
      absoluteBoundingBox: { x: 12, y: 8, width: 80, height: 20 },
      parent: null,
    };
    const component = {
      id: "component",
      name: "Button/Primary",
      type: "COMPONENT",
      visible: false,
      key: "component-key",
      description: "Primary action",
      children: [text],
      parent: null,
    };
    const componentSet = {
      id: "set",
      name: "Button",
      type: "COMPONENT_SET",
      visible: true,
      key: "set-key",
      description: "Button variants",
      children: [component],
      parent: null,
    };
    const frame = {
      id: "frame",
      name: "Card",
      type: "FRAME",
      visible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 200 },
      children: [],
      parent: null,
    };
    const root = {
      id: "root",
      name: "Page root",
      type: "FRAME",
      visible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 1200, height: 800 },
      children: [componentSet, frame],
      parent: null,
    };
    componentSet.parent = root as never;
    component.parent = componentSet as never;
    text.parent = component as never;
    frame.parent = root as never;
    const nodes = new Map([root, componentSet, component, text, frame].map((node) => [node.id, node]));
    const figma = baseFigma(async (id) => nodes.get(id) ?? null);
    figma.currentPage = { id: "page", name: "Components", selection: [frame] };
    return { figma, root, component, componentSet };
  }

  it("returns symbol-free bounded trees without unrelated selection metadata", async () => {
    const { figma } = inspectionFigma();
    const result = await runPluginRead(figma, { depth: 2, limit: 2 });

    expect(result).toMatchObject({
      success: true,
      operation: "tree",
      fileKey: "file-a",
      returnedCount: 2,
      totalScanned: 2,
      truncated: true,
      truncationReasons: ["result_limit"],
      currentPage: { id: "page", name: "Components" },
      roots: [{
        id: "root",
        visible: true,
        bounds: { width: 1200, height: 800 },
        childCount: 2,
        children: [{ id: "set", visible: true }],
      }],
    });
    expect(JSON.stringify(result)).not.toContain("Symbol");
    expect(result).not.toHaveProperty("selection");
    expect(result).not.toHaveProperty("selectionCount");
    expect(result).not.toHaveProperty("totalNodeCount");
    expect(figma.triggerUndo).not.toHaveBeenCalled();
  });

  it.each(["find", "components"] as const)(
    "bounds sparse %s reads by visited nodes and reports scan-limit truncation",
    async (operation) => {
      const result = await runPluginRead(inspectionFigma().figma, {
        operation,
        filters: { name: "Never matches" },
        scanLimit: operation === "find" ? 2 : 1,
      });

      expect(result).toMatchObject({
        returnedCount: 0,
        totalScanned: operation === "find" ? 2 : 1,
        scanLimit: operation === "find" ? 2 : 1,
        scanLimitReached: true,
        truncated: true,
        truncationReasons: ["scan_limit"],
      });
      expect(operation === "find" ? result.matches : result.components).toEqual([]);
    }
  );

  it("does not scan the full tree before bounded serialization", async () => {
    let childReads = 0;
    const nodes = Array.from({ length: 50 }, (_, index) => ({
      id: `child-${index}`,
      name: `Child ${index}`,
      type: "FRAME",
      parent: null,
    })) as Array<Record<string, unknown>>;
    for (const node of nodes) {
      Object.defineProperty(node, "children", {
        get: () => {
          childReads++;
          return [];
        },
      });
    }
    const root = { id: "root", name: "Root", type: "FRAME", children: nodes, parent: null };
    const figma = baseFigma(async (id) => id === "root" ? root : null);

    const result = await runPluginRead(figma, { depth: 2, limit: 2 });

    expect(result).toMatchObject({ returnedCount: 2, totalScanned: 2, truncated: true });
    expect(childReads).toBeLessThan(10);
  });

  it("bounds a 50,000-node selection to the requested metadata page", async () => {
    let nameReads = 0;
    const selection = Array.from({ length: 50_000 }, (_, index) => {
      const node = { id: `selected-${index}`, type: "FRAME", children: [] } as Record<string, unknown>;
      Object.defineProperty(node, "name", {
        enumerable: true,
        get: () => {
          nameReads++;
          return `Selected ${index}`;
        },
      });
      return node;
    });
    const figma = baseFigma(async () => null);
    figma.currentPage = { id: "page", name: "Large selection", selection };

    const result = await runPluginRead(figma, {
      root: "selection",
      nodeId: undefined,
      depth: 0,
      limit: 1,
    });

    expect(result).toMatchObject({
      returnedCount: 1,
      selectionCount: 50_000,
      selection: [{ id: "selected-0", name: "Selected 0", type: "FRAME" }],
      selectionMetadata: { offset: 0, returned: 1, total: 50_000, omitted: 49_999, nextOffset: 1 },
      roots: [{ id: "selected-0" }],
    });
    expect(nameReads).toBeLessThan(10);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(20_000);

    figma.ui.postMessage.mockClear();
    const continuation = await runPluginRead(figma, {
      root: "selection",
      nodeId: undefined,
      depth: 0,
      limit: 1,
      selectionMetadataOffset: 1,
    });
    expect(continuation).toMatchObject({
      selection: [{ id: "selected-1", name: "Selected 1" }],
      selectionMetadata: { offset: 1, returned: 1, total: 50_000, omitted: 49_999, nextOffset: 2 },
    });
  });

  it("bounds every Figma-origin scalar and reports exact truncation metadata", async () => {
    const huge = "😀".repeat(5_000);
    const text = {
      id: "text",
      name: "Label",
      type: "TEXT",
      characters: huge,
      children: [],
      parent: null,
    };
    const component = {
      id: huge,
      name: huge,
      type: "COMPONENT",
      key: huge,
      description: huge,
      children: [text],
      parent: null,
    };
    text.parent = component as never;
    const figma = baseFigma(async () => component);
    figma.currentPage = { id: "page", name: huge, selection: [] };

    const result = await runPluginRead(figma, { depth: 1, limit: 2 });
    const root = result.roots[0];
    const label = root.children[0];

    for (const value of [result.currentPage.name, root.id, root.name, root.componentKey, root.description, label.textContent]) {
      expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(4_000);
      expect(value.endsWith("…")).toBe(true);
    }
    expect(root.truncatedFields).toMatchObject({
      id: { originalBytes: 20_000, returnedBytes: 3_999 },
      name: { originalBytes: 20_000, returnedBytes: 3_999 },
      componentKey: { originalBytes: 20_000, returnedBytes: 3_999 },
      description: { originalBytes: 20_000, returnedBytes: 3_999 },
    });
    expect(label.truncatedFields.textContent).toEqual({ originalBytes: 20_000, returnedBytes: 3_999 });
    expect(result).toMatchObject({
      truncated: true,
      truncationReasons: ["scalar_field_limit"],
      truncatedFieldCount: 6,
      omittedScalarBytes: 6 * (20_000 - 3_999),
    });
  });

  it("filters descendants by exact name, regex name, and node type", async () => {
    const exact = await runPluginRead(inspectionFigma().figma, {
      operation: "find",
      filters: { name: "Card", type: "FRAME" },
    });
    const regex = await runPluginRead(inspectionFigma().figma, {
      operation: "find",
      filters: { namePattern: "button/(primary|secondary)", type: "COMPONENT" },
    });

    expect(exact.matches.map((node: { id: string }) => node.id)).toEqual(["frame"]);
    expect(regex.matches.map((node: { id: string }) => node.id)).toEqual(["component"]);
  });

  it("discovers component sets and components under the requested root", async () => {
    const result = await runPluginRead(inspectionFigma().figma, {
      operation: "components",
      depth: 3,
      limit: 10,
    });

    expect(result.components).toEqual([
      expect.objectContaining({ id: "set", name: "Button", type: "COMPONENT_SET", key: "set-key" }),
      expect.objectContaining({
        id: "component",
        name: "Button/Primary",
        type: "COMPONENT",
        componentSetId: "set",
      }),
    ]);
  });

  it.each([
    [{ nodeId: "missing" }, "Node not found: missing"],
    [{ operation: "find", filters: { namePattern: "[" } }, "Invalid namePattern regex"],
    [{ operation: "find", filters: { namePattern: "^(?<word>a+)\\k<word>+$" } }, "Unsafe namePattern regex"],
    [{ depth: 21 }, "Read depth must be between 0 and 20"],
    [{ limit: 1001 }, "Read limit must be between 1 and 1000"],
    [{ scanLimit: 10001 }, "Read scan limit must be between 1 and 10000"],
    [{ fileKey: "file-b" }, "Plugin file mismatch"],
  ])("returns a correlated read error for invalid input %#", async (request, message) => {
    const result = await runPluginRead(inspectionFigma().figma, request);
    expect(result).toMatchObject({ requestId: "read-1", success: false });
    expect(result.error).toContain(message);
  });
});

describe("connected plugin batch execution", () => {
  it("clears a new frame's fills immediately after creation", async () => {
    const operations: string[] = [];
    const parent = {
      id: "parent",
      appendChild: () => { operations.push("appendChild"); },
    };
    let fills: unknown = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    const frame = {
      id: "frame",
      name: "",
      resize: () => { operations.push("resize"); },
      x: 0,
      y: 0,
    } as Record<string, unknown>;
    Object.defineProperty(frame, "fills", {
      enumerable: true,
      get: () => fills,
      set: (value) => {
        operations.push("fills");
        fills = value;
      },
    });
    const figma = baseFigma(async () => parent);
    figma.createFrame = vi.fn(() => {
      operations.push("createFrame");
      return frame;
    });

    const result = await runPlugin(figma, [
      { type: "create_frame", name: "Frame", parentId: "parent" },
    ]);

    expect(result.summary).toMatchObject({ applied: 1, failed: 0 });
    expect(fills).toEqual([]);
    expect(operations.slice(0, 2)).toEqual(["createFrame", "fills"]);
  });

  it("defines a variant axis on an existing component set", async () => {
    const addComponentProperty = vi.fn().mockReturnValue("State#1");
    const figma = baseFigma(async () => ({ id: "set", type: "COMPONENT_SET", addComponentProperty }));

    const result = await runPlugin(figma, [{
      type: "define_component_property", nodeId: "set", propertyName: "State", propertyType: "VARIANT", defaultValue: "Default",
    }]);

    expect(result.summary).toMatchObject({ applied: 1, failed: 0 });
    expect(addComponentProperty).toHaveBeenCalledWith("State", "VARIANT", "Default");
  });

  it.each(["LINEAR", "RADIAL", "ANGULAR"])("serializes %s gradients without leaking mixed symbols", async (gradientType) => {
    const node = { id: "node", type: "RECTANGLE", parent: { id: "parent" }, fills: Symbol("mixed") };
    const figma = baseFigma(async () => node);
    const result = await runPlugin(figma, [{
      type: "set_gradient_fill", nodeId: "node", gradientType,
      stops: [
        { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
      ],
      angle: 30,
    }]);

    expect(result.summary).toMatchObject({ applied: 1, failed: 0 });
    expect(result.results[0].before.fills).toBe("mixed");
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("serializes mixed per-corner state and applies each explicit radius", async () => {
    const node = {
      id: "node", type: "RECTANGLE", parent: { id: "parent" }, cornerRadius: Symbol("mixed"),
      topLeftRadius: 0, topRightRadius: 0, bottomRightRadius: 0, bottomLeftRadius: 0,
    };
    const figma = baseFigma(async () => node);
    const result = await runPlugin(figma, [{ type: "set_corner_radius", nodeId: "node", radii: [1, 2, 3, 4] }]);

    expect(result.summary).toMatchObject({ applied: 1, failed: 0 });
    expect(result.results[0].before.cornerRadius).toBe("mixed");
    expect(node).toMatchObject({ topLeftRadius: 1, topRightRadius: 2, bottomRightRadius: 3, bottomLeftRadius: 4 });
  });

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

  it("isolates a failed second batch from a successful first batch", async () => {
    let committedName = "Before";
    let currentName = "Before";
    const node = {
      id: "node", type: "RECTANGLE", parent: { id: "parent" },
      get name() { return currentName; },
      set name(value: string) { currentName = value; },
    };
    const figma = baseFigma(async (id) => id === "node" ? node : null);
    figma.commitUndo.mockImplementation(() => { committedName = currentName; });
    figma.triggerUndo.mockImplementation(() => { currentName = committedName; });

    vi.resetModules();
    vi.stubGlobal("figma", figma);
    vi.stubGlobal("__html__", "");
    await import("./code.js");
    await figma.ui.onmessage!({ type: "bridge_message", data: { type: "batch", ...batch([
      { type: "rename", nodeId: "node", name: "Successful" },
    ]) } });
    await figma.ui.onmessage!({ type: "bridge_message", data: { type: "batch", ...batch([
      { type: "rename", nodeId: "node", name: "Transient" },
      { type: "rename", nodeId: "missing", name: "Fails" },
    ]) } });

    expect(currentName).toBe("Successful");
    expect(figma.commitUndo).toHaveBeenCalledTimes(3);
    expect(figma.triggerUndo).toHaveBeenCalledTimes(1);
  });

  it("loads a name-resolved text style font before applying it", async () => {
    const loaded = new Set<string>();
    const setTextStyleIdAsync = vi.fn(async () => {
      if (!loaded.has("Style Family|Regular")) throw new Error("style font was not loaded");
    });
    const figma = baseFigma(async () => ({ id: "text", type: "TEXT", parent: { id: "parent" }, setTextStyleIdAsync }));
    figma.loadFontAsync = async (font) => { loaded.add(`${font.family}|${font.style}`); };
    (figma as unknown as { getLocalTextStylesAsync: () => Promise<unknown[]> }).getLocalTextStylesAsync = async () => [{
      id: "style", type: "TEXT", name: "Typography/Body", fontName: { family: "Style Family", style: "Regular" },
    }];

    const result = await runPlugin(figma, [{ type: "apply_style", nodeId: "text", styleName: "Typography/Body", property: "text" }]);

    expect(result.summary).toMatchObject({ applied: 1, failed: 0 });
    expect(setTextStyleIdAsync).toHaveBeenCalledWith("style");
  });

  it("applies a text style before explicit create_text typography overrides", async () => {
    const events: string[] = [];
    const loaded = new Set<string>();
    let currentFont = { family: "Inter", style: "Regular" };
    const text = {
      id: "created", type: "TEXT", parent: { id: "parent" }, name: "", textAutoResize: "HEIGHT",
      get fontName() { return currentFont; },
      set fontName(font: { family: string; style: string }) {
        if (!loaded.has(`${font.family}|${font.style}`)) throw new Error("override font was not loaded");
        currentFont = font;
        events.push(`font:${font.family}|${font.style}`);
      },
      set characters(value: string) { events.push(`characters:${value}`); },
      async setTextStyleIdAsync() {
        if (!loaded.has("Style Family|Regular")) throw new Error("style font was not loaded");
        currentFont = { family: "Style Family", style: "Regular" };
        events.push("style");
      },
    };
    const figma = baseFigma(async () => ({ id: "parent", appendChild: vi.fn() }));
    figma.loadFontAsync = async (font) => { loaded.add(`${font.family}|${font.style}`); events.push(`load:${font.family}|${font.style}`); };
    figma.createText = vi.fn(() => text);
    (figma as unknown as { getLocalTextStylesAsync: () => Promise<unknown[]> }).getLocalTextStylesAsync = async () => [{
      id: "style", type: "TEXT", name: "Typography/Body", fontName: { family: "Style Family", style: "Regular" },
    }];

    const result = await runPlugin(figma, [{
      type: "create_text", parentId: "parent", characters: "Hello", textStyleName: "Typography/Body", fontWeight: 700,
    }]);

    expect(result.summary).toMatchObject({ applied: 1, failed: 0 });
    expect(events).toEqual([
      "load:Style Family|Regular", "load:Style Family|Bold", "style", "font:Style Family|Bold", "characters:Hello",
    ]);
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
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const BEHAVIORAL_PARITY_CASES: ParityCase[] = [
  { type: "inspect", action: { type: "inspect", nodeId: "node", depth: 0, limit: 10, scanLimit: 10 } },
  { type: "rename", action: { type: "rename", nodeId: "node", name: "Renamed" } },
  { type: "move", action: { type: "move", nodeId: "node", targetParentId: "parent", insertIndex: 0 } },
  { type: "create_text", action: { type: "create_text", parentId: "parent", characters: "Text", name: "Title", fontFamily: "Inter", fontWeight: 600, fontSize: 16, lineHeight: 20, letterSpacing: 1, fills: [PAINT], textCase: "UPPER", textAlignHorizontal: "CENTER", textAutoResize: "TRUNCATE", layoutSizingHorizontal: "FILL", layoutSizingVertical: "HUG", opacity: 0.5, textTruncation: "ENDING", maxLines: 2 } },
  { type: "create_frame", action: { type: "create_frame", name: "Frame", parentId: "parent", x: 1, y: 2, width: 100, height: 50 } },
  { type: "delete_node", action: { type: "delete_node", nodeId: "node", confirmed: true } },
  { type: "set_layout_mode", action: { type: "set_layout_mode", nodeId: "node", mode: "HORIZONTAL", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "FIXED", layoutWrap: "WRAP" } },
  { type: "set_spacing", action: { type: "set_spacing", nodeId: "node", itemSpacing: 8, paddingTop: 1, paddingRight: 2, paddingBottom: 3, paddingLeft: 4, counterAxisSpacing: 12 } },
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
  { type: "set_effects", action: { type: "set_effects", nodeId: "node", effects: [EFFECT, { type: "BACKGROUND_BLUR", visible: true, radius: 12 }] } },
  { type: "set_alignment", action: { type: "set_alignment", nodeId: "node", primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "BASELINE" } },
  { type: "duplicate_node", action: { type: "duplicate_node", nodeId: "node", targetParentId: "parent", insertIndex: 0, x: 4, y: 5 } },
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
  { type: "set_image_fill", action: { type: "set_image_fill", nodeId: "node", imageBase64: PNG_BASE64, scaleMode: "CROP" } },
  { type: "set_text_properties", action: { type: "set_text_properties", nodeId: "text", textAlignHorizontal: "CENTER", textAlignVertical: "BOTTOM", paragraphSpacing: 8, textCase: "TITLE", textDecoration: "UNDERLINE", textAutoResize: "HEIGHT" } },
  { type: "apply_style", action: { type: "apply_style", nodeId: "node", styleName: "style", property: "effect" } },
  { type: "set_description", action: { type: "set_description", nodeId: "component", description: "Description" } },
  { type: "define_component_property", action: { type: "define_component_property", nodeId: "component", propertyName: "Label", propertyType: "TEXT", defaultValue: "Default" } },
  { type: "create_variable_collection", action: { type: "create_variable_collection", name: "Tokens", modes: ["Light", "Dark"] } },
  { type: "create_variable", action: { type: "create_variable", collectionId: "collection", name: "spacing/md", resolvedType: "FLOAT", value: 8, scopes: ["ALL_SCOPES"] } },
  { type: "bind_variable", action: { type: "bind_variable", nodeId: "node", property: "topLeftRadius", variableName: "spacing/md", collectionName: "Collection", resolvedType: "FLOAT" } },
  { type: "set_component_property_reference", action: { type: "set_component_property_reference", nodeId: "component-child", property: "characters", componentPropertyName: "Label" } },
  { type: "set_instance_text", action: { type: "set_instance_text", instanceId: "instance", childPath: ["Label"], characters: "Nested" } },
  { type: "set_instance_visibility", action: { type: "set_instance_visibility", instanceId: "instance", childPath: ["Icon"], visible: false } },
  { type: "swap_nested_instance", action: { type: "swap_nested_instance", instanceId: "instance", childPath: ["Icon"], newComponentId: "component" } },
  { type: "set_variable_value", action: { type: "set_variable_value", variableName: "spacing/md", collectionName: "Collection", resolvedType: "FLOAT", modeName: "Default", value: 12 } },
  { type: "update_style", action: { type: "update_style", styleType: "TEXT", styleId: "text-target", copyFromStyleName: "Text/Source", name: "Text/Updated", fontFamily: "Inter", fontWeight: 700, fontSize: 18, lineHeight: 24, letterSpacing: 0.5 } },
  { type: "create_from_svg", action: { type: "create_from_svg", parentId: "parent", svg: "<svg><path d=\"M0 0h1v1z\"/></svg>", name: "Glyph", x: 3, y: 4 } },
  { type: "create_section", action: { type: "create_section", parentId: "page", name: "Flow", x: 1, y: 2, width: 300, height: 200 } },
  { type: "resize_section", action: { type: "resize_section", sectionId: "section", width: 400, height: 300 } },
  { type: "move_to_section", action: { type: "move_to_section", nodeId: "node", sectionId: "section", insertIndex: 0 } },
  { type: "set_reaction", action: { type: "set_reaction", nodeId: "node", trigger: "ON_CLICK", destinationId: "destination", navigation: "NAVIGATE", mode: "append" } },
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
  const variable = {
    id: "variable",
    name: "spacing/md",
    resolvedType: "FLOAT",
    variableCollectionId: "collection",
    setValueForMode: (modeId: string, value: unknown) => recordCall("variable", "setValueForMode", modeId, value),
  };

  for (const [id, type] of [["node", "RECTANGLE"], ["text", "TEXT"], ["source", "RECTANGLE"], ["component", "COMPONENT"], ["instance", "INSTANCE"], ["section", "SECTION"], ["destination", "FRAME"], ["component-child", "TEXT"]] as const) {
    const node = makeParityNode(id, type);
    node.parent = parent;
    nodes.set(id, node);
  }
  const component = nodes.get("component")!;
  component.componentPropertyDefinitions = {
    Variant: { type: "VARIANT", defaultValue: "Primary" },
    "Disabled#1": { type: "BOOLEAN", defaultValue: false },
    "Label#2": { type: "TEXT", defaultValue: "Label" },
    "Icon#3": { type: "INSTANCE_SWAP", defaultValue: "component" },
  };
  const label = makeParityNode("instance-label", "TEXT");
  label.name = "Label";
  label.parent = nodes.get("instance");
  const icon = makeParityNode("instance-icon", "INSTANCE");
  icon.name = "Icon";
  icon.parent = nodes.get("instance");
  icon.getMainComponentAsync = async () => component;
  nodes.set("instance-label", label);
  nodes.set("instance-icon", icon);
  nodes.get("instance")!.children = [label, icon];
  nodes.get("instance")!.getMainComponentAsync = async () => component;
  nodes.get("component-child")!.parent = component;
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
      topLeftRadius: 0,
      topRightRadius: 0,
      bottomRightRadius: 0,
      bottomLeftRadius: 0,
      fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
      strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }],
      effects: [],
      layoutMode: "HORIZONTAL",
      layoutWrap: "WRAP",
      counterAxisSpacing: 0,
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
      children: [] as Record<string, unknown>[],
      componentPropertyReferences: null as Record<string, string> | null,
      reactions: [] as unknown[],
      appendChild: (child: unknown) => recordCall(id, "appendChild", child),
      insertChild: (index: number, child: unknown) => recordCall(id, "insertChild", index, child),
      remove: () => recordCall(id, "remove"),
      resize: (width: number, height: number) => recordCall(id, "resize", width, height),
      clone: () => {
        recordCall(id, "clone");
        const clone = makeParityNode("clone", "RECTANGLE");
        nodes.set("clone", clone);
        return clone;
      },
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
      setReactionsAsync: async (...args: unknown[]) => {
        recordCall(id, "setReactionsAsync", ...args);
        node.reactions = args[0] as unknown[];
      },
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

  const paintTarget = makeParityNode("paint-target", "PAINT");
  paintTarget.paints = [];
  const effectStyle = makeParityNode("style", "EFFECT");
  const textTarget = makeParityNode("text-target", "TEXT");
  const textSource = makeParityNode("text-source", "TEXT");
  textSource.name = "Text/Source";
  textSource.fontSize = 14;
  textSource.lineHeight = { value: 20, unit: "PIXELS" };
  textSource.letterSpacing = { value: 0, unit: "PIXELS" };
  const styles = new Map([["paint-target", paintTarget], ["style", effectStyle], ["text-target", textTarget], ["text-source", textSource]]);

  const figma = {
    editorType: "figma",
    currentPage: page,
    root: { name: "Document" },
    showUI: vi.fn(),
    ui: { postMessage: vi.fn() },
    on: vi.fn(),
    mixed: Symbol("mixed"),
    getNodeById: (id: string) => nodes.get(id),
    getNodeByIdAsync: async (id: string) => nodes.get(id) ?? null,
    loadFontAsync: async (...args: unknown[]) => recordCall("figma", "loadFontAsync", ...args),
    createFrame: () => {
      recordCall("figma", "createFrame");
      const frame = makeParityNode("frame", "FRAME");
      nodes.set("frame", frame);
      return frame;
    },
    createText: () => { recordCall("figma", "createText"); return makeParityNode("created-text", "TEXT"); },
    createComponentFromNode: (...args: unknown[]) => { recordCall("figma", "createComponentFromNode", ...args); return makeParityNode("created-component", "COMPONENT"); },
    combineAsVariants: (...args: unknown[]) => { recordCall("figma", "combineAsVariants", ...args); return makeParityNode("component-set", "COMPONENT_SET"); },
    createPaintStyle: () => { recordCall("figma", "createPaintStyle"); return makeParityNode("paint-style", "PAINT_STYLE"); },
    createTextStyle: () => { recordCall("figma", "createTextStyle"); return makeParityNode("text-style", "TEXT_STYLE"); },
    createEffectStyle: () => { recordCall("figma", "createEffectStyle"); return makeParityNode("effect-style", "EFFECT_STYLE"); },
    createNodeFromSvg: (...args: unknown[]) => { recordCall("figma", "createNodeFromSvg", ...args); return makeParityNode("svg-node", "FRAME"); },
    createSection: () => { recordCall("figma", "createSection"); return makeParityNode("created-section", "SECTION"); },
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
    commitUndo: vi.fn(),
    triggerUndo: vi.fn(),
    getStyleByIdAsync: async (id: string) => styles.get(id) ?? null,
    getLocalPaintStylesAsync: async () => [...styles.values()].filter((style) => style.type === "PAINT"),
    getLocalTextStylesAsync: async () => [...styles.values()].filter((style) => style.type === "TEXT"),
    getLocalEffectStylesAsync: async () => [...styles.values()].filter((style) => style.type === "EFFECT"),
    variables: {
      getVariableById: () => variable,
      getVariableCollectionById: () => collection,
      getVariableByIdAsync: async () => variable,
      getVariableCollectionByIdAsync: async () => collection,
      getLocalVariablesAsync: async () => [variable],
      getLocalVariableCollectionsAsync: async () => [collection],
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

function createInspectableBehavioralFigma() {
  const environment = createBehavioralFigma();
  environment.figma.loadAllPagesAsync = vi.fn().mockResolvedValue(undefined);
  const parent = environment.nodes.get("parent")!;
  parent.children = [];
  const attach = (container: Record<string, unknown>, child: Record<string, unknown>) => {
    (container.children as Record<string, unknown>[]).push(child);
    child.parent = container;
  };
  parent.appendChild = (child: Record<string, unknown>) => attach(parent, child);

  const makeNode = (id: string, type: string, name: string, width: number, height: number) => {
    const node: Record<string, unknown> = {
      id, type, name, parent: undefined, children: [], visible: true, opacity: 1,
      width, height, absoluteBoundingBox: { x: 0, y: 0, width, height },
      fills: [{ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3 }, opacity: 0.8 }],
      strokes: [], effects: [], fillStyleId: "paint-style", boundVariables: {},
      resize: (nextWidth: number, nextHeight: number) => {
        node.width = nextWidth;
        node.height = nextHeight;
        node.absoluteBoundingBox = { x: 0, y: 0, width: nextWidth, height: nextHeight };
      },
      appendChild: (child: Record<string, unknown>) => attach(node, child),
      getCSSAsync: async () => ({ background: "rgba(26, 51, 77, 0.8)", width: `${node.width}px` }),
    };
    environment.nodes.set(id, node);
    return node;
  };

  environment.figma.createFrame = () => makeNode("created-card", "FRAME", "Frame", 100, 100);
  environment.figma.createText = () => {
    const text = makeNode("created-label", "TEXT", "Text", 80, 20);
    text.fontName = { family: "Inter", style: "Regular" };
    text.characters = "";
    text.textAutoResize = "HEIGHT";
    text.setTextStyleIdAsync = async () => {};
    return text;
  };
  const component = environment.nodes.get("component")!;
  component.componentPropertyDefinitions = {
    Variant: { type: "VARIANT", defaultValue: "Primary" },
    Disabled: { type: "BOOLEAN", defaultValue: false },
  };
  component.createInstance = () => {
    const instance = makeNode("created-instance", "INSTANCE", "Button", 120, 40);
    instance.componentProperties = {
      Variant: { type: "VARIANT", value: "Primary" },
      Disabled: { type: "BOOLEAN", value: false },
    };
    instance.getMainComponentAsync = async () => component;
    instance.setProperties = (properties: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(properties)) {
        (instance.componentProperties as Record<string, { type: string; value: unknown }>)[key].value = value;
      }
    };
    return instance;
  };
  return environment;
}

function normalizeInspection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeInspection);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => key === "responseBytes" ? [] : [[
    key,
    key === "classification" ? "normalized" : normalizeInspection(item),
  ]]));
}

describe("all-action behavioral parity", () => {
  it("has a full-field behavior case for every action schema", () => {
    expect(BEHAVIORAL_PARITY_CASES.map(({ type }) => type).sort()).toEqual([...ACTION_TYPES].sort());
    for (const { action } of BEHAVIORAL_PARITY_CASES) {
      expect(actionSchema.parse(action).type).toBe(action.type);
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
      label: "counter-axis spacing without wrapping",
      action: { type: "set_spacing", nodeId: "node", itemSpacing: 8, counterAxisSpacing: 12 },
      configure: (nodes) => { nodes.get("node")!.layoutWrap = "NO_WRAP"; },
    },
    {
      label: "baseline alignment on vertical layout",
      action: { type: "set_alignment", nodeId: "node", primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "BASELINE" },
      configure: (nodes) => { nodes.get("node")!.layoutMode = "VERTICAL"; },
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
      label: "a missing image-fill target",
      action: { type: "set_image_fill", nodeId: "node", imageBase64: PNG_BASE64, scaleMode: "CROP" },
      configure: (nodes) => { nodes.delete("node"); },
      forbidImageStoreMutation: true,
    },
    {
      label: "an image-fill target without fills",
      action: { type: "set_image_fill", nodeId: "node", imageBase64: PNG_BASE64, scaleMode: "CROP" },
      configure: (nodes) => { delete nodes.get("node")!.fills; },
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

describe("stable named references", () => {
  it("publishes aliases in nodeIdMap and resolves them in later connected actions", async () => {
    const environment = createBehavioralFigma();
    const result = await runPlugin(environment.figma as unknown as PluginFigma, [
      { type: "create_frame", parentId: "parent", name: "Outer", as: "outer" },
      { type: "duplicate_node", nodeId: "$outer", targetParentId: "parent", as: "copy" },
      { type: "rename", nodeId: "$copy", name: "Copy" },
    ]);

    expect(result.summary).toMatchObject({ applied: 3, failed: 0 });
    expect(result.nodeIdMap).toMatchObject({ "$ref:node-0": "frame", "$outer": "frame", "$ref:node-1": "clone", "$copy": "clone" });
    expect(environment.trace).toContain('set:clone.name:"Copy"');
  });
});

describe("same-batch inspect action", () => {
  const actions = [
    { type: "create_frame", parentId: "parent", name: "Card", width: 320, height: 180, as: "card" },
    { type: "create_text", parentId: "$card", characters: "Hello", name: "Title", fontFamily: "Inter", fontWeight: 400, fills: [PAINT], as: "label" },
    { type: "create_instance", componentId: "component", parentId: "$card", x: 8, y: 24, as: "button" },
    { type: "set_component_properties", nodeId: "$button", properties: { Variant: "Secondary", Disabled: true } },
    { type: "inspect", nodeId: "$card", depth: 2, limit: 20, scanLimit: 20 },
  ];

  it("returns ordered create-to-inspect data with connected/fallback contract parity", async () => {
    const fallback = createInspectableBehavioralFigma();
    const generated = await handleExecute(null, { actions, rollbackOnError: true });
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: typeof fallback.figma) => Promise<Array<Record<string, unknown>>>;
    const fallbackResults = await new AsyncFunction("figma", generated.fallbackJs!)(fallback.figma);

    const connected = createInspectableBehavioralFigma();
    const pluginResult = await runPlugin(connected.figma as unknown as PluginFigma, actions, { preloadFonts: true });
    const connectedInspection = pluginResult.results[4].inspection;
    const fallbackInspection = fallbackResults[4].inspection;

    expect(pluginResult.results.map((result: { type: string }) => result.type)).toEqual(actions.map((action) => action.type));
    expect(fallbackResults.slice(0, actions.length).map((result) => result.type)).toEqual(actions.map((action) => action.type));
    expect(pluginResult.summary).toMatchObject({ applied: 5, failed: 0, mutations: 4 });
    expect(pluginResult.nodeIdMap).toMatchObject({ "$card": "created-card", "$label": "created-label", "$button": "created-instance" });
    expect(connectedInspection.root).toMatchObject({
      id: "created-card",
      bounds: { width: 320, height: 180 },
      css: { background: "rgba(26, 51, 77, 0.8)", width: "320px" },
      children: [
        { id: "created-label", textContent: "Hello", bounds: { width: 80, height: 20 }, fills: [{ color: { r: 0.1, g: 0.2, b: 0.3 } }] },
        { id: "created-instance", componentId: "component", componentProperties: { Variant: { value: "Secondary" }, Disabled: { value: true } } },
      ],
    });
    expect(normalizeInspection(fallbackInspection)).toEqual(normalizeInspection(connectedInspection));
    expect(pluginResult.summary.mutations).toBe(actions.length - 1);
    expect(connected.figma.triggerUndo).not.toHaveBeenCalled();
    expect(fallback.figma.triggerUndo).not.toHaveBeenCalled();
  });

  it("enforces scalar, result, scan, and aggregate response bounds in both paths", async () => {
    const inspectActions = [
      { type: "inspect", nodeId: "node", depth: 1, limit: 50, scanLimit: 1_000 },
      { type: "inspect", nodeId: "node", depth: 1, limit: 1_000, scanLimit: 50 },
    ];
    const configureLargeTree = (environment: ReturnType<typeof createInspectableBehavioralFigma>) => {
      const root = environment.nodes.get("node")!;
      root.characters = "😀".repeat(5_000);
      root.absoluteBoundingBox = { x: 0, y: 0, width: 1000, height: 1000 };
      root.children = Array.from({ length: 80 }, (_, index) => ({
        id: `child-${index}`,
        name: `Child ${index} ${"x".repeat(800)}`,
        type: "FRAME",
        visible: true,
        absoluteBoundingBox: { x: 0, y: index * 10, width: 100, height: 10 },
        children: [],
        parent: root,
      }));
    };

    const fallback = createInspectableBehavioralFigma();
    configureLargeTree(fallback);
    const generated = await handleExecute(null, { actions: inspectActions });
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: typeof fallback.figma) => Promise<Array<Record<string, unknown>>>;
    const fallbackResults = await new AsyncFunction("figma", generated.fallbackJs!)(fallback.figma);

    const connected = createInspectableBehavioralFigma();
    configureLargeTree(connected);
    const pluginResult = await runPlugin(connected.figma as unknown as PluginFigma, inspectActions);

    for (const results of [fallbackResults, pluginResult.results]) {
      const inspections = results.map((result: { inspection: { responseBytes: number; truncationReasons: string[]; root: { textContent: string; truncatedFields: Record<string, unknown> } } }) => result.inspection);
      expect(inspections.reduce((bytes, inspection) => bytes + inspection.responseBytes, 0)).toBeLessThanOrEqual(80_000);
      for (const inspection of inspections) {
        expect(inspection.responseBytes).toBe(Buffer.byteLength(JSON.stringify(inspection), "utf8"));
      }
      expect(inspections.some((inspection) => inspection.truncationReasons.includes("response_byte_limit"))).toBe(true);
      expect(inspections[0].truncationReasons).toContain("result_limit");
      expect(inspections[1].truncationReasons).toContain("scan_limit");
      expect(inspections[0].truncationReasons).toContain("scalar_field_limit");
      expect(Buffer.byteLength(inspections[0].root.textContent, "utf8")).toBeLessThanOrEqual(4_000);
      expect(inspections[0].root.truncatedFields).toHaveProperty("textContent");
    }
    expect(pluginResult.summary).toMatchObject({ applied: 2, failed: 0, mutations: 0 });
  });

  it("redacts transient inspection trees after rollback in both paths", async () => {
    const rollbackActions = [
      { type: "create_frame", parentId: "parent", name: "Card", as: "card" },
      { type: "inspect", nodeId: "$card", depth: 1, limit: 10, scanLimit: 10 },
      { type: "rename", nodeId: "missing", name: "Fails" },
    ];
    const fallback = createInspectableBehavioralFigma();
    const generated = await handleExecute(null, { actions: rollbackActions, rollbackOnError: true });
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: typeof fallback.figma) => Promise<Array<Record<string, unknown>>>;
    const fallbackResults = await new AsyncFunction("figma", generated.fallbackJs!)(fallback.figma);
    const connected = createInspectableBehavioralFigma();
    const pluginResult = await runPlugin(connected.figma as unknown as PluginFigma, rollbackActions);

    for (const inspection of [fallbackResults[1].inspection, pluginResult.results[1].inspection]) {
      expect(inspection).toMatchObject({ rolledBack: true, returnedCount: 0, truncated: true });
      expect(inspection).not.toHaveProperty("root");
    }
    expect(fallbackResults.at(-1)).toEqual({ type: "rollback", status: "applied" });
    expect(pluginResult).toMatchObject({ rollbackApplied: true, summary: { applied: 2, failed: 1, mutations: 1 } });
  });
});

describe("deterministic write resolvers", () => {
  it("preserves dollar-prefixed text properties while resolving INSTANCE_SWAP values", async () => {
    const actions = [
      { type: "duplicate_node", nodeId: "component", targetParentId: "parent", as: "icon" },
      { type: "set_component_properties", nodeId: "instance", properties: { Label: "$price", Icon: "$icon" } },
    ];
    for (const mode of ["fallback", "connected"] as const) {
      const environment = createBehavioralFigma();
      environment.nodes.get("component")!.componentPropertyDefinitions = {
        "Label#1": { type: "TEXT", defaultValue: "" },
        "Icon#3": { type: "INSTANCE_SWAP", defaultValue: "component" },
      };
      environment.trace.length = 0;
      if (mode === "fallback") {
        const generated = await handleExecute(null, { actions });
        const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
          ...args: string[]
        ) => (figmaApi: typeof environment.figma) => Promise<unknown>;
        await new AsyncFunction("figma", generated.fallbackJs!)(environment.figma);
      } else {
        const result = await runPlugin(environment.figma as unknown as PluginFigma, actions);
        expect(result.summary).toMatchObject({ applied: 2, failed: 0 });
      }
      expect(environment.trace).toContain('call:instance.setProperties:[{"Label#1":"$price"}]');
      expect(environment.trace).toContain('call:instance.setProperties:[{"Icon#3":"clone"}]');
    }
  });

  it("applies layered linear and radial gradients with explicit transforms in both paths", async () => {
    const action = {
      type: "set_gradient_fill", nodeId: "node",
      gradients: [
        {
          gradientType: "LINEAR", stops: [
            { position: 0, color: { r: 0, g: 0, b: 0, a: 0.8 } },
            { position: 1, color: { r: 0, g: 0, b: 0, a: 0 } },
          ], gradientTransform: [[1, 0, 0], [0, 1, 0]],
        },
        {
          gradientType: "RADIAL", stops: [
            { position: 0, color: { r: 1, g: 1, b: 1, a: 0.4 } },
            { position: 1, color: { r: 1, g: 1, b: 1, a: 0 } },
          ], gradientTransform: [[0.5, 0, 0.25], [0, 0.5, 0.25]], opacity: 0.75,
        },
      ],
    };
    const fallback = createBehavioralFigma();
    const generated = await handleExecute(null, { actions: [action] });
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: typeof fallback.figma) => Promise<unknown>;
    await new AsyncFunction("figma", generated.fallbackJs!)(fallback.figma);
    const connected = createBehavioralFigma();
    const result = await runPlugin(connected.figma as unknown as PluginFigma, [action]);

    expect(result.summary).toMatchObject({ applied: 1, failed: 0 });
    expect(connected.nodes.get("node")!.fills).toEqual(fallback.nodes.get("node")!.fills);
    expect(connected.nodes.get("node")!.fills).toMatchObject([
      { type: "GRADIENT_LINEAR", gradientTransform: [[1, 0, 0], [0, 1, 0]] },
      { type: "GRADIENT_RADIAL", gradientTransform: [[0.5, 0, 0.25], [0, 0.5, 0.25]], opacity: 0.75 },
    ]);
  });

  it("normalizes effects to the installed Figma API contract in both paths", async () => {
    const action = {
      type: "set_effects", nodeId: "node", effects: [
        { type: "DROP_SHADOW", radius: 8 },
        { type: "BACKGROUND_BLUR", radius: 12 },
      ],
    };
    const parsed = actionSchema.parse(action);
    expect(parsed.effects).toEqual([
      {
        type: "DROP_SHADOW", radius: 8, visible: true, blendMode: "NORMAL",
        color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 0 },
        showShadowBehindNode: false,
      },
      { type: "BACKGROUND_BLUR", blurType: "NORMAL", radius: 12, visible: true },
    ]);
    expect(actionSchema.safeParse({ ...action, effects: [{ type: "DROP_SHADOW", radius: 8, showShadowOnly: true }] }).success).toBe(false);

    const fallback = createBehavioralFigma();
    const generated = await handleExecute(null, { actions: [action] });
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: typeof fallback.figma) => Promise<unknown>;
    await new AsyncFunction("figma", generated.fallbackJs!)(fallback.figma);
    const connected = createBehavioralFigma();
    const result = await runPlugin(connected.figma as unknown as PluginFigma, [action]);

    expect(result.summary).toMatchObject({ applied: 1, failed: 0 });
    expect(connected.nodes.get("node")!.effects).toEqual(fallback.nodes.get("node")!.effects);
    expect(connected.nodes.get("node")!.effects).toEqual(parsed.effects);
  });

  it("rejects ambiguous childPath segments without changing either child", async () => {
    const environment = createBehavioralFigma();
    const first = environment.nodes.get("instance-label")!;
    const second = { ...first, id: "second-label", visible: true };
    environment.nodes.get("instance")!.children = [first, second];

    const result = await runPlugin(environment.figma as unknown as PluginFigma, [{
      type: "set_instance_visibility", instanceId: "instance", childPath: ["Label"], visible: false,
    }]);

    expect(result.summary).toMatchObject({ applied: 0, failed: 1 });
    expect(first.visible).toBe(true);
    expect(second.visible).toBe(true);
  });

  it("rejects detached instances and ambiguous component-property display names", async () => {
    const detached = createBehavioralFigma();
    detached.nodes.get("instance")!.getMainComponentAsync = async () => null;
    const detachedResult = await runPlugin(detached.figma as unknown as PluginFigma, [{
      type: "set_instance_text", instanceId: "instance", childPath: ["Label"], characters: "Nope",
    }]);
    expect(detachedResult.results[0].error).toContain("detached");

    const ambiguous = createBehavioralFigma();
    ambiguous.nodes.get("component")!.componentPropertyDefinitions = {
      "Label#1": { type: "TEXT", defaultValue: "A" },
      "Label#2": { type: "TEXT", defaultValue: "B" },
    };
    const result = await runPlugin(ambiguous.figma as unknown as PluginFigma, [{
      type: "set_component_properties", nodeId: "instance", properties: { Label: "Nope" },
    }]);
    expect(result.results[0].error).toContain("ambiguous");
    expect(ambiguous.trace.some((entry) => entry.includes("setProperties"))).toBe(false);
  });

  it("rejects ambiguous variable and style names before binding", async () => {
    const variables = createBehavioralFigma();
    const variable = await variables.figma.variables.getVariableByIdAsync();
    variables.figma.variables.getLocalVariablesAsync = async () => [variable, { ...variable, id: "variable-2" }];
    const variableResult = await runPlugin(variables.figma as unknown as PluginFigma, [{
      type: "bind_variable", nodeId: "node", property: "topLeftRadius", variableName: "spacing/md", resolvedType: "FLOAT",
    }]);
    expect(variableResult.results[0].error).toContain("ambiguous");
    expect(variables.trace.some((entry) => entry.includes("setBoundVariable"))).toBe(false);

    const styles = createBehavioralFigma();
    const duplicateStyle = { id: "style-2", type: "EFFECT", name: "Shadow" };
    styles.figma.getLocalEffectStylesAsync = async () => [
      { id: "style-1", type: "EFFECT", name: "Shadow" }, duplicateStyle,
    ] as never;
    const styleResult = await runPlugin(styles.figma as unknown as PluginFigma, [{
      type: "apply_style", nodeId: "node", styleName: "Shadow", property: "effect",
    }]);
    expect(styleResult.results[0].error).toContain("ambiguous");
    expect(styles.trace.some((entry) => entry.includes("setEffectStyleIdAsync"))).toBe(false);
  });
});
