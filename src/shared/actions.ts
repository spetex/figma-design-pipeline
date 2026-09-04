import { z } from "zod";

export const actionAliasSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, "Alias must start with a letter and contain at most 64 letters, digits, '_' or '-'")
  .refine((value) => !/^(?:node-|ref(?:-|$))/i.test(value), "Alias prefixes 'node-' and 'ref' are reserved for legacy references");

const aliasField = { as: actionAliasSchema.optional().describe("Stable batch alias; reference as $alias") };
const childPathSchema = z.array(z.string().min(1)).min(1).max(64)
  .describe("Exact direct-child names from the instance root to one unambiguous descendant");
const variableTypeSchema = z.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"]);
const variableSelectorFields = {
  variableId: z.string().optional(),
  variableName: z.string().min(1).optional(),
  collectionId: z.string().optional(),
  collectionName: z.string().min(1).optional(),
  resolvedType: variableTypeSchema.optional(),
};

// ─── Plugin Action Types (Discriminated Union) ──────────────────────

export const renameActionSchema = z
  .object({
    type: z.literal("rename"),
    nodeId: z.string(),
    name: z.string().min(1),
  })
  .strict();

export const moveActionSchema = z
  .object({
    type: z.literal("move"),
    nodeId: z.string().describe("Node to move"),
    targetParentId: z.string().describe("Target parent container ID"),
    insertIndex: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Zero-based position in target parent's children array. 0 = bottom/back of layer stack, last = top/front. Omit to append (top/front)."
      ),
  })
  .strict();

export const createTextActionSchema = z
  .object({
    type: z.literal("create_text"),
    parentId: z.string(),
    characters: z.string(),
    name: z.string().optional(),
    fontFamily: z.string().min(1).optional(),
    fontWeight: z.number().min(100).max(900).optional(),
    fontSize: z.number().min(1).optional(),
    lineHeight: z.number().optional(),
    letterSpacing: z.number().optional(),
    fills: z.array(z.object({
      type: z.enum(["SOLID"]),
      color: z.object({
        r: z.number().min(0).max(1),
        g: z.number().min(0).max(1),
        b: z.number().min(0).max(1),
        a: z.number().min(0).max(1).optional(),
      }).optional(),
      opacity: z.number().min(0).max(1).optional(),
    })).optional(),
    textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE"]).optional(),
    textAlignHorizontal: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(),
    textAutoResize: z.enum(["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"]).optional(),
    layoutSizingHorizontal: z.enum(["FILL", "HUG", "FIXED"]).optional(),
    layoutSizingVertical: z.enum(["FILL", "HUG", "FIXED"]).optional(),
    opacity: z.number().min(0).max(1).optional(),
    textTruncation: z.enum(["DISABLED", "ENDING"]).optional(),
    maxLines: z.number().int().positive().nullable().optional(),
    textStyleId: z.string().optional(),
    textStyleName: z.string().min(1).optional(),
    ...aliasField,
  })
  .strict();

export const createFrameActionSchema = z
  .object({
    type: z.literal("create_frame"),
    name: z.string().min(1),
    parentId: z.string(),
    x: z.number().default(0),
    y: z.number().default(0),
    width: z.number().min(1).default(100),
    height: z.number().min(1).default(100),
    ...aliasField,
  })
  .strict();

export const deleteNodeActionSchema = z
  .object({
    type: z.literal("delete_node"),
    nodeId: z.string(),
    /** Safety: must be explicitly set to true */
    confirmed: z.literal(true),
  })
  .strict();

export const setLayoutModeActionSchema = z
  .object({
    type: z.literal("set_layout_mode"),
    nodeId: z.string(),
    mode: z.enum(["HORIZONTAL", "VERTICAL", "NONE"]),
    primaryAxisSizingMode: z.enum(["FIXED", "AUTO"]).optional(),
    counterAxisSizingMode: z.enum(["FIXED", "AUTO"]).optional(),
    layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional(),
  })
  .strict();

export const setSpacingActionSchema = z
  .object({
    type: z.literal("set_spacing"),
    nodeId: z.string(),
    itemSpacing: z.number().min(0).optional(),
    paddingTop: z.number().min(0).optional(),
    paddingRight: z.number().min(0).optional(),
    paddingBottom: z.number().min(0).optional(),
    paddingLeft: z.number().min(0).optional(),
    counterAxisSpacing: z.number().min(0).nullable().optional(),
  })
  .strict();

export const resizeActionSchema = z
  .object({
    type: z.literal("resize"),
    nodeId: z.string(),
    width: z.number().min(1).optional(),
    height: z.number().min(1).optional(),
  })
  .strict();

export const createComponentFromNodeActionSchema = z
  .object({
    type: z.literal("create_component_from_node"),
    nodeId: z.string(),
    name: z.string().min(1),
    ...aliasField,
  })
  .strict();

export const createComponentSetActionSchema = z
  .object({
    type: z.literal("create_component_set"),
    componentIds: z.array(z.string()).min(1),
    name: z.string().min(1),
    ...aliasField,
  })
  .strict();

export const createInstanceActionSchema = z
  .object({
    type: z.literal("create_instance"),
    componentId: z.string(),
    parentId: z.string(),
    x: z.number().default(0),
    y: z.number().default(0),
    ...aliasField,
  })
  .strict();

export const swapInstanceActionSchema = z
  .object({
    type: z.literal("swap_instance"),
    instanceId: z.string(),
    newComponentId: z.string(),
  })
  .strict();

export const setFillsActionSchema = z
  .object({
    type: z.literal("set_fills"),
    nodeId: z.string(),
    fills: z.array(
      z.object({
        type: z.enum(["SOLID"]),
        color: z
          .object({
            r: z.number().min(0).max(1),
            g: z.number().min(0).max(1),
            b: z.number().min(0).max(1),
            a: z.number().min(0).max(1).optional(),
          })
          .optional(),
        opacity: z.number().min(0).max(1).optional(),
      })
    ),
  })
  .strict();

export const setTextContentActionSchema = z
  .object({
    type: z.literal("set_text_content"),
    nodeId: z.string(),
    characters: z.string(),
  })
  .strict();

export const setTextStyleActionSchema = z
  .object({
    type: z.literal("set_text_style"),
    nodeId: z.string(),
    fontFamily: z.string().optional(),
    fontSize: z.number().min(1).optional(),
    fontWeight: z.number().optional(),
    lineHeight: z.number().optional(),
    letterSpacing: z.number().optional(),
  })
  .strict();

export const setCornerRadiusActionSchema = z
  .object({
    type: z.literal("set_corner_radius"),
    nodeId: z.string(),
    radius: z.number().min(0).optional(),
    radii: z
      .tuple([z.number(), z.number(), z.number(), z.number()])
      .optional(),
  })
  .strict();

export const exportNodeActionSchema = z
  .object({
    type: z.literal("export_node"),
    nodeId: z.string(),
    format: z.enum(["PNG", "SVG", "PDF", "JPG"]).default("PNG"),
    scale: z.number().min(0.5).max(4).default(2),
  })
  .strict();

export const setPositionActionSchema = z
  .object({
    type: z.literal("set_position"),
    nodeId: z.string(),
    x: z.number().optional(),
    y: z.number().optional(),
  })
  .strict();

export const setLayoutPositioningActionSchema = z
  .object({
    type: z.literal("set_layout_positioning"),
    nodeId: z.string().describe("Child node inside auto-layout parent"),
    positioning: z
      .enum(["AUTO", "ABSOLUTE"])
      .describe(
        "AUTO = in flow, ABSOLUTE = taken out of flow (like CSS position:absolute)"
      ),
  })
  .strict();

export const setVisibleActionSchema = z
  .object({
    type: z.literal("set_visible"),
    nodeId: z.string(),
    visible: z.boolean(),
  })
  .strict();

export const setOpacityActionSchema = z
  .object({
    type: z.literal("set_opacity"),
    nodeId: z.string(),
    opacity: z.number().min(0).max(1),
  })
  .strict();

export const setStrokesActionSchema = z
  .object({
    type: z.literal("set_strokes"),
    nodeId: z.string(),
    strokes: z.array(
      z.object({
        type: z.enum(["SOLID"]),
        color: z.object({
          r: z.number().min(0).max(1),
          g: z.number().min(0).max(1),
          b: z.number().min(0).max(1),
          a: z.number().min(0).max(1).optional(),
        }),
        opacity: z.number().min(0).max(1).optional(),
      })
    ),
    strokeWeight: z.number().min(0).optional(),
  })
  .strict();

const effectColorSchema = z
  .object({
    r: z.number().min(0).max(1),
    g: z.number().min(0).max(1),
    b: z.number().min(0).max(1),
    a: z.number().min(0).max(1).default(1),
  }).strict()
  .describe("RGBA color for shadow effects");

const effectOffsetSchema = z
  .object({
    x: z.number().default(0),
    y: z.number().default(0),
  }).strict()
  .describe("Offset for shadow effects");

const effectBlendModeSchema = z.enum([
  "NORMAL",
  "MULTIPLY",
  "SCREEN",
  "OVERLAY",
  "DARKEN",
  "LINEAR_BURN",
  "LIGHTEN",
  "LINEAR_DODGE",
  "COLOR_DODGE",
  "COLOR_BURN",
  "HARD_LIGHT",
  "SOFT_LIGHT",
  "DIFFERENCE",
  "EXCLUSION",
  "HUE",
  "SATURATION",
  "COLOR",
  "LUMINOSITY",
]);

const shadowEffectBase = {
  visible: z.boolean().default(true),
  radius: z.number().min(0).default(0),
  blendMode: effectBlendModeSchema.default("NORMAL"),
  color: effectColorSchema.default({ r: 0, g: 0, b: 0, a: 0.25 }),
  offset: effectOffsetSchema.default({ x: 0, y: 0 }),
  spread: z.number().optional(),
};

const dropShadowEffectSchema = z
  .object({
    type: z.literal("DROP_SHADOW"),
    ...shadowEffectBase,
    showShadowBehindNode: z.boolean().default(false),
  }).strict()
  .describe("Drop shadow effect using the current Figma Plugin API fields");

const innerShadowEffectSchema = z
  .object({
    type: z.literal("INNER_SHADOW"),
    ...shadowEffectBase,
  }).strict()
  .describe("Inner shadow effect using the current Figma Plugin API fields");

const blurEffectSchema = z
  .object({
    type: z.enum(["LAYER_BLUR", "BACKGROUND_BLUR"]),
    blurType: z.literal("NORMAL").default("NORMAL"),
    visible: z.boolean().default(true),
    radius: z.number().min(0).default(0),
  }).strict()
  .describe("Blur effects");

export const setEffectsActionSchema = z
  .object({
    type: z.literal("set_effects"),
    nodeId: z.string(),
    effects: z.array(z.union([dropShadowEffectSchema, innerShadowEffectSchema, blurEffectSchema])),
  })
  .strict();

export const setAlignmentActionSchema = z
  .object({
    type: z.literal("set_alignment"),
    nodeId: z.string(),
    primaryAxisAlignItems: z
      .enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"])
      .optional()
      .describe("Main axis alignment (like justify-content)"),
    counterAxisAlignItems: z
      .enum(["MIN", "CENTER", "MAX", "BASELINE"])
      .optional()
      .describe("Cross axis alignment (like align-items)"),
  })
  .strict();

export const duplicateNodeActionSchema = z
  .object({
    type: z.literal("duplicate_node"),
    nodeId: z.string(),
    targetParentId: z.string().optional(),
    insertIndex: z.number().int().min(0).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    ...aliasField,
  })
  .strict();

export const setComponentPropertiesActionSchema = z
  .object({
    type: z.literal("set_component_properties"),
    nodeId: z.string().describe("Instance node ID"),
    properties: z.record(z.string(), z.union([z.string(), z.boolean()])).describe("Property name -> value map"),
  })
  .strict();

// ─── Style actions ───────────────────────────────────────────────────

export const createPaintStyleActionSchema = z
  .object({
    type: z.literal("create_paint_style"),
    name: z.string().min(1).describe("Style name (use '/' for folders, e.g. 'Brand/Primary')"),
    paints: z.array(
      z.object({
        type: z.enum(["SOLID"]),
        color: z.object({
          r: z.number().min(0).max(1),
          g: z.number().min(0).max(1),
          b: z.number().min(0).max(1),
          a: z.number().min(0).max(1).optional(),
        }),
        opacity: z.number().min(0).max(1).optional(),
      })
    ),
    ...aliasField,
  })
  .strict();

export const createTextStyleActionSchema = z
  .object({
    type: z.literal("create_text_style"),
    name: z.string().min(1).describe("Style name (use '/' for folders)"),
    fontFamily: z.string().describe("Font family, e.g. 'Inter'"),
    fontWeight: z.number().default(400).describe("Font weight (100-900)"),
    fontSize: z.number().min(1).describe("Font size in pixels"),
    lineHeight: z.number().optional().describe("Line height in pixels"),
    letterSpacing: z.number().optional().describe("Letter spacing in pixels"),
    ...aliasField,
  })
  .strict();

export const createEffectStyleActionSchema = z
  .object({
    type: z.literal("create_effect_style"),
    name: z.string().min(1).describe("Style name (use '/' for folders)"),
    effects: z.array(z.union([dropShadowEffectSchema, innerShadowEffectSchema, blurEffectSchema])),
    ...aliasField,
  })
  .strict();

// ─── Responsive Layout Actions ──────────────────────────────────────

export const setChildLayoutSizingActionSchema = z
  .object({
    type: z.literal("set_child_layout_sizing"),
    nodeId: z.string().describe("Child node inside an auto-layout parent"),
    layoutSizingHorizontal: z.enum(["FILL", "HUG", "FIXED"]).optional(),
    layoutSizingVertical: z.enum(["FILL", "HUG", "FIXED"]).optional(),
  })
  .strict();

export const setConstraintsActionSchema = z
  .object({
    type: z.literal("set_constraints"),
    nodeId: z.string(),
    horizontal: z.enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"]).optional(),
    vertical: z.enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"]).optional(),
  })
  .strict();

export const setMinMaxSizeActionSchema = z
  .object({
    type: z.literal("set_min_max_size"),
    nodeId: z.string(),
    minWidth: z.number().min(0).optional(),
    maxWidth: z.number().min(0).optional(),
    minHeight: z.number().min(0).optional(),
    maxHeight: z.number().min(0).optional(),
  })
  .strict();

// ─── Page Management Actions ────────────────────────────────────────

export const createPageActionSchema = z
  .object({
    type: z.literal("create_page"),
    name: z.string().min(1),
    ...aliasField,
  })
  .strict();

export const switchPageActionSchema = z
  .object({
    type: z.literal("switch_page"),
    pageId: z.string().describe("Page node ID to switch to"),
  })
  .strict();

// ─── Rich Content Actions ───────────────────────────────────────────

const transformSchema = z.tuple([
  z.tuple([z.number(), z.number(), z.number()]),
  z.tuple([z.number(), z.number(), z.number()]),
]).superRefine((transform, ctx) => {
  const determinant = transform[0][0] * transform[1][1] - transform[0][1] * transform[1][0];
  if (Math.abs(determinant) < Number.EPSILON) {
    ctx.addIssue({ code: "custom", message: "gradientTransform must be invertible" });
  }
});

const gradientStopsSchema = z.array(z.object({
  position: z.number().min(0).max(1),
  color: z.object({
    r: z.number().min(0).max(1),
    g: z.number().min(0).max(1),
    b: z.number().min(0).max(1),
    a: z.number().min(0).max(1).default(1),
  }).strict(),
}).strict()).min(2);

const gradientSchema = z.object({
  gradientType: z.enum(["LINEAR", "RADIAL", "ANGULAR"]).default("LINEAR"),
  stops: gradientStopsSchema,
  angle: z.number().optional().describe("Angle in degrees; ignored when gradientTransform is supplied"),
  gradientTransform: transformSchema.optional(),
  visible: z.boolean().optional(),
  opacity: z.number().min(0).max(1).optional(),
  blendMode: effectBlendModeSchema.optional(),
}).strict().superRefine((gradient, ctx) => {
  if (gradient.angle !== undefined && gradient.gradientTransform !== undefined) {
    ctx.addIssue({ code: "custom", message: "gradient accepts angle or gradientTransform, not both" });
  }
});

export const setGradientFillActionSchema = z
  .object({
    type: z.literal("set_gradient_fill"),
    nodeId: z.string(),
    gradientType: z.enum(["LINEAR", "RADIAL", "ANGULAR"]).optional(),
    stops: gradientStopsSchema.optional(),
    angle: z.number().optional().describe("Angle in degrees for linear gradients (0 = top to bottom)"),
    gradientTransform: transformSchema.optional(),
    gradients: z.array(gradientSchema).min(1).optional()
      .describe("Ordered gradient fills; use for layered linear/radial scrims"),
  })
  .strict();

export const setImageFillActionSchema = z
  .object({
    type: z.literal("set_image_fill"),
    nodeId: z.string(),
    imageBase64: z.string().optional().describe("Base64-encoded image data"),
    path: z.string().min(1).optional().describe("Server-local image path; read and validated before transport"),
    url: z.url().optional().describe("Public HTTP(S) image URL; fetched and validated before transport"),
    scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).default("FILL"),
  })
  .strict();

// ─── Text Enhancement Actions ───────────────────────────────────────

export const setTextPropertiesActionSchema = z
  .object({
    type: z.literal("set_text_properties"),
    nodeId: z.string(),
    textAlignHorizontal: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(),
    textAlignVertical: z.enum(["TOP", "CENTER", "BOTTOM"]).optional(),
    paragraphSpacing: z.number().min(0).optional(),
    textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE"]).optional(),
    textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
    textAutoResize: z.enum(["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"]).optional(),
  })
  .strict();

// ─── Style Binding Actions ──────────────────────────────────────────

export const applyStyleActionSchema = z
  .object({
    type: z.literal("apply_style"),
    nodeId: z.string(),
    styleId: z.string().optional().describe("Paint/text/effect style ID"),
    styleName: z.string().min(1).optional().describe("Exact local style name"),
    property: z.enum(["fill", "stroke", "text", "effect"]),
  })
  .strict();

export const setDescriptionActionSchema = z
  .object({
    type: z.literal("set_description"),
    nodeId: z.string(),
    description: z.string(),
  })
  .strict();

// ─── Component Property Definition ──────────────────────────────────

export const defineComponentPropertyActionSchema = z
  .object({
    type: z.literal("define_component_property"),
    nodeId: z.string().describe("Master component ID"),
    propertyName: z.string(),
    propertyType: z.enum(["TEXT", "BOOLEAN", "INSTANCE_SWAP", "VARIANT"]),
    defaultValue: z.union([z.string(), z.boolean()]),
  })
  .strict();

export const setComponentPropertyReferenceActionSchema = z
  .object({
    type: z.literal("set_component_property_reference"),
    nodeId: z.string().describe("Component or component-set descendant node"),
    property: z.enum(["characters", "visible", "mainComponent"]),
    componentPropertyName: z.string().min(1).describe("Exact display name or internal Prop#id key"),
  })
  .strict();

export const setInstanceTextActionSchema = z
  .object({ type: z.literal("set_instance_text"), instanceId: z.string(), childPath: childPathSchema, characters: z.string() })
  .strict();

export const setInstanceVisibilityActionSchema = z
  .object({ type: z.literal("set_instance_visibility"), instanceId: z.string(), childPath: childPathSchema, visible: z.boolean() })
  .strict();

export const swapNestedInstanceActionSchema = z
  .object({ type: z.literal("swap_nested_instance"), instanceId: z.string(), childPath: childPathSchema, newComponentId: z.string() })
  .strict();

// ─── Figma Variables Actions ────────────────────────────────────────

export const createVariableCollectionActionSchema = z
  .object({
    type: z.literal("create_variable_collection"),
    name: z.string().min(1),
    modes: z.array(z.string()).default(["Default"]).describe("Mode names (e.g., ['Light', 'Dark'])"),
    ...aliasField,
  })
  .strict();

export const createVariableActionSchema = z
  .object({
    type: z.literal("create_variable"),
    collectionId: z.string().describe("Variable collection ID (use $ref: for recently created)"),
    name: z.string().min(1).describe("Variable name (use '/' for folders, e.g., 'color/brand/primary')"),
    resolvedType: z.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"]),
    value: z.unknown().describe("Value matching the type: hex string for COLOR, number for FLOAT, etc."),
    scopes: z.array(z.string()).optional().describe("Scope list, e.g., ['FRAME_FILL', 'SHAPE_FILL'] — defaults to ALL_SCOPES if omitted"),
    ...aliasField,
  })
  .strict();

export const bindVariableActionSchema = z
  .object({
    type: z.literal("bind_variable"),
    nodeId: z.string(),
    property: z.enum([
      "fills", "strokes",
      "paddingLeft", "paddingRight", "paddingTop", "paddingBottom",
      "itemSpacing", "cornerRadius", "opacity",
      "width", "height", "topLeftRadius", "topRightRadius",
      "bottomRightRadius", "bottomLeftRadius", "counterAxisSpacing",
    ]),
    ...variableSelectorFields,
    paintIndex: z.number().int().min(0).optional().describe("For fills/strokes: which paint in the array to bind (default 0)"),
  })
  .strict();

export const setVariableValueActionSchema = z
  .object({
    type: z.literal("set_variable_value"),
    ...variableSelectorFields,
    modeId: z.string().optional(),
    modeName: z.string().min(1).optional(),
    value: z.unknown(),
  })
  .strict();

export const updateStyleActionSchema = z
  .object({
    type: z.literal("update_style"),
    styleType: z.enum(["PAINT", "TEXT", "EFFECT"]),
    styleId: z.string().optional(),
    styleName: z.string().min(1).optional(),
    copyFromStyleId: z.string().optional(),
    copyFromStyleName: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    paints: z.array(z.object({
      type: z.literal("SOLID"),
      color: z.object({ r: z.number().min(0).max(1), g: z.number().min(0).max(1), b: z.number().min(0).max(1), a: z.number().min(0).max(1).optional() }),
      opacity: z.number().min(0).max(1).optional(),
    })).optional(),
    effects: z.array(z.union([dropShadowEffectSchema, innerShadowEffectSchema, blurEffectSchema])).optional(),
    fontFamily: z.string().min(1).optional(),
    fontWeight: z.number().min(100).max(900).optional(),
    fontSize: z.number().min(1).optional(),
    lineHeight: z.number().positive().optional(),
    letterSpacing: z.number().optional(),
  })
  .strict();

export const createFromSvgActionSchema = z
  .object({
    type: z.literal("create_from_svg"), parentId: z.string(), svg: z.string().min(1),
    name: z.string().min(1).optional(), x: z.number().default(0), y: z.number().default(0), ...aliasField,
  })
  .strict();

export const createSectionActionSchema = z
  .object({
    type: z.literal("create_section"), parentId: z.string(), name: z.string().min(1),
    x: z.number().default(0), y: z.number().default(0), width: z.number().min(0.01).default(100),
    height: z.number().min(0.01).default(100), ...aliasField,
  })
  .strict();

export const resizeSectionActionSchema = z
  .object({ type: z.literal("resize_section"), sectionId: z.string(), width: z.number().min(0.01), height: z.number().min(0.01) })
  .strict();

export const moveToSectionActionSchema = z
  .object({ type: z.literal("move_to_section"), nodeId: z.string(), sectionId: z.string(), insertIndex: z.number().int().min(0).optional() })
  .strict();

export const setReactionActionSchema = z
  .object({
    type: z.literal("set_reaction"), nodeId: z.string(), trigger: z.literal("ON_CLICK"), destinationId: z.string(),
    navigation: z.enum(["NAVIGATE", "OVERLAY", "SWAP", "SCROLL_TO"]), mode: z.enum(["append", "replace"]),
  })
  .strict();

// ─── Union of all actions ────────────────────────────────────────────

export const actionSchema = z.discriminatedUnion("type", [
  // Core scene graph
  renameActionSchema,
  moveActionSchema,
  createFrameActionSchema,
  createTextActionSchema,
  deleteNodeActionSchema,
  resizeActionSchema,
  setPositionActionSchema,
  duplicateNodeActionSchema,
  setVisibleActionSchema,
  setOpacityActionSchema,
  // Layout
  setLayoutModeActionSchema,
  setLayoutPositioningActionSchema,
  setAlignmentActionSchema,
  setSpacingActionSchema,
  setChildLayoutSizingActionSchema,
  setConstraintsActionSchema,
  setMinMaxSizeActionSchema,
  // Appearance
  setFillsActionSchema,
  setGradientFillActionSchema,
  setImageFillActionSchema,
  setStrokesActionSchema,
  setEffectsActionSchema,
  setCornerRadiusActionSchema,
  // Text
  setTextContentActionSchema,
  setTextStyleActionSchema,
  setTextPropertiesActionSchema,
  // Components
  createComponentFromNodeActionSchema,
  createComponentSetActionSchema,
  createInstanceActionSchema,
  swapInstanceActionSchema,
  setComponentPropertiesActionSchema,
  defineComponentPropertyActionSchema,
  setComponentPropertyReferenceActionSchema,
  setInstanceTextActionSchema,
  setInstanceVisibilityActionSchema,
  swapNestedInstanceActionSchema,
  // Styles
  createPaintStyleActionSchema,
  createTextStyleActionSchema,
  createEffectStyleActionSchema,
  applyStyleActionSchema,
  updateStyleActionSchema,
  setDescriptionActionSchema,
  // Pages
  createPageActionSchema,
  switchPageActionSchema,
  // Variables (design tokens)
  createVariableCollectionActionSchema,
  createVariableActionSchema,
  bindVariableActionSchema,
  setVariableValueActionSchema,
  // Safe assets, board organization, and prototypes
  createFromSvgActionSchema,
  createSectionActionSchema,
  resizeSectionActionSchema,
  moveToSectionActionSchema,
  setReactionActionSchema,
  // Export
  exportNodeActionSchema,
]).superRefine((action, ctx) => {
  const record = action as Record<string, unknown>;
  const exactlyOne = (fields: string[], label: string) => {
    if (fields.filter((field) => record[field] !== undefined).length !== 1) {
      ctx.addIssue({ code: "custom", message: `${label} requires exactly one of ${fields.join(" or ")}` });
    }
  };
  const atMostOne = (fields: string[], label: string) => {
    if (fields.filter((field) => record[field] !== undefined).length > 1) {
      ctx.addIssue({ code: "custom", message: `${label} accepts at most one of ${fields.join(" or ")}` });
    }
  };
  if (action.type === "set_image_fill") exactlyOne(["imageBase64", "path", "url"], "set_image_fill");
  if (action.type === "set_gradient_fill") {
    exactlyOne(["stops", "gradients"], "set_gradient_fill");
    if (action.gradients !== undefined && (action.gradientType !== undefined || action.angle !== undefined || action.gradientTransform !== undefined)) {
      ctx.addIssue({ code: "custom", message: "set_gradient_fill gradients cannot be combined with legacy single-gradient fields" });
    }
    if (action.angle !== undefined && action.gradientTransform !== undefined) {
      ctx.addIssue({ code: "custom", message: "set_gradient_fill accepts angle or gradientTransform, not both" });
    }
  }
  if (action.type === "bind_variable" || action.type === "set_variable_value") {
    exactlyOne(["variableId", "variableName"], action.type);
    atMostOne(["collectionId", "collectionName"], action.type);
  }
  if (action.type === "bind_variable" && action.paintIndex !== undefined
    && action.property !== "fills" && action.property !== "strokes") {
    ctx.addIssue({ code: "custom", message: "bind_variable paintIndex is only valid for fills or strokes" });
  }
  if (action.type === "set_variable_value") exactlyOne(["modeId", "modeName"], "set_variable_value mode");
  if (action.type === "apply_style") exactlyOne(["styleId", "styleName"], "apply_style");
  if (action.type === "update_style") {
    exactlyOne(["styleId", "styleName"], "update_style target");
    atMostOne(["copyFromStyleId", "copyFromStyleName"], "update_style source");
  }
  if (action.type === "create_text") {
    atMostOne(["textStyleId", "textStyleName"], "create_text style");
    if (action.maxLines !== undefined && action.maxLines !== null && action.textTruncation !== "ENDING") {
      ctx.addIssue({ code: "custom", message: "create_text maxLines requires textTruncation: ENDING" });
    }
  }
  if (action.type === "duplicate_node" && action.insertIndex !== undefined && action.targetParentId === undefined) {
    ctx.addIssue({ code: "custom", message: "duplicate_node insertIndex requires targetParentId" });
  }
  if (action.type === "define_component_property") {
    const needsBoolean = action.propertyType === "BOOLEAN";
    if ((needsBoolean && typeof action.defaultValue !== "boolean") || (!needsBoolean && typeof action.defaultValue !== "string")) {
      ctx.addIssue({ code: "custom", message: `define_component_property ${action.propertyType} has an incompatible defaultValue` });
    }
  }
});

export type Action = z.infer<typeof actionSchema>;
export type ActionType = Action["type"];
