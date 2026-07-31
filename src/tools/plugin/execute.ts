import type { BridgeServer, BatchResult } from "../../plugin/bridge.js";
import type { SnapshotCache } from "../../pipeline/snapshot.js";
import { compileBatch } from "../../plugin/batch-compiler.js";
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
  condition: "figma.triggerUndo_unavailable";
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
  const validated: Action[] = [];
  for (const raw of params.actions) {
    const parsed = actionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid action: ${parsed.error.issues.map(i => i.message).join(", ")}`);
    }
    assertActionInputCoverage(parsed.data);
    validated.push(parsed.data);
  }

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
        condition: "figma.triggerUndo_unavailable" as const,
        message: "Fallback rollback uses figma.triggerUndo. The generated program aborts instead of silently ignoring rollbackOnError when that API is unavailable.",
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

  for (const action of actions) {
    if (action.type === "create_text" || action.type === "create_text_style") {
      const weight = action.fontWeight ?? 400;
      const style = weightToStyle(weight);
      fontsNeeded.add(`await figma.loadFontAsync({ family: "${action.fontFamily}", style: "${style}" });`);
    }
  }

  const j = JSON.stringify;
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
  lines.push("if (executionOptions.rollbackOnError && typeof figma.triggerUndo !== \"function\") {");
  lines.push("  throw new Error(\"Fallback execution environment does not support rollback (figma.triggerUndo).\");");
  lines.push("}");
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
  lines.push("const recordCreatedNode = (ref, result) => {");
  lines.push("  createdNodeIds.set(ref, result.nodeId);");
  lines.push("  results.push(result);");
  lines.push("};");
  lines.push("const markDocumentWrite = () => { documentWrites++; };");
  lines.push("const resolveRefId = (id) => {");
  lines.push("  if (typeof id !== \"string\") return id;");
  lines.push("  const match = id.match(/^\\$ref:node-(\\d+)$/);");
  lines.push("  if (!match) return id;");
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
  lines.push("  if (resolvedType !== \"COLOR\" || typeof value !== \"string\") return value;");
  lines.push("  const cleaned = value.replace(\"#\", \"\");");
  lines.push("  const expanded = cleaned.length === 3 ? cleaned.split(\"\").map((channel) => channel + channel).join(\"\") : cleaned;");
  lines.push("  return {");
  lines.push("    r: parseInt(expanded.substring(0, 2), 16) / 255,");
  lines.push("    g: parseInt(expanded.substring(2, 4), 16) / 255,");
  lines.push("    b: parseInt(expanded.substring(4, 6), 16) / 255,");
  lines.push("    a: expanded.length === 8 ? parseInt(expanded.substring(6, 8), 16) / 255 : 1,");
  lines.push("  };");
  lines.push("};");
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
    const cr = (t: string, nodeId: string) => {
      if (typeof createRef !== "string") {
        throw new Error(`Missing compiled reference for create action ${i}: ${t}`);
      }
      return `recordCreatedNode(${j(createRef)}, { type: "${t}", nodeId: ${nodeId} });`;
    };

    switch (a.type) {
      case "rename":
        lines.push(`{ ${g(nid)}.name = ${j(a.name)}; markDocumentWrite(); ${r("rename")} }`);
        break;
      case "move":
        lines.push(`{ const n = ${g(nid)}; const p = requireContainer(${j(a.targetParentId)}); ${a.insertIndex !== undefined ? `p.insertChild(${a.insertIndex}, n)` : "p.appendChild(n)"}; markDocumentWrite(); ${r("move")} }`);
        break;
      case "create_frame":
        lines.push(`{ const parent = requireContainer(${j(a.parentId)}); const f = figma.createFrame(); markDocumentWrite(); f.name = ${j(a.name)}; f.resize(${a.width}, ${a.height}); parent.appendChild(f); f.x = ${a.x}; f.y = ${a.y}; ${cr("create_frame", "f.id")} }`);
        break;
      case "create_text": {
        const fam = a.fontFamily || "Inter";
        const sty = weightToStyle(a.fontWeight || 400);
        lines.push(`{ const parent = requireContainer(${j(a.parentId)}); await figma.loadFontAsync({ family: "${fam}", style: "${sty}" }); const t = figma.createText(); markDocumentWrite(); t.fontName = { family: "${fam}", style: "${sty}" }; t.characters = ${j(a.characters)}; ${a.name ? `t.name = ${j(a.name)};` : ""} ${a.fontSize !== undefined ? `t.fontSize = ${a.fontSize};` : ""} ${a.lineHeight !== undefined ? `t.lineHeight = { value: ${a.lineHeight}, unit: "PIXELS" };` : ""} ${a.letterSpacing !== undefined ? `t.letterSpacing = { value: ${a.letterSpacing}, unit: "PIXELS" };` : ""} ${a.fills ? `t.fills = sanitizePaints(${j(a.fills)});` : ""} ${a.textCase ? `t.textCase = "${a.textCase}";` : ""} ${a.textAlignHorizontal ? `t.textAlignHorizontal = "${a.textAlignHorizontal}";` : ""} t.textAutoResize = "${a.textAutoResize || "HEIGHT"}"; ${a.opacity !== undefined ? `t.opacity = ${a.opacity};` : ""} parent.appendChild(t); ${a.layoutSizingHorizontal ? `t.layoutSizingHorizontal = "${a.layoutSizingHorizontal}";` : ""} ${a.layoutSizingVertical ? `t.layoutSizingVertical = "${a.layoutSizingVertical}";` : ""} ${cr("create_text", "t.id")} }`);
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
        lines.push(`{ const c = ${g(nid)}.clone(); markDocumentWrite(); ${cr("duplicate_node", "c.id")} }`);
        break;
      case "set_visible":
        lines.push(`{ ${g(nid)}.visible = ${a.visible}; markDocumentWrite(); ${r("set_visible")} }`);
        break;
      case "set_opacity":
        lines.push(`{ ${g(nid)}.opacity = ${a.opacity}; markDocumentWrite(); ${r("set_opacity")} }`);
        break;
      case "set_layout_mode":
        lines.push(`{ const n = ${g(nid)}; n.layoutMode = "${a.mode}"; markDocumentWrite(); ${a.primaryAxisSizingMode ? `n.primaryAxisSizingMode = "${a.primaryAxisSizingMode}"; markDocumentWrite();` : ""} ${a.counterAxisSizingMode ? `n.counterAxisSizingMode = "${a.counterAxisSizingMode}"; markDocumentWrite();` : ""} ${r("set_layout_mode")} }`);
        break;
      case "set_layout_positioning":
        lines.push(`{ ${g(nid)}.layoutPositioning = "${a.positioning}"; markDocumentWrite(); ${r("set_layout_positioning")} }`);
        break;
      case "set_alignment":
        lines.push(`{ const n = ${g(nid)}; ${a.primaryAxisAlignItems ? `n.primaryAxisAlignItems = "${a.primaryAxisAlignItems}"; markDocumentWrite();` : ""} ${a.counterAxisAlignItems ? `n.counterAxisAlignItems = "${a.counterAxisAlignItems}"; markDocumentWrite();` : ""} ${r("set_alignment")} }`);
        break;
      case "set_spacing":
        lines.push(`{ const n = ${g(nid)}; ${a.itemSpacing !== undefined ? `n.itemSpacing = ${a.itemSpacing}; markDocumentWrite();` : ""} ${a.paddingTop !== undefined ? `n.paddingTop = ${a.paddingTop}; markDocumentWrite();` : ""} ${a.paddingRight !== undefined ? `n.paddingRight = ${a.paddingRight}; markDocumentWrite();` : ""} ${a.paddingBottom !== undefined ? `n.paddingBottom = ${a.paddingBottom}; markDocumentWrite();` : ""} ${a.paddingLeft !== undefined ? `n.paddingLeft = ${a.paddingLeft}; markDocumentWrite();` : ""} ${r("set_spacing")} }`);
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
        lines.push(`{ const n = ${g(nid)}; const angle = ${(a.angle ?? 0)} * Math.PI / 180; n.fills = [{ type: "GRADIENT_${a.gradientType}", gradientStops: ${j(a.stops)}, gradientTransform: [[Math.cos(angle), Math.sin(angle), 0], [-Math.sin(angle), Math.cos(angle), 0]] }]; markDocumentWrite(); ${r("set_gradient_fill")} }`);
        break;
      case "set_image_fill":
        lines.push(`{ const img = figma.createImage(figma.base64Decode(${j(a.imageBase64)})); ${g(nid)}.fills = [{ type: "IMAGE", imageHash: img.hash, scaleMode: "${a.scaleMode || "FILL"}" }]; markDocumentWrite(); ${r("set_image_fill")} }`);
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
        lines.push(`{ const n = ${g(nid)}; if (n.fontName === figma.mixed) { const seenFonts = new Set(); for (let rangeStart = 0; rangeStart < n.characters.length; rangeStart++) { const rangeFont = n.getRangeFontName(rangeStart, rangeStart + 1); const fontKey = \`${"${rangeFont.family}|${rangeFont.style}"}\`; if (!seenFonts.has(fontKey)) { seenFonts.add(fontKey); await figma.loadFontAsync(rangeFont); } } } else { await figma.loadFontAsync(n.fontName); } n.characters = ${j(a.characters)}; markDocumentWrite(); ${r("set_text_content")} }`);
        break;
      case "set_text_style": {
        const hasFontOverride = Boolean(a.fontFamily) || a.fontWeight !== undefined;
        const family = a.fontFamily ? j(a.fontFamily) : "currentFamily";
        const style = a.fontWeight !== undefined ? j(weightToStyle(a.fontWeight)) : "currentStyle";
        lines.push(`{ const n = ${g(nid)}; const currentFont = n.fontName; if (${hasFontOverride}) { const currentFamily = currentFont === figma.mixed ? "Inter" : currentFont.family; const currentStyle = currentFont === figma.mixed ? "Regular" : currentFont.style; const family = ${family}; const style = ${style}; await figma.loadFontAsync({ family, style }); n.fontName = { family, style }; markDocumentWrite(); } else if (currentFont === figma.mixed) { const seenFonts = new Set(); for (let rangeStart = 0; rangeStart < n.characters.length; rangeStart++) { const rangeFont = n.getRangeFontName(rangeStart, rangeStart + 1); const fontKey = \`${"${rangeFont.family}|${rangeFont.style}"}\`; if (!seenFonts.has(fontKey)) { seenFonts.add(fontKey); await figma.loadFontAsync(rangeFont); } } } else { await figma.loadFontAsync(currentFont); } ${a.fontSize !== undefined ? `n.fontSize = ${a.fontSize}; markDocumentWrite();` : ""} ${a.lineHeight !== undefined ? `n.lineHeight = { value: ${a.lineHeight}, unit: "PIXELS" }; markDocumentWrite();` : ""} ${a.letterSpacing !== undefined ? `n.letterSpacing = { value: ${a.letterSpacing}, unit: "PIXELS" }; markDocumentWrite();` : ""} ${r("set_text_style")} }`);
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
        lines.push(`{ ${g(a.instanceId)}.swapComponent(${g(a.newComponentId)}); markDocumentWrite(); results.push({ type: "swap_instance" }); }`);
        break;
      case "set_component_properties":
        lines.push(`{ ${g(nid)}.setProperties(${j(a.properties)}); markDocumentWrite(); ${r("set_component_properties")} }`);
        break;
      case "define_component_property":
        lines.push(`{ ${g(nid)}.addComponentProperty(${j(a.propertyName)}, "${a.propertyType}", ${j(a.defaultValue)}); markDocumentWrite(); ${r("define_component_property")} }`);
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
        lines.push(`{ const n = ${g(nid)}; const styleId = resolveRefId(${j(a.styleId)}); ${a.property === "fill" ? "await n.setFillStyleIdAsync(styleId);" : a.property === "stroke" ? "await n.setStrokeStyleIdAsync(styleId);" : a.property === "text" ? "await n.setTextStyleIdAsync(styleId);" : "await n.setEffectStyleIdAsync(styleId);"} markDocumentWrite(); ${r("apply_style")} }`);
        break;
      case "set_description":
        lines.push(`{ ${g(nid)}.description = ${j(a.description)}; markDocumentWrite(); ${r("set_description")} }`);
        break;
      case "create_page":
        lines.push(`{ const p = figma.createPage(); markDocumentWrite(); p.name = ${j(a.name)}; ${cr("create_page", "p.id")} }`);
        break;
      case "switch_page":
        lines.push(`{ await figma.setCurrentPageAsync(getNode(${j(a.pageId)})); results.push({ type: "switch_page" }); }`);
        break;
      case "create_variable_collection":
        lines.push(`{ const c = figma.variables.createVariableCollection(${j(a.name)}); markDocumentWrite(); const modes = ${j(a.modes)}; if (modes[0]) { c.renameMode(c.modes[0].modeId, modes[0]); markDocumentWrite(); } for (let modeIndex = 1; modeIndex < modes.length; modeIndex++) { c.addMode(modes[modeIndex]); markDocumentWrite(); } ${cr("create_variable_collection", "c.id")} }`);
        break;
      case "create_variable":
        lines.push(`{ const c = figma.variables.getVariableCollectionById(resolveRefId(${j(a.collectionId)})); if (!c) throw new Error("Variable collection not found"); const v = figma.variables.createVariable(${j(a.name)}, c, "${a.resolvedType}"); markDocumentWrite(); ${a.scopes ? `v.scopes = ${j(a.scopes)};` : ""} const value = parseVariableValue("${a.resolvedType}", ${j(a.value)}); for (const mode of c.modes) v.setValueForMode(mode.modeId, value); ${cr("create_variable", "v.id")} }`);
        break;
      case "bind_variable":
        lines.push(`{ const v = figma.variables.getVariableById(resolveRefId(${j(a.variableId)})); if (!v) throw new Error("Variable not found"); const n = ${g(nid)}; ${a.property === "fills" || a.property === "strokes" ? `const paints = [...n.${a.property}]; const paintIndex = ${a.paintIndex ?? 0}; const paint = paints[paintIndex]; if (!paint) throw new Error(\"Paint index \" + paintIndex + \" does not exist in ${a.property}\"); if (paint.type !== \"SOLID\") throw new Error(\"Paint index \" + paintIndex + \" in ${a.property} is not a solid paint\"); paints[paintIndex] = figma.variables.setBoundVariableForPaint(paint, "color", v); n.${a.property} = paints; markDocumentWrite();` : `n.setBoundVariable("${a.property}", v); markDocumentWrite();`} ${r("bind_variable")} }`);
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
  lines.push("}");
  lines.push("return results;");
  return lines.join("\n");
}

// Re-export for local use — canonical source is src/shared/font.ts
const weightToStyle = weightToFontStyle;
