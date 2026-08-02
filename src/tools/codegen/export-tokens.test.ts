import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../shared/context.js";
import type { FigmaRawNode } from "../../shared/types.js";
import { generateScale } from "../../shared/tailwind-tokens.js";
import { extractTokens } from "../../analysis/token-extractor.js";
import { handleExportTokens } from "./export-tokens.js";

const fixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/token-fidelity.json", import.meta.url), "utf8")
) as FigmaRawNode;

function makeContext(document: FigmaRawNode = fixture): ToolContext {
  return {
    rest: {
      getFileNodes: vi.fn(async () => ({ nodes: { root: { document } } })),
    },
  } as unknown as ToolContext;
}

async function exportFormat(
  format: "tailwind" | "css" | "json" | "style-dictionary",
  document: FigmaRawNode = fixture
) {
  return (await handleExportTokens(makeContext(document), { nodeId: "root", format })).file.content;
}

function parseTailwind(content: string): Record<string, Record<string, unknown>> {
  return JSON.parse(content.match(/= (\{[\s\S]*\});\s*$/)?.[1] ?? "null");
}

describe("token fidelity", () => {
  it("extracts a layered shadow without losing offsets, blur, spread, color alpha, or inset semantics", () => {
    const tokens = extractTokens(fixture);

    expect(tokens.colors).toHaveLength(14);
    expect(tokens.opacities.map((token) => token.raw)).toEqual([0.42, 0.421, 0]);
    expect(tokens.shadows).toHaveLength(1);
    expect(tokens.shadows[0]?.tailwind).toBe("shadow-sm");
    expect(tokens.shadows[0]?.raw).toBe(
      "-2px 4px 8px 3px color(srgb 0.1 0.2 0.3 / 0.25), inset 1.5px -1px 2.5px -0.5px color(srgb 1 0 0 / 0.6)"
    );
    expect(tokens.shadows[0]?.shadow).toEqual([
      {
        offsetX: -2,
        offsetY: 4,
        blur: 8,
        spread: 3,
        color: { r: 0.1, g: 0.2, b: 0.3, a: 0.25 },
        inset: false,
      },
      {
        offsetX: 1.5,
        offsetY: -1,
        blur: 2.5,
        spread: -0.5,
        color: { r: 1, g: 0, b: 0, a: 0.6 },
        inset: true,
      },
    ]);
  });

  it("treats omitted visibility as visible and does not deduplicate shadows that differ in alpha or spread", () => {
    const tokens = extractTokens({
      id: "visibility",
      name: "Visibility defaults",
      type: "FRAME",
      effects: [{
        type: "DROP_SHADOW",
        offset: { x: 0, y: 1 },
        radius: 2,
        spread: 1,
        color: { r: 0, g: 0, b: 0, a: 0.2 },
      }],
      children: [{
        id: "different-alpha",
        name: "Different alpha",
        type: "FRAME",
        effects: [{
          type: "DROP_SHADOW",
          visible: true,
          offset: { x: 0, y: 1 },
          radius: 2,
          spread: 2,
          color: { r: 0, g: 0, b: 0, a: 0.3 },
        }],
      }, {
        id: "hidden",
        name: "Hidden",
        type: "FRAME",
        effects: [{
          type: "DROP_SHADOW",
          visible: false,
          radius: 99,
          color: { r: 0, g: 0, b: 0, a: 1 },
        }],
      }],
    });

    expect(tokens.shadows).toHaveLength(2);
    expect(tokens.shadows.map((token) => token.shadow?.[0])).toMatchObject([
      { spread: 1, color: { a: 0.2 } },
      { spread: 2, color: { a: 0.3 } },
    ]);
  });

  it("exports all colors, the layered shadow, and opacity to Tailwind without key collisions", async () => {
    const content = await exportFormat("tailwind");
    const config = parseTailwind(content);

    expect(Object.keys(config.colors)).toHaveLength(14);
    expect(Object.keys(config.colors).some((key) => key.includes("undefined"))).toBe(false);
    expect(new Set(Object.values(config.colors))).toHaveLength(14);
    expect(config.boxShadow.sm).toBe(
      "-2px 4px 8px 3px color(srgb 0.1 0.2 0.3 / 0.25), inset 1.5px -1px 2.5px -0.5px color(srgb 1 0 0 / 0.6)"
    );
    expect(config.opacity).toEqual({ "0": "0", "42": "0.42", "42.1": "0.421" });
  });

  it("makes every extracted Tailwind hint resolve to the generated key and value", async () => {
    const tokens = extractTokens(fixture);
    const config = parseTailwind(await exportFormat("tailwind"));

    for (const token of tokens.colors) {
      expect(token.tailwind).toBeTruthy();
      expect(config.colors[token.tailwind!]).toBe(token.raw);
    }
    for (const token of tokens.spacing) {
      expect(token.tailwind).toBe(`gap-${token.raw}`);
      expect(config.spacing[String(token.raw)]).toBe(`${token.raw}px`);
    }
    for (const token of tokens.radii) {
      const label = token.tailwind === "rounded" ? "DEFAULT" : token.tailwind!.slice("rounded-".length);
      expect(config.borderRadius[label]).toBe(`${token.raw}px`);
    }
    for (const token of tokens.shadows) {
      const label = token.tailwind === "shadow" ? "DEFAULT" : token.tailwind!.slice("shadow-".length);
      expect(config.boxShadow[label]).toBe(token.raw);
    }
    for (const token of tokens.opacities) {
      const label = token.tailwind!.slice("opacity-".length);
      expect(config.opacity[label]).toBe(String(token.raw));
    }

    expect(tokens.fonts[0]?.tailwind).toBe("font-sans text-base font-normal");
    expect(config.fontFamily.sans).toEqual(["Inter"]);
    expect(config.fontSize.base).toBe("16px");
    expect(config.fontWeight.normal).toBe("400");
  });

  it("shares collision-safe exact opacity names between extraction and Tailwind export", async () => {
    const document: FigmaRawNode = {
      id: "root",
      name: "Opacity collisions",
      type: "FRAME",
      opacity: 0.42,
      children: [{
        id: "collision",
        name: "Collision",
        type: "FRAME",
        opacity: 0.42000000000000004,
      }],
    };
    const tokens = extractTokens(document);
    const config = parseTailwind(await exportFormat("tailwind", document));

    expect(tokens.opacities.map((token) => token.tailwind)).toEqual([
      "opacity-42",
      "opacity-42-2",
    ]);
    expect(config.opacity).toEqual({
      "42": "0.42",
      "42-2": "0.42000000000000004",
    });
  });

  it("deduplicates repeated shadows but preserves sub-8-bit and sub-4-decimal differences", async () => {
    const shadow = (id: string, r: number, alpha: number): FigmaRawNode => ({
      id,
      name: id,
      type: "FRAME",
      effects: [{
        type: "DROP_SHADOW",
        visible: true,
        offset: { x: 0, y: 2 },
        radius: 4,
        spread: 1,
        color: { r, g: 0.2, b: 0.3, a: alpha },
      }],
    });
    const document: FigmaRawNode = {
      id: "root",
      name: "Precision shadows",
      type: "FRAME",
      children: [
        shadow("first", 0.100001, 0.123441),
        shadow("different", 0.100002, 0.123449),
        shadow("repeat", 0.100001, 0.123441),
      ],
    };
    const tokens = extractTokens(document);
    const tailwind = parseTailwind(await exportFormat("tailwind", document));
    const css = await exportFormat("css", document);

    expect(tokens.shadows).toHaveLength(2);
    expect(new Set(tokens.shadows.map((token) => token.raw))).toEqual(new Set([
      "0px 2px 4px 1px color(srgb 0.100001 0.2 0.3 / 0.123441)",
      "0px 2px 4px 1px color(srgb 0.100002 0.2 0.3 / 0.123449)",
    ]));
    expect(new Set(Object.values(tailwind.boxShadow))).toHaveLength(2);
    for (const token of tokens.shadows) {
      const label = token.tailwind === "shadow" ? "DEFAULT" : token.tailwind!.slice("shadow-".length);
      expect(tailwind.boxShadow[label]).toBe(token.raw);
      expect(css).toContain(String(token.raw));
    }
  });

  it("exports syntactically complete CSS shadow and opacity variables", async () => {
    const content = await exportFormat("css");

    expect(content.match(/--color-\d+:/g)).toHaveLength(14);
    expect(content).toContain(
      "--shadow-1: -2px 4px 8px 3px color(srgb 0.1 0.2 0.3 / 0.25), inset 1.5px -1px 2.5px -0.5px color(srgb 1 0 0 / 0.6);"
    );
    expect(content).toContain("--opacity-1: 0;");
    expect(content).toContain("--opacity-2: 0.42;");
    expect(content).toContain("--opacity-3: 0.421;");
  });

  it("round-trips structured shadows and opacity through the plain JSON format", async () => {
    const output = JSON.parse(await exportFormat("json"));

    expect(output.colors).toHaveLength(14);
    expect(output.shadows[0].raw).toBe(
      "-2px 4px 8px 3px color(srgb 0.1 0.2 0.3 / 0.25), inset 1.5px -1px 2.5px -0.5px color(srgb 1 0 0 / 0.6)"
    );
    expect(output.shadows[0].shadow).toHaveLength(2);
    expect(output.shadows[0].shadow[1]).toMatchObject({ inset: true, spread: -0.5 });
    expect(output.opacities.map((token: { raw: number }) => token.raw)).toEqual([0.42, 0.421, 0]);
  });

  it("emits DTCG-valid composite shadows, dimensions, colors, and opacity", async () => {
    const output = JSON.parse(await exportFormat("style-dictionary"));

    expect(output.$schema).toBe("https://www.designtokens.org/schemas/2025.10/format.json");
    expect(output.color).toHaveProperty("14");
    expect(output.color["1"].$value).toMatchObject({ colorSpace: "srgb" });
    expect(output.spacing["1"]).toEqual({
      $value: { value: 12, unit: "px" },
      $type: "dimension",
    });
    expect(output.borderRadius["1"]).toEqual({
      $value: { value: 6, unit: "px" },
      $type: "dimension",
    });
    expect(output.shadow["1"].$value).toHaveLength(2);
    expect(output.shadow["1"].$value[0]).toEqual({
      color: {
        colorSpace: "srgb",
        components: [0.1, 0.2, 0.3],
        alpha: 0.25,
      },
      offsetX: { value: -2, unit: "px" },
      offsetY: { value: 4, unit: "px" },
      blur: { value: 8, unit: "px" },
      spread: { value: 3, unit: "px" },
      inset: false,
    });
    expect(output.opacity).toEqual({
      "1": { $value: 0, $type: "number" },
      "2": { $value: 0.42, $type: "number" },
      "3": { $value: 0.421, $type: "number" },
    });
  });

  it("generates unique palette positions for arbitrary scale sizes", () => {
    const scale = generateScale(2_000);

    expect(scale).toHaveLength(2_000);
    expect(new Set(scale)).toHaveLength(2_000);
    expect(scale).not.toContain(undefined);
  });
});
