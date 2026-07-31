import type { ActionType } from "./actions.js";

/**
 * The executable input contract shared by both execution paths. Both the
 * connected plugin and the fallback generator reject an action that contains
 * an input field absent here. Tests derive schema fields from Zod and compare
 * them against this map, so adding an optional schema field fails coverage
 * until both executors explicitly acknowledge it.
 */
export interface ActionOperationSpec {
  inputFields: readonly string[];
}

const operation = (...inputFields: string[]): ActionOperationSpec => ({ inputFields });

export const ACTION_OPERATIONS = {
  rename: operation("nodeId", "name"),
  move: operation("nodeId", "targetParentId", "insertIndex"),
  create_text: operation("parentId", "characters", "name", "fontFamily", "fontWeight", "fontSize", "lineHeight", "letterSpacing", "fills", "textCase", "textAlignHorizontal", "textAutoResize", "layoutSizingHorizontal", "layoutSizingVertical", "opacity"),
  create_frame: operation("name", "parentId", "x", "y", "width", "height"),
  delete_node: operation("nodeId", "confirmed"),
  set_layout_mode: operation("nodeId", "mode", "primaryAxisSizingMode", "counterAxisSizingMode"),
  set_spacing: operation("nodeId", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"),
  resize: operation("nodeId", "width", "height"),
  create_component_from_node: operation("nodeId", "name"),
  create_component_set: operation("componentIds", "name"),
  create_instance: operation("componentId", "parentId", "x", "y"),
  swap_instance: operation("instanceId", "newComponentId"),
  set_fills: operation("nodeId", "fills"),
  set_text_content: operation("nodeId", "characters"),
  set_text_style: operation("nodeId", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing"),
  set_corner_radius: operation("nodeId", "radius", "radii"),
  export_node: operation("nodeId", "format", "scale"),
  set_position: operation("nodeId", "x", "y"),
  set_layout_positioning: operation("nodeId", "positioning"),
  set_visible: operation("nodeId", "visible"),
  set_opacity: operation("nodeId", "opacity"),
  set_strokes: operation("nodeId", "strokes", "strokeWeight"),
  set_effects: operation("nodeId", "effects"),
  set_alignment: operation("nodeId", "primaryAxisAlignItems", "counterAxisAlignItems"),
  duplicate_node: operation("nodeId"),
  set_component_properties: operation("nodeId", "properties"),
  create_paint_style: operation("name", "paints"),
  create_text_style: operation("name", "fontFamily", "fontWeight", "fontSize", "lineHeight", "letterSpacing"),
  create_effect_style: operation("name", "effects"),
  set_child_layout_sizing: operation("nodeId", "layoutSizingHorizontal", "layoutSizingVertical"),
  set_constraints: operation("nodeId", "horizontal", "vertical"),
  set_min_max_size: operation("nodeId", "minWidth", "maxWidth", "minHeight", "maxHeight"),
  create_page: operation("name"),
  switch_page: operation("pageId"),
  set_gradient_fill: operation("nodeId", "gradientType", "stops", "angle"),
  set_image_fill: operation("nodeId", "imageBase64", "scaleMode"),
  set_text_properties: operation("nodeId", "textAlignHorizontal", "textAlignVertical", "paragraphSpacing", "textCase", "textDecoration", "textAutoResize"),
  apply_style: operation("nodeId", "styleId", "property"),
  set_description: operation("nodeId", "description"),
  define_component_property: operation("nodeId", "propertyName", "propertyType", "defaultValue"),
  create_variable_collection: operation("name", "modes"),
  create_variable: operation("collectionId", "name", "resolvedType", "value", "scopes"),
  bind_variable: operation("nodeId", "property", "variableId", "paintIndex"),
} as const satisfies Record<ActionType, ActionOperationSpec>;

export const ACTION_TYPES = Object.keys(ACTION_OPERATIONS) as ActionType[];

/** Nodes protected from destructive actions in every execution path. */
export const FORBIDDEN_DELETE_NODE_TYPES = ["PAGE", "DOCUMENT"] as const;

export function isForbiddenDeleteNodeType(type: unknown): boolean {
  return FORBIDDEN_DELETE_NODE_TYPES.includes(
    type as typeof FORBIDDEN_DELETE_NODE_TYPES[number]
  );
}

export function isKnownActionType(type: string): type is ActionType {
  return Object.prototype.hasOwnProperty.call(ACTION_OPERATIONS, type);
}

/** Reject fields that neither executor has explicitly modeled. */
export function assertActionInputCoverage(action: Record<string, unknown>): void {
  const type = action.type;
  if (typeof type !== "string" || !isKnownActionType(type)) {
    throw new Error(`Unknown action type: ${String(type)}`);
  }
  const unsupportedFields = Object.keys(action).filter(
    (field) => field !== "type" && field !== "_ref" && !ACTION_OPERATIONS[type].inputFields.includes(field)
  );
  if (unsupportedFields.length > 0) {
    throw new Error(
      `Action ${type} contains field(s) not implemented by both executors: ${unsupportedFields.join(", ")}`
    );
  }
}

/** Test-only schema guard: makes schema/executor drift fail immediately. */
export function assertActionSchemaCoverage(type: string, schemaFields: readonly string[]): void {
  if (!isKnownActionType(type)) throw new Error(`Unknown action type: ${type}`);
  const operationFields = ACTION_OPERATIONS[type].inputFields;
  const missingFromExecutors = schemaFields.filter((field) => !operationFields.includes(field));
  const absentFromSchema = operationFields.filter((field) => !schemaFields.includes(field));
  if (missingFromExecutors.length > 0 || absentFromSchema.length > 0) {
    throw new Error(
      `Action ${type} schema/executor coverage drift: missing from executors: ${missingFromExecutors.join(", ") || "none"}; absent from schema: ${absentFromSchema.join(", ") || "none"}`
    );
  }
}
