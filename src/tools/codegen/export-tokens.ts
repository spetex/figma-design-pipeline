import type { ToolContext } from "../../shared/context.js";
import type { GeneratedFile } from "../../shared/types.js";
import { hexToRgba } from "../../shared/color.js";
import { colorToDtcg, shadowToCss, shadowToDtcg } from "../../shared/shadow.js";
import {
  classifyFontFamily,
  createTailwindProjection,
  parseFontToken,
} from "../../shared/tailwind-tokens.js";
import { handleExtractTokens } from "../inspect/extract-tokens.js";
import type { ExtractedTokens } from "../../analysis/token-extractor.js";

interface ExportTokensParams {
  figmaUrl?: string;
  nodeId?: string;
  format?: "tailwind" | "css" | "json" | "style-dictionary";
}

export async function handleExportTokens(
  ctx: ToolContext,
  params: ExportTokensParams
): Promise<{
  format: string;
  file: GeneratedFile;
}> {
  const { format = "tailwind", nodeId } = params;

  if (!nodeId) {
    throw new Error("nodeId is required. Pass a Figma URL or nodeId directly.");
  }

  const { tokens } = await handleExtractTokens(ctx, { nodeId });

  let file: GeneratedFile;

  switch (format) {
    case "tailwind":
      file = emitTailwindConfig(tokens);
      break;
    case "css":
      file = emitCssVariables(tokens);
      break;
    case "json":
      file = {
        path: "design-tokens.json",
        content: JSON.stringify(tokens, null, 2),
        type: "json",
      };
      break;
    case "style-dictionary":
      file = emitStyleDictionary(tokens);
      break;
    default:
      throw new Error(`Unsupported format: ${format}`);
  }

  return { format, file };
}

// ─── Color helpers ──────────────────────────────────────────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const cleaned = hex.replace("#", "");
  if (cleaned.length < 6) return null;
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return { r, g, b };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const rgb = hexToRgb(hex);
  if (!rgb) return { h: 0, s: 0, l: 0.5 };
  return rgbToHsl(rgb.r, rgb.g, rgb.b);
}

// ─── Font helpers ───────────────────────────────────────────────────

function parseFontFamily(raw: string | number): string {
  return parseFontToken(raw).family;
}

// ─── Tailwind config emitter ────────────────────────────────────────

function emitTailwindConfig(tokens: ExtractedTokens): GeneratedFile {
  const config = createTailwindProjection(tokens).theme;

  const content = `// Auto-generated from Figma design tokens
// Add these to your tailwind.config.ts extend section

export const figmaTokens = ${JSON.stringify(config, null, 2)};
`;

  return { path: "figma-tokens.ts", content, type: "typescript" };
}

function quoteCssString(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("\n", "\\a ")
    .replaceAll("\r", "\\d ")}"`;
}

// ─── CSS variables emitter ──────────────────────────────────────────

function emitCssVariables(tokens: ExtractedTokens): GeneratedFile {
  const lines: string[] = ["/* Auto-generated from Figma design tokens */", ":root {"];

  // Colors ordered by lightness
  const colorEntries = tokens.colors
    .map(t => ({ hex: String(t.raw), lightness: hexToHsl(String(t.raw)).l }))
    .filter(c => c.hex.startsWith("#"))
    .sort((a, b) => a.lightness - b.lightness);
  lines.push("  /* Colors (dark to light) */");
  for (let i = 0; i < colorEntries.length; i++) {
    lines.push(`  --color-${i + 1}: ${colorEntries[i].hex};`);
  }

  // Fonts
  const fontsByClass: Record<string, string[]> = {};
  const seenFamilies = new Set<string>();
  for (const token of tokens.fonts) {
    const family = parseFontFamily(token.raw);
    if (seenFamilies.has(family)) continue;
    seenFamilies.add(family);
    const cls = classifyFontFamily(family);
    if (!fontsByClass[cls]) fontsByClass[cls] = [];
    fontsByClass[cls].push(family);
  }
  if (Object.keys(fontsByClass).length > 0) {
    lines.push("", "  /* Fonts */");
    for (const [cls, families] of Object.entries(fontsByClass)) {
      lines.push(`  --font-${cls}: ${families.map(quoteCssString).join(", ")};`);
    }
  }

  // Spacing
  const spacingVals = [...tokens.spacing].map(t => Number(t.raw)).filter(n => !isNaN(n)).sort((a, b) => a - b);
  if (spacingVals.length > 0) {
    lines.push("", "  /* Spacing */");
    for (let i = 0; i < spacingVals.length; i++) lines.push(`  --spacing-${i + 1}: ${spacingVals[i]}px;`);
  }

  // Radii
  const radiiVals = [...tokens.radii].map(t => Number(t.raw)).filter(n => !isNaN(n)).sort((a, b) => a - b);
  if (radiiVals.length > 0) {
    lines.push("", "  /* Border radius */");
    for (let i = 0; i < radiiVals.length; i++) lines.push(`  --radius-${i + 1}: ${radiiVals[i]}px;`);
  }

  if (tokens.shadows.length > 0) {
    lines.push("", "  /* Shadows */");
    for (let i = 0; i < tokens.shadows.length; i++) {
      lines.push(
        `  --shadow-${i + 1}: ${shadowToCss(tokens.shadows[i].shadow ?? tokens.shadows[i].raw)};`
      );
    }
  }

  const opacityVals = tokens.opacities
    .map((token) => Number(token.raw))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (opacityVals.length > 0) {
    lines.push("", "  /* Opacity */");
    for (let i = 0; i < opacityVals.length; i++) {
      lines.push(`  --opacity-${i + 1}: ${opacityVals[i]};`);
    }
  }

  lines.push("}");
  return { path: "figma-tokens.css", content: lines.join("\n"), type: "css" };
}

// ─── Style Dictionary (W3C DTCG) emitter ────────────────────────────

function emitStyleDictionary(tokens: ExtractedTokens): GeneratedFile {
  const output: Record<string, unknown> = {
    $schema: "https://www.designtokens.org/schemas/2025.10/format.json",
  };

  const colorEntries = tokens.colors
    .map(t => ({ hex: String(t.raw), lightness: hexToHsl(String(t.raw)).l }))
    .filter(c => c.hex.startsWith("#"))
    .sort((a, b) => a.lightness - b.lightness);
  if (colorEntries.length > 0) {
    const color: Record<string, { $value: ReturnType<typeof colorToDtcg>; $type: "color" }> = {};
    for (let i = 0; i < colorEntries.length; i++) {
      color[String(i + 1)] = { $value: colorToDtcg(hexToRgba(colorEntries[i].hex)), $type: "color" };
    }
    output.color = color;
  }

  const spacingVals = [...tokens.spacing].map(t => Number(t.raw)).filter(n => !isNaN(n)).sort((a, b) => a - b);
  if (spacingVals.length > 0) {
    const spacing: Record<string, { $value: { value: number; unit: "px" }; $type: "dimension" }> = {};
    for (let i = 0; i < spacingVals.length; i++) {
      spacing[String(i + 1)] = { $value: { value: spacingVals[i], unit: "px" }, $type: "dimension" };
    }
    output.spacing = spacing;
  }

  const radiiVals = [...tokens.radii].map(t => Number(t.raw)).filter(n => !isNaN(n)).sort((a, b) => a - b);
  if (radiiVals.length > 0) {
    const borderRadius: Record<string, { $value: { value: number; unit: "px" }; $type: "dimension" }> = {};
    for (let i = 0; i < radiiVals.length; i++) {
      borderRadius[String(i + 1)] = { $value: { value: radiiVals[i], unit: "px" }, $type: "dimension" };
    }
    output.borderRadius = borderRadius;
  }

  const seenFamilies = new Set<string>();
  const fontList: string[] = [];
  for (const token of tokens.fonts) {
    const family = parseFontFamily(token.raw);
    if (seenFamilies.has(family)) continue;
    seenFamilies.add(family);
    fontList.push(family);
  }
  if (fontList.length > 0) {
    const fontFamily: Record<string, { $value: string; $type: "fontFamily" }> = {};
    for (let i = 0; i < fontList.length; i++) {
      fontFamily[String(i + 1)] = { $value: fontList[i], $type: "fontFamily" };
    }
    output.fontFamily = fontFamily;
  }

  if (tokens.shadows.length > 0) {
    const shadow: Record<string, { $value: ReturnType<typeof shadowToDtcg>; $type: "shadow" }> = {};
    for (let i = 0; i < tokens.shadows.length; i++) {
      shadow[String(i + 1)] = {
        $value: shadowToDtcg(tokens.shadows[i].shadow ?? tokens.shadows[i].raw),
        $type: "shadow",
      };
    }
    output.shadow = shadow;
  }

  const opacityVals = tokens.opacities
    .map((token) => Number(token.raw))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (opacityVals.length > 0) {
    const opacity: Record<string, { $value: number; $type: "number" }> = {};
    for (let i = 0; i < opacityVals.length; i++) {
      opacity[String(i + 1)] = { $value: opacityVals[i], $type: "number" };
    }
    output.opacity = opacity;
  }

  return { path: "design-tokens.json", content: JSON.stringify(output, null, 2), type: "json" };
}
