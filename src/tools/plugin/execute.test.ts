import { describe, expect, it, vi } from "vitest";
import type { BridgeServer } from "../../plugin/bridge.js";
import { compileBatch, CREATE_TYPES } from "../../plugin/batch-compiler.js";
import { SnapshotCache } from "../../pipeline/snapshot.js";
import { ACTION_TYPES, assertActionInputCoverage, assertActionSchemaCoverage } from "../../shared/action-parity.js";
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

  it("enforces exclusive name/ID selectors and text truncation invariants", () => {
    expect(actionSchema.safeParse({ type: "apply_style", nodeId: "1:2", property: "text", styleId: "S:1", styleName: "Body" }).success).toBe(false);
    expect(actionSchema.safeParse({ type: "bind_variable", nodeId: "1:2", property: "opacity", variableId: "V:1", variableName: "opacity/muted" }).success).toBe(false);
    expect(actionSchema.safeParse({ type: "create_text", parentId: "1:1", characters: "Long", maxLines: 2 }).success).toBe(false);
    expect(actionSchema.safeParse({ type: "create_text", parentId: "1:1", characters: "Long", textTruncation: "ENDING", maxLines: 2 }).success).toBe(true);
  });

  it("enforces gradient transforms, API effect fields, and the section 0.01 boundary", () => {
    const stops = [
      { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
      { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
    ];
    expect(actionSchema.safeParse({
      type: "set_gradient_fill", nodeId: "node", stops, gradientTransform: [[1, 0, 0], [0, 1, 0]],
    }).success).toBe(true);
    expect(actionSchema.safeParse({
      type: "set_gradient_fill", nodeId: "node", stops, gradientTransform: [[0, 0, 0], [0, 0, 0]],
    }).success).toBe(false);
    expect(actionSchema.safeParse({
      type: "set_gradient_fill", nodeId: "node", stops, angle: 10, gradientTransform: [[1, 0, 0], [0, 1, 0]],
    }).success).toBe(false);
    expect(actionSchema.safeParse({ type: "set_effects", nodeId: "node", effects: [{ type: "BACKGROUND_BLUR", radius: 4 }] }).success).toBe(true);
    expect(actionSchema.safeParse({ type: "set_effects", nodeId: "node", effects: [{ type: "BACKGROUND_BLUR", blurType: "PROGRESSIVE", radius: 4 }] }).success).toBe(false);
    for (const type of ["create_section", "resize_section"] as const) {
      const base = type === "create_section"
        ? { type, parentId: "page", name: "Section" }
        : { type, sectionId: "section" };
      expect(actionSchema.safeParse({ ...base, width: 0.01, height: 0.01 }).success).toBe(true);
      expect(actionSchema.safeParse({ ...base, width: 0.009, height: 1 }).success).toBe(false);
      expect(actionSchema.safeParse({ ...base, width: 1, height: 0 }).success).toBe(false);
    }
  });

  it("applies bounded inspect defaults and rejects values above plugin read limits", () => {
    expect(actionSchema.parse({ type: "inspect", nodeId: "$card" })).toEqual({
      type: "inspect", nodeId: "$card", depth: 2, limit: 100, scanLimit: 1_000,
    });
    expect(actionSchema.safeParse({ type: "inspect", nodeId: "node", depth: 21 }).success).toBe(false);
    expect(actionSchema.safeParse({ type: "inspect", nodeId: "node", limit: 1_001 }).success).toBe(false);
    expect(actionSchema.safeParse({ type: "inspect", nodeId: "node", scanLimit: 10_001 }).success).toBe(false);
  });

  it("rejects invalid gradients and section sizes before bridge mutation", async () => {
    const execute = vi.fn();
    const bridge = { isConnected: () => true, execute } as unknown as BridgeServer;
    await expect(handleExecute(bridge, { actions: [{
      type: "set_gradient_fill", nodeId: "node",
      stops: [{ position: 0, color: { r: 0, g: 0, b: 0 } }, { position: 1, color: { r: 1, g: 1, b: 1 } }],
      gradientTransform: [[0, 0, 0], [0, 0, 0]],
    }] })).rejects.toThrow("gradientTransform");
    await expect(handleExecute(bridge, { actions: [{
      type: "create_section", parentId: "page", name: "Too small", width: 0.009, height: 1,
    }] })).rejects.toThrow("Invalid action 0");
    await expect(handleExecute(bridge, { actions: [{
      type: "resize_section", sectionId: "section", width: 1, height: 0.009,
    }] })).rejects.toThrow("Invalid action 0");
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("symbolic reference preflight", () => {
  it("does not classify ordinary component-property strings as aliases", () => {
    const action = actionSchema.parse({
      type: "set_component_properties", nodeId: "instance", properties: { Price: "$12.00", Empty: "" },
    });
    expect(() => compileBatch([action])).not.toThrow();
  });

  it.each([
    ["duplicate", [
      { type: "create_frame", parentId: "1:2", name: "A", as: "same" },
      { type: "create_frame", parentId: "1:2", name: "B", as: "same" },
    ], "duplicate alias"],
    ["unknown", [{ type: "rename", nodeId: "$missing", name: "Nope" }], "unknown reference"],
    ["self", [{ type: "duplicate_node", nodeId: "$copy", as: "copy" }], "self reference"],
    ["forward", [
      { type: "rename", nodeId: "$later", name: "Too early" },
      { type: "create_frame", parentId: "1:2", name: "Later", as: "later" },
    ], "forward reference"],
    ["cyclic", [
      { type: "duplicate_node", nodeId: "$b", as: "a" },
      { type: "duplicate_node", nodeId: "$a", as: "b" },
    ], "cyclic"],
    ["legacy-forward", [
      { type: "rename", nodeId: "$ref:node-0", name: "Too early" },
      { type: "create_frame", parentId: "1:2", name: "Later" },
    ], "forward reference"],
    ["inspect-unknown", [
      { type: "inspect", nodeId: "$missing" },
    ], "unknown reference"],
    ["inspect-forward", [
      { type: "inspect", nodeId: "$later" },
      { type: "create_frame", parentId: "1:2", name: "Later", as: "later" },
    ], "forward reference"],
  ])("rejects %s references before bridge execution", async (_label, actions, message) => {
    const execute = vi.fn();
    const bridge = { isConnected: () => true, execute } as unknown as BridgeServer;
    await expect(handleExecute(bridge, { actions })).rejects.toThrow(message as string);
    await expect(handleExecute(null, { actions })).rejects.toThrow(message as string);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects malformed and reserved aliases during schema validation", async () => {
    await expect(handleExecute(null, { actions: [{ type: "create_frame", parentId: "1:2", name: "Bad", as: "node-0" }] }))
      .rejects.toThrow("reserved");
    await expect(handleExecute(null, { actions: [{ type: "create_frame", parentId: "1:2", name: "Bad", as: "1bad" }] }))
      .rejects.toThrow("Alias must start");
  });
});

describe("handleExecute fallback generation", () => {
  it("clears a new frame's fills immediately after creation in fallback JavaScript", async () => {
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
    const figma = {
      getNodeById: () => parent,
      createFrame: () => {
        operations.push("createFrame");
        return frame;
      },
    };
    const fallback = await handleExecute(null, {
      actions: [{ type: "create_frame", name: "Frame", parentId: "parent" }],
    });
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: typeof figma) => Promise<Array<Record<string, unknown>>>;

    const result = await new AsyncFunction("figma", fallback.fallbackJs!)(figma);

    expect(result).toEqual([{ type: "create_frame", nodeId: "frame" }]);
    expect(fills).toEqual([]);
    expect(operations.slice(0, 2)).toEqual(["createFrame", "fills"]);
  });

  it("derives exhaustive executor coverage from the Zod schemas", () => {
    const schemaOperations = actionSchema.options.map((schema) => {
      const shape = (schema as unknown as { shape: Record<string, unknown> }).shape;
      const type = (shape.type as { value: string }).value;
      return { type, fields: Object.keys(shape).filter((field) => field !== "type").sort() };
    });

    expect(schemaOperations.map(({ type }) => type).sort()).toEqual([...ACTION_TYPES].sort());
    for (const { type, fields } of schemaOperations) {
      expect(() => assertActionSchemaCoverage(type, fields)).not.toThrow();
    }
  });

  it("rejects a newly introduced optional field until both executors model it", () => {
    expect(() => assertActionInputCoverage({ type: "set_position", nodeId: "node", experimentalOffset: 1 })).toThrow(
      "not implemented by both executors"
    );
    expect(() => assertActionSchemaCoverage("set_position", ["nodeId", "x", "y", "experimentalOffset"])).toThrow(
      "schema/executor coverage drift"
    );
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

  it("preserves mixed text fonts and loads every range font before changing text metrics", async () => {
    const mixed = Symbol("mixed");
    const node = {
      id: "text",
      characters: "AB",
      fontName: mixed,
      fontSize: 12,
      getRangeFontName: (start: number) => start === 0
        ? { family: "Roboto", style: "Regular" }
        : { family: "Roboto", style: "Bold" },
    };
    const loadedFonts: Array<{ family: string; style: string }> = [];
    const figma = {
      mixed,
      getNodeById: () => node,
      loadFontAsync: async (font: { family: string; style: string }) => { loadedFonts.push(font); },
    };
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: typeof figma) => Promise<unknown>;

    const fallback = await handleExecute(null, {
      actions: [{ type: "set_text_style", nodeId: "text", fontSize: 18, lineHeight: 24, letterSpacing: 0.5 }],
    });
    await new AsyncFunction("figma", fallback.fallbackJs!)(figma);

    expect(node.fontName).toBe(mixed);
    expect(node.fontSize).toBe(18);
    expect(loadedFonts).toEqual([
      { family: "Roboto", style: "Regular" },
      { family: "Roboto", style: "Bold" },
    ]);
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

  it.each([
    { label: "missing", paints: [] },
    { label: "non-solid", paints: [{ type: "GRADIENT_LINEAR" }] },
  ])("fails $label paint-variable bindings instead of reporting success", async ({ paints }) => {
    const setBoundVariableForPaint = vi.fn();
    const figma = {
      getNodeById: () => ({ id: "node", fills: paints }),
      variables: {
        getVariableById: () => ({ id: "variable" }),
        setBoundVariableForPaint,
      },
    };
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: typeof figma) => Promise<Array<Record<string, unknown>>>;
    const fallback = await handleExecute(null, {
      actions: [{ type: "bind_variable", nodeId: "node", property: "fills", variableId: "variable" }],
    });
    const result = await new AsyncFunction("figma", fallback.fallbackJs!)(figma);

    expect(result).toEqual([expect.objectContaining({ actionIndex: 0, status: "failed" })]);
    expect(setBoundVariableForPaint).not.toHaveBeenCalled();
  });

  it("fails rollback preflight before any fallback mutation when undo is unavailable", async () => {
    const node = { id: "node", name: "Before" };
    const fallback = await handleExecute(null, {
      actions: [{ type: "rename", nodeId: "node", name: "After" }],
      rollbackOnError: true,
    });
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: { getNodeById: () => typeof node }) => Promise<unknown>;

    await expect(new AsyncFunction("figma", fallback.fallbackJs!)({ getNodeById: () => node })).rejects.toThrow("does not support rollback");
    expect(node.name).toBe("Before");
  });

  it("rejects delete_node for a page before calling remove", async () => {
    const remove = vi.fn();
    const fallback = await handleExecute(null, {
      actions: [{ type: "delete_node", nodeId: "page", confirmed: true }],
    });
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: { getNodeById: () => { id: string; type: string; remove: typeof remove } }) => Promise<Array<Record<string, unknown>>>;

    const result = await new AsyncFunction("figma", fallback.fallbackJs!)({
      getNodeById: () => ({ id: "page", type: "PAGE", remove }),
    });

    expect(result).toEqual([expect.objectContaining({ actionIndex: 0, status: "failed" })]);
    expect(remove).not.toHaveBeenCalled();
  });

  it("does not create a detached node when a fallback create dependency is invalid", async () => {
    const createFrame = vi.fn();
    const fallback = await handleExecute(null, {
      actions: [{ type: "create_frame", name: "Frame", parentId: "missing" }],
    });
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: { getNodeById: () => undefined; createFrame: typeof createFrame }) => Promise<Array<Record<string, unknown>>>;
    const result = await new AsyncFunction("figma", fallback.fallbackJs!)({
      getNodeById: () => undefined,
      createFrame,
    });

    expect(result).toEqual([expect.objectContaining({ actionIndex: 0, status: "failed" })]);
    expect(createFrame).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "a non-container frame parent",
      action: { type: "create_frame", name: "Frame", parentId: "parent" },
      figma: { getNodeById: () => ({ id: "parent" }), createFrame: vi.fn() },
      factory: (figma: { createFrame: ReturnType<typeof vi.fn> }) => figma.createFrame,
    },
    {
      label: "a rejected text font",
      action: { type: "create_text", parentId: "parent", characters: "Text" },
      figma: {
        getNodeById: () => ({ id: "parent", appendChild: vi.fn() }),
        loadFontAsync: async () => { throw new Error("font unavailable"); },
        createText: vi.fn(),
      },
      factory: (figma: { createText: ReturnType<typeof vi.fn> }) => figma.createText,
    },
    {
      label: "an invalid instance parent",
      action: { type: "create_instance", componentId: "component", parentId: "parent" },
      figma: {
        getNodeById: (id: string) => id === "component"
          ? { id, type: "COMPONENT", createInstance: vi.fn() }
          : { id },
      },
      factory: (figma: { getNodeById: (id: string) => { createInstance?: ReturnType<typeof vi.fn> } }) => figma.getNodeById("component").createInstance!,
    },
    {
      label: "an invalid component source parent",
      action: { type: "create_component_from_node", nodeId: "source", name: "Component" },
      figma: { getNodeById: () => ({ id: "source", type: "RECTANGLE" }), createComponentFromNode: vi.fn() },
      factory: (figma: { createComponentFromNode: ReturnType<typeof vi.fn> }) => figma.createComponentFromNode,
    },
    {
      label: "a non-component variant source",
      action: { type: "create_component_set", componentIds: ["source"], name: "Variants" },
      figma: { getNodeById: () => ({ id: "source", type: "RECTANGLE" }), combineAsVariants: vi.fn() },
      factory: (figma: { combineAsVariants: ReturnType<typeof vi.fn> }) => figma.combineAsVariants,
    },
  ])("preflights $label before fallback factories run", async ({ action, figma, factory }) => {
    const fallback = await handleExecute(null, { actions: [action] });
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: typeof figma) => Promise<Array<Record<string, unknown>>>;

    const result = await new AsyncFunction("figma", fallback.fallbackJs!)(figma).catch(() => undefined);

    if (result) {
      expect(result).toEqual([expect.objectContaining({ actionIndex: 0, status: "failed" })]);
    }
    expect(factory(figma as never)).not.toHaveBeenCalled();
  });

  it("only rolls back fallback batches after document writes, including partial writes", async () => {
    const commitUndo = vi.fn();
    const triggerUndo = vi.fn();
    const exported = {
      id: "exported",
      exportAsync: async () => new Uint8Array([1]),
    };
    const exportFallback = await handleExecute(null, {
      actions: [
        { type: "export_node", nodeId: "exported" },
        { type: "rename", nodeId: "missing", name: "Fails" },
      ],
      rollbackOnError: true,
    });
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: Record<string, unknown>) => Promise<unknown>;
    await new AsyncFunction("figma", exportFallback.fallbackJs!)({
      getNodeById: (id: string) => id === "exported" ? exported : undefined,
      base64Encode: () => "AQ==",
      commitUndo,
      triggerUndo,
    });
    expect(triggerUndo).not.toHaveBeenCalled();

    const noOpFallback = await handleExecute(null, {
      actions: [
        { type: "set_position", nodeId: "node", x: 0, y: 0 },
        { type: "rename", nodeId: "missing", name: "Fails" },
      ],
      rollbackOnError: true,
    });
    await new AsyncFunction("figma", noOpFallback.fallbackJs!)({
      getNodeById: (id: string) => id === "node" ? { id, x: 0, y: 0 } : undefined,
      commitUndo,
      triggerUndo,
    });
    expect(triggerUndo).not.toHaveBeenCalled();

    let x = 0;
    const partiallyWritable = { id: "node" } as { id: string; x: number; y: number };
    Object.defineProperties(partiallyWritable, {
      x: { get: () => x, set: (value: number) => { x = value; }, enumerable: true },
      y: { get: () => 0, set: () => { throw new Error("y rejected"); }, enumerable: true },
    });
    const partialFallback = await handleExecute(null, {
      actions: [{ type: "set_position", nodeId: "node", x: 12, y: 24 }],
      rollbackOnError: true,
    });
    await new AsyncFunction("figma", partialFallback.fallbackJs!)({
      getNodeById: () => partiallyWritable,
      commitUndo,
      triggerUndo,
    });
    expect(x).toBe(12);
    expect(triggerUndo).toHaveBeenCalledTimes(1);
  });

  it("rolls back a partial set_component_properties mutation", async () => {
    const commitUndo = vi.fn();
    const triggerUndo = vi.fn();
    const applied: Array<Record<string, string | boolean>> = [];
    const node = {
      id: "instance",
      type: "INSTANCE",
      setProperties: (properties: Record<string, string | boolean>) => {
        applied.push(properties);
        if ("Second" in properties) throw new Error("Second rejected");
      },
    };
    const fallback = await handleExecute(null, {
      actions: [{
        type: "set_component_properties",
        nodeId: "instance",
        properties: { First: "Applied", Second: true },
      }],
      rollbackOnError: true,
    });
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: { getNodeById: () => typeof node; commitUndo: typeof commitUndo; triggerUndo: typeof triggerUndo }) => Promise<Array<Record<string, unknown>>>;

    const result = await new AsyncFunction("figma", fallback.fallbackJs!)({
      getNodeById: () => node,
      commitUndo,
      triggerUndo,
    });

    expect(applied).toEqual([{ First: "Applied" }, { Second: true }]);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionIndex: 0, status: "failed" }),
      { type: "rollback", status: "applied" },
    ]));
    expect(triggerUndo).toHaveBeenCalledTimes(1);
  });

  it("isolates a failed fallback batch from a prior successful batch", async () => {
    let committedName = "Before";
    const node = { id: "node", name: "Before" };
    const figma = {
      getNodeById: (id: string) => id === "node" ? node : undefined,
      commitUndo: vi.fn(() => { committedName = node.name; }),
      triggerUndo: vi.fn(() => { node.name = committedName; }),
    };
    const first = await handleExecute(null, {
      actions: [{ type: "rename", nodeId: "node", name: "Successful" }], rollbackOnError: true,
    });
    const second = await handleExecute(null, {
      actions: [
        { type: "rename", nodeId: "node", name: "Transient" },
        { type: "rename", nodeId: "missing", name: "Fails" },
      ], rollbackOnError: true,
    });
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: typeof figma) => Promise<Array<Record<string, unknown>>>;

    await new AsyncFunction("figma", first.fallbackJs!)(figma);
    await new AsyncFunction("figma", second.fallbackJs!)(figma);

    expect(node.name).toBe("Successful");
    expect(figma.commitUndo).toHaveBeenCalledTimes(3);
    expect(figma.triggerUndo).toHaveBeenCalledTimes(1);
  });

  it("loads resolved text-style fonts and applies explicit create overrides second", async () => {
    const loaded = new Set<string>();
    const events: string[] = [];
    const style = { id: "style", type: "TEXT", name: "Typography/Body", fontName: { family: "Style Family", style: "Regular" } };
    let currentFont = { family: "Inter", style: "Regular" };
    const textNode = {
      id: "text", type: "TEXT", name: "", textAutoResize: "HEIGHT",
      get fontName() { return currentFont; },
      set fontName(font: { family: string; style: string }) {
        if (!loaded.has(`${font.family}|${font.style}`)) throw new Error("font was not loaded");
        currentFont = font;
        events.push(`font:${font.family}|${font.style}`);
      },
      set characters(value: string) { events.push(`characters:${value}`); },
      async setTextStyleIdAsync() {
        if (!loaded.has("Style Family|Regular")) throw new Error("style font was not loaded");
        currentFont = style.fontName;
        events.push("style");
      },
    };
    const parent = { id: "parent", appendChild: vi.fn() };
    const figma = {
      getNodeById: (id: string) => id === "text" ? textNode : id === "parent" ? parent : undefined,
      getLocalTextStylesAsync: async () => [style],
      loadFontAsync: async (font: { family: string; style: string }) => {
        loaded.add(`${font.family}|${font.style}`);
        events.push(`load:${font.family}|${font.style}`);
      },
      createText: () => textNode,
    };
    const apply = await handleExecute(null, {
      actions: [{ type: "apply_style", nodeId: "text", styleName: "Typography/Body", property: "text" }],
    });
    const create = await handleExecute(null, {
      actions: [{ type: "create_text", parentId: "parent", characters: "Hello", textStyleName: "Typography/Body", fontWeight: 700 }],
    });
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (figmaApi: typeof figma) => Promise<Array<Record<string, unknown>>>;

    await new AsyncFunction("figma", apply.fallbackJs!)(figma);
    events.length = 0;
    loaded.clear();
    await new AsyncFunction("figma", create.fallbackJs!)(figma);

    expect(events).toEqual([
      "load:Style Family|Regular", "load:Style Family|Bold", "style", "font:Style Family|Bold", "characters:Hello",
    ]);
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
    const commitUndo = vi.fn();
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
      condition: "figma.undo_api_unavailable",
      message: expect.stringContaining("figma.triggerUndo"),
    }]);
    const result = await new AsyncFunction("figma", fallback.fallbackJs!)({
      getNodeById: (id: string) => id === "node" ? node : undefined,
      commitUndo,
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
    const positioning = 'getNode("$ref:node-0").layoutPositioning = "ABSOLUTE"; markDocumentWrite();';
    const position = 'const n = getNode("$ref:node-0"); if (n.x !== 20) { n.x = 20; markDocumentWrite(); }';
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
    expect(result.fallbackJs).toContain('const parent = requireContainer("$ref:node-0");');
    expect(result.fallbackJs).toContain("parent.appendChild(f);");
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
      { type: "create_from_svg", parentId: "1:2", svg: "<svg/>" },
      { type: "create_section", parentId: "1:2", name: "Section" },
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

  it("does not invalidate for an applied inspect-only connected batch", () => {
    const snapshotCache = new SnapshotCache();
    snapshotCache.set("file/root", {} as EnrichedNode);
    const cacheInvalidated = invalidateSnapshotsAfterExecute(snapshotCache, {
      pluginConnected: true,
      result: {
        batchId: "batch-inspect",
        dryRun: false,
        success: true,
        results: [],
        nodeIdMap: {},
        summary: { total: 1, applied: 1, failed: 0, skipped: 0, mutations: 0 },
      },
    });

    expect(cacheInvalidated).toBe(false);
    expect(snapshotCache.get("file/root", Number.POSITIVE_INFINITY)).not.toBeNull();
  });
});
