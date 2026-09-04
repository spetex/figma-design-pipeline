import type { Action } from "../shared/actions.js";
import { isKnownActionType } from "../shared/action-parity.js";
import { WEIGHT_TO_STYLE } from "../shared/font.js";

interface CompiledBatch {
  dryRun: boolean;
  stopOnError: boolean;
  rollbackOnError: boolean;
  requiredFonts: Array<{ family: string; style: string }>;
  actions: Array<Record<string, unknown>>;
}

interface CompileOptions {
  dryRun?: boolean;
  stopOnError?: boolean;
  rollbackOnError?: boolean;
}

/** Actions whose results are addressable through `$ref:node-N`, in create-action order. */
export const CREATE_TYPES: ReadonlySet<Action["type"]> = new Set([
  "create_frame", "create_text", "create_component_from_node", "create_component_set",
  "create_instance", "duplicate_node", "create_paint_style", "create_text_style", "create_effect_style",
  "create_page", "create_variable_collection", "create_variable", "create_from_svg", "create_section",
]);

const ID_FIELDS = new Set([
  "nodeId", "parentId", "targetParentId", "componentId", "instanceId", "newComponentId",
  "componentIds", "pageId", "collectionId", "variableId", "styleId", "copyFromStyleId",
  "sectionId", "destinationId", "textStyleId",
]);

function referencesInAction(action: Record<string, unknown>): string[] {
  const references: string[] = [];
  for (const [key, value] of Object.entries(action)) {
    if (!ID_FIELDS.has(key)) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === "string" && item.startsWith("$")) references.push(item);
    }
  }
  if (action.type === "define_component_property" && action.propertyType === "INSTANCE_SWAP"
    && typeof action.defaultValue === "string" && action.defaultValue.startsWith("$")) {
    references.push(action.defaultValue);
  }
  // set_component_properties values are data unless the resolved component
  // definition says a particular key is INSTANCE_SWAP. That cannot be known
  // during static preflight, so those references are resolved at execution.
  return references;
}

/** Validate the complete symbolic-reference graph before either executor can mutate a document. */
export function preflightActionReferences(actions: ReadonlyArray<Record<string, unknown>>): void {
  const aliases = new Map<string, number>();
  const createPositions: number[] = [];
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index];
    if (CREATE_TYPES.has(action.type as Action["type"])) createPositions.push(index);
    if (typeof action.as === "string") {
      const reference = `$${action.as}`;
      const previous = aliases.get(reference);
      if (previous !== undefined) {
        throw new Error(`Action ${index}: duplicate alias ${reference} (already declared by action ${previous})`);
      }
      aliases.set(reference, index);
    }
  }

  const edges = new Map<number, number[]>();
  for (let index = 0; index < actions.length; index++) {
    for (const reference of referencesInAction(actions[index])) {
      let target: number | undefined;
      const legacy = reference.match(/^\$ref:node-(\d+)$/);
      if (legacy) target = createPositions[Number(legacy[1])];
      else if (reference.startsWith("$ref:")) {
        throw new Error(`Action ${index}: malformed legacy reference ${reference}`);
      } else target = aliases.get(reference);
      if (target === undefined) throw new Error(`Action ${index}: unknown reference ${reference}`);
      if (target === index) throw new Error(`Action ${index}: self reference ${reference}`);
      const list = edges.get(index) ?? [];
      list.push(target);
      edges.set(index, list);
    }
  }

  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (index: number): void => {
    if (visiting.has(index)) throw new Error(`Action ${index}: cyclic symbolic reference graph`);
    if (visited.has(index)) return;
    visiting.add(index);
    for (const target of edges.get(index) ?? []) visit(target);
    visiting.delete(index);
    visited.add(index);
  };
  for (let index = 0; index < actions.length; index++) visit(index);

  for (const [index, targets] of edges) {
    const forward = targets.find((target) => target > index);
    if (forward !== undefined) throw new Error(`Action ${index}: forward reference to action ${forward} is not allowed`);
  }
}

function createReference(index: number): string {
  return `$ref:node-${index}`;
}

/**
 * Return the reference that the compiler will assign to the next create action.
 *
 * Plans can use this before adding their create action so dependent actions use
 * the same create-order reference as the compiled plugin batch and fallback.
 */
export function getNextCreateReference(actions: readonly Action[]): string {
  let createCount = 0;
  for (const action of actions) {
    if (CREATE_TYPES.has(action.type)) createCount++;
  }
  return createReference(createCount);
}

/** Compile validated actions into an optimized batch with font hoisting and symbolic refs. */
export function compileBatch(actions: Action[], options: CompileOptions = {}): CompiledBatch {
  preflightActionReferences(actions as Array<Record<string, unknown>>);
  const fonts = new Map<string, { family: string; style: string }>();
  const compiled: Array<Record<string, unknown>> = [];
  let refCounter = 0;

  for (const action of actions) {
    if (!isKnownActionType(action.type)) {
      throw new Error(`Unknown action type: ${action.type}`);
    }
    const entry = { ...action } as Record<string, unknown>;

    // Assign symbolic ref for create-type actions
    if (CREATE_TYPES.has(action.type)) {
      entry._ref = createReference(refCounter++);
      if ("as" in action && typeof action.as === "string") entry._aliasRef = `$${action.as}`;
    }

    // Hoist font requirements
    if (action.type === "create_text" && !action.textStyleId && !action.textStyleName) {
      const family = (action.fontFamily as string) || "Inter";
      const weight = (action.fontWeight as number) || 400;
      const style = WEIGHT_TO_STYLE[Math.round(weight / 100) * 100] || "Regular";
      const key = `${family}|${style}`;
      if (!fonts.has(key)) fonts.set(key, { family, style });
    }
    if (action.type === "set_text_content") {
      // Default font will be loaded by the plugin from the node's existing font
      // No hoisting needed — plugin handles it
    }
    if (action.type === "create_text_style") {
      const family = action.fontFamily as string;
      const weight = (action.fontWeight as number) ?? 400;
      const style = WEIGHT_TO_STYLE[Math.round(weight / 100) * 100] || "Regular";
      const key = `${family}|${style}`;
      if (!fonts.has(key)) fonts.set(key, { family, style });
    }

    // Strip 'a' from fill/stroke colors — Figma uses {r,g,b} + opacity on the paint
    if (action.type === "set_fills" || action.type === "set_strokes" || action.type === "create_text") {
      const key = action.type === "set_strokes" ? "strokes" : "fills";
      const paints = entry[key] as Array<Record<string, unknown>> | undefined;
      if (paints) {
        entry[key] = paints.map(p => {
          if (p.color && typeof p.color === "object" && "a" in (p.color as Record<string, unknown>)) {
            const { a, ...rgb } = p.color as Record<string, unknown>;
            const cleaned: Record<string, unknown> = { ...p, color: rgb };
            // Convert 'a' to paint-level opacity if not already set
            if (a !== undefined && a !== 1 && cleaned.opacity === undefined) {
              cleaned.opacity = a;
            }
            return cleaned;
          }
          return p;
        });
      }
    }

    compiled.push(entry);
  }

  return {
    dryRun: options.dryRun ?? false,
    stopOnError: options.stopOnError ?? true,
    rollbackOnError: options.rollbackOnError ?? false,
    requiredFonts: Array.from(fonts.values()),
    actions: compiled,
  };
}
