import { afterEach, describe, expect, it, vi } from "vitest";

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
