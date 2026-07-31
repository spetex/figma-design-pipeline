import type { Action } from "../shared/actions.js";
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
  "create_page", "create_variable_collection", "create_variable",
]);

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
  const fonts = new Map<string, { family: string; style: string }>();
  const compiled: Array<Record<string, unknown>> = [];
  let refCounter = 0;

  for (const action of actions) {
    const entry = { ...action } as Record<string, unknown>;

    // Assign symbolic ref for create-type actions
    if (CREATE_TYPES.has(action.type)) {
      entry._ref = createReference(refCounter++);
    }

    // Hoist font requirements
    if (action.type === "set_text_style") {
      const family = action.fontFamily || "Inter";
      const weight = action.fontWeight || 400;
      const style = WEIGHT_TO_STYLE[Math.round(weight / 100) * 100] || "Regular";
      const key = `${family}|${style}`;
      if (!fonts.has(key)) fonts.set(key, { family, style });
    }
    if (action.type === "create_text") {
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
