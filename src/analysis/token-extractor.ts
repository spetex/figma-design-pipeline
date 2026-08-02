import type { FigmaRawNode, DesignToken, ShadowTokenValue } from "../shared/types.js";
import { rgbaToHex } from "../shared/color.js";
import { shadowToCss } from "../shared/shadow.js";
import { applyTailwindHints } from "../shared/tailwind-tokens.js";

export interface ExtractedTokens {
  colors: DesignToken[];
  fonts: DesignToken[];
  spacing: DesignToken[];
  radii: DesignToken[];
  shadows: DesignToken[];
  opacities: DesignToken[];
}

/** Extract design tokens from a Figma node tree. */
export function extractTokens(
  root: FigmaRawNode,
  types: string[] = ["color", "font", "spacing", "radius", "shadow", "opacity"]
): ExtractedTokens {
  const result: ExtractedTokens = {
    colors: [],
    fonts: [],
    spacing: [],
    radii: [],
    shadows: [],
    opacities: [],
  };

  const seenColors = new Set<string>();
  const seenFonts = new Set<string>();
  const seenSpacing = new Set<number>();
  const seenRadii = new Set<number>();
  const seenShadows = new Set<string>();
  const seenOpacities = new Set<number>();
  const typeSet = new Set(types);

  walkForTokens(root, (node) => {
    if (typeSet.has("color")) {
      for (const fill of node.fills || []) {
        if (fill.type === "SOLID" && fill.color) {
          const hex = rgbaToHex(fill.color);
          if (!seenColors.has(hex)) {
            seenColors.add(hex);
            result.colors.push({
              type: "color",
              raw: hex,
              cssVar: `--color-${hex.slice(1)}`,
            });
          }
        }
      }
    }

    if (typeSet.has("font") && node.style) {
      const fontKey = `${node.style.fontFamily || ""}|${node.style.fontSize || ""}|${node.style.fontWeight || ""}`;
      if (fontKey !== "||" && !seenFonts.has(fontKey)) {
        seenFonts.add(fontKey);
        result.fonts.push({ type: "font", raw: fontKey });
      }
    }

    if (typeSet.has("spacing")) {
      for (const token of extractSpacingTokens(node)) {
        if (!seenSpacing.has(token.raw)) {
          seenSpacing.add(token.raw);
          result.spacing.push(token);
        }
      }
    }

    if (typeSet.has("radius")) {
      const radius = node.cornerRadius;
      if (radius !== undefined && radius > 0 && !seenRadii.has(radius)) {
        seenRadii.add(radius);
        result.radii.push({ type: "radius", raw: radius });
      }
    }

    if (typeSet.has("shadow")) {
      const layers: ShadowTokenValue[] = [];
      for (const effect of node.effects || []) {
        if (
          (effect.type !== "DROP_SHADOW" && effect.type !== "INNER_SHADOW") ||
          effect.visible === false
        ) continue;

        layers.push({
          offsetX: effect.offset?.x ?? 0,
          offsetY: effect.offset?.y ?? 0,
          blur: effect.radius ?? 0,
          spread: effect.spread ?? 0,
          color: effect.color ?? { r: 0, g: 0, b: 0, a: 1 },
          inset: effect.type === "INNER_SHADOW",
        });
      }

      if (layers.length > 0) {
        const shadowKey = JSON.stringify(layers);
        if (!seenShadows.has(shadowKey)) {
          seenShadows.add(shadowKey);
          result.shadows.push({
            type: "shadow",
            raw: shadowToCss(layers),
            shadow: layers,
          });
        }
      }
    }

    if (
      typeSet.has("opacity") &&
      node.opacity !== undefined &&
      node.opacity < 1 &&
      !seenOpacities.has(node.opacity)
    ) {
      seenOpacities.add(node.opacity);
      result.opacities.push({ type: "opacity", raw: node.opacity });
    }
  });

  result.spacing.sort((a, b) => (a.raw as number) - (b.raw as number));
  result.radii.sort((a, b) => (a.raw as number) - (b.raw as number));
  applyTailwindHints(result);
  return result;
}

/** Extract tokens for a single node (used during enrichment). */
export function extractNodeTokens(node: FigmaRawNode): DesignToken[] {
  const tokens: DesignToken[] = [];

  for (const fill of node.fills || []) {
    if (fill.type === "SOLID" && fill.color) {
      tokens.push({ type: "color", raw: rgbaToHex(fill.color) });
    }
  }

  if (node.style?.fontSize) {
    tokens.push({
      type: "font",
      raw: `${node.style.fontFamily || "Inter"}/${node.style.fontSize}/${node.style.fontWeight || 400}`,
    });
  }

  if (node.cornerRadius && node.cornerRadius > 0) {
    tokens.push({ type: "radius", raw: node.cornerRadius });
  }

  tokens.push(...extractSpacingTokens(node));
  return tokens;
}

/** Extract distinct positive auto-layout spacing values for one node. */
function extractSpacingTokens(
  node: FigmaRawNode
): Array<DesignToken & { type: "spacing"; raw: number }> {
  const values = new Set([
    node.itemSpacing,
    node.paddingTop,
    node.paddingRight,
    node.paddingBottom,
    node.paddingLeft,
  ]);

  return [...values]
    .filter((value): value is number => value !== undefined && value > 0)
    .map((value) => ({ type: "spacing", raw: value }));
}

function walkForTokens(node: FigmaRawNode, visit: (node: FigmaRawNode) => void): void {
  visit(node);
  for (const child of node.children || []) walkForTokens(child, visit);
}
