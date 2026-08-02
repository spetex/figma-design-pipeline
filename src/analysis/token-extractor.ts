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

/**
 * Extract design tokens from a Figma node tree.
 */
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
    // Colors
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

    // Fonts
    if (typeSet.has("font") && node.style) {
      const fontKey = `${node.style.fontFamily || ""}|${node.style.fontSize || ""}|${node.style.fontWeight || ""}`;
      if (fontKey !== "||" && !seenFonts.has(fontKey)) {
        seenFonts.add(fontKey);
        result.fonts.push({
          type: "font",
          raw: fontKey,
          cssVar: undefined,
        });
      }
    }

    // Spacing (from auto-layout or padding)
    if (typeSet.has("spacing")) {
      for (const val of [
        node.itemSpacing,
        node.paddingTop,
        node.paddingRight,
        node.paddingBottom,
        node.paddingLeft,
      ]) {
        if (val !== undefined && val > 0 && !seenSpacing.has(val)) {
          seenSpacing.add(val);
          result.spacing.push({
            type: "spacing",
            raw: val,
          });
        }
      }
    }

    // Border radius
    if (typeSet.has("radius")) {
      const r = node.cornerRadius;
      if (r !== undefined && r > 0 && !seenRadii.has(r)) {
        seenRadii.add(r);
        result.radii.push({
          type: "radius",
          raw: r,
        });
      }
    }

    // Shadows
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

    // Opacity
    if (typeSet.has("opacity")) {
      if (node.opacity !== undefined && node.opacity < 1 && !seenOpacities.has(node.opacity)) {
        seenOpacities.add(node.opacity);
        result.opacities.push({
          type: "opacity",
          raw: node.opacity,
        });
      }
    }
  });

  // Sort spacing and radii numerically
  result.spacing.sort((a, b) => (a.raw as number) - (b.raw as number));
  result.radii.sort((a, b) => (a.raw as number) - (b.raw as number));
  applyTailwindHints(result);

  return result;
}

/** Extract tokens for a single node (used during enrichment) */
export function extractNodeTokens(node: FigmaRawNode): DesignToken[] {
  const tokens: DesignToken[] = [];

  for (const fill of node.fills || []) {
    if (fill.type === "SOLID" && fill.color) {
      tokens.push({
        type: "color",
        raw: rgbaToHex(fill.color),
      });
    }
  }

  if (node.style?.fontSize) {
    tokens.push({
      type: "font",
      raw: `${node.style.fontFamily || "Inter"}/${node.style.fontSize}/${node.style.fontWeight || 400}`,
    });
  }

  if (node.cornerRadius && node.cornerRadius > 0) {
    tokens.push({
      type: "radius",
      raw: node.cornerRadius,
    });
  }

  return tokens;
}

function walkForTokens(node: FigmaRawNode, visit: (n: FigmaRawNode) => void): void {
  visit(node);
  for (const child of node.children || []) walkForTokens(child, visit);
}
