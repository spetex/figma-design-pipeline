import { shadowToCss } from "./shadow.js";
import type { DesignToken } from "./types.js";

export interface TailwindTokenCollections {
  colors: DesignToken[];
  fonts: DesignToken[];
  spacing: DesignToken[];
  radii: DesignToken[];
  shadows: DesignToken[];
  opacities: DesignToken[];
}

export interface TailwindTheme {
  colors: Record<string, string>;
  spacing: Record<string, string>;
  fontFamily: Record<string, string[]>;
  fontSize: Record<string, string>;
  fontWeight: Record<string, string>;
  borderRadius: Record<string, string>;
  boxShadow?: Record<string, string>;
  opacity?: Record<string, string>;
}

export interface TailwindProjection {
  theme: TailwindTheme;
  hints: Map<DesignToken, string>;
}

const FONT_SIZE_LABELS: Record<number, string> = {
  12: "xs", 14: "sm", 16: "base", 18: "lg", 20: "xl", 24: "2xl",
  30: "3xl", 36: "4xl", 48: "5xl", 60: "6xl", 72: "7xl", 96: "8xl",
};

const FONT_WEIGHT_LABELS: Record<number, string> = {
  100: "thin", 200: "extralight", 300: "light", 400: "normal", 500: "medium",
  600: "semibold", 700: "bold", 800: "extrabold", 900: "black",
};

const RADIUS_LABELS = ["sm", "DEFAULT", "md", "lg", "xl", "2xl", "3xl", "full"];
const SHADOW_LABELS = ["sm", "DEFAULT", "md", "lg", "xl", "2xl"];

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const cleaned = hex.replace("#", "");
  if (cleaned.length < 6) return null;
  const r = Number.parseInt(cleaned.slice(0, 2), 16) / 255;
  const g = Number.parseInt(cleaned.slice(2, 4), 16) / 255;
  const b = Number.parseInt(cleaned.slice(4, 6), 16) / 255;
  if (![r, g, b].every(Number.isFinite)) return null;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const delta = max - min;
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / delta + 2) / 6;
  else h = ((r - g) / delta + 4) / 6;
  return { h: h * 360, s, l };
}

function hueBucketName(hue: number, saturation: number): string {
  if (saturation < 0.08) return "gray";
  if (hue < 15) return "red";
  if (hue < 40) return "orange";
  if (hue < 65) return "yellow";
  if (hue < 160) return "green";
  if (hue < 200) return "cyan";
  if (hue < 260) return "blue";
  if (hue < 300) return "purple";
  if (hue < 340) return "pink";
  return "red";
}

export function generateScale(n: number): number[] {
  if (n === 1) return [500];
  if (n === 2) return [300, 700];
  const full = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
  if (n > full.length) {
    return full.concat(Array.from({ length: n - full.length }, (_, index) => 1000 + index * 50));
  }
  if (n === full.length) return full;
  const step = (full.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, index) => full[Math.round(index * step)]);
}

export function classifyFontFamily(family: string): "sans" | "serif" | "mono" {
  const lower = family.toLowerCase();
  if (/mono|courier|consolas|fira\s*code|jetbrains|menlo|source\s*code/i.test(lower)) return "mono";
  if (/serif|georgia|times|garamond|palatino|baskerville/i.test(lower)) {
    return /sans[-\s]?serif/i.test(lower) ? "sans" : "serif";
  }
  return "sans";
}

export function parseFontToken(raw: DesignToken["raw"]): {
  family: string;
  size?: number;
  weight?: number;
} {
  const [family = String(raw), sizeRaw, weightRaw] = String(raw).split("|");
  const size = Number(sizeRaw);
  const weight = Number(weightRaw);
  return {
    family: family || String(raw),
    ...(Number.isFinite(size) && size > 0 ? { size } : {}),
    ...(Number.isFinite(weight) && weight > 0 ? { weight } : {}),
  };
}

function fontSizeLabel(value: number): string {
  return FONT_SIZE_LABELS[value] ?? String(value);
}

function fontWeightLabel(value: number): string {
  return FONT_WEIGHT_LABELS[value] ?? String(value);
}

function opacityBaseLabel(value: number): string {
  return String(Number((value * 100).toPrecision(15)));
}

function utilityName(prefix: string, label: string): string {
  return label === "DEFAULT" ? prefix : `${prefix}-${label}`;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function createTailwindProjection(tokens: TailwindTokenCollections): TailwindProjection {
  const hints = new Map<DesignToken, string>();
  const colors: Record<string, string> = {};
  const spacing: Record<string, string> = {};
  const fontFamily: Record<string, string[]> = {};
  const fontSize: Record<string, string> = {};
  const fontWeight: Record<string, string> = {};
  const borderRadius: Record<string, string> = {};
  const boxShadow: Record<string, string> = {};
  const opacity: Record<string, string> = {};

  const buckets = new Map<string, Map<string, { hex: string; lightness: number; tokens: DesignToken[] }>>();
  for (const token of tokens.colors) {
    const hex = String(token.raw);
    const hsl = hex.startsWith("#") ? hexToHsl(hex) : null;
    if (!hsl) continue;
    const bucket = hueBucketName(hsl.h, hsl.s);
    const shades = buckets.get(bucket) ?? new Map();
    const shade = shades.get(hex) ?? { hex, lightness: hsl.l, tokens: [] };
    shade.tokens.push(token);
    shades.set(hex, shade);
    buckets.set(bucket, shades);
  }
  for (const [bucket, shadeMap] of [...buckets].sort(([a], [b]) => compareStrings(a, b))) {
    const shades = [...shadeMap.values()].sort(
      (a, b) => b.lightness - a.lightness || compareStrings(a.hex, b.hex)
    );
    const labels = shades.length === 1 ? [null] : generateScale(shades.length);
    for (let index = 0; index < shades.length; index++) {
      const key = labels[index] === null ? bucket : `${bucket}-${labels[index]}`;
      colors[key] = shades[index].hex;
      for (const token of shades[index].tokens) hints.set(token, key);
    }
  }

  const spacingValues = [...new Set(tokens.spacing
    .map((token) => Number(token.raw))
    .filter(Number.isFinite))].sort((a, b) => a - b);
  for (const value of spacingValues) spacing[String(value)] = `${value}px`;
  for (const token of tokens.spacing) {
    const value = Number(token.raw);
    if (Number.isFinite(value)) hints.set(token, `gap-${value}`);
  }

  for (const token of tokens.fonts) {
    const { family, size, weight } = parseFontToken(token.raw);
    const familyLabel = classifyFontFamily(family);
    const families = fontFamily[familyLabel] ?? [];
    if (!families.includes(family)) families.push(family);
    fontFamily[familyLabel] = families;
    const tokenHints = [`font-${familyLabel}`];
    if (size !== undefined) {
      const label = fontSizeLabel(size);
      fontSize[label] = `${size}px`;
      tokenHints.push(`text-${label}`);
    }
    if (weight !== undefined) {
      const label = fontWeightLabel(weight);
      fontWeight[label] = String(weight);
      tokenHints.push(`font-${label}`);
    }
    hints.set(token, tokenHints.join(" "));
  }

  const radiusValues = [...new Set(tokens.radii
    .map((token) => Number(token.raw))
    .filter(Number.isFinite))].sort((a, b) => a - b);
  const radiusLabels = new Map<number, string>();
  for (let index = 0; index < radiusValues.length; index++) {
    const label = RADIUS_LABELS[index] ?? String(index + 1);
    borderRadius[label] = `${radiusValues[index]}px`;
    radiusLabels.set(radiusValues[index], label);
  }
  for (const token of tokens.radii) {
    const label = radiusLabels.get(Number(token.raw));
    if (label) hints.set(token, utilityName("rounded", label));
  }

  const shadowsByCss = new Map<string, DesignToken[]>();
  for (const token of tokens.shadows) {
    const css = shadowToCss(token.shadow ?? token.raw);
    const duplicates = shadowsByCss.get(css) ?? [];
    duplicates.push(token);
    shadowsByCss.set(css, duplicates);
  }
  const shadowEntries = [...shadowsByCss].sort(([a], [b]) => compareStrings(a, b));
  for (let index = 0; index < shadowEntries.length; index++) {
    const [css, shadowTokens] = shadowEntries[index];
    const label = SHADOW_LABELS[index] ?? String(index + 1);
    boxShadow[label] = css;
    for (const token of shadowTokens) hints.set(token, utilityName("shadow", label));
  }

  const opacityValues = [...new Set(tokens.opacities
    .map((token) => Number(token.raw))
    .filter(Number.isFinite))].sort((a, b) => a - b);
  const opacityLabels = new Map<number, string>();
  for (const value of opacityValues) {
    const baseLabel = opacityBaseLabel(value);
    let label = baseLabel;
    let suffix = 2;
    while (label in opacity) label = `${baseLabel}-${suffix++}`;
    opacity[label] = String(value);
    opacityLabels.set(value, label);
  }
  for (const token of tokens.opacities) {
    const label = opacityLabels.get(Number(token.raw));
    if (label) hints.set(token, `opacity-${label}`);
  }

  const theme: TailwindTheme = {
    colors,
    spacing,
    fontFamily,
    fontSize,
    fontWeight,
    borderRadius,
  };
  if (Object.keys(boxShadow).length > 0) theme.boxShadow = boxShadow;
  if (Object.keys(opacity).length > 0) theme.opacity = opacity;
  return { theme, hints };
}

export function applyTailwindHints(tokens: TailwindTokenCollections): TailwindProjection {
  const projection = createTailwindProjection(tokens);
  for (const collection of Object.values(tokens)) {
    for (const token of collection) delete token.tailwind;
  }
  for (const [token, hint] of projection.hints) token.tailwind = hint;
  return projection;
}
