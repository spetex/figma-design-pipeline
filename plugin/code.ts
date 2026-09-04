/// <reference types="@figma/plugin-typings" />

import { assertActionInputCoverage, isForbiddenDeleteNodeType, isKnownActionType } from "../src/shared/action-parity";
import { classifyNode } from "../src/analysis/node-classifier";
import {
  MAX_PLUGIN_READ_DEPTH,
  MAX_PLUGIN_BATCH_INSPECTION_BYTES,
  MAX_PLUGIN_READ_RESULTS,
  MAX_PLUGIN_READ_SCALAR_BYTES,
  MAX_PLUGIN_READ_VISITS,
  MAX_PLUGIN_SELECTION_METADATA,
  type PluginComponentNode,
  type PluginBatchInspection,
  type PluginReadFilters,
  type PluginReadNode,
  type PluginReadRequest,
  type PluginReadResponse,
  type PluginReadContextNode,
  type PluginTruncatedFields,
} from "../src/shared/plugin-read";
import { compileInspectionRegex, type InspectionRegex } from "../src/shared/safe-regex";
import { preflightActionReferences } from "../src/plugin/batch-compiler";

// ─── SPFR Design Pipeline Plugin v2 ──────────────────────────────
// High-performance batch executor with font caching, symbolic refs,
// before/after snapshots, dry-run, and rollback.

figma.showUI(__html__, { visible: true, width: 200, height: 40 });

// ─── Font Cache ─────────────────────────────────────────────────

const loadedFonts = new Map<string, true>();

async function ensureFonts(fonts: Array<{ family: string; style?: string }>): Promise<void> {
  const toLoad: Array<{ family: string; style: string }> = [];
  for (const f of fonts) {
    const style = f.style || "Regular";
    const key = `${f.family}|${style}`;
    if (!loadedFonts.has(key)) {
      toLoad.push({ family: f.family, style });
    }
  }
  if (toLoad.length === 0) return;
  await Promise.all(toLoad.map(async (f) => {
    await figma.loadFontAsync(f);
    loadedFonts.set(`${f.family}|${f.style}`, true);
  }));
}

// ─── Node Ref Resolution ────────────────────────────────────────

function resolveBatchId(id: string, references: ReadonlyMap<string, string>): string {
  if (id.startsWith("$")) {
    const real = references.get(id);
    if (!real) throw new Error(`Unresolved ref: ${id}`);
    return real;
  }
  return id;
}

async function findBatchNode(nodeId: string, references: ReadonlyMap<string, string>): Promise<BaseNode> {
  const id = resolveBatchId(nodeId, references);
  const node = await figma.getNodeByIdAsync(id);
  if (!node) throw new Error(`Node not found: ${id}`);
  return node;
}

async function findBatchSceneNode(nodeId: string, references: ReadonlyMap<string, string>): Promise<SceneNode> {
  const node = await findBatchNode(nodeId, references);
  if (!("parent" in node)) throw new Error(`Not a scene node: ${nodeId}`);
  return node as SceneNode;
}

function requireContainer(node: BaseNode, nodeId: string): BaseNode & ChildrenMixin {
  if (!("appendChild" in node) || typeof node.appendChild !== "function") {
    throw new Error(`Node ${nodeId} is not a container`);
  }
  return node as BaseNode & ChildrenMixin;
}

function propertyDisplayName(key: string): string {
  const separator = key.lastIndexOf("#");
  return separator < 0 ? key : key.slice(0, separator);
}

function resolveComponentPropertyKey(
  definitions: ComponentPropertyDefinitions,
  requested: string
): string {
  if (Object.prototype.hasOwnProperty.call(definitions, requested)) return requested;
  const matches = Object.keys(definitions).filter((key) => propertyDisplayName(key) === requested);
  if (matches.length === 0) throw new Error(`Component property not found: ${requested}`);
  if (matches.length > 1) throw new Error(`Component property name is ambiguous: ${requested}`);
  return matches[0];
}

async function requireBatchAttachedInstance(instanceId: string, references: ReadonlyMap<string, string>): Promise<InstanceNode> {
  const node = await findBatchSceneNode(instanceId, references);
  if (node.type !== "INSTANCE") throw new Error(`Node ${instanceId} is not an instance`);
  if (typeof node.getMainComponentAsync === "function" && !(await node.getMainComponentAsync())) {
    throw new Error(`Instance ${instanceId} is detached or has no main component`);
  }
  return node;
}

async function findBatchInstanceChild(instanceId: string, childPath: string[], references: ReadonlyMap<string, string>): Promise<SceneNode> {
  let current: BaseNode = await requireBatchAttachedInstance(instanceId, references);
  for (const segment of childPath) {
    if (!("children" in current)) throw new Error(`Child path cannot descend through ${current.type}`);
    const matches: SceneNode[] = current.children.filter((child: SceneNode) => child.name === segment);
    if (matches.length === 0) throw new Error(`Child path segment not found: ${segment}`);
    if (matches.length > 1) throw new Error(`Child path segment is ambiguous: ${segment}`);
    current = matches[0];
  }
  if (!("parent" in current)) throw new Error("Child path did not resolve to a scene node");
  return current as SceneNode;
}

async function resolveBatchVariable(action: Record<string, unknown>, references: ReadonlyMap<string, string>): Promise<Variable> {
  let variable: Variable | null = null;
  if (typeof action.variableId === "string") {
    variable = typeof figma.variables.getVariableByIdAsync === "function"
      ? await figma.variables.getVariableByIdAsync(resolveBatchId(action.variableId, references))
      : figma.variables.getVariableById(resolveBatchId(action.variableId, references));
  } else {
    const name = action.variableName as string;
    let candidates = (await figma.variables.getLocalVariablesAsync(action.resolvedType as VariableResolvedDataType | undefined))
      .filter((candidate) => candidate.name === name);
    if (action.collectionId || action.collectionName) {
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      const collectionMatches = action.collectionId
        ? collections.filter((collection) => collection.id === resolveBatchId(action.collectionId as string, references))
        : collections.filter((collection) => collection.name === action.collectionName);
      if (collectionMatches.length === 0) throw new Error(`Variable collection not found: ${String(action.collectionId ?? action.collectionName)}`);
      if (collectionMatches.length > 1) throw new Error(`Variable collection name is ambiguous: ${String(action.collectionName)}`);
      candidates = candidates.filter((candidate) => candidate.variableCollectionId === collectionMatches[0].id);
    }
    if (candidates.length === 0) throw new Error(`Variable not found: ${name}`);
    if (candidates.length > 1) throw new Error(`Variable name is ambiguous: ${name}`);
    variable = candidates[0];
  }
  if (!variable) throw new Error(`Variable not found: ${String(action.variableId)}`);
  if (action.resolvedType && variable.resolvedType !== action.resolvedType) {
    throw new Error(`Variable ${variable.name} is ${variable.resolvedType}, not ${String(action.resolvedType)}`);
  }
  if (action.collectionId || action.collectionName) {
    let collections: VariableCollection[];
    if (action.collectionId) {
      const collectionId = resolveBatchId(action.collectionId as string, references);
      const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
      collections = collection ? [collection] : [];
    } else {
      collections = (await figma.variables.getLocalVariableCollectionsAsync())
        .filter((collection) => collection.name === action.collectionName);
    }
    if (collections.length === 0) throw new Error(`Variable collection not found: ${String(action.collectionId ?? action.collectionName)}`);
    if (collections.length > 1) throw new Error(`Variable collection name is ambiguous: ${String(action.collectionName)}`);
    if (variable.variableCollectionId !== collections[0].id) {
      throw new Error(`Variable ${variable.name} is not in collection ${collections[0].name}`);
    }
  }
  return variable;
}

async function localStyles(type: "PAINT" | "TEXT" | "EFFECT"): Promise<Array<PaintStyle | TextStyle | EffectStyle>> {
  if (type === "PAINT") return figma.getLocalPaintStylesAsync();
  if (type === "TEXT") return figma.getLocalTextStylesAsync();
  return figma.getLocalEffectStylesAsync();
}

async function resolveBatchStyle(
  type: "PAINT" | "TEXT" | "EFFECT",
  id: unknown,
  name: unknown,
  references: ReadonlyMap<string, string>,
): Promise<PaintStyle | TextStyle | EffectStyle> {
  if (typeof id === "string") {
    const style = await figma.getStyleByIdAsync(resolveBatchId(id, references));
    if (!style) throw new Error(`Style not found: ${id}`);
    if (style.type !== type) throw new Error(`Style ${id} is ${style.type}, not ${type}`);
    return style as PaintStyle | TextStyle | EffectStyle;
  }
  const matches = (await localStyles(type)).filter((style) => style.name === name);
  if (matches.length === 0) throw new Error(`Style not found: ${String(name)}`);
  if (matches.length > 1) throw new Error(`Style name is ambiguous: ${String(name)}`);
  return matches[0];
}

function gradientTransform(action: Record<string, unknown>): Transform {
  if (action.gradientTransform) return action.gradientTransform as Transform;
  const angle = ((action.angle as number | undefined) ?? 0) * Math.PI / 180;
  return [
    [Math.cos(angle), Math.sin(angle), 0],
    [-Math.sin(angle), Math.cos(angle), 0],
  ];
}

function gradientPaints(action: Record<string, unknown>): GradientPaint[] {
  const inputs = Array.isArray(action.gradients)
    ? action.gradients as Array<Record<string, unknown>>
    : [action];
  return inputs.map((input) => ({
    type: `GRADIENT_${(input.gradientType as string | undefined) ?? "LINEAR"}` as GradientPaint["type"],
    gradientStops: input.stops as ColorStop[],
    gradientTransform: gradientTransform(input),
    ...(input.visible !== undefined ? { visible: input.visible as boolean } : {}),
    ...(input.opacity !== undefined ? { opacity: input.opacity as number } : {}),
    ...(input.blendMode !== undefined ? { blendMode: input.blendMode as BlendMode } : {}),
  }));
}

function parseVariableValue(type: VariableResolvedDataType, value: unknown): VariableValue {
  if (type === "COLOR") {
    if (typeof value === "object" && value !== null && ["r", "g", "b"].every((key) => typeof (value as Record<string, unknown>)[key] === "number")) {
      return value as RGBA;
    }
    if (typeof value !== "string" || !/^#?(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) {
      throw new Error("COLOR variable value must be #RGB, #RRGGBB, #RRGGBBAA, or RGBA");
    }
    const cleaned = value.replace("#", "");
    const expanded = cleaned.length === 3 ? cleaned.split("").map((channel) => channel + channel).join("") : cleaned;
    return {
      r: parseInt(expanded.slice(0, 2), 16) / 255,
      g: parseInt(expanded.slice(2, 4), 16) / 255,
      b: parseInt(expanded.slice(4, 6), 16) / 255,
      a: expanded.length === 8 ? parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    };
  }
  if (type === "FLOAT" && typeof value !== "number") throw new Error("FLOAT variable value must be a number");
  if (type === "STRING" && typeof value !== "string") throw new Error("STRING variable value must be a string");
  if (type === "BOOLEAN" && typeof value !== "boolean") throw new Error("BOOLEAN variable value must be a boolean");
  return value as VariableValue;
}

/** Load every font needed to modify a text node without replacing its font. */
async function ensureTextNodeFonts(node: TextNode): Promise<void> {
  const fontName = node.fontName;
  if (typeof fontName !== "symbol") {
    await ensureFonts([{ family: fontName.family, style: fontName.style }]);
    return;
  }

  const seen = new Set<string>();
  for (let i = 0; i < node.characters.length; i++) {
    const font = node.getRangeFontName(i, i + 1) as FontName;
    const key = `${font.family}|${font.style}`;
    if (!seen.has(key)) {
      seen.add(key);
      await ensureFonts([font]);
    }
  }
}

// ─── Font Weight Helpers ────────────────────────────────────────

const WEIGHT_TO_STYLE: Record<number, string> = {
  100: "Thin", 200: "Extra Light", 300: "Light", 400: "Regular",
  500: "Medium", 600: "Semi Bold", 700: "Bold", 800: "Extra Bold", 900: "Black",
};

function weightToFontStyle(weight: number): string {
  const snapped = Math.round(weight / 100) * 100;
  return WEIGHT_TO_STYLE[snapped] || "Regular";
}

// ─── Snapshot ───────────────────────────────────────────────────

/** Safely serialize a value that might be figma.mixed (a Symbol that breaks JSON.stringify). */
function safeSerialize(value: unknown): unknown {
  if (typeof value === "symbol") return "mixed";
  try { return JSON.parse(JSON.stringify(value)); } catch { return "mixed"; }
}

function boundedNativeProperty(
  node: BaseNode,
  property: string,
  truncatedFields: PluginTruncatedFields
): Record<string, unknown> {
  const raw = readProperty(node, property);
  if (raw === undefined) return {};
  const value = safeSerialize(raw);
  const serialized = JSON.stringify(value);
  const originalBytes = truncateFigmaString(serialized).originalBytes;
  if (originalBytes > MAX_PLUGIN_READ_SCALAR_BYTES) {
    truncatedFields[property] = { originalBytes, returnedBytes: 0 };
    return {};
  }
  return { [property]: value };
}

async function nativeInspectionProperties(
  node: BaseNode,
  truncatedFields: PluginTruncatedFields
): Promise<Partial<PluginReadNode>> {
  const result: Record<string, unknown> = {};
  for (const property of [
    "opacity", "rotation", "topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius",
  ]) {
    Object.assign(result, numberProperty(node, property));
  }
  for (const property of [
    "layoutWrap", "primaryAxisAlignItems", "counterAxisAlignItems", "layoutSizingHorizontal",
    "layoutSizingVertical", "fillStyleId", "strokeStyleId", "textStyleId", "effectStyleId",
  ]) {
    Object.assign(result, stringProperty(node, property, truncatedFields));
  }
  Object.assign(result, cornerRadiusProperty(node));
  for (const property of [
    "fills", "strokes", "effects", "componentProperties", "componentPropertyDefinitions",
    "componentPropertyReferences", "boundVariables", "resolvedVariableModes",
  ]) {
    Object.assign(result, boundedNativeProperty(node, property, truncatedFields));
  }
  const getCSSAsync = readProperty(node, "getCSSAsync");
  if (typeof getCSSAsync === "function") {
    try {
      const css = await (getCSSAsync as () => Promise<Record<string, string>>).call(node);
      Object.assign(result, boundedNativeProperty({ css } as unknown as BaseNode, "css", truncatedFields));
    } catch {
      // CSS resolution is useful enrichment, not a reason to fail inspection.
    }
  }
  return result as Partial<PluginReadNode>;
}

function captureSnapshot(node: SceneNode): Record<string, unknown> {
  const snap: Record<string, unknown> = {
    id: node.id,
    name: node.name,
    type: node.type,
  };
  if ("x" in node) { snap.x = node.x; snap.y = node.y; }
  if ("width" in node) { snap.width = node.width; snap.height = node.height; }
  if ("fills" in node) snap.fills = safeSerialize((node as GeometryMixin).fills);
  if ("opacity" in node) snap.opacity = (node as BlendMixin).opacity;
  if ("visible" in node) snap.visible = node.visible;
  if ("layoutMode" in node) snap.layoutMode = (node as FrameNode).layoutMode;
  if ("characters" in node) snap.characters = (node as TextNode).characters;
  if ("cornerRadius" in node) {
    const cr = (node as FrameNode).cornerRadius;
    snap.cornerRadius = typeof cr === "symbol" ? "mixed" : cr;
  }
  return snap;
}

// ─── Read-only inspection ──────────────────────────────────────

function readChildren(node: BaseNode): readonly BaseNode[] {
  const value = readProperty(node, "children");
  return Array.isArray(value) ? value as BaseNode[] : [];
}

function readProperty(node: BaseNode, property: string): unknown {
  try {
    return (node as unknown as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function truncateFigmaString(value: string): {
  value: string;
  originalBytes: number;
  returnedBytes: number;
  truncated: boolean;
} {
  let originalBytes = 0;
  let returnedContentBytes = 0;
  let returnedEnd = 0;
  const contentBudget = MAX_PLUGIN_READ_SCALAR_BYTES - 3; // UTF-8 ellipsis
  let prefixComplete = true;

  for (let index = 0; index < value.length; index++) {
    const first = value.charCodeAt(index);
    let characterBytes: number;
    let characterEnd = index + 1;
    if (first <= 0x7f) {
      characterBytes = 1;
    } else if (first <= 0x7ff) {
      characterBytes = 2;
    } else if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
      const second = value.charCodeAt(index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        characterBytes = 4;
        characterEnd = index + 2;
        index++;
      } else {
        characterBytes = 3;
      }
    } else {
      // BMP code points and unpaired surrogates both encode to at most 3 bytes.
      characterBytes = 3;
    }
    originalBytes += characterBytes;
    if (prefixComplete && returnedContentBytes + characterBytes <= contentBudget) {
      returnedContentBytes += characterBytes;
      returnedEnd = characterEnd;
    } else {
      prefixComplete = false;
    }
  }

  if (originalBytes <= MAX_PLUGIN_READ_SCALAR_BYTES) {
    return { value, originalBytes, returnedBytes: originalBytes, truncated: false };
  }
  return {
    value: `${value.slice(0, returnedEnd)}…`,
    originalBytes,
    returnedBytes: returnedContentBytes + 3,
    truncated: true,
  };
}

function boundedFigmaString(
  value: string,
  field: string,
  truncatedFields: PluginTruncatedFields
): string {
  const bounded = truncateFigmaString(value);
  if (bounded.truncated) {
    truncatedFields[field] = {
      originalBytes: bounded.originalBytes,
      returnedBytes: bounded.returnedBytes,
    };
  }
  return bounded.value;
}

function boundedOptionalFigmaString(
  value: unknown,
  field: string,
  truncatedFields: PluginTruncatedFields
): string | undefined {
  return typeof value === "string" ? boundedFigmaString(value, field, truncatedFields) : undefined;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeBounds(node: BaseNode): PluginReadNode["bounds"] {
  const value = readProperty(node, "absoluteBoundingBox");
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const x = safeNumber(raw.x);
  const y = safeNumber(raw.y);
  const width = safeNumber(raw.width);
  const height = safeNumber(raw.height);
  return x === undefined || y === undefined || width === undefined || height === undefined
    ? undefined
    : { x, y, width, height };
}

async function componentMetadata(node: BaseNode): Promise<Pick<PluginReadNode,
  "componentId" | "componentKey" | "description" | "componentSetId">> {
  let componentId: string | undefined;
  if (node.type === "INSTANCE") {
    try {
      const component = await (node as InstanceNode).getMainComponentAsync();
      componentId = component?.id;
    } catch {
      // A missing or inaccessible library component must not make the node unsafe to inspect.
    }
  }
  const parent = readProperty(node, "parent") as BaseNode | undefined;
  const componentKey = safeString(readProperty(node, "key"));
  const description = safeString(readProperty(node, "description"));
  return {
    ...(componentId ? { componentId } : {}),
    ...((node.type === "COMPONENT" || node.type === "COMPONENT_SET")
      && componentKey
      ? { componentKey }
      : {}),
    ...((node.type === "COMPONENT" || node.type === "COMPONENT_SET")
      && description
      ? { description }
      : {}),
    ...(parent?.type === "COMPONENT_SET" ? { componentSetId: parent.id } : {}),
  };
}

async function serializeReadNode(
  node: BaseNode,
  children: PluginReadNode[],
  depth: number,
  includeNativeProperties = false
): Promise<PluginReadNode> {
  const truncatedFields: PluginTruncatedFields = {};
  const bounds = safeBounds(node);
  const visible = readProperty(node, "visible");
  const rawCharacters = safeString(readProperty(node, "characters"));
  const layoutMode = safeString(readProperty(node, "layoutMode"));
  const rawMetadata = await componentMetadata(node);
  const textContent = boundedOptionalFigmaString(rawCharacters, "textContent", truncatedFields);
  const componentId = boundedOptionalFigmaString(rawMetadata.componentId, "componentId", truncatedFields);
  const componentKey = boundedOptionalFigmaString(rawMetadata.componentKey, "componentKey", truncatedFields);
  const description = boundedOptionalFigmaString(rawMetadata.description, "description", truncatedFields);
  const componentSetId = boundedOptionalFigmaString(rawMetadata.componentSetId, "componentSetId", truncatedFields);
  const nativeProperties = includeNativeProperties
    ? await nativeInspectionProperties(node, truncatedFields)
    : {};
  const sourceChildren = readChildren(node);
  const classificationChildren = sourceChildren.slice(0, 20).map((child) => ({
    id: child.id,
    name: child.name,
    type: child.type,
    absoluteBoundingBox: safeBounds(child),
  }));
  return {
    id: boundedFigmaString(node.id, "id", truncatedFields),
    name: boundedFigmaString(node.name, "name", truncatedFields),
    type: boundedFigmaString(safeString(readProperty(node, "type")) ?? "UNKNOWN", "type", truncatedFields),
    classification: classifyNode({
      id: node.id,
      name: node.name,
      type: node.type,
      absoluteBoundingBox: bounds,
      characters: rawCharacters,
      children: classificationChildren,
    }),
    depth,
    ...(typeof visible === "boolean" ? { visible } : {}),
    ...(bounds ? { bounds } : {}),
    ...(textContent !== undefined ? { textContent } : {}),
    ...(componentId !== undefined ? { componentId } : {}),
    ...(componentKey !== undefined ? { componentKey } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(componentSetId !== undefined ? { componentSetId } : {}),
    ...(layoutMode === "HORIZONTAL" || layoutMode === "VERTICAL" || layoutMode === "GRID" || layoutMode === "NONE"
      ? { layoutMode }
      : {}),
    ...numberProperty(node, "itemSpacing"),
    ...numberProperty(node, "paddingLeft"),
    ...numberProperty(node, "paddingRight"),
    ...numberProperty(node, "paddingTop"),
    ...numberProperty(node, "paddingBottom"),
    ...nativeProperties,
    childCount: sourceChildren.length,
    ...(Object.keys(truncatedFields).length > 0 ? { truncatedFields } : {}),
    children,
  };
}

function numberProperty(node: BaseNode, property: string): Record<string, number> {
  const value = safeNumber(readProperty(node, property));
  return value === undefined ? {} : { [property]: value };
}

function stringProperty(
  node: BaseNode,
  property: string,
  truncatedFields: PluginTruncatedFields
): Record<string, string> {
  const value = boundedOptionalFigmaString(readProperty(node, property), property, truncatedFields);
  return value === undefined ? {} : { [property]: value };
}

function cornerRadiusProperty(node: BaseNode): Pick<PluginReadNode, "cornerRadius"> {
  const value = readProperty(node, "cornerRadius");
  if (typeof value === "symbol") return { cornerRadius: "mixed" };
  return typeof value === "number" && Number.isFinite(value) ? { cornerRadius: value } : {};
}

async function serializeTree(
  node: BaseNode,
  depth: number,
  budget: { remaining: number; visited: number; truncated: boolean; omittedNodeCount: number },
  currentDepth = 0,
  includeNativeProperties = false
): Promise<PluginReadNode | null> {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    budget.omittedNodeCount++;
    return null;
  }
  budget.remaining--;
  budget.visited++;
  const children: PluginReadNode[] = [];
  if (depth > 0) {
    const sourceChildren = readChildren(node);
    for (let index = 0; index < sourceChildren.length; index++) {
      const child = sourceChildren[index]!;
      const serialized = await serializeTree(child, depth - 1, budget, currentDepth + 1, includeNativeProperties);
      if (!serialized) {
        budget.omittedNodeCount += sourceChildren.length - index - 1;
        break;
      }
      children.push(serialized);
    }
  }
  return serializeReadNode(node, children, currentDepth, includeNativeProperties);
}

async function resolveReadRoots(request: PluginReadRequest): Promise<readonly BaseNode[]> {
  if (request.root === "current-page") return [figma.currentPage];
  if (request.root === "selection") return figma.currentPage.selection;
  if (!request.nodeId) throw new Error("nodeId is required when root is 'node'");
  const node = await figma.getNodeByIdAsync(request.nodeId);
  if (!node) throw new Error(`Node not found: ${request.nodeId}`);
  return [node];
}

function compileReadRegex(pattern: string | undefined, label: string): InspectionRegex | undefined {
  return compileInspectionRegex(pattern, label);
}

function nodeMatches(
  source: BaseNode,
  node: PluginReadNode,
  filters: PluginReadFilters,
  nameRegex?: InspectionRegex,
  textRegex?: InspectionRegex
): boolean {
  const sourceName = safeString(readProperty(source, "name")) ?? "";
  const sourceText = safeString(readProperty(source, "characters"));
  const sourceType = safeString(readProperty(source, "type")) ?? "";
  if (filters.name !== undefined && sourceName !== filters.name) return false;
  if (nameRegex && !nameRegex.test(sourceName)) return false;
  if (filters.type && sourceType.toUpperCase() !== filters.type.toUpperCase()) return false;
  if (filters.classification && node.classification !== filters.classification) return false;
  if (textRegex && (!sourceText || !textRegex.test(sourceText))) return false;
  if (filters.componentId && node.componentId !== filters.componentId) return false;
  if (filters.hasChildren !== undefined && (node.childCount > 0) !== filters.hasChildren) return false;
  if (filters.minWidth !== undefined && (!node.bounds || node.bounds.width < filters.minWidth)) return false;
  if (filters.maxWidth !== undefined && (!node.bounds || node.bounds.width > filters.maxWidth)) return false;
  if (filters.minHeight !== undefined && (!node.bounds || node.bounds.height < filters.minHeight)) return false;
  if (filters.maxHeight !== undefined && (!node.bounds || node.bounds.height > filters.maxHeight)) return false;
  return true;
}

async function walkReadNodes(
  roots: readonly BaseNode[],
  depth: number,
  budget: { limit: number; visited: number; limitReached: boolean },
  visit: (node: BaseNode, depth: number) => Promise<boolean>
): Promise<boolean> {
  const walk = async (node: BaseNode, remainingDepth: number, currentDepth: number): Promise<boolean> => {
    if (budget.visited >= budget.limit) {
      budget.limitReached = true;
      return false;
    }
    budget.visited++;
    if (!await visit(node, currentDepth)) return false;
    if (remainingDepth <= 0) return true;
    for (const child of readChildren(node)) {
      if (!await walk(child, remainingDepth - 1, currentDepth + 1)) return false;
    }
    return true;
  };
  for (const root of roots) {
    if (!await walk(root, depth, 0)) return false;
  }
  return true;
}

function serializeContextNode(node: BaseNode): PluginReadContextNode {
  const truncatedFields: PluginTruncatedFields = {};
  return {
    id: boundedFigmaString(safeString(readProperty(node, "id")) ?? "unknown", "id", truncatedFields),
    name: boundedFigmaString(safeString(readProperty(node, "name")) ?? "Unknown", "name", truncatedFields),
    type: boundedFigmaString(safeString(readProperty(node, "type")) ?? "UNKNOWN", "type", truncatedFields),
    ...(Object.keys(truncatedFields).length > 0 ? { truncatedFields } : {}),
  };
}

function readResponseBase(request: PluginReadRequest) {
  const currentPage = serializeContextNode(figma.currentPage);
  const selectionContext = request.root === "selection"
    ? serializeSelectionMetadata(request)
    : undefined;
  return {
    type: "read_response",
    requestId: request.requestId,
    operation: request.operation,
    fileKey: figma.fileKey!,
    traversalDepth: request.depth,
    resultLimit: request.limit,
    scanLimit: request.scanLimit,
    currentPage,
    ...(selectionContext ?? {}),
  } as const;
}

function serializeSelectionMetadata(request: PluginReadRequest): Pick<PluginReadResponse,
  "selection" | "selectionCount" | "selectionMetadata"> {
  const source = figma.currentPage.selection;
  const requestedOffset = request.selectionMetadataOffset ?? 0;
  const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0 && requestedOffset <= source.length
    ? requestedOffset
    : 0;
  const requestedLimit = Number.isInteger(request.limit) && request.limit > 0 ? request.limit : 1;
  const end = Math.min(source.length, offset + Math.min(requestedLimit, MAX_PLUGIN_SELECTION_METADATA));
  const selection: PluginReadContextNode[] = [];
  for (let index = offset; index < end; index++) {
    selection.push(serializeContextNode(source[index]!));
  }
  return {
    selection,
    selectionCount: source.length,
    selectionMetadata: {
      offset,
      returned: selection.length,
      total: source.length,
      omitted: source.length - selection.length,
      ...(end < source.length ? { nextOffset: end } : {}),
    },
  };
}

function finalizeReadResponse(
  response: Omit<PluginReadResponse, "truncatedFieldCount" | "omittedScalarBytes">
): PluginReadResponse {
  let truncatedFieldCount = 0;
  let omittedScalarBytes = 0;
  const add = (fields: PluginTruncatedFields | undefined): void => {
    for (const field of Object.values(fields ?? {})) {
      truncatedFieldCount++;
      omittedScalarBytes += field.originalBytes - field.returnedBytes;
    }
  };
  const visitNode = (node: PluginReadNode): void => {
    add(node.truncatedFields);
    node.children.forEach(visitNode);
  };
  add(response.currentPage.truncatedFields);
  response.selection?.forEach((node) => add(node.truncatedFields));
  response.roots.forEach(visitNode);
  response.matches.forEach(visitNode);
  response.components.forEach((component) => add(component.truncatedFields));
  const scalarLimited = truncatedFieldCount > 0;
  return {
    ...response,
    truncated: response.truncated || scalarLimited,
    truncationReasons: Array.from(new Set([
      ...response.truncationReasons,
      ...(scalarLimited ? ["scalar_field_limit" as const] : []),
    ])),
    truncatedFieldCount,
    omittedScalarBytes,
  };
}

const INSPECTION_OPTIONAL_FIELDS: ReadonlyArray<keyof PluginReadNode> = [
  "css", "resolvedVariableModes", "boundVariables", "componentPropertyReferences",
  "componentPropertyDefinitions", "componentProperties", "effects", "strokes", "fills",
  "description", "componentKey", "componentId", "componentSetId", "textContent",
  "fillStyleId", "strokeStyleId", "textStyleId", "effectStyleId",
];

function inspectionScalarSummary(root: PluginReadNode | undefined): {
  truncatedFieldCount: number;
  omittedScalarBytes: number;
} {
  let truncatedFieldCount = 0;
  let omittedScalarBytes = 0;
  const visit = (node: PluginReadNode): void => {
    for (const field of Object.values(node.truncatedFields ?? {})) {
      truncatedFieldCount++;
      omittedScalarBytes += field.originalBytes - field.returnedBytes;
    }
    node.children.forEach(visit);
  };
  if (root) visit(root);
  return { truncatedFieldCount, omittedScalarBytes };
}

function countInspectionNodes(root: PluginReadNode | undefined): number {
  if (!root) return 0;
  return 1 + root.children.reduce((count, child) => count + countInspectionNodes(child), 0);
}

function inspectionTreeAtDepth(node: PluginReadNode, maxDepth: number): PluginReadNode {
  return {
    ...node,
    children: maxDepth > 0
      ? node.children.map((child) => inspectionTreeAtDepth(child, maxDepth - 1))
      : [],
  };
}

function measureInspection(
  inspection: Omit<PluginBatchInspection, "responseBytes">
): PluginBatchInspection {
  let responseBytes = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = { ...inspection, responseBytes };
    const measured = truncateFigmaString(JSON.stringify(result)).originalBytes;
    if (measured === responseBytes) return result;
    responseBytes = measured;
  }
  return { ...inspection, responseBytes };
}

function invalidateInspectionAfterRollback(inspection: PluginBatchInspection): PluginBatchInspection {
  const { root: _root, responseBytes: _responseBytes, ...retained } = inspection;
  return measureInspection({
    ...retained,
    returnedCount: 0,
    omittedNodeCount: inspection.omittedNodeCount + inspection.returnedCount,
    truncated: true,
    rolledBack: true,
  });
}

async function inspectBatchNode(
  node: BaseNode,
  depth: number,
  limit: number,
  scanLimit: number,
  maxResponseBytes: number
): Promise<PluginBatchInspection> {
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_PLUGIN_READ_DEPTH) {
    throw new Error(`Inspect depth must be between 0 and ${MAX_PLUGIN_READ_DEPTH}`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PLUGIN_READ_RESULTS) {
    throw new Error(`Inspect limit must be between 1 and ${MAX_PLUGIN_READ_RESULTS}`);
  }
  if (!Number.isInteger(scanLimit) || scanLimit < 1 || scanLimit > MAX_PLUGIN_READ_VISITS) {
    throw new Error(`Inspect scan limit must be between 1 and ${MAX_PLUGIN_READ_VISITS}`);
  }
  if (maxResponseBytes < 512) {
    throw new Error(`Batch inspection response limit of ${MAX_PLUGIN_BATCH_INSPECTION_BYTES} bytes exhausted`);
  }

  const effectiveLimit = Math.min(limit, scanLimit);
  const budget = { remaining: effectiveLimit, visited: 0, truncated: false, omittedNodeCount: 0 };
  const serialized = await serializeTree(node, depth, budget, 0, true);
  if (!serialized) throw new Error("Inspect result limit exhausted before serializing the root node");
  const scannedCount = budget.visited;
  const limitReasons = budget.truncated
    ? [limit <= scanLimit ? "result_limit" as const : "scan_limit" as const]
    : [];
  const scanLimitReached = budget.truncated && scanLimit < limit;
  const originalReturnedCount = countInspectionNodes(serialized);
  let omittedPropertyCount = 0;

  const candidate = (root: PluginReadNode, responseLimited: boolean): PluginBatchInspection => {
    const returnedCount = countInspectionNodes(root);
    const scalar = inspectionScalarSummary(root);
    const reasons = Array.from(new Set([
      ...limitReasons,
      ...(scalar.truncatedFieldCount > 0 ? ["scalar_field_limit" as const] : []),
      ...(responseLimited ? ["response_byte_limit" as const] : []),
    ]));
    return measureInspection({
      root,
      totalScanned: scannedCount,
      returnedCount,
      omittedNodeCount: budget.omittedNodeCount + originalReturnedCount - returnedCount,
      omittedNodeCountExact: !budget.truncated,
      truncated: reasons.length > 0,
      truncationReasons: reasons,
      traversalDepth: depth,
      resultLimit: limit,
      scanLimit,
      scanLimitReached,
      truncatedFieldCount: scalar.truncatedFieldCount,
      omittedScalarBytes: scalar.omittedScalarBytes,
      omittedPropertyCount,
    });
  };

  let response = candidate(serialized, false);
  if (response.responseBytes <= maxResponseBytes) return response;

  for (let retainedDepth = Math.max(0, depth - 1); retainedDepth >= 0; retainedDepth--) {
    response = candidate(inspectionTreeAtDepth(serialized, retainedDepth), true);
    if (response.responseBytes <= maxResponseBytes) return response;
  }

  const root = inspectionTreeAtDepth(serialized, 0);
  for (const field of INSPECTION_OPTIONAL_FIELDS) {
    if (root[field] === undefined) continue;
    delete (root as unknown as Record<string, unknown>)[field];
    omittedPropertyCount++;
    response = candidate(root, true);
    if (response.responseBytes <= maxResponseBytes) return response;
  }
  throw new Error(`Inspect root cannot fit within remaining batch response limit of ${maxResponseBytes} bytes`);
}

async function processReadRequest(request: PluginReadRequest): Promise<PluginReadResponse> {
  if (!figma.fileKey || request.fileKey !== figma.fileKey) {
    throw new Error(`Plugin file mismatch: requested ${request.fileKey}, open ${figma.fileKey || "unknown"}`);
  }
  if (!Number.isInteger(request.depth) || request.depth < 0 || request.depth > MAX_PLUGIN_READ_DEPTH) {
    throw new Error(`Read depth must be between 0 and ${MAX_PLUGIN_READ_DEPTH}`);
  }
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > MAX_PLUGIN_READ_RESULTS) {
    throw new Error(`Read limit must be between 1 and ${MAX_PLUGIN_READ_RESULTS}`);
  }
  if (!Number.isInteger(request.scanLimit) || request.scanLimit < 1 || request.scanLimit > MAX_PLUGIN_READ_VISITS) {
    throw new Error(`Read scan limit must be between 1 and ${MAX_PLUGIN_READ_VISITS}`);
  }
  if (request.operation !== "tree" && request.operation !== "find" && request.operation !== "components") {
    throw new Error(`Unsupported read operation: ${String(request.operation)}`);
  }
  if (request.root !== "node" && request.root !== "current-page" && request.root !== "selection") {
    throw new Error(`Unsupported read root: ${String(request.root)}`);
  }
  if (!Number.isInteger(request.selectionMetadataOffset ?? 0) || (request.selectionMetadataOffset ?? 0) < 0) {
    throw new Error("Selection metadata offset must be a non-negative integer");
  }
  if (request.root !== "selection" && (request.selectionMetadataOffset ?? 0) !== 0) {
    throw new Error("Selection metadata offset is supported only for selection reads");
  }
  if (request.root === "selection" && (request.selectionMetadataOffset ?? 0) > figma.currentPage.selection.length) {
    throw new Error(`Selection metadata offset exceeds the ${figma.currentPage.selection.length}-node selection`);
  }

  const roots = await resolveReadRoots(request);
  const base = readResponseBase(request);
  if (request.operation === "tree") {
    const budget = { remaining: request.limit, visited: 0, truncated: false, omittedNodeCount: 0 };
    const serializedRoots: PluginReadNode[] = [];
    for (const root of roots) {
      const serialized = await serializeTree(root, request.depth, budget);
      if (!serialized) break;
      serializedRoots.push(serialized);
    }
    const returnedCount = request.limit - budget.remaining;
    return finalizeReadResponse({
      ...base,
      success: true,
      roots: serializedRoots,
      matches: [],
      components: [],
      totalScanned: budget.visited,
      returnedCount,
      ...(!budget.truncated ? { totalNodeCount: returnedCount } : {}),
      truncated: budget.truncated,
      truncationReasons: budget.truncated ? ["result_limit"] : [],
      scanLimitReached: false,
    });
  }

  const matches: PluginReadNode[] = [];
  const components: PluginComponentNode[] = [];
  let resultLimitReached = false;
  const scanBudget = { limit: request.scanLimit, visited: 0, limitReached: false };
  const filters = request.filters ?? {};
  const nameRegex = compileReadRegex(filters.namePattern, "namePattern");
  const textRegex = compileReadRegex(filters.textContent, "textContent");
  await walkReadNodes(roots, request.depth, scanBudget, async (node, nodeDepth) => {
    const serialized = await serializeReadNode(node, [], nodeDepth);
    if (request.operation === "find" && nodeMatches(node, serialized, filters, nameRegex, textRegex)) {
      if (matches.length >= request.limit) {
        resultLimitReached = true;
        return false;
      }
      matches.push(serialized);
    }
    if (request.operation === "components" && (node.type === "COMPONENT" || node.type === "COMPONENT_SET")) {
      if (components.length >= request.limit) {
        resultLimitReached = true;
        return false;
      }
      const truncatedFields: PluginTruncatedFields = {};
      for (const [sourceField, targetField] of [
        ["id", "id"],
        ["name", "name"],
        ["type", "type"],
        ["componentKey", "key"],
        ["description", "description"],
        ["componentSetId", "componentSetId"],
      ] as const) {
        const truncation = serialized.truncatedFields?.[sourceField];
        if (truncation) truncatedFields[targetField] = truncation;
      }
      components.push({
        id: serialized.id,
        name: serialized.name,
        type: serialized.type,
        ...(serialized.componentKey ? { key: serialized.componentKey } : {}),
        ...(serialized.description ? { description: serialized.description } : {}),
        ...(serialized.componentSetId ? { componentSetId: serialized.componentSetId } : {}),
        ...(Object.keys(truncatedFields).length > 0 ? { truncatedFields } : {}),
      } as PluginComponentNode);
    }
    return true;
  });

  return finalizeReadResponse({
    ...base,
    success: true,
    roots: [],
    matches,
    components,
    totalScanned: scanBudget.visited,
    returnedCount: request.operation === "find" ? matches.length : components.length,
    truncated: resultLimitReached || scanBudget.limitReached,
    truncationReasons: [
      ...(resultLimitReached ? ["result_limit" as const] : []),
      ...(scanBudget.limitReached ? ["scan_limit" as const] : []),
    ],
    scanLimitReached: scanBudget.limitReached,
  });
}

// ─── Paint Sanitizer (strip 'a' from color — Figma uses paint-level opacity) ──

function sanitizePaints(paints: unknown[]): Paint[] {
  return paints.map((p: any) => {
    if (p && p.color && "a" in p.color) {
      const { a, ...rgb } = p.color;
      const cleaned = { ...p, color: rgb };
      if (a !== undefined && a !== 1 && cleaned.opacity === undefined) {
        cleaned.opacity = a;
      }
      return cleaned;
    }
    return p;
  }) as Paint[];
}

// ─── Action Executors ───────────────────────────────────────────

type ActionResult = {
  actionIndex: number;
  type: string;
  status: "applied" | "planned" | "failed" | "skipped";
  nodeId?: string;
  newNodeId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  inspection?: PluginBatchInspection;
  rolledBack?: boolean;
  error?: string;
};

function redactTransientIds(value: unknown, transientIds: ReadonlySet<string>): unknown {
  if (typeof value === "string") {
    let redacted = value;
    for (const id of transientIds) redacted = redacted.split(id).join("[rolled back node]");
    return redacted;
  }
  if (Array.isArray(value)) return value.map(item => redactTransientIds(item, transientIds));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    redactTransientIds(key, transientIds) as string,
    redactTransientIds(item, transientIds),
  ]));
}

async function executeAction(
  action: Record<string, unknown>,
  markDocumentWrite: () => void,
  references: ReadonlyMap<string, string>,
  maxInspectionBytes = MAX_PLUGIN_BATCH_INSPECTION_BYTES
): Promise<{
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  newNodeId?: string;
  inspection?: PluginBatchInspection;
}> {
  const resolveId = (id: string) => resolveBatchId(id, references);
  const findNode = (id: string) => findBatchNode(id, references);
  const findSceneNode = (id: string) => findBatchSceneNode(id, references);
  const requireAttachedInstance = (id: string) => requireBatchAttachedInstance(id, references);
  const findInstanceChild = (id: string, path: string[]) => findBatchInstanceChild(id, path, references);
  const resolveVariable = (input: Record<string, unknown>) => resolveBatchVariable(input, references);
  const resolveStyle = (styleType: "PAINT" | "TEXT" | "EFFECT", id: unknown, name: unknown) =>
    resolveBatchStyle(styleType, id, name, references);
  const type = action.type as string;
  if (!isKnownActionType(type)) throw new Error(`Unknown action type: ${type}`);
  assertActionInputCoverage(action);

  switch (type) {
    case "inspect": {
      const node = await findNode(action.nodeId as string);
      const inspection = await inspectBatchNode(
        node,
        action.depth as number,
        action.limit as number,
        action.scanLimit as number,
        maxInspectionBytes
      );
      return { inspection };
    }

    case "rename": {
      const node = await findNode(action.nodeId as string);
      const before = { name: node.name };
      node.name = action.name as string;
      markDocumentWrite();
      return { before, after: { name: node.name } };
    }

    case "move": {
      const node = await findSceneNode(action.nodeId as string);
      const parent = await findNode(action.targetParentId as string);
      const container = requireContainer(parent, action.targetParentId as string);
      const beforeParent = node.parent?.id;
      if (action.insertIndex !== undefined) {
        container.insertChild(action.insertIndex as number, node);
      } else {
        container.appendChild(node);
      }
      markDocumentWrite();
      return { before: { parentId: beforeParent }, after: { parentId: container.id } };
    }

    case "create_text": {
      const parent = await findNode(action.parentId as string);
      const container = requireContainer(parent, action.parentId as string);
      const textStyle = action.textStyleId || action.textStyleName
        ? await resolveStyle("TEXT", action.textStyleId, action.textStyleName) as TextStyle
        : null;
      const hasFontOverride = action.fontFamily !== undefined || action.fontWeight !== undefined;
      if (textStyle) await ensureFonts([textStyle.fontName]);
      const family = (action.fontFamily as string | undefined) ?? textStyle?.fontName.family ?? "Inter";
      const style = action.fontWeight !== undefined
        ? weightToFontStyle(action.fontWeight as number)
        : textStyle?.fontName.style ?? "Regular";
      if (!textStyle || hasFontOverride) await ensureFonts([{ family, style }]);
      const text = figma.createText();
      markDocumentWrite();
      if (textStyle) await text.setTextStyleIdAsync(textStyle.id);
      if (!textStyle || hasFontOverride) text.fontName = { family, style };
      text.characters = (action.characters as string) || "";
      if (action.fontSize !== undefined) text.fontSize = action.fontSize as number;
      if (action.lineHeight !== undefined) text.lineHeight = { value: action.lineHeight as number, unit: "PIXELS" };
      if (action.letterSpacing !== undefined) text.letterSpacing = { value: action.letterSpacing as number, unit: "PIXELS" };
      if (action.fills) text.fills = sanitizePaints(action.fills as unknown[]);
      if (action.textCase) text.textCase = action.textCase as TextCase;
      if (action.textAlignHorizontal) text.textAlignHorizontal = action.textAlignHorizontal as "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
      text.textAutoResize = (action.textAutoResize as "NONE" | "WIDTH_AND_HEIGHT" | "HEIGHT" | "TRUNCATE") || "HEIGHT";
      if (action.textTruncation) text.textTruncation = action.textTruncation as "DISABLED" | "ENDING";
      if (action.maxLines !== undefined) text.maxLines = action.maxLines as number | null;
      if (action.name) text.name = action.name as string;
      container.appendChild(text);
      if (action.layoutSizingHorizontal) text.layoutSizingHorizontal = action.layoutSizingHorizontal as "FILL" | "HUG" | "FIXED";
      if (action.layoutSizingVertical) text.layoutSizingVertical = action.layoutSizingVertical as "FILL" | "HUG" | "FIXED";
      if (action.opacity !== undefined) text.opacity = action.opacity as number;
      return { after: { id: text.id, name: text.name, characters: text.characters }, newNodeId: text.id };
    }

    case "create_frame": {
      const parent = await findNode(action.parentId as string);
      const container = requireContainer(parent, action.parentId as string);
      const frame = figma.createFrame();
      frame.fills = [];
      markDocumentWrite();
      frame.name = action.name as string;
      frame.resize((action.width as number) || 100, (action.height as number) || 100);
      container.appendChild(frame);
      // Set position AFTER appendChild so coordinates are relative to parent
      frame.x = (action.x as number) || 0;
      frame.y = (action.y as number) || 0;
      return { after: { id: frame.id, name: frame.name }, newNodeId: frame.id };
    }

    case "delete_node": {
      const node = await findSceneNode(action.nodeId as string);
      if (isForbiddenDeleteNodeType(node.type)) throw new Error(`Cannot delete ${node.type} node`);
      const before = captureSnapshot(node);
      node.remove();
      markDocumentWrite();
      return { before };
    }

    case "resize": {
      const node = await findSceneNode(action.nodeId as string) as FrameNode;
      const before = { width: node.width, height: node.height };
      node.resize(
        (action.width as number) ?? node.width,
        (action.height as number) ?? node.height
      );
      markDocumentWrite();
      return { before, after: { width: node.width, height: node.height } };
    }

    case "set_position": {
      const node = await findSceneNode(action.nodeId as string);
      const before = { x: node.x, y: node.y };
      if (action.x !== undefined) {
        const x = action.x as number;
        if (node.x !== x) {
          node.x = x;
          markDocumentWrite();
        }
      }
      if (action.y !== undefined) {
        const y = action.y as number;
        if (node.y !== y) {
          node.y = y;
          markDocumentWrite();
        }
      }
      return { before, after: { x: node.x, y: node.y } };
    }

    case "duplicate_node": {
      const node = await findSceneNode(action.nodeId as string);
      const target = action.targetParentId
        ? requireContainer(await findNode(action.targetParentId as string), action.targetParentId as string)
        : null;
      if (target && action.insertIndex !== undefined && (action.insertIndex as number) > target.children.length) {
        throw new Error(`insertIndex ${String(action.insertIndex)} exceeds target child count ${target.children.length}`);
      }
      const clone = node.clone();
      markDocumentWrite();
      if (target) {
        if (action.insertIndex !== undefined) target.insertChild(action.insertIndex as number, clone);
        else target.appendChild(clone);
      }
      if (action.x !== undefined) clone.x = action.x as number;
      if (action.y !== undefined) clone.y = action.y as number;
      return { after: { id: clone.id, name: clone.name, parentId: clone.parent?.id, x: clone.x, y: clone.y }, newNodeId: clone.id };
    }

    case "set_layout_mode": {
      const node = await findSceneNode(action.nodeId as string);
      if (!("layoutMode" in node)) throw new Error(`Node ${action.nodeId} does not support layout mode`);
      const frame = node as FrameNode;
      if (action.layoutWrap && action.mode !== "HORIZONTAL") throw new Error("layoutWrap requires HORIZONTAL auto layout");
      const before = { layoutMode: frame.layoutMode };
      frame.layoutMode = action.mode as "HORIZONTAL" | "VERTICAL" | "NONE";
      markDocumentWrite();
      if (action.primaryAxisSizingMode) {
        frame.primaryAxisSizingMode = action.primaryAxisSizingMode as "FIXED" | "AUTO";
        markDocumentWrite();
      }
      if (action.counterAxisSizingMode) {
        frame.counterAxisSizingMode = action.counterAxisSizingMode as "FIXED" | "AUTO";
        markDocumentWrite();
      }
      if (action.layoutWrap) {
        frame.layoutWrap = action.layoutWrap as "NO_WRAP" | "WRAP";
        markDocumentWrite();
      }
      return { before, after: { layoutMode: frame.layoutMode, layoutWrap: frame.layoutWrap } };
    }

    case "set_layout_positioning": {
      const node = await findSceneNode(action.nodeId as string) as FrameNode;
      const before = { layoutPositioning: node.layoutPositioning };
      node.layoutPositioning = action.positioning as "AUTO" | "ABSOLUTE";
      markDocumentWrite();
      return { before, after: { layoutPositioning: node.layoutPositioning } };
    }

    case "set_alignment": {
      const node = await findSceneNode(action.nodeId as string);
      if (!("layoutMode" in node)) throw new Error(`Node ${action.nodeId} does not support alignment`);
      const frame = node as FrameNode;
      if (frame.layoutMode === "NONE") throw new Error("Alignment requires auto layout");
      if (action.counterAxisAlignItems === "BASELINE" && frame.layoutMode !== "HORIZONTAL") {
        throw new Error("BASELINE alignment requires HORIZONTAL auto layout");
      }
      const before = {
        primaryAxisAlignItems: frame.primaryAxisAlignItems,
        counterAxisAlignItems: frame.counterAxisAlignItems,
      };
      if (action.primaryAxisAlignItems) {
        frame.primaryAxisAlignItems = action.primaryAxisAlignItems as "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
        markDocumentWrite();
      }
      if (action.counterAxisAlignItems) {
        frame.counterAxisAlignItems = action.counterAxisAlignItems as "MIN" | "CENTER" | "MAX" | "BASELINE";
        markDocumentWrite();
      }
      return { before, after: { primaryAxisAlignItems: frame.primaryAxisAlignItems, counterAxisAlignItems: frame.counterAxisAlignItems } };
    }

    case "set_spacing": {
      const node = await findSceneNode(action.nodeId as string);
      if (!("layoutMode" in node)) throw new Error(`Node ${action.nodeId} does not support spacing`);
      const frame = node as FrameNode;
      if (frame.layoutMode === "NONE") throw new Error("Spacing requires auto layout");
      if (action.counterAxisSpacing !== undefined && frame.layoutWrap !== "WRAP") {
        throw new Error("counterAxisSpacing requires wrapping auto layout");
      }
      const before = {
        itemSpacing: frame.itemSpacing,
        paddingTop: frame.paddingTop, paddingRight: frame.paddingRight,
        paddingBottom: frame.paddingBottom, paddingLeft: frame.paddingLeft,
      };
      if (action.itemSpacing !== undefined) {
        frame.itemSpacing = action.itemSpacing as number;
        markDocumentWrite();
      }
      if (action.paddingTop !== undefined) {
        frame.paddingTop = action.paddingTop as number;
        markDocumentWrite();
      }
      if (action.paddingRight !== undefined) {
        frame.paddingRight = action.paddingRight as number;
        markDocumentWrite();
      }
      if (action.paddingBottom !== undefined) {
        frame.paddingBottom = action.paddingBottom as number;
        markDocumentWrite();
      }
      if (action.paddingLeft !== undefined) {
        frame.paddingLeft = action.paddingLeft as number;
        markDocumentWrite();
      }
      if (action.counterAxisSpacing !== undefined) {
        frame.counterAxisSpacing = action.counterAxisSpacing as number | null;
        markDocumentWrite();
      }
      return { before, after: { itemSpacing: frame.itemSpacing, paddingTop: frame.paddingTop, paddingRight: frame.paddingRight, paddingBottom: frame.paddingBottom, paddingLeft: frame.paddingLeft, counterAxisSpacing: frame.counterAxisSpacing } };
    }

    case "set_fills": {
      const node = await findSceneNode(action.nodeId as string) as GeometryMixin & SceneNode;
      const before = { fills: safeSerialize(node.fills) };
      node.fills = sanitizePaints(action.fills as unknown[]);
      markDocumentWrite();
      return { before, after: { fills: safeSerialize(node.fills) } };
    }

    case "set_strokes": {
      const node = await findSceneNode(action.nodeId as string) as GeometryMixin & SceneNode;
      const before = { strokes: safeSerialize(node.strokes), strokeWeight: safeSerialize((node as FrameNode).strokeWeight) };
      node.strokes = sanitizePaints(action.strokes as unknown[]);
      markDocumentWrite();
      if (action.strokeWeight !== undefined) {
        (node as FrameNode).strokeWeight = action.strokeWeight as number;
        markDocumentWrite();
      }
      return { before, after: { strokes: safeSerialize(node.strokes) } };
    }

    case "set_effects": {
      const node = await findSceneNode(action.nodeId as string) as BlendMixin & SceneNode;
      const before = { effects: safeSerialize(node.effects) };
      node.effects = action.effects as Effect[];
      markDocumentWrite();
      return { before, after: { effects: safeSerialize(node.effects) } };
    }

    case "set_corner_radius": {
      const node = await findSceneNode(action.nodeId as string) as FrameNode;
      const before = { cornerRadius: safeSerialize(node.cornerRadius) };
      if (action.radius !== undefined) {
        node.cornerRadius = action.radius as number;
        markDocumentWrite();
      }
      if (action.radii) {
        const [tl, tr, br, bl] = action.radii as [number, number, number, number];
        node.topLeftRadius = tl;
        markDocumentWrite();
        node.topRightRadius = tr;
        markDocumentWrite();
        node.bottomRightRadius = br;
        markDocumentWrite();
        node.bottomLeftRadius = bl;
        markDocumentWrite();
      }
      return { before, after: { cornerRadius: safeSerialize(node.cornerRadius), radii: [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius] } };
    }

    case "set_visible": {
      const node = await findSceneNode(action.nodeId as string);
      const before = { visible: node.visible };
      node.visible = action.visible as boolean;
      markDocumentWrite();
      return { before, after: { visible: node.visible } };
    }

    case "set_opacity": {
      const node = await findSceneNode(action.nodeId as string) as BlendMixin & SceneNode;
      const before = { opacity: node.opacity };
      node.opacity = action.opacity as number;
      markDocumentWrite();
      return { before, after: { opacity: node.opacity } };
    }

    case "set_text_content": {
      const node = await findSceneNode(action.nodeId as string) as TextNode;
      await ensureTextNodeFonts(node);
      const before = { characters: node.characters };
      node.characters = action.characters as string;
      markDocumentWrite();
      return { before, after: { characters: node.characters } };
    }

    case "set_text_style": {
      const node = await findSceneNode(action.nodeId as string) as TextNode;
      const currentFont = node.fontName;
      const before = { fontSize: node.fontSize, fontName: typeof currentFont === "symbol" ? "mixed" : currentFont };
      const hasFontOverride = Boolean(action.fontFamily) || action.fontWeight !== undefined;
      if (hasFontOverride) {
        const currentFamily = typeof currentFont === "symbol" ? "Inter" : currentFont.family;
        const currentStyle = typeof currentFont === "symbol" ? "Regular" : currentFont.style;
        const family = (action.fontFamily as string) || currentFamily;
        const weight = action.fontWeight as number | undefined;
        const style = weight !== undefined ? weightToFontStyle(weight) : currentStyle;
        await ensureFonts([{ family, style }]);
        node.fontName = { family, style };
        markDocumentWrite();
      } else {
        await ensureTextNodeFonts(node);
      }
      if (action.fontSize !== undefined) {
        node.fontSize = action.fontSize as number;
        markDocumentWrite();
      }
      if (action.lineHeight !== undefined) {
        node.lineHeight = { value: action.lineHeight as number, unit: "PIXELS" };
        markDocumentWrite();
      }
      if (action.letterSpacing !== undefined) {
        node.letterSpacing = { value: action.letterSpacing as number, unit: "PIXELS" };
        markDocumentWrite();
      }
      return { before, after: { fontSize: node.fontSize, fontName: node.fontName } };
    }

    case "create_component_from_node": {
      const node = await findSceneNode(action.nodeId as string);
      if (!node.parent) throw new Error(`Node ${action.nodeId} has no parent`);
      requireContainer(node.parent, `${action.nodeId} parent`);
      const comp = figma.createComponentFromNode(node);
      markDocumentWrite();
      comp.name = action.name as string;
      return { after: { id: comp.id, name: comp.name }, newNodeId: comp.id };
    }

    case "create_component_set": {
      const ids = (action.componentIds as string[]).map(resolveId);
      const comps = await Promise.all(ids.map(async id => {
        const node = await figma.getNodeByIdAsync(id);
        if (!node || node.type !== "COMPONENT") throw new Error(`Node ${id} is not a component`);
        return node as ComponentNode;
      }));
      const parent = comps[0].parent;
      if (!parent) throw new Error("Component has no valid parent for variant set");
      const container = requireContainer(parent, comps[0].id);
      if (comps.some((component) => component.parent?.id !== parent.id)) {
        throw new Error("All components must share a parent for variant set");
      }
      const set = figma.combineAsVariants(comps, container as FrameNode);
      markDocumentWrite();
      set.name = action.name as string;
      return { after: { id: set.id, name: set.name }, newNodeId: set.id };
    }

    case "create_instance": {
      const componentNode = await findNode(action.componentId as string);
      if (componentNode.type !== "COMPONENT") throw new Error(`Node ${action.componentId} is not a component`);
      const comp = componentNode as ComponentNode;
      const parent = requireContainer(await findNode(action.parentId as string), action.parentId as string);
      const instance = comp.createInstance();
      markDocumentWrite();
      parent.appendChild(instance);
      if (action.x !== undefined) { instance.x = action.x as number; markDocumentWrite(); }
      if (action.y !== undefined) { instance.y = action.y as number; markDocumentWrite(); }
      return { after: { id: instance.id }, newNodeId: instance.id };
    }

    case "swap_instance": {
      const instNode = await findSceneNode(action.instanceId as string);
      if (instNode.type !== "INSTANCE") throw new Error(`Node ${action.instanceId} is not an instance`);
      const instance = instNode as InstanceNode;
      const compNode = await findNode(action.newComponentId as string);
      if (compNode.type !== "COMPONENT") throw new Error(`Node ${action.newComponentId} is not a component`);
      const newComp = compNode as ComponentNode;
      instance.swapComponent(newComp);
      markDocumentWrite();
      return { after: { componentId: newComp.id } };
    }

    case "set_component_properties": {
      const node = await requireAttachedInstance(action.nodeId as string);
      const props = action.properties as Record<string, string | boolean>;
      const main = typeof node.getMainComponentAsync === "function" ? await node.getMainComponentAsync() : null;
      const resolved = main
        ? Object.fromEntries(Object.entries(props).map(([key, value]) => {
          const resolvedKey = resolveComponentPropertyKey(main.componentPropertyDefinitions, key);
          const resolvedValue = main.componentPropertyDefinitions[resolvedKey].type === "INSTANCE_SWAP"
            && typeof value === "string" && value.startsWith("$") ? resolveId(value) : value;
          return [resolvedKey, resolvedValue];
        }))
        : props;
      for (const [key, value] of Object.entries(resolved)) {
        node.setProperties({ [key]: value as string | boolean });
        markDocumentWrite();
      }
      return { after: { properties: resolved } };
    }

    case "create_paint_style": {
      const style = figma.createPaintStyle();
      markDocumentWrite();
      style.name = action.name as string;
      style.paints = sanitizePaints((action.paints as unknown[]) || []);
      return { after: { id: style.id, name: style.name }, newNodeId: style.id };
    }

    case "create_text_style": {
      const family = action.fontFamily as string;
      const weight = (action.fontWeight as number) || 400;
      const fontStyle = weightToFontStyle(weight);
      await ensureFonts([{ family, style: fontStyle }]);
      const style = figma.createTextStyle();
      markDocumentWrite();
      style.name = action.name as string;
      style.fontName = { family, style: fontStyle };
      style.fontSize = action.fontSize as number;
      if (action.lineHeight !== undefined) style.lineHeight = { value: action.lineHeight as number, unit: "PIXELS" };
      if (action.letterSpacing !== undefined) style.letterSpacing = { value: action.letterSpacing as number, unit: "PIXELS" };
      return { after: { id: style.id, name: style.name }, newNodeId: style.id };
    }

    case "create_effect_style": {
      const style = figma.createEffectStyle();
      markDocumentWrite();
      style.name = action.name as string;
      style.effects = action.effects as Effect[];
      return { after: { id: style.id, name: style.name }, newNodeId: style.id };
    }

    case "export_node": {
      const node = await findSceneNode(action.nodeId as string);
      const format = (action.format as string) || "PNG";
      const scale = (action.scale as number) || 2;
      const bytes = await node.exportAsync({
        format: format as "PNG" | "SVG" | "PDF" | "JPG",
        ...(format !== "SVG" ? { constraint: { type: "SCALE", value: scale } } : {}),
      });
      const base64 = figma.base64Encode(bytes);
      return { after: { format, size: bytes.byteLength, base64 } };
    }

    // ─── Responsive Layout ────────────────────────────────────────

    case "set_child_layout_sizing": {
      const node = await findSceneNode(action.nodeId as string);
      const before: Record<string, unknown> = {};
      if ("layoutSizingHorizontal" in node) before.layoutSizingHorizontal = (node as FrameNode).layoutSizingHorizontal;
      if ("layoutSizingVertical" in node) before.layoutSizingVertical = (node as FrameNode).layoutSizingVertical;
      if (action.layoutSizingHorizontal) {
        (node as FrameNode).layoutSizingHorizontal = action.layoutSizingHorizontal as "FILL" | "HUG" | "FIXED";
        markDocumentWrite();
      }
      if (action.layoutSizingVertical) {
        (node as FrameNode).layoutSizingVertical = action.layoutSizingVertical as "FILL" | "HUG" | "FIXED";
        markDocumentWrite();
      }
      return { before, after: { layoutSizingHorizontal: (node as FrameNode).layoutSizingHorizontal, layoutSizingVertical: (node as FrameNode).layoutSizingVertical } };
    }

    case "set_constraints": {
      const node = await findSceneNode(action.nodeId as string);
      if (!("constraints" in node)) throw new Error(`Node ${action.nodeId} does not support constraints`);
      const before = { constraints: (node as FrameNode).constraints };
      if (action.horizontal) {
        (node as FrameNode).constraints = { ...(node as FrameNode).constraints, horizontal: action.horizontal as ConstraintType };
        markDocumentWrite();
      }
      if (action.vertical) {
        (node as FrameNode).constraints = { ...(node as FrameNode).constraints, vertical: action.vertical as ConstraintType };
        markDocumentWrite();
      }
      return { before, after: { constraints: (node as FrameNode).constraints } };
    }

    case "set_min_max_size": {
      const node = await findSceneNode(action.nodeId as string);
      const before: Record<string, unknown> = {};
      if ("minWidth" in node) before.minWidth = (node as FrameNode).minWidth;
      if ("maxWidth" in node) before.maxWidth = (node as FrameNode).maxWidth;
      if (action.minWidth !== undefined) {
        (node as FrameNode).minWidth = action.minWidth as number;
        markDocumentWrite();
      }
      if (action.maxWidth !== undefined) {
        (node as FrameNode).maxWidth = action.maxWidth as number;
        markDocumentWrite();
      }
      if (action.minHeight !== undefined) {
        (node as FrameNode).minHeight = action.minHeight as number;
        markDocumentWrite();
      }
      if (action.maxHeight !== undefined) {
        (node as FrameNode).maxHeight = action.maxHeight as number;
        markDocumentWrite();
      }
      return { before, after: { minWidth: (node as FrameNode).minWidth, maxWidth: (node as FrameNode).maxWidth, minHeight: (node as FrameNode).minHeight, maxHeight: (node as FrameNode).maxHeight } };
    }

    // ─── Page Management ──────────────────────────────────────────

    case "create_page": {
      const page = figma.createPage();
      markDocumentWrite();
      page.name = action.name as string;
      return { after: { id: page.id, name: page.name }, newNodeId: page.id };
    }

    case "switch_page": {
      const pageNode = await findNode(action.pageId as string);
      if (!pageNode || pageNode.type !== "PAGE") throw new Error(`Node ${action.pageId} is not a page`);
      await figma.setCurrentPageAsync(pageNode as PageNode);
      return { after: { pageId: pageNode.id, pageName: pageNode.name } };
    }

    // ─── Rich Content ─────────────────────────────────────────────

    case "set_gradient_fill": {
      const node = await findSceneNode(action.nodeId as string) as GeometryMixin & SceneNode;
      if (!("fills" in node)) throw new Error(`Node ${action.nodeId} does not support fills`);
      const before = { fills: safeSerialize(node.fills) };
      node.fills = gradientPaints(action);
      markDocumentWrite();
      return { before, after: { fills: safeSerialize(node.fills) } };
    }

    case "set_image_fill": {
      const node = await findSceneNode(action.nodeId as string) as GeometryMixin & SceneNode;
      if (!("fills" in node)) throw new Error(`Node ${action.nodeId} does not support fills`);
      const before = { fills: safeSerialize(node.fills) };
      const base64 = action.imageBase64 as string;
      const image = figma.createImage(figma.base64Decode(base64));
      const fill: ImagePaint = {
        type: "IMAGE",
        imageHash: image.hash,
        scaleMode: (action.scaleMode as "FILL" | "FIT" | "CROP" | "TILE") || "FILL",
      };
      node.fills = [fill];
      markDocumentWrite();
      return { before, after: { imageHash: image.hash } };
    }

    case "create_from_svg": {
      const parent = requireContainer(await findNode(action.parentId as string), action.parentId as string);
      const node = figma.createNodeFromSvg(action.svg as string);
      markDocumentWrite();
      if (action.name) node.name = action.name as string;
      parent.appendChild(node);
      node.x = action.x as number;
      node.y = action.y as number;
      return { after: { id: node.id, name: node.name, x: node.x, y: node.y }, newNodeId: node.id };
    }

    case "create_section": {
      if (figma.editorType !== "figma") throw new Error("Sections are only supported in Figma Design");
      if ((action.width as number) < 0.01 || (action.height as number) < 0.01) throw new Error("Section dimensions must be at least 0.01");
      const parent = await findNode(action.parentId as string);
      if (parent.type !== "PAGE") throw new Error("Sections must be created on a page");
      const section = figma.createSection();
      markDocumentWrite();
      section.name = action.name as string;
      section.resize(action.width as number, action.height as number);
      parent.appendChild(section);
      section.x = action.x as number;
      section.y = action.y as number;
      return { after: { id: section.id, name: section.name, width: section.width, height: section.height }, newNodeId: section.id };
    }

    case "resize_section": {
      if (figma.editorType !== "figma") throw new Error("Sections are only supported in Figma Design");
      if ((action.width as number) < 0.01 || (action.height as number) < 0.01) throw new Error("Section dimensions must be at least 0.01");
      const node = await findNode(action.sectionId as string);
      if (node.type !== "SECTION") throw new Error(`Node ${action.sectionId} is not a section`);
      const before = { width: node.width, height: node.height };
      node.resize(action.width as number, action.height as number);
      markDocumentWrite();
      return { before, after: { width: node.width, height: node.height } };
    }

    case "move_to_section": {
      if (figma.editorType !== "figma") throw new Error("Sections are only supported in Figma Design");
      const node = await findSceneNode(action.nodeId as string);
      const section = await findNode(action.sectionId as string);
      if (section.type !== "SECTION") throw new Error(`Node ${action.sectionId} is not a section`);
      if (["SECTION", "PAGE", "DOCUMENT"].includes(node.type as string)) {
        throw new Error(`${node.type} nodes cannot be moved into sections`);
      }
      if (action.insertIndex !== undefined && (action.insertIndex as number) > section.children.length) {
        throw new Error(`insertIndex ${String(action.insertIndex)} exceeds section child count ${section.children.length}`);
      }
      let ancestor: BaseNode | null = section;
      while (ancestor && "parent" in ancestor) {
        if (ancestor.id === node.id) throw new Error("Cannot move a node into its own descendant");
        ancestor = ancestor.parent;
      }
      const before = { parentId: node.parent?.id };
      if (action.insertIndex !== undefined) section.insertChild(action.insertIndex as number, node);
      else section.appendChild(node);
      markDocumentWrite();
      return { before, after: { parentId: section.id } };
    }

    case "set_reaction": {
      if (figma.editorType !== "figma") throw new Error("Prototype reactions are only supported in Figma Design");
      const node = await findSceneNode(action.nodeId as string);
      const destination = await findSceneNode(action.destinationId as string);
      if (!("setReactionsAsync" in node)) throw new Error(`Node ${action.nodeId} does not support reactions`);
      const reaction: Reaction = {
        trigger: { type: "ON_CLICK" },
        actions: [{ type: "NODE", destinationId: destination.id, navigation: action.navigation as Navigation, transition: null }],
      };
      const previous = [...(node as SceneNode & ReactionMixin).reactions];
      const next = action.mode === "append" ? [...previous, reaction] : [reaction];
      await (node as SceneNode & ReactionMixin).setReactionsAsync(next);
      markDocumentWrite();
      return { before: { reactionCount: previous.length }, after: { reactionCount: next.length } };
    }

    // ─── Text Enhancement ─────────────────────────────────────────

    case "set_text_properties": {
      const node = await findSceneNode(action.nodeId as string) as TextNode;
      const before: Record<string, unknown> = {};
      if (action.textAlignHorizontal) {
        before.textAlignHorizontal = node.textAlignHorizontal;
        node.textAlignHorizontal = action.textAlignHorizontal as "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
        markDocumentWrite();
      }
      if (action.textAlignVertical) {
        before.textAlignVertical = node.textAlignVertical;
        node.textAlignVertical = action.textAlignVertical as "TOP" | "CENTER" | "BOTTOM";
        markDocumentWrite();
      }
      if (action.paragraphSpacing !== undefined) {
        before.paragraphSpacing = node.paragraphSpacing;
        node.paragraphSpacing = action.paragraphSpacing as number;
        markDocumentWrite();
      }
      if (action.textCase) {
        node.textCase = action.textCase as TextCase;
        markDocumentWrite();
      }
      if (action.textDecoration) {
        node.textDecoration = action.textDecoration as TextDecoration;
        markDocumentWrite();
      }
      if (action.textAutoResize) {
        before.textAutoResize = node.textAutoResize;
        node.textAutoResize = action.textAutoResize as "NONE" | "WIDTH_AND_HEIGHT" | "HEIGHT" | "TRUNCATE";
        markDocumentWrite();
      }
      return { before, after: {
        textAlignHorizontal: node.textAlignHorizontal,
        textAlignVertical: node.textAlignVertical,
        paragraphSpacing: node.paragraphSpacing,
        textAutoResize: node.textAutoResize,
      } };
    }

    // ─── Style Binding ────────────────────────────────────────────

    case "apply_style": {
      const node = await findSceneNode(action.nodeId as string);
      const property = action.property as string;
      const expectedType = property === "text" ? "TEXT" : property === "effect" ? "EFFECT" : "PAINT";
      const style = await resolveStyle(expectedType, action.styleId, action.styleName);
      const styleId = style.id;
      if (property === "text") await ensureFonts([(style as TextStyle).fontName]);
      // Figma's dynamic-page document access disallows the sync setters
      // (`node.fillStyleId = x`); the async variants are required.
      if (property === "fill" && "setFillStyleIdAsync" in node) {
        await (node as unknown as { setFillStyleIdAsync: (id: string) => Promise<void> }).setFillStyleIdAsync(styleId);
      } else if (property === "stroke" && "setStrokeStyleIdAsync" in node) {
        await (node as unknown as { setStrokeStyleIdAsync: (id: string) => Promise<void> }).setStrokeStyleIdAsync(styleId);
      } else if (property === "text" && node.type === "TEXT" && "setTextStyleIdAsync" in node) {
        await (node as unknown as { setTextStyleIdAsync: (id: string) => Promise<void> }).setTextStyleIdAsync(styleId);
      } else if (property === "effect" && "setEffectStyleIdAsync" in node) {
        await (node as unknown as { setEffectStyleIdAsync: (id: string) => Promise<void> }).setEffectStyleIdAsync(styleId);
      } else {
        throw new Error(`Cannot apply ${property} style to node type ${node.type}`);
      }
      markDocumentWrite();
      return { after: { styleId, property } };
    }

    case "update_style": {
      const styleType = action.styleType as "PAINT" | "TEXT" | "EFFECT";
      const style = await resolveStyle(styleType, action.styleId, action.styleName);
      const source = action.copyFromStyleId || action.copyFromStyleName
        ? await resolveStyle(styleType, action.copyFromStyleId, action.copyFromStyleName)
        : null;
      const paintFields = action.paints !== undefined;
      const effectFields = action.effects !== undefined;
      const textFields = ["fontFamily", "fontWeight", "fontSize", "lineHeight", "letterSpacing"].some((field) => action[field] !== undefined);
      if ((paintFields && styleType !== "PAINT") || (effectFields && styleType !== "EFFECT") || (textFields && styleType !== "TEXT")) {
        throw new Error(`Update fields do not match ${styleType} style type`);
      }
      if (!source && action.name === undefined && !paintFields && !effectFields && !textFields) throw new Error("update_style has no updates");

      let textValues: { fontName: FontName; fontSize?: number; lineHeight?: LineHeight; letterSpacing?: LetterSpacing } | null = null;
      if (styleType === "TEXT") {
        const target = style as TextStyle;
        const sourceText = source as TextStyle | null;
        const current = sourceText ?? target;
        const family = (action.fontFamily as string | undefined) ?? current.fontName.family;
        const fontStyle = action.fontWeight !== undefined ? weightToFontStyle(action.fontWeight as number) : current.fontName.style;
        await ensureFonts([{ family, style: fontStyle }]);
        textValues = {
          fontName: { family, style: fontStyle },
          fontSize: (action.fontSize as number | undefined) ?? (sourceText ? sourceText.fontSize : undefined),
          lineHeight: action.lineHeight !== undefined ? { value: action.lineHeight as number, unit: "PIXELS" } : sourceText?.lineHeight,
          letterSpacing: action.letterSpacing !== undefined ? { value: action.letterSpacing as number, unit: "PIXELS" } : sourceText?.letterSpacing,
        };
      }
      const before = { name: style.name };
      markDocumentWrite();
      if (action.name !== undefined) style.name = action.name as string;
      if (styleType === "PAINT" && (action.paints !== undefined || source)) {
        (style as PaintStyle).paints = sanitizePaints((action.paints as unknown[] | undefined) ?? [...(source as PaintStyle).paints]);
      }
      if (styleType === "EFFECT" && (action.effects !== undefined || source)) {
        (style as EffectStyle).effects = (action.effects as Effect[] | undefined) ?? [...(source as EffectStyle).effects];
      }
      if (textValues) {
        const target = style as TextStyle;
        const sourceText = source as TextStyle | null;
        if (sourceText) {
          target.textDecoration = sourceText.textDecoration;
          target.leadingTrim = sourceText.leadingTrim;
          target.paragraphIndent = sourceText.paragraphIndent;
          target.paragraphSpacing = sourceText.paragraphSpacing;
          target.listSpacing = sourceText.listSpacing;
          target.hangingPunctuation = sourceText.hangingPunctuation;
          target.hangingList = sourceText.hangingList;
          target.textCase = sourceText.textCase;
        }
        target.fontName = textValues.fontName;
        if (textValues.fontSize !== undefined) target.fontSize = textValues.fontSize;
        if (textValues.lineHeight !== undefined) target.lineHeight = textValues.lineHeight;
        if (textValues.letterSpacing !== undefined) target.letterSpacing = textValues.letterSpacing;
      }
      return { before, after: { id: style.id, name: style.name, type: style.type } };
    }

    case "set_description": {
      const node = await findNode(action.nodeId as string);
      if (!("description" in node)) throw new Error(`Node ${action.nodeId} does not support descriptions`);
      const before = { description: (node as ComponentNode).description };
      (node as ComponentNode).description = action.description as string;
      markDocumentWrite();
      return { before, after: { description: (node as ComponentNode).description } };
    }

    // ─── Component Property Definition ────────────────────────────

    case "define_component_property": {
      const node = await findNode(action.nodeId as string);
      if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") {
        throw new Error(`Node ${action.nodeId} is not a component or component set`);
      }
      if (action.propertyType === "VARIANT" && node.type !== "COMPONENT_SET") {
        throw new Error("VARIANT properties require a component set");
      }
      const comp = node as ComponentNode | ComponentSetNode;
      comp.addComponentProperty(
        action.propertyName as string,
        action.propertyType as ComponentPropertyType,
        action.propertyType === "INSTANCE_SWAP" && typeof action.defaultValue === "string"
          ? resolveId(action.defaultValue)
          : action.defaultValue as string | boolean
      );
      markDocumentWrite();
      return { after: { propertyName: action.propertyName, propertyType: action.propertyType } };
    }

    case "set_component_property_reference": {
      const node = await findSceneNode(action.nodeId as string);
      let owner: BaseNode | null = node.parent;
      while (owner && owner.type !== "COMPONENT" && owner.type !== "COMPONENT_SET") owner = "parent" in owner ? owner.parent : null;
      if (!owner || (owner.type !== "COMPONENT" && owner.type !== "COMPONENT_SET")) {
        throw new Error(`Node ${action.nodeId} is not inside a component or component set`);
      }
      const key = resolveComponentPropertyKey(owner.componentPropertyDefinitions, action.componentPropertyName as string);
      const property = action.property as "characters" | "visible" | "mainComponent";
      const expected = property === "characters" ? "TEXT" : property === "visible" ? "BOOLEAN" : "INSTANCE_SWAP";
      if (owner.componentPropertyDefinitions[key].type !== expected) throw new Error(`${property} requires a ${expected} component property`);
      if (property === "characters" && node.type !== "TEXT") throw new Error("characters references require a text node");
      if (property === "mainComponent" && node.type !== "INSTANCE") throw new Error("mainComponent references require an instance node");
      const before = safeSerialize(node.componentPropertyReferences);
      node.componentPropertyReferences = { ...(node.componentPropertyReferences ?? {}), [property]: key };
      markDocumentWrite();
      return { before: { componentPropertyReferences: before }, after: { componentPropertyReferences: safeSerialize(node.componentPropertyReferences) } };
    }

    case "set_instance_text": {
      const child = await findInstanceChild(action.instanceId as string, action.childPath as string[]);
      if (child.type !== "TEXT") throw new Error("childPath does not resolve to a text node");
      await ensureTextNodeFonts(child);
      const before = { characters: child.characters };
      child.characters = action.characters as string;
      markDocumentWrite();
      return { before, after: { nodeId: child.id, characters: child.characters } };
    }

    case "set_instance_visibility": {
      const child = await findInstanceChild(action.instanceId as string, action.childPath as string[]);
      const before = { visible: child.visible };
      child.visible = action.visible as boolean;
      markDocumentWrite();
      return { before, after: { nodeId: child.id, visible: child.visible } };
    }

    case "swap_nested_instance": {
      const child = await findInstanceChild(action.instanceId as string, action.childPath as string[]);
      if (child.type !== "INSTANCE") throw new Error("childPath does not resolve to an instance node");
      const component = await findNode(action.newComponentId as string);
      if (component.type !== "COMPONENT") throw new Error(`Node ${action.newComponentId} is not a component`);
      child.swapComponent(component);
      markDocumentWrite();
      return { after: { nodeId: child.id, componentId: component.id } };
    }

    // ─── Figma Variables ──────────────────────────────────────────

    case "create_variable_collection": {
      const collection = figma.variables.createVariableCollection(action.name as string);
      markDocumentWrite();
      const modes = (action.modes as string[]) || ["Default"];
      // Rename the default mode
      if (modes[0]) collection.renameMode(collection.modes[0].modeId, modes[0]);
      // Add additional modes
      for (let i = 1; i < modes.length; i++) {
        collection.addMode(modes[i]);
      }
      return { after: { id: collection.id, name: collection.name, modes: collection.modes }, newNodeId: collection.id };
    }

    case "create_variable": {
      const collectionId = resolveId(action.collectionId as string);
      const collection = typeof figma.variables.getVariableCollectionByIdAsync === "function"
        ? await figma.variables.getVariableCollectionByIdAsync(collectionId)
        : figma.variables.getVariableCollectionById(collectionId);
      if (!collection) throw new Error(`Variable collection not found: ${collectionId}`);
      const value = parseVariableValue(action.resolvedType as VariableResolvedDataType, action.value);
      const variable = figma.variables.createVariable(
        action.name as string,
        collection,
        action.resolvedType as VariableResolvedDataType
      );
      markDocumentWrite();
      // Set scopes if provided
      if (action.scopes) variable.scopes = action.scopes as VariableScope[];
      // Set value for each mode
      for (const mode of collection.modes) variable.setValueForMode(mode.modeId, value);
      return { after: { id: variable.id, name: variable.name }, newNodeId: variable.id };
    }

    case "bind_variable": {
      const node = await findSceneNode(action.nodeId as string);
      const variable = await resolveVariable(action);
      const property = action.property as string;
      const paintIndex = (action.paintIndex as number) || 0;

      if (property === "fills" || property === "strokes") {
        if (variable.resolvedType !== "COLOR") throw new Error(`${property} bindings require a COLOR variable`);
        const paintsProp = property as "fills" | "strokes";
        const paints = [...((node as GeometryMixin)[paintsProp] as Paint[])];
        const paint = paints[paintIndex];
        if (!paint) throw new Error(`Paint index ${paintIndex} does not exist in ${property}`);
        if (paint.type !== "SOLID") throw new Error(`Paint index ${paintIndex} in ${property} is not a solid paint`);
        paints[paintIndex] = figma.variables.setBoundVariableForPaint(paint, "color", variable);
        (node as GeometryMixin)[paintsProp] = paints;
        markDocumentWrite();
      } else {
        // Numeric properties: spacing, radius, opacity, size
        if (variable.resolvedType !== "FLOAT") throw new Error(`${property} bindings require a FLOAT variable`);
        if (!(property in node) || typeof node.setBoundVariable !== "function") throw new Error(`Node ${node.id} does not support ${property} variable binding`);
        if (property === "counterAxisSpacing" && (!("layoutWrap" in node) || (node as FrameNode).layoutWrap !== "WRAP")) {
          throw new Error("counterAxisSpacing bindings require wrapping auto layout");
        }
        (node as SceneNode).setBoundVariable(property as VariableBindableNodeField, variable);
        markDocumentWrite();
      }
      return { after: { variableId: variable.id, property } };
    }

    case "set_variable_value": {
      const variable = await resolveVariable(action);
      const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
      if (!collection) throw new Error(`Variable collection not found: ${variable.variableCollectionId}`);
      const modeMatches = action.modeId
        ? collection.modes.filter((mode) => mode.modeId === action.modeId)
        : collection.modes.filter((mode) => mode.name === action.modeName);
      if (modeMatches.length === 0) throw new Error(`Variable mode not found: ${String(action.modeId ?? action.modeName)}`);
      if (modeMatches.length > 1) throw new Error(`Variable mode name is ambiguous: ${String(action.modeName)}`);
      const value = parseVariableValue(variable.resolvedType, action.value);
      variable.setValueForMode(modeMatches[0].modeId, value);
      markDocumentWrite();
      return { after: { variableId: variable.id, modeId: modeMatches[0].modeId, value: safeSerialize(value) } };
    }

    default:
      throw new Error(`Unknown action type: ${type}`);
  }
}

// ─── Batch Processor ────────────────────────────────────────────

interface Batch {
  batchId: string;
  dryRun: boolean;
  stopOnError: boolean;
  rollbackOnError: boolean;
  requiredFonts: Array<{ family: string; style?: string }>;
  actions: Array<Record<string, unknown>>;
}

interface BatchResult {
  batchId: string;
  dryRun: boolean;
  success: boolean;
  results: ActionResult[];
  nodeIdMap: Record<string, string>;
  summary: { total: number; applied: number; failed: number; skipped: number; mutations: number };
  rollbackApplied?: boolean;
  error?: string;
}

async function processBatch(batch: Batch): Promise<BatchResult> {
  preflightActionReferences(batch.actions);
  const references = new Map<string, string>();
  const resolveId = (id: string) => resolveBatchId(id, references);

  // Preload all required fonts
  if (batch.requiredFonts.length > 0) {
    await ensureFonts(batch.requiredFonts);
  }

  // Establish a batch-local baseline. Without this boundary triggerUndo()
  // can roll back writes from an earlier successful bridge message.
  if (!batch.dryRun && batch.rollbackOnError) figma.commitUndo();

  const results: ActionResult[] = [];
  let applied = 0;
  let documentWrites = 0;
  let failed = 0;
  let skipped = 0;
  let inspectionBytes = 0;
  let stopProcessing = false;

  for (let i = 0; i < batch.actions.length; i++) {
    // Shallow copy to avoid mutating the original batch payload
    const action = { ...batch.actions[i] };
    const actionType = action.type as string;

    if (stopProcessing) {
      results.push({ actionIndex: i, type: actionType, status: "skipped" });
      skipped++;
      continue;
    }

    if (batch.dryRun) {
      results.push({ actionIndex: i, type: actionType, status: "planned", nodeId: action.nodeId as string });
      applied++;
      continue;
    }

    let actionWroteDocument = false;
    try {
      // Resolve every ID-bearing scalar/array field before execution.
      for (const key of ["nodeId", "parentId", "targetParentId", "componentId", "instanceId", "newComponentId", "pageId", "collectionId", "variableId", "styleId", "copyFromStyleId", "sectionId", "destinationId", "textStyleId"]) {
        if (typeof action[key] === "string" && (action[key] as string).startsWith("$")) {
          action[key] = resolveId(action[key] as string);
        }
      }
      if (Array.isArray(action.componentIds)) {
        action.componentIds = (action.componentIds as string[]).map(id =>
          id.startsWith("$") ? resolveId(id) : id
        );
      }

      const result = await executeAction(action, () => {
        actionWroteDocument = true;
      }, references, MAX_PLUGIN_BATCH_INSPECTION_BYTES - inspectionBytes);
      if (result.inspection) inspectionBytes += result.inspection.responseBytes;

      // Register new node ID for symbolic ref
      if (result.newNodeId && action._ref) {
        references.set(action._ref as string, result.newNodeId);
        if (action._aliasRef) references.set(action._aliasRef as string, result.newNodeId);
      }

      results.push({
        actionIndex: i,
        type: actionType,
        status: "applied",
        nodeId: (action.nodeId as string) || result.newNodeId,
        newNodeId: result.newNodeId,
        before: result.before,
        after: result.after,
        inspection: result.inspection,
      });
      applied++;
      if (actionWroteDocument) documentWrites++;
    } catch (err) {
      if (actionWroteDocument) documentWrites++;
      const message = err instanceof Error ? err.message : String(err);
      results.push({ actionIndex: i, type: actionType, status: "failed", error: message });
      failed++;
      if (batch.stopOnError) stopProcessing = true;
    }
  }

  // Rollback: Figma coalesces rapid plugin mutations into a single undo entry,
  // so we call triggerUndo() exactly ONCE to undo the entire batch.
  let rollbackApplied = false;
  if (batch.rollbackOnError && failed > 0 && documentWrites > 0) {
    figma.triggerUndo();
    rollbackApplied = true;
    const transientNodeIds = new Set(references.values());
    for (let index = 0; index < results.length; index++) {
      const result = results[index]!;
      if (result.inspection) result.inspection = invalidateInspectionAfterRollback(result.inspection);
      if (result.status === "applied") {
        result.rolledBack = true;
        delete result.after;
        delete result.newNodeId;
        delete result.nodeId;
      }
      results[index] = redactTransientIds(result, transientNodeIds) as ActionResult;
    }
    references.clear();
  } else if (batch.rollbackOnError && documentWrites > 0) {
    // Close the successful batch as its own undo unit.
    figma.commitUndo();
  }

  return {
    batchId: batch.batchId,
    dryRun: batch.dryRun,
    success: failed === 0,
    results,
    nodeIdMap: rollbackApplied ? {} : Object.fromEntries(references),
    summary: { total: batch.actions.length, applied, failed, skipped, mutations: documentWrites },
    ...(rollbackApplied ? { rollbackApplied: true } : {}),
  };
}

// ─── Message Handler ────────────────────────────────────────────

async function respondToBatch(batch: Batch): Promise<void> {
  try {
    const result = await processBatch(batch);
    figma.ui.postMessage({ type: "send_to_bridge", data: { type: "batch_result", ...result } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    figma.ui.postMessage({
      type: "send_to_bridge",
      data: { type: "batch_result", batchId: batch.batchId, success: false, error: message, results: [], nodeIdMap: {}, summary: { total: 0, applied: 0, failed: 0, skipped: 0 } },
    });
  }
}

let batchQueueTail: Promise<void> = Promise.resolve();

function enqueueBatch(batch: Batch): Promise<void> {
  const execution = batchQueueTail.then(() => respondToBatch(batch));
  batchQueueTail = execution.then(() => undefined, () => undefined);
  return execution;
}

figma.ui.onmessage = async (msg: { type: string; data?: unknown }) => {
  if (msg.type === "bridge_connected") {
    // Clear font cache on reconnect (fonts may have changed between sessions)
    loadedFonts.clear();
    figma.ui.postMessage({
      type: "send_to_bridge",
      data: {
        type: "handshake",
        pluginVersion: "2.1.0",
        fileKey: figma.fileKey,
        pageId: figma.currentPage.id,
        pageName: figma.currentPage.name,
        documentName: figma.root.name,
      },
    });
    figma.ui.postMessage({
      type: "ui_status",
      status: "connected",
      documentName: figma.root.name,
      pageName: figma.currentPage.name,
      selectionCount: figma.currentPage.selection.length,
    });
    return;
  }

  if (msg.type === "bridge_disconnected") {
    figma.ui.postMessage({
      type: "ui_status",
      status: "disconnected",
      documentName: figma.root.name,
      pageName: figma.currentPage.name,
      selectionCount: figma.currentPage.selection.length,
    });
    return;
  }

  if (msg.type === "bridge_message") {
    const data = msg.data as Record<string, unknown>;

    if (data.type === "batch") {
      const batch = data as unknown as Batch;
      if (!batch.batchId || !Array.isArray(batch.actions)) {
        console.error("[plugin] Malformed batch payload, ignoring");
        return;
      }
      await enqueueBatch(batch);
    } else if (data.type === "read_request") {
      const request = data as unknown as PluginReadRequest;
      if (!request.requestId || !request.operation || !request.fileKey) {
        console.error("[plugin] Malformed read request, ignoring");
        return;
      }
      try {
        const result = await processReadRequest(request);
        figma.ui.postMessage({ type: "send_to_bridge", data: result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        figma.ui.postMessage({
          type: "send_to_bridge",
          data: finalizeReadResponse({
            ...readResponseBase(request),
            success: false,
            roots: [],
            matches: [],
            components: [],
            totalScanned: 0,
            returnedCount: 0,
            truncated: false,
            truncationReasons: [],
            scanLimitReached: false,
            error: message,
          }),
        });
      }
    } else if (data.type === "ping") {
      figma.ui.postMessage({
        type: "send_to_bridge",
        data: { type: "pong", fileKey: figma.fileKey, pageId: figma.currentPage.id, pageName: figma.currentPage.name },
      });
    }
  }
};

function pushUiContext(status: "idle" | "connected" | "disconnected" = "idle") {
  figma.ui.postMessage({
    type: "ui_status",
    status,
    documentName: figma.root.name,
    pageName: figma.currentPage.name,
    selectionCount: figma.currentPage.selection.length,
  });
}

figma.on("selectionchange", () => {
  pushUiContext();
});

figma.on("currentpagechange", () => {
  pushUiContext();
});

// Coalesce Figma's sometimes-bursty documentchange events before sending a
// bridge notification. The bridge invalidates all REST inspection snapshots,
// including those affected by edits made outside figma_execute.
let documentChangeTimer: ReturnType<typeof setTimeout> | null = null;
async function registerDocumentChangeListener(): Promise<void> {
  // Global documentchange listeners require every page to be loaded when the
  // manifest uses dynamic-page document access.
  await figma.loadAllPagesAsync();
  figma.on("documentchange", () => {
    if (documentChangeTimer) return;
    documentChangeTimer = setTimeout(() => {
      documentChangeTimer = null;
      figma.ui.postMessage({
        type: "send_to_bridge",
        data: { type: "document_changed" },
      });
    }, 100);
  });
}

void registerDocumentChangeListener().catch((error) => {
  console.error("[plugin] Failed to register documentchange listener", error);
});

pushUiContext();

figma.on("close", () => {});
