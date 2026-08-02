import type { FigmaColor, ShadowTokenValue } from "./types.js";

export type ShadowRawValue = string | number | ShadowTokenValue[];

export interface DtcgColorValue {
  colorSpace: "srgb";
  components: [number, number, number];
  alpha?: number;
}

export interface DtcgShadowValue {
  color: DtcgColorValue;
  offsetX: { value: number; unit: "px" };
  offsetY: { value: number; unit: "px" };
  blur: { value: number; unit: "px" };
  spread: { value: number; unit: "px" };
  inset: boolean;
}

function formatNumber(value: number): string {
  return Object.is(value, -0) ? "0" : String(value);
}

function colorToCss({ r, g, b, a }: FigmaColor): string {
  return `color(srgb ${formatNumber(r)} ${formatNumber(g)} ${formatNumber(b)} / ${formatNumber(a)})`;
}

function layerToCss(layer: ShadowTokenValue): string {
  const inset = layer.inset ? "inset " : "";
  return `${inset}${formatNumber(layer.offsetX)}px ${formatNumber(layer.offsetY)}px ${formatNumber(layer.blur)}px ${formatNumber(layer.spread)}px ${colorToCss(layer.color)}`;
}

/** Serialize structured shadows to a valid CSS box-shadow value. */
export function shadowToCss(raw: ShadowRawValue): string {
  if (Array.isArray(raw)) return raw.map(layerToCss).join(", ");
  if (typeof raw === "number") return `0px 0px ${formatNumber(raw)}px 0px rgba(0, 0, 0, 1)`;

  const scalar = raw.trim().match(/^(-?(?:\d+\.?\d*|\.\d+))(px)?$/i);
  if (scalar) return `0px 0px ${scalar[1]}px 0px rgba(0, 0, 0, 1)`;
  return raw;
}

export function colorToDtcg(color: FigmaColor): DtcgColorValue {
  const value: DtcgColorValue = {
    colorSpace: "srgb",
    components: [color.r, color.g, color.b],
  };
  if (color.a < 1) value.alpha = color.a;
  return value;
}

/** Convert a shadow to the DTCG composite shape, including legacy scalar blur values. */
export function shadowToDtcg(raw: ShadowRawValue): DtcgShadowValue[] {
  let layers: ShadowTokenValue[];
  if (Array.isArray(raw)) {
    layers = raw;
  } else {
    const blur = typeof raw === "number" ? raw : Number.parseFloat(raw);
    layers = [{
      offsetX: 0,
      offsetY: 0,
      blur: Number.isFinite(blur) ? blur : 0,
      spread: 0,
      color: { r: 0, g: 0, b: 0, a: 1 },
      inset: false,
    }];
  }

  return layers.map((layer) => ({
    color: colorToDtcg(layer.color),
    offsetX: { value: layer.offsetX, unit: "px" },
    offsetY: { value: layer.offsetY, unit: "px" },
    blur: { value: layer.blur, unit: "px" },
    spread: { value: layer.spread, unit: "px" },
    inset: layer.inset,
  }));
}
