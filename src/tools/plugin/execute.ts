import type { BridgeServer, BatchResult } from "../../plugin/bridge.js";
import type { SnapshotCache } from "../../pipeline/snapshot.js";
import { compileBatch } from "../../plugin/batch-compiler.js";
import { preprocessActions } from "../../plugin/assets.js";
import { actionSchema, type Action } from "../../shared/actions.js";
import { assertActionInputCoverage, FORBIDDEN_DELETE_NODE_TYPES, isKnownActionType } from "../../shared/action-parity.js";
import { weightToFontStyle } from "../../shared/font.js";

interface ExecuteParams {
  actions: unknown[];
  dryRun?: boolean;
  stopOnError?: boolean;
  rollbackOnError?: boolean;
  timeoutMs?: number;
}

export interface ExecuteResult {
  pluginConnected: boolean;
  result?: BatchResult;
  fallbackJs?: string;
  fallbackLimitations?: FallbackLimitation[];
}

export interface FallbackLimitation {
  option: "rollbackOnError";
  condition: "figma.undo_api_unavailable";
  message: string;
}

/**
 * Connected writes can alter any cached ancestor or descendant, so invalidate
 * the whole inspection cache after a completed non-dry-run batch that applied
 * at least one action. Returns whether invalidation was performed.
 */
export function invalidateSnapshotsAfterExecute(
  snapshotCache: SnapshotCache,
  execution: ExecuteResult
): boolean {
  const batch = execution.result;
  if (!execution.pluginConnected || !batch || batch.dryRun || batch.summary.applied === 0) {
    return false;
  }
  snapshotCache.invalidateAll();
  return true;
}

export async function handleExecute(
  bridge: BridgeServer | null,
  params: ExecuteParams
): Promise<ExecuteResult> {
  // Validate actions
  const parsedActions: Action[] = [];
  for (let index = 0; index < params.actions.length; index++) {
    const raw = params.actions[index];
    const parsed = actionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid action ${index}: ${parsed.error.issues.map(i => i.message).join(", ")}`);
    }
    assertActionInputCoverage(parsed.data);
    parsedActions.push(parsed.data);
  }
  const validated = await preprocessActions(parsedActions);

  // Compile batch
  const batch = compileBatch(validated, {
    dryRun: params.dryRun,
    stopOnError: params.stopOnError,
    rollbackOnError: params.rollbackOnError,
  });

  // Try plugin bridge first
  if (bridge?.isConnected()) {
    const result = await bridge.execute(batch, params.timeoutMs);
    return { pluginConnected: true, result };
  }

  // Fallback: generate use_figma JavaScript
  const js = generateFallbackJs(validated, batch.actions, {
    dryRun: batch.dryRun,
    stopOnError: batch.stopOnError,
    rollbackOnError: batch.rollbackOnError,
  });
  return {
    pluginConnected: false,
    fallbackJs: js,
    ...(batch.rollbackOnError ? {
      fallbackLimitations: [{
        option: "rollbackOnError" as const,
        condition: "figma.undo_api_unavailable" as const,
        message: "Fallback rollback uses figma.commitUndo and figma.triggerUndo. The generated program aborts instead of risking a cross-batch undo when either API is unavailable.",
      }],
    } : {}),
  };
}

/** Generate Plugin API JavaScript from validated actions for use with use_figma fallback. */
function generateFallbackJs(
  actions: Action[],
  compiledActions: Array<Record<string, unknown>>,
  options: { dryRun: boolean; stopOnError: boolean; rollbackOnError: boolean }
): string {
  const lines: string[] = [];
  const fontsNeeded = new Set<string>();
  const j = JSON.stringify;

  for (const action of actions) {
    if (action.type === "create_text_style" || (action.type === "create_text" && !action.textStyleId && !action.textStyleName)) {
      const weight = action.fontWeight ?? 400;
      const style = weightToStyle(weight);
      fontsNeeded.add(`await loadFontOnce({ family: ${j(action.fontFamily ?? "Inter")}, style: ${j(style)} });`);
    }
  }

  lines.push(`const executionOptions = ${j(options)};`);
  lines.push("if (executionOptions.dryRun) {");
  lines.push("  return [");
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const nodeId = "nodeId" in action ? `, nodeId: ${j(action.nodeId)}` : "";
    lines.push(`    { actionIndex: ${i}, type: ${j(action.type)}, status: "planned"${nodeId} },`);
  }
  lines.push("  ];");
  lines.push("}");
  lines.push("");
  lines.push("if (executionOptions.rollbackOnError && (typeof figma.commitUndo !== \"function\" || typeof figma.triggerUndo !== \"function\")) {");
  lines.push("  throw new Error(\"Fallback execution environment does not support rollback isolation (figma.commitUndo and figma.triggerUndo are required).\");");
  lines.push("}");
  lines.push("");
  lines.push("const loadedFonts = new Set();");
  lines.push("const loadFontOnce = async (font) => {");
  lines.push("  const key = `${font.family}|${font.style || 'Regular'}`;");
  lines.push("  if (loadedFonts.has(key)) return;");
  lines.push("  await figma.loadFontAsync(font);");
  lines.push("  loadedFonts.add(key);");
  lines.push("};");
  lines.push("");

  if (fontsNeeded.size > 0) {
    lines.push("// Load fonts");
    for (const font of fontsNeeded) lines.push(font);
    lines.push("");
  }

  lines.push("const results = [];");
  lines.push("let failed = false;");
  lines.push("let documentWrites = 0;");
  lines.push("let stopProcessing = false;");
  lines.push("const createdNodeIds = new Map();");
  lines.push("const recordCreatedNode = (ref, result, aliasRef) => {");
  lines.push("  createdNodeIds.set(ref, result.nodeId);");
  lines.push("  if (aliasRef) createdNodeIds.set(aliasRef, result.nodeId);");
  lines.push("  results.push(result);");
  lines.push("};");
  lines.push("const markDocumentWrite = () => { documentWrites++; };");
  lines.push("const resolveRefId = (id) => {");
  lines.push("  if (typeof id !== \"string\") return id;");
  lines.push("  if (!id.startsWith(\"$\")) return id;");
  lines.push("  const resolved = createdNodeIds.get(id);");
  lines.push("  if (!resolved) throw new Error(`Unable to resolve ${id}. Ensure referenced action ran first.`);");
  lines.push("  return resolved;");
  lines.push("};");
  lines.push("const getNode = (id) => figma.getNodeById(resolveRefId(id));");
  lines.push("const requireNode = (id) => {");
  lines.push("  const node = getNode(id);");
  lines.push("  if (!node) throw new Error(`Node not found: ${resolveRefId(id)}`);");
  lines.push("  return node;");
  lines.push("};");
  lines.push("const requireContainer = (id) => {");
  lines.push("  const node = requireNode(id);");
  lines.push("  if (typeof node.appendChild !== \"function\") throw new Error(`Node ${resolveRefId(id)} is not a container`);");
  lines.push("  return node;");
  lines.push("};");
  lines.push("const requireSceneNode = (id) => {");
  lines.push("  const node = requireNode(id);");
  lines.push("  if (!(\"parent\" in node)) throw new Error(`Not a scene node: ${resolveRefId(id)}`);");
  lines.push("  return node;");
  lines.push("};");
  lines.push("const requireFills = (id) => {");
  lines.push("  const node = requireSceneNode(id);");
  lines.push("  if (!(\"fills\" in node)) throw new Error(`Node ${resolveRefId(id)} does not support fills`);");
  lines.push("  return node;");
  lines.push("};");
  lines.push(`const cannotDeleteNode = (node) => !node || ${j(FORBIDDEN_DELETE_NODE_TYPES)}.includes(node.type);`);
  lines.push("const sanitizePaints = (paints) => (paints || []).map((paint) => {");
  lines.push("  if (!paint || typeof paint !== \"object\" || !paint.color || typeof paint.color !== \"object\") return paint;");
  lines.push("  if (!(\"a\" in paint.color)) return paint;");
  lines.push("  const { a, ...rgb } = paint.color;");
  lines.push("  const cleaned = { ...paint, color: rgb };");
  lines.push("  if (a !== undefined && a !== 1 && cleaned.opacity === undefined) cleaned.opacity = a;");
  lines.push("  return cleaned;");
  lines.push("});");
  lines.push("const parseVariableValue = (resolvedType, value) => {");
  lines.push("  if (resolvedType === 'COLOR') {");
  lines.push("    if (value && typeof value === 'object' && ['r','g','b'].every(key => typeof value[key] === 'number')) return value;");
  lines.push("    if (typeof value !== 'string' || !/^#?(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) throw new Error('COLOR variable value must be valid hex or RGBA');");
  lines.push("    const cleaned = value.replace('#', ''); const expanded = cleaned.length === 3 ? cleaned.split('').map(channel => channel + channel).join('') : cleaned;");
  lines.push("    return { r: parseInt(expanded.slice(0,2),16)/255, g: parseInt(expanded.slice(2,4),16)/255, b: parseInt(expanded.slice(4,6),16)/255, a: expanded.length === 8 ? parseInt(expanded.slice(6,8),16)/255 : 1 };");
  lines.push("  }");
  lines.push("  if (resolvedType === 'FLOAT' && typeof value !== 'number') throw new Error('FLOAT variable value must be a number');");
  lines.push("  if (resolvedType === 'STRING' && typeof value !== 'string') throw new Error('STRING variable value must be a string');");
  lines.push("  if (resolvedType === 'BOOLEAN' && typeof value !== 'boolean') throw new Error('BOOLEAN variable value must be a boolean');");
  lines.push("  return value;");
  lines.push("};");
  lines.push("const propertyDisplayName = (key) => key.includes('#') ? key.slice(0, key.lastIndexOf('#')) : key;");
  lines.push("const resolveComponentPropertyKey = (definitions, requested) => {");
  lines.push("  if (Object.prototype.hasOwnProperty.call(definitions, requested)) return requested;");
  lines.push("  const matches = Object.keys(definitions).filter(key => propertyDisplayName(key) === requested);");
  lines.push("  if (!matches.length) throw new Error(`Component property not found: ${requested}`);");
  lines.push("  if (matches.length > 1) throw new Error(`Component property name is ambiguous: ${requested}`);");
  lines.push("  return matches[0];");
  lines.push("};");
  lines.push("const requireAttachedInstance = async (id) => { const node = requireNode(id); if (node.type !== 'INSTANCE') throw new Error(`Node ${id} is not an instance`); if (typeof node.getMainComponentAsync === 'function' && !(await node.getMainComponentAsync())) throw new Error(`Instance ${id} is detached or has no main component`); return node; };");
  lines.push("const findInstanceChild = async (id, path) => { let current = await requireAttachedInstance(id); for (const segment of path) { if (!Array.isArray(current.children)) throw new Error(`Child path cannot descend through ${current.type}`); const matches = current.children.filter(child => child.name === segment); if (!matches.length) throw new Error(`Child path segment not found: ${segment}`); if (matches.length > 1) throw new Error(`Child path segment is ambiguous: ${segment}`); current = matches[0]; } return current; };");
  lines.push("const localStyles = async (type) => type === 'PAINT' ? figma.getLocalPaintStylesAsync() : type === 'TEXT' ? figma.getLocalTextStylesAsync() : figma.getLocalEffectStylesAsync();");
  lines.push("const resolveStyle = async (type, id, name) => { if (id) { const style = await figma.getStyleByIdAsync(resolveRefId(id)); if (!style) throw new Error(`Style not found: ${id}`); if (style.type !== type) throw new Error(`Style ${id} is ${style.type}, not ${type}`); return style; } const matches = (await localStyles(type)).filter(style => style.name === name); if (!matches.length) throw new Error(`Style not found: ${name}`); if (matches.length > 1) throw new Error(`Style name is ambiguous: ${name}`); return matches[0]; };");
  lines.push("const gradientTransform = (gradient) => { if (gradient.gradientTransform) return gradient.gradientTransform; const angle = (gradient.angle || 0) * Math.PI / 180; return [[Math.cos(angle), Math.sin(angle), 0], [-Math.sin(angle), Math.cos(angle), 0]]; };");
  lines.push("const gradientPaints = (action) => (action.gradients || [action]).map((gradient) => ({ type: `GRADIENT_${gradient.gradientType || 'LINEAR'}`, gradientStops: gradient.stops, gradientTransform: gradientTransform(gradient), ...(gradient.visible !== undefined ? { visible: gradient.visible } : {}), ...(gradient.opacity !== undefined ? { opacity: gradient.opacity } : {}), ...(gradient.blendMode !== undefined ? { blendMode: gradient.blendMode } : {}) }));");
  lines.push("const resolveVariable = async (action) => { let variable; if (action.variableId) variable = figma.variables.getVariableByIdAsync ? await figma.variables.getVariableByIdAsync(resolveRefId(action.variableId)) : figma.variables.getVariableById(resolveRefId(action.variableId)); else { let candidates = (await figma.variables.getLocalVariablesAsync(action.resolvedType)).filter(item => item.name === action.variableName); if (action.collectionId || action.collectionName) { const collections = await figma.variables.getLocalVariableCollectionsAsync(); const matches = action.collectionId ? collections.filter(item => item.id === resolveRefId(action.collectionId)) : collections.filter(item => item.name === action.collectionName); if (!matches.length) throw new Error(`Variable collection not found: ${action.collectionId || action.collectionName}`); if (matches.length > 1) throw new Error(`Variable collection name is ambiguous: ${action.collectionName}`); candidates = candidates.filter(item => item.variableCollectionId === matches[0].id); } if (!candidates.length) throw new Error(`Variable not found: ${action.variableName}`); if (candidates.length > 1) throw new Error(`Variable name is ambiguous: ${action.variableName}`); variable = candidates[0]; } if (!variable) throw new Error(`Variable not found: ${action.variableId}`); if (action.resolvedType && variable.resolvedType !== action.resolvedType) throw new Error(`Variable ${variable.name} is ${variable.resolvedType}, not ${action.resolvedType}`); return variable; };");
  lines.push("const validateVariableCollection = async (action, variable) => { if (!action.collectionId && !action.collectionName) return; let matches; if (action.collectionId) { const id = resolveRefId(action.collectionId); const collection = figma.variables.getVariableCollectionByIdAsync ? await figma.variables.getVariableCollectionByIdAsync(id) : figma.variables.getVariableCollectionById(id); matches = collection ? [collection] : []; } else matches = (await figma.variables.getLocalVariableCollectionsAsync()).filter(item => item.name === action.collectionName); if (!matches.length) throw new Error(`Variable collection not found: ${action.collectionId || action.collectionName}`); if (matches.length > 1) throw new Error(`Variable collection name is ambiguous: ${action.collectionName}`); if (variable.variableCollectionId !== matches[0].id) throw new Error(`Variable ${variable.name} is not in collection ${matches[0].name}`); };");
  lines.push("");
  lines.push("if (executionOptions.rollbackOnError) figma.commitUndo();");
  lines.push("");

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (!isKnownActionType(a.type)) {
      throw new Error(`Unknown action type: ${a.type}`);
    }
    assertActionInputCoverage(a);
    lines.push(`// Action ${i}: ${a.type}`);
    lines.push("if (stopProcessing) {");
    lines.push(`  results.push({ actionIndex: ${i}, type: ${j(a.type)}, status: "skipped" });`);
    lines.push("} else {");
    lines.push("  try {");

    const nid = "nodeId" in a ? a.nodeId : "";
    const g = (id: string) => `getNode(${j(id)})`;
    const r = (t: string, extra = "") => `results.push({ type: "${t}", nodeId: "${nid}"${extra} });`;
    const createRef = compiledActions[i]?._ref;
    const aliasRef = compiledActions[i]?._aliasRef;
    const cr = (t: string, nodeId: string) => {
      if (typeof createRef !== "string") {
        throw new Error(`Missing compiled reference for create action ${i}: ${t}`);
      }
      return `recordCreatedNode(${j(createRef)}, { type: "${t}", nodeId: ${nodeId} }${typeof aliasRef === "string" ? `, ${j(aliasRef)}` : ""});`;
    };

    switch (a.type) {
      case "rename":
        lines.push(`{ ${g(nid)}.name = ${j(a.name)}; markDocumentWrite(); ${r("rename")} }`);
        break;
      case "move":
        lines.push(`{ const n = requireNode(${j(nid)}); const p = requireContainer(${j(a.targetParentId)}); ${a.insertIndex !== undefined ? `p.insertChild(${a.insertIndex}, n)` : "p.appendChild(n)"}; markDocumentWrite(); ${r("move")} }`);
        break;
      case "create_frame":
        lines.push(`{ const parent = requireContainer(${j(a.parentId)}); const f = figma.createFrame(); f.fills = []; markDocumentWrite(); f.name = ${j(a.name)}; f.resize(${a.width}, ${a.height}); parent.appendChild(f); f.x = ${a.x}; f.y = ${a.y}; ${cr("create_frame", "f.id")} }`);
        break;
      case "create_text": {
        const hasFontOverride = a.fontFamily !== undefined || a.fontWeight !== undefined;
        const fallbackFamily = a.fontFamily ?? "Inter";
        const fallbackStyle = a.fontWeight !== undefined ? weightToStyle(a.fontWeight) : "Regular";
        lines.push(`{ const parent = requireContainer(${j(a.parentId)}); const textStyle = ${a.textStyleId || a.textStyleName ? `await resolveStyle("TEXT", ${j(a.textStyleId)}, ${j(a.textStyleName)})` : "null"}; if (textStyle) await loadFontOnce(textStyle.fontName); const family = ${a.fontFamily !== undefined ? j(a.fontFamily) : "textStyle ? textStyle.fontName.family : " + j(fallbackFamily)}; const fontStyle = ${a.fontWeight !== undefined ? j(weightToStyle(a.fontWeight)) : "textStyle ? textStyle.fontName.style : " + j(fallbackStyle)}; if (!textStyle || ${hasFontOverride}) await loadFontOnce({ family, style: fontStyle }); const t = figma.createText(); markDocumentWrite(); if (textStyle) await t.setTextStyleIdAsync(textStyle.id); if (!textStyle || ${hasFontOverride}) t.fontName = { family, style: fontStyle }; t.characters = ${j(a.characters)}; ${a.fontSize !== undefined ? `t.fontSize = ${a.fontSize};` : ""} ${a.lineHeight !== undefined ? `t.lineHeight = { value: ${a.lineHeight}, unit: "PIXELS" };` : ""} ${a.letterSpacing !== undefined ? `t.letterSpacing = { value: ${a.letterSpacing}, unit: "PIXELS" };` : ""} ${a.fills ? `t.fills = sanitizePaints(${j(a.fills)});` : ""} ${a.textCase ? `t.textCase = "${a.textCase}";` : ""} ${a.textAlignHorizontal ? `t.textAlignHorizontal = "${a.textAlignHorizontal}";` : ""} t.textAutoResize = "${a.textAutoResize || "HEIGHT"}"; ${a.textTruncation ? `t.textTruncation = "${a.textTruncation}";` : ""} ${a.maxLines !== undefined ? `t.maxLines = ${j(a.maxLines)};` : ""} ${a.name ? `t.name = ${j(a.name)};` : ""} parent.appendChild(t); ${a.layoutSizingHorizontal ? `t.layoutSizingHorizontal = "${a.layoutSizingHorizontal}";` : ""} ${a.layoutSizingVertical ? `t.layoutSizingVertical = "${a.layoutSizingVertical}";` : ""} ${a.opacity !== undefined ? `t.opacity = ${a.opacity};` : ""} ${cr("create_text", "t.id")} }`);
        break;
      }
      case "delete_node":
        lines.push(`{ const n = ${g(nid)}; if (cannotDeleteNode(n)) throw new Error("Cannot delete page or document nodes"); n.remove(); markDocumentWrite(); ${r("delete_node")} }`);
        break;
      case "resize":
        lines.push(`{ const n = ${g(nid)}; n.resize(${a.width ?? "n.width"}, ${a.height ?? "n.height"}); markDocumentWrite(); ${r("resize")} }`);
        break;
      case "set_position":
        lines.push(`{ const n = ${g(nid)}; ${a.x !== undefined ? `if (n.x !== ${a.x}) { n.x = ${a.x}; markDocumentWrite(); }` : ""} ${a.y !== undefined ? `if (n.y !== ${a.y}) { n.y = ${a.y}; markDocumentWrite(); }` : ""} ${r("set_position")} }`);
        break;
      case "duplicate_node":
        lines.push(`{ const source = requireSceneNode(${j(nid)}); const target = ${a.targetParentId ? `requireContainer(${j(a.targetParentId)})` : "null"}; ${a.insertIndex !== undefined ? `if (target && ${a.insertIndex} > target.children.length) throw new Error("insertIndex exceeds target child count");` : ""} const c = source.clone(); markDocumentWrite(); ${a.targetParentId ? (a.insertIndex !== undefined ? `target.insertChild(${a.insertIndex}, c);` : "target.appendChild(c);") : ""} ${a.x !== undefined ? `c.x = ${a.x};` : ""} ${a.y !== undefined ? `c.y = ${a.y};` : ""} ${cr("duplicate_node", "c.id")} }`);
        break;
      case "set_visible":
        lines.push(`{ ${g(nid)}.visible = ${a.visible}; markDocumentWrite(); ${r("set_visible")} }`);
        break;
      case "set_opacity":
        lines.push(`{ ${g(nid)}.opacity = ${a.opacity}; markDocumentWrite(); ${r("set_opacity")} }`);
        break;
      case "set_layout_mode":
        lines.push(`{ const n = ${g(nid)}; ${a.layoutWrap && a.mode !== "HORIZONTAL" ? `throw new Error("layoutWrap requires HORIZONTAL auto layout");` : ""} n.layoutMode = "${a.mode}"; markDocumentWrite(); ${a.primaryAxisSizingMode ? `n.primaryAxisSizingMode = "${a.primaryAxisSizingMode}"; markDocumentWrite();` : ""} ${a.counterAxisSizingMode ? `n.counterAxisSizingMode = "${a.counterAxisSizingMode}"; markDocumentWrite();` : ""} ${a.layoutWrap ? `n.layoutWrap = "${a.layoutWrap}"; markDocumentWrite();` : ""} ${r("set_layout_mode")} }`);
        break;
      case "set_layout_positioning":
        lines.push(`{ ${g(nid)}.layoutPositioning = "${a.positioning}"; markDocumentWrite(); ${r("set_layout_positioning")} }`);
        break;
      case "set_alignment":
        lines.push(`{ const n = ${g(nid)}; if (n.layoutMode === "NONE") throw new Error("Alignment requires auto layout"); ${a.counterAxisAlignItems === "BASELINE" ? `if (n.layoutMode !== "HORIZONTAL") throw new Error("BASELINE alignment requires HORIZONTAL auto layout");` : ""} ${a.primaryAxisAlignItems ? `n.primaryAxisAlignItems = "${a.primaryAxisAlignItems}"; markDocumentWrite();` : ""} ${a.counterAxisAlignItems ? `n.counterAxisAlignItems = "${a.counterAxisAlignItems}"; markDocumentWrite();` : ""} ${r("set_alignment")} }`);
        break;
      case "set_spacing":
        lines.push(`{ const n = ${g(nid)}; if (n.layoutMode === "NONE") throw new Error("Spacing requires auto layout"); ${a.counterAxisSpacing !== undefined ? `if (n.layoutWrap !== "WRAP") throw new Error("counterAxisSpacing requires wrapping auto layout");` : ""} ${a.itemSpacing !== undefined ? `n.itemSpacing = ${a.itemSpacing}; markDocumentWrite();` : ""} ${a.paddingTop !== undefined ? `n.paddingTop = ${a.paddingTop}; markDocumentWrite();` : ""} ${a.paddingRight !== undefined ? `n.paddingRight = ${a.paddingRight}; markDocumentWrite();` : ""} ${a.paddingBottom !== undefined ? `n.paddingBottom = ${a.paddingBottom}; markDocumentWrite();` : ""} ${a.paddingLeft !== undefined ? `n.paddingLeft = ${a.paddingLeft}; markDocumentWrite();` : ""} ${a.counterAxisSpacing !== undefined ? `n.counterAxisSpacing = ${j(a.counterAxisSpacing)}; markDocumentWrite();` : ""} ${r("set_spacing")} }`);
        break;
      case "set_child_layout_sizing":
        lines.push(`{ const n = ${g(nid)}; ${a.layoutSizingHorizontal ? `n.layoutSizingHorizontal = "${a.layoutSizingHorizontal}"; markDocumentWrite();` : ""} ${a.layoutSizingVertical ? `n.layoutSizingVertical = "${a.layoutSizingVertical}"; markDocumentWrite();` : ""} ${r("set_child_layout_sizing")} }`);
        break;
      case "set_constraints":
        lines.push(`{ const n = ${g(nid)}; ${a.horizontal ? `n.constraints = { ...n.constraints, horizontal: "${a.horizontal}" }; markDocumentWrite();` : ""} ${a.vertical ? `n.constraints = { ...n.constraints, vertical: "${a.vertical}" }; markDocumentWrite();` : ""} ${r("set_constraints")} }`);
        break;
      case "set_min_max_size":
        lines.push(`{ const n = ${g(nid)}; ${a.minWidth !== undefined ? `n.minWidth = ${a.minWidth}; markDocumentWrite();` : ""} ${a.maxWidth !== undefined ? `n.maxWidth = ${a.maxWidth}; markDocumentWrite();` : ""} ${a.minHeight !== undefined ? `n.minHeight = ${a.minHeight}; markDocumentWrite();` : ""} ${a.maxHeight !== undefined ? `n.maxHeight = ${a.maxHeight}; markDocumentWrite();` : ""} ${r("set_min_max_size")} }`);
        break;
      case "set_fills":
        lines.push(`{ ${g(nid)}.fills = sanitizePaints(${j(a.fills)}); markDocumentWrite(); ${r("set_fills")} }`);
        break;
      case "set_gradient_fill":
        lines.push(`{ const n = requireFills(${j(nid)}); n.fills = gradientPaints(${j(a)}); markDocumentWrite(); ${r("set_gradient_fill")} }`);
        break;
      case "set_image_fill":
        lines.push(`{ const n = requireFills(${j(nid)}); const img = figma.createImage(figma.base64Decode(${j(a.imageBase64)})); n.fills = [{ type: "IMAGE", imageHash: img.hash, scaleMode: "${a.scaleMode || "FILL"}" }]; markDocumentWrite(); ${r("set_image_fill")} }`);
        break;
      case "create_from_svg":
        lines.push(`{ const parent = requireContainer(${j(a.parentId)}); const n = figma.createNodeFromSvg(${j(a.svg)}); markDocumentWrite(); ${a.name ? `n.name = ${j(a.name)};` : ""} parent.appendChild(n); n.x = ${a.x}; n.y = ${a.y}; ${cr("create_from_svg", "n.id")} }`);
        break;
      case "create_section":
        lines.push(`{ if (figma.editorType !== "figma") throw new Error("Sections are only supported in Figma Design"); if (${a.width} < 0.01 || ${a.height} < 0.01) throw new Error("Section dimensions must be at least 0.01"); const parent = requireNode(${j(a.parentId)}); if (parent.type !== "PAGE") throw new Error("Sections must be created on a page"); const s = figma.createSection(); markDocumentWrite(); s.name = ${j(a.name)}; s.resize(${a.width}, ${a.height}); parent.appendChild(s); s.x = ${a.x}; s.y = ${a.y}; ${cr("create_section", "s.id")} }`);
        break;
      case "resize_section":
        lines.push(`{ if (figma.editorType !== "figma") throw new Error("Sections are only supported in Figma Design"); if (${a.width} < 0.01 || ${a.height} < 0.01) throw new Error("Section dimensions must be at least 0.01"); const s = requireNode(${j(a.sectionId)}); if (s.type !== "SECTION") throw new Error("Node is not a section"); s.resize(${a.width}, ${a.height}); markDocumentWrite(); results.push({ type: "resize_section", nodeId: s.id }); }`);
        break;
      case "move_to_section":
        lines.push(`{ if (figma.editorType !== "figma") throw new Error("Sections are only supported in Figma Design"); const n = requireSceneNode(${j(nid)}); const s = requireNode(${j(a.sectionId)}); if (s.type !== "SECTION") throw new Error("Node is not a section"); if (["SECTION", "PAGE", "DOCUMENT"].includes(n.type)) throw new Error(n.type + " nodes cannot be moved into sections"); ${a.insertIndex !== undefined ? `if (${a.insertIndex} > s.children.length) throw new Error("insertIndex exceeds section child count");` : ""} let ancestor = s; while (ancestor && ancestor.parent) { if (ancestor.id === n.id) throw new Error("Cannot move a node into its own descendant"); ancestor = ancestor.parent; } ${a.insertIndex !== undefined ? `s.insertChild(${a.insertIndex}, n);` : "s.appendChild(n);"} markDocumentWrite(); ${r("move_to_section")} }`);
        break;
      case "set_reaction":
        lines.push(`{ if (figma.editorType !== "figma") throw new Error("Prototype reactions are only supported in Figma Design"); const n = requireSceneNode(${j(nid)}); const destination = requireSceneNode(${j(a.destinationId)}); if (typeof n.setReactionsAsync !== "function") throw new Error("Node does not support reactions"); const reaction = { trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId: destination.id, navigation: "${a.navigation}", transition: null }] }; const next = "${a.mode}" === "append" ? [...n.reactions, reaction] : [reaction]; await n.setReactionsAsync(next); markDocumentWrite(); ${r("set_reaction")} }`);
        break;
      case "set_strokes":
        lines.push(`{ const n = ${g(nid)}; n.strokes = sanitizePaints(${j(a.strokes)}); markDocumentWrite(); ${a.strokeWeight !== undefined ? `n.strokeWeight = ${a.strokeWeight}; markDocumentWrite();` : ""} ${r("set_strokes")} }`);
        break;
      case "set_effects":
        lines.push(`{ ${g(nid)}.effects = ${j(a.effects)}; markDocumentWrite(); ${r("set_effects")} }`);
        break;
      case "set_corner_radius":
        lines.push(`{ const n = ${g(nid)}; ${a.radius !== undefined ? `n.cornerRadius = ${a.radius}; markDocumentWrite();` : ""} ${a.radii ? `n.topLeftRadius=${a.radii[0]}; markDocumentWrite(); n.topRightRadius=${a.radii[1]}; markDocumentWrite(); n.bottomRightRadius=${a.radii[2]}; markDocumentWrite(); n.bottomLeftRadius=${a.radii[3]}; markDocumentWrite();` : ""} ${r("set_corner_radius")} }`);
        break;
      case "set_text_content":
        lines.push(`{ const n = ${g(nid)}; if (n.fontName === figma.mixed) { const seenFonts = new Set(); for (let rangeStart = 0; rangeStart < n.characters.length; rangeStart++) { const rangeFont = n.getRangeFontName(rangeStart, rangeStart + 1); const fontKey = \`${"${rangeFont.family}|${rangeFont.style}"}\`; if (!seenFonts.has(fontKey)) { seenFonts.add(fontKey); await loadFontOnce(rangeFont); } } } else { await loadFontOnce(n.fontName); } n.characters = ${j(a.characters)}; markDocumentWrite(); ${r("set_text_content")} }`);
        break;
      case "set_text_style": {
        const hasFontOverride = Boolean(a.fontFamily) || a.fontWeight !== undefined;
        const family = a.fontFamily ? j(a.fontFamily) : "currentFamily";
        const style = a.fontWeight !== undefined ? j(weightToStyle(a.fontWeight)) : "currentStyle";
        lines.push(`{ const n = ${g(nid)}; const currentFont = n.fontName; if (${hasFontOverride}) { const currentFamily = currentFont === figma.mixed ? "Inter" : currentFont.family; const currentStyle = currentFont === figma.mixed ? "Regular" : currentFont.style; const family = ${family}; const style = ${style}; await loadFontOnce({ family, style }); n.fontName = { family, style }; markDocumentWrite(); } else if (currentFont === figma.mixed) { const seenFonts = new Set(); for (let rangeStart = 0; rangeStart < n.characters.length; rangeStart++) { const rangeFont = n.getRangeFontName(rangeStart, rangeStart + 1); const fontKey = \`${"${rangeFont.family}|${rangeFont.style}"}\`; if (!seenFonts.has(fontKey)) { seenFonts.add(fontKey); await loadFontOnce(rangeFont); } } } else { await loadFontOnce(currentFont); } ${a.fontSize !== undefined ? `n.fontSize = ${a.fontSize}; markDocumentWrite();` : ""} ${a.lineHeight !== undefined ? `n.lineHeight = { value: ${a.lineHeight}, unit: "PIXELS" }; markDocumentWrite();` : ""} ${a.letterSpacing !== undefined ? `n.letterSpacing = { value: ${a.letterSpacing}, unit: "PIXELS" }; markDocumentWrite();` : ""} ${r("set_text_style")} }`);
        break;
      }
      case "set_text_properties":
        lines.push(`{ const n = ${g(nid)}; ${a.textAlignHorizontal ? `n.textAlignHorizontal = "${a.textAlignHorizontal}"; markDocumentWrite();` : ""} ${a.textAlignVertical ? `n.textAlignVertical = "${a.textAlignVertical}"; markDocumentWrite();` : ""} ${a.paragraphSpacing !== undefined ? `n.paragraphSpacing = ${a.paragraphSpacing}; markDocumentWrite();` : ""} ${a.textCase ? `n.textCase = "${a.textCase}"; markDocumentWrite();` : ""} ${a.textDecoration ? `n.textDecoration = "${a.textDecoration}"; markDocumentWrite();` : ""} ${a.textAutoResize ? `n.textAutoResize = "${a.textAutoResize}"; markDocumentWrite();` : ""} ${r("set_text_properties")} }`);
        break;
      case "create_component_from_node":
        lines.push(`{ const source = requireNode(${j(nid)}); if (!source.parent || typeof source.parent.appendChild !== "function" || source.type === "PAGE" || source.type === "DOCUMENT") throw new Error("Node is not a scene node with a container parent"); const c = figma.createComponentFromNode(source); markDocumentWrite(); c.name = ${j(a.name)}; ${cr("create_component_from_node", "c.id")} }`);
        break;
      case "create_component_set":
        lines.push(`{ const comps = ${j(a.componentIds)}.map(id => requireNode(id)); if (comps.some(component => component.type !== "COMPONENT")) throw new Error("All variant nodes must be components"); const parent = comps[0].parent; if (!parent || typeof parent.appendChild !== "function") throw new Error("Component has no valid parent for variant set"); if (comps.some(component => component.parent !== parent)) throw new Error("All components must share a parent for variant set"); const set = figma.combineAsVariants(comps, parent); markDocumentWrite(); set.name = ${j(a.name)}; ${cr("create_component_set", "set.id")} }`);
        break;
      case "create_instance":
        lines.push(`{ const component = requireNode(${j(a.componentId)}); if (component.type !== "COMPONENT" || typeof component.createInstance !== "function") throw new Error("Node is not a component"); const parent = requireContainer(${j(a.parentId)}); const inst = component.createInstance(); markDocumentWrite(); parent.appendChild(inst); ${a.x !== undefined ? `inst.x = ${a.x}; markDocumentWrite();` : ""} ${a.y !== undefined ? `inst.y = ${a.y}; markDocumentWrite();` : ""} ${cr("create_instance", "inst.id")} }`);
        break;
      case "swap_instance":
        lines.push(`{ const instance = requireNode(${j(a.instanceId)}); if (instance.type !== "INSTANCE" || typeof instance.swapComponent !== "function") throw new Error("Node is not an instance"); const component = requireNode(${j(a.newComponentId)}); if (component.type !== "COMPONENT") throw new Error("Node is not a component"); instance.swapComponent(component); markDocumentWrite(); results.push({ type: "swap_instance" }); }`);
        break;
      case "set_component_properties":
        lines.push(`{ const n = await requireAttachedInstance(${j(nid)}); const main = typeof n.getMainComponentAsync === "function" ? await n.getMainComponentAsync() : null; const properties = main ? Object.fromEntries(Object.entries(${j(a.properties)}).map(([key, value]) => { const resolvedKey = resolveComponentPropertyKey(main.componentPropertyDefinitions, key); const definition = main.componentPropertyDefinitions[resolvedKey]; return [resolvedKey, definition.type === "INSTANCE_SWAP" && typeof value === "string" && value.startsWith("$") ? resolveRefId(value) : value]; })) : ${j(a.properties)}; for (const [property, value] of Object.entries(properties)) { n.setProperties({ [property]: value }); markDocumentWrite(); } ${r("set_component_properties")} }`);
        break;
      case "define_component_property":
        lines.push(`{ const n = requireNode(${j(nid)}); if (n.type !== "COMPONENT" && n.type !== "COMPONENT_SET") throw new Error("Node is not a component or component set"); ${a.propertyType === "VARIANT" ? `if (n.type !== "COMPONENT_SET") throw new Error("VARIANT properties require a component set");` : ""} const defaultValue = ${a.propertyType === "INSTANCE_SWAP" && typeof a.defaultValue === "string" ? `resolveRefId(${j(a.defaultValue)})` : j(a.defaultValue)}; n.addComponentProperty(${j(a.propertyName)}, "${a.propertyType}", defaultValue); markDocumentWrite(); ${r("define_component_property")} }`);
        break;
      case "set_component_property_reference":
        lines.push(`{ const n = requireSceneNode(${j(nid)}); let owner = n.parent; while (owner && owner.type !== "COMPONENT" && owner.type !== "COMPONENT_SET") owner = owner.parent; if (!owner) throw new Error("Node is not inside a component or component set"); const key = resolveComponentPropertyKey(owner.componentPropertyDefinitions, ${j(a.componentPropertyName)}); const expected = ${j(a.property === "characters" ? "TEXT" : a.property === "visible" ? "BOOLEAN" : "INSTANCE_SWAP")}; if (owner.componentPropertyDefinitions[key].type !== expected) throw new Error("Component property type is incompatible"); ${a.property === "characters" ? `if (n.type !== "TEXT") throw new Error("characters references require a text node");` : ""} ${a.property === "mainComponent" ? `if (n.type !== "INSTANCE") throw new Error("mainComponent references require an instance node");` : ""} n.componentPropertyReferences = { ...(n.componentPropertyReferences || {}), ${j(a.property)}: key }; markDocumentWrite(); ${r("set_component_property_reference")} }`);
        break;
      case "set_instance_text":
        lines.push(`{ const n = await findInstanceChild(${j(a.instanceId)}, ${j(a.childPath)}); if (n.type !== "TEXT") throw new Error("childPath does not resolve to a text node"); if (n.fontName === figma.mixed) { const fonts = new Map(); for (let i = 0; i < n.characters.length; i++) { const font = n.getRangeFontName(i, i + 1); fonts.set(font.family + "|" + font.style, font); } for (const font of fonts.values()) await loadFontOnce(font); } else await loadFontOnce(n.fontName); n.characters = ${j(a.characters)}; markDocumentWrite(); results.push({ type: "set_instance_text", nodeId: n.id }); }`);
        break;
      case "set_instance_visibility":
        lines.push(`{ const n = await findInstanceChild(${j(a.instanceId)}, ${j(a.childPath)}); n.visible = ${a.visible}; markDocumentWrite(); results.push({ type: "set_instance_visibility", nodeId: n.id }); }`);
        break;
      case "swap_nested_instance":
        lines.push(`{ const n = await findInstanceChild(${j(a.instanceId)}, ${j(a.childPath)}); if (n.type !== "INSTANCE") throw new Error("childPath does not resolve to an instance node"); const component = requireNode(${j(a.newComponentId)}); if (component.type !== "COMPONENT") throw new Error("Swap target is not a component"); n.swapComponent(component); markDocumentWrite(); results.push({ type: "swap_nested_instance", nodeId: n.id }); }`);
        break;
      case "create_paint_style":
        lines.push(`{ const s = figma.createPaintStyle(); markDocumentWrite(); s.name = ${j(a.name)}; s.paints = sanitizePaints(${j(a.paints)}); ${cr("create_paint_style", "s.id")} }`);
        break;
      case "create_text_style":
        lines.push(`{ const s = figma.createTextStyle(); markDocumentWrite(); s.name = ${j(a.name)}; s.fontName = { family: "${a.fontFamily}", style: "${weightToStyle(a.fontWeight)}" }; s.fontSize = ${a.fontSize}; ${a.lineHeight !== undefined ? `s.lineHeight = { value: ${a.lineHeight}, unit: "PIXELS" };` : ""} ${a.letterSpacing !== undefined ? `s.letterSpacing = { value: ${a.letterSpacing}, unit: "PIXELS" };` : ""} ${cr("create_text_style", "s.id")} }`);
        break;
      case "create_effect_style":
        lines.push(`{ const s = figma.createEffectStyle(); markDocumentWrite(); s.name = ${j(a.name)}; s.effects = ${j(a.effects)}; ${cr("create_effect_style", "s.id")} }`);
        break;
      case "apply_style":
        lines.push(`{ const n = ${g(nid)}; const style = await resolveStyle(${j(a.property === "text" ? "TEXT" : a.property === "effect" ? "EFFECT" : "PAINT")}, ${j(a.styleId)}, ${j(a.styleName)}); const styleId = style.id; ${a.property === "text" ? "await loadFontOnce(style.fontName);" : ""} ${a.property === "fill" ? "await n.setFillStyleIdAsync(styleId);" : a.property === "stroke" ? "await n.setStrokeStyleIdAsync(styleId);" : a.property === "text" ? "await n.setTextStyleIdAsync(styleId);" : "await n.setEffectStyleIdAsync(styleId);"} markDocumentWrite(); ${r("apply_style")} }`);
        break;
      case "update_style": {
        const textUpdates = a.fontFamily !== undefined || a.fontWeight !== undefined || a.fontSize !== undefined || a.lineHeight !== undefined || a.letterSpacing !== undefined;
        const noUpdates = a.name === undefined && a.paints === undefined && a.effects === undefined && !textUpdates && !a.copyFromStyleId && !a.copyFromStyleName;
        lines.push(`{ const style = await resolveStyle(${j(a.styleType)}, ${j(a.styleId)}, ${j(a.styleName)}); const source = ${a.copyFromStyleId || a.copyFromStyleName ? `await resolveStyle(${j(a.styleType)}, ${j(a.copyFromStyleId)}, ${j(a.copyFromStyleName)})` : "null"}; ${a.paints !== undefined && a.styleType !== "PAINT" || a.effects !== undefined && a.styleType !== "EFFECT" || textUpdates && a.styleType !== "TEXT" ? `throw new Error("Update fields do not match style type");` : ""} ${noUpdates ? `throw new Error("update_style has no updates");` : ""} ${a.styleType === "TEXT" ? `const current = source || style; const family = ${a.fontFamily !== undefined ? j(a.fontFamily) : "current.fontName.family"}; const fontStyle = ${a.fontWeight !== undefined ? j(weightToStyle(a.fontWeight)) : "current.fontName.style"}; await loadFontOnce({ family, style: fontStyle });` : ""} markDocumentWrite(); ${a.name !== undefined ? `style.name = ${j(a.name)};` : ""} ${a.styleType === "PAINT" && (a.paints !== undefined || a.copyFromStyleId || a.copyFromStyleName) ? `style.paints = sanitizePaints(${a.paints !== undefined ? j(a.paints) : "[...source.paints]"});` : ""} ${a.styleType === "EFFECT" && (a.effects !== undefined || a.copyFromStyleId || a.copyFromStyleName) ? `style.effects = ${a.effects !== undefined ? j(a.effects) : "[...source.effects]"};` : ""} ${a.styleType === "TEXT" ? `${a.copyFromStyleId || a.copyFromStyleName ? "style.textDecoration = source.textDecoration; style.leadingTrim = source.leadingTrim; style.paragraphIndent = source.paragraphIndent; style.paragraphSpacing = source.paragraphSpacing; style.listSpacing = source.listSpacing; style.hangingPunctuation = source.hangingPunctuation; style.hangingList = source.hangingList; style.textCase = source.textCase;" : ""} style.fontName = { family, style: fontStyle }; ${a.fontSize !== undefined ? `style.fontSize = ${a.fontSize};` : (a.copyFromStyleId || a.copyFromStyleName) ? "style.fontSize = source.fontSize;" : ""} ${a.lineHeight !== undefined ? `style.lineHeight = { value: ${a.lineHeight}, unit: "PIXELS" };` : (a.copyFromStyleId || a.copyFromStyleName) ? "style.lineHeight = source.lineHeight;" : ""} ${a.letterSpacing !== undefined ? `style.letterSpacing = { value: ${a.letterSpacing}, unit: "PIXELS" };` : (a.copyFromStyleId || a.copyFromStyleName) ? "style.letterSpacing = source.letterSpacing;" : ""}` : ""} results.push({ type: "update_style", nodeId: style.id }); }`);
        break;
      }
      case "set_description":
        lines.push(`{ ${g(nid)}.description = ${j(a.description)}; markDocumentWrite(); ${r("set_description")} }`);
        break;
      case "create_page":
        lines.push(`{ const p = figma.createPage(); markDocumentWrite(); p.name = ${j(a.name)}; ${cr("create_page", "p.id")} }`);
        break;
      case "switch_page":
        lines.push(`{ const page = getNode(${j(a.pageId)}); if (!page || page.type !== "PAGE") throw new Error("Node ${a.pageId} is not a page"); await figma.setCurrentPageAsync(page); results.push({ type: "switch_page" }); }`);
        break;
      case "create_variable_collection":
        lines.push(`{ const c = figma.variables.createVariableCollection(${j(a.name)}); markDocumentWrite(); const modes = ${j(a.modes)}; if (modes[0]) { c.renameMode(c.modes[0].modeId, modes[0]); markDocumentWrite(); } for (let modeIndex = 1; modeIndex < modes.length; modeIndex++) { c.addMode(modes[modeIndex]); markDocumentWrite(); } ${cr("create_variable_collection", "c.id")} }`);
        break;
      case "create_variable":
        lines.push(`{ const collectionId = resolveRefId(${j(a.collectionId)}); const c = figma.variables.getVariableCollectionByIdAsync ? await figma.variables.getVariableCollectionByIdAsync(collectionId) : figma.variables.getVariableCollectionById(collectionId); if (!c) throw new Error("Variable collection not found"); const value = parseVariableValue("${a.resolvedType}", ${j(a.value)}); const v = figma.variables.createVariable(${j(a.name)}, c, "${a.resolvedType}"); markDocumentWrite(); ${a.scopes ? `v.scopes = ${j(a.scopes)};` : ""} for (const mode of c.modes) v.setValueForMode(mode.modeId, value); ${cr("create_variable", "v.id")} }`);
        break;
      case "bind_variable":
        lines.push(`{ const action = ${j(a)}; const v = await resolveVariable(action); await validateVariableCollection(action, v); const n = ${g(nid)}; ${a.property === "fills" || a.property === "strokes" ? `if (v.resolvedType && v.resolvedType !== "COLOR") throw new Error("${a.property} bindings require a COLOR variable"); const paints = [...n.${a.property}]; const paintIndex = ${a.paintIndex ?? 0}; const paint = paints[paintIndex]; if (!paint) throw new Error(\"Paint index \" + paintIndex + \" does not exist in ${a.property}\"); if (paint.type !== \"SOLID\") throw new Error(\"Paint index \" + paintIndex + \" in ${a.property} is not a solid paint\"); paints[paintIndex] = figma.variables.setBoundVariableForPaint(paint, "color", v); n.${a.property} = paints; markDocumentWrite();` : `if (v.resolvedType && v.resolvedType !== "FLOAT") throw new Error("${a.property} bindings require a FLOAT variable"); if (!("${a.property}" in n) || typeof n.setBoundVariable !== "function") throw new Error("Node does not support ${a.property} variable binding"); ${a.property === "counterAxisSpacing" ? `if (n.layoutWrap !== "WRAP") throw new Error("counterAxisSpacing bindings require wrapping auto layout");` : ""} n.setBoundVariable("${a.property}", v); markDocumentWrite();`} ${r("bind_variable")} }`);
        break;
      case "set_variable_value":
        lines.push(`{ const action = ${j(a)}; const v = await resolveVariable(action); await validateVariableCollection(action, v); const c = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId); if (!c) throw new Error("Variable collection not found"); const matches = action.modeId ? c.modes.filter(mode => mode.modeId === action.modeId) : c.modes.filter(mode => mode.name === action.modeName); if (!matches.length) throw new Error("Variable mode not found"); if (matches.length > 1) throw new Error("Variable mode name is ambiguous"); const value = parseVariableValue(v.resolvedType, action.value); v.setValueForMode(matches[0].modeId, value); markDocumentWrite(); results.push({ type: "set_variable_value", nodeId: v.id }); }`);
        break;
      case "export_node":
        lines.push(`{ const format = "${a.format}"; const scale = ${a.scale}; const bytes = await ${g(nid)}.exportAsync({ format, ...(format !== "SVG" ? { constraint: { type: "SCALE", value: scale } } : {}) }); results.push({ type: "export_node", nodeId: "${nid}", base64: figma.base64Encode(bytes) }); }`);
        break;
    }
    lines.push("  } catch (error) {");
    lines.push("    failed = true;");
    lines.push(`    results.push({ actionIndex: ${i}, type: ${j(a.type)}, status: "failed", error: error instanceof Error ? error.message : String(error) });`);
    lines.push("    if (executionOptions.stopOnError) stopProcessing = true;");
    lines.push("  }");
    lines.push("}");
    lines.push("");
  }

  lines.push("if (executionOptions.rollbackOnError && failed && documentWrites > 0) {");
  lines.push("  figma.triggerUndo();");
  lines.push("  results.push({ type: \"rollback\", status: \"applied\" });");
  lines.push("} else if (executionOptions.rollbackOnError && documentWrites > 0) {");
  lines.push("  figma.commitUndo();");
  lines.push("}");
  lines.push("return results;");
  return lines.join("\n");
}

// Re-export for local use — canonical source is src/shared/font.ts
const weightToStyle = weightToFontStyle;
