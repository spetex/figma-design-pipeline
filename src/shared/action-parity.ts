import type { ActionType } from "./actions.js";

/**
 * The execution contract shared by the plugin batch executor and fallback
 * generator. `schemaFields` documents every validated input field; fields
 * that are only validation guards (such as `confirmed`) are intentionally
 * absent from `operationFields`.
 */
export interface ActionParitySpec {
  schemaFields: readonly string[];
  operationFields: readonly string[];
}

export const ACTION_PARITY = {
  rename: { schemaFields: ["nodeId", "name"], operationFields: ["nodeId", "name"] },
  move: { schemaFields: ["nodeId", "targetParentId", "insertIndex"], operationFields: ["nodeId", "targetParentId", "insertIndex"] },
  create_text: { schemaFields: ["parentId", "characters", "name", "fontFamily", "fontWeight", "fontSize", "lineHeight", "letterSpacing", "fills", "textCase", "textAlignHorizontal", "textAutoResize", "layoutSizingHorizontal", "layoutSizingVertical", "opacity"], operationFields: ["parentId", "characters", "name", "fontFamily", "fontWeight", "fontSize", "lineHeight", "letterSpacing", "fills", "textCase", "textAlignHorizontal", "textAutoResize", "layoutSizingHorizontal", "layoutSizingVertical", "opacity"] },
  create_frame: { schemaFields: ["name", "parentId", "x", "y", "width", "height"], operationFields: ["name", "parentId", "x", "y", "width", "height"] },
  delete_node: { schemaFields: ["nodeId", "confirmed"], operationFields: ["nodeId"] },
  set_layout_mode: { schemaFields: ["nodeId", "mode", "primaryAxisSizingMode", "counterAxisSizingMode"], operationFields: ["nodeId", "mode", "primaryAxisSizingMode", "counterAxisSizingMode"] },
  set_spacing: { schemaFields: ["nodeId", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"], operationFields: ["nodeId", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] },
  resize: { schemaFields: ["nodeId", "width", "height"], operationFields: ["nodeId", "width", "height"] },
  create_component_from_node: { schemaFields: ["nodeId", "name"], operationFields: ["nodeId", "name"] },
  create_component_set: { schemaFields: ["componentIds", "name"], operationFields: ["componentIds", "name"] },
  create_instance: { schemaFields: ["componentId", "parentId", "x", "y"], operationFields: ["componentId", "parentId", "x", "y"] },
  swap_instance: { schemaFields: ["instanceId", "newComponentId"], operationFields: ["instanceId", "newComponentId"] },
  set_fills: { schemaFields: ["nodeId", "fills"], operationFields: ["nodeId", "fills"] },
  set_text_content: { schemaFields: ["nodeId", "characters"], operationFields: ["nodeId", "characters"] },
  set_text_style: { schemaFields: ["nodeId", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing"], operationFields: ["nodeId", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing"] },
  set_corner_radius: { schemaFields: ["nodeId", "radius", "radii"], operationFields: ["nodeId", "radius", "radii"] },
  export_node: { schemaFields: ["nodeId", "format", "scale"], operationFields: ["nodeId", "format", "scale"] },
  set_position: { schemaFields: ["nodeId", "x", "y"], operationFields: ["nodeId", "x", "y"] },
  set_layout_positioning: { schemaFields: ["nodeId", "positioning"], operationFields: ["nodeId", "positioning"] },
  set_visible: { schemaFields: ["nodeId", "visible"], operationFields: ["nodeId", "visible"] },
  set_opacity: { schemaFields: ["nodeId", "opacity"], operationFields: ["nodeId", "opacity"] },
  set_strokes: { schemaFields: ["nodeId", "strokes", "strokeWeight"], operationFields: ["nodeId", "strokes", "strokeWeight"] },
  set_effects: { schemaFields: ["nodeId", "effects"], operationFields: ["nodeId", "effects"] },
  set_alignment: { schemaFields: ["nodeId", "primaryAxisAlignItems", "counterAxisAlignItems"], operationFields: ["nodeId", "primaryAxisAlignItems", "counterAxisAlignItems"] },
  duplicate_node: { schemaFields: ["nodeId"], operationFields: ["nodeId"] },
  set_component_properties: { schemaFields: ["nodeId", "properties"], operationFields: ["nodeId", "properties"] },
  create_paint_style: { schemaFields: ["name", "paints"], operationFields: ["name", "paints"] },
  create_text_style: { schemaFields: ["name", "fontFamily", "fontWeight", "fontSize", "lineHeight", "letterSpacing"], operationFields: ["name", "fontFamily", "fontWeight", "fontSize", "lineHeight", "letterSpacing"] },
  create_effect_style: { schemaFields: ["name", "effects"], operationFields: ["name", "effects"] },
  set_child_layout_sizing: { schemaFields: ["nodeId", "layoutSizingHorizontal", "layoutSizingVertical"], operationFields: ["nodeId", "layoutSizingHorizontal", "layoutSizingVertical"] },
  set_constraints: { schemaFields: ["nodeId", "horizontal", "vertical"], operationFields: ["nodeId", "horizontal", "vertical"] },
  set_min_max_size: { schemaFields: ["nodeId", "minWidth", "maxWidth", "minHeight", "maxHeight"], operationFields: ["nodeId", "minWidth", "maxWidth", "minHeight", "maxHeight"] },
  create_page: { schemaFields: ["name"], operationFields: ["name"] },
  switch_page: { schemaFields: ["pageId"], operationFields: ["pageId"] },
  set_gradient_fill: { schemaFields: ["nodeId", "gradientType", "stops", "angle"], operationFields: ["nodeId", "gradientType", "stops", "angle"] },
  set_image_fill: { schemaFields: ["nodeId", "imageBase64", "scaleMode"], operationFields: ["nodeId", "imageBase64", "scaleMode"] },
  set_text_properties: { schemaFields: ["nodeId", "textAlignHorizontal", "textAlignVertical", "paragraphSpacing", "textCase", "textDecoration", "textAutoResize"], operationFields: ["nodeId", "textAlignHorizontal", "textAlignVertical", "paragraphSpacing", "textCase", "textDecoration", "textAutoResize"] },
  apply_style: { schemaFields: ["nodeId", "styleId", "property"], operationFields: ["nodeId", "styleId", "property"] },
  set_description: { schemaFields: ["nodeId", "description"], operationFields: ["nodeId", "description"] },
  define_component_property: { schemaFields: ["nodeId", "propertyName", "propertyType", "defaultValue"], operationFields: ["nodeId", "propertyName", "propertyType", "defaultValue"] },
  create_variable_collection: { schemaFields: ["name", "modes"], operationFields: ["name", "modes"] },
  create_variable: { schemaFields: ["collectionId", "name", "resolvedType", "value", "scopes"], operationFields: ["collectionId", "name", "resolvedType", "value", "scopes"] },
  bind_variable: { schemaFields: ["nodeId", "property", "variableId", "paintIndex"], operationFields: ["nodeId", "property", "variableId", "paintIndex"] },
} as const satisfies Record<ActionType, ActionParitySpec>;

export const ACTION_TYPES = Object.keys(ACTION_PARITY) as ActionType[];

/** Actions that do not change the document and must never make rollback eligible. */
export const NON_DOCUMENT_WRITE_ACTION_TYPES = [
  "export_node",
  "switch_page",
] as const satisfies readonly ActionType[];

export function isKnownActionType(type: string): type is ActionType {
  return Object.prototype.hasOwnProperty.call(ACTION_PARITY, type);
}

export function actionWritesDocument(type: ActionType): boolean {
  return !NON_DOCUMENT_WRITE_ACTION_TYPES.includes(
    type as typeof NON_DOCUMENT_WRITE_ACTION_TYPES[number]
  );
}
