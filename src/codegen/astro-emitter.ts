import { extname, posix } from "node:path";
import type {
  CodegenDiagnostic,
  EnrichedNode,
  ComponentMapping,
  GeneratedFile,
} from "../shared/types.js";
import { toPascal } from "../shared/naming.js";

interface EmitOptions {
  mappings: ComponentMapping[];
  tree: EnrichedNode;
  templateType: string;
  schemaId?: string;
}

export interface AstroEmitResult {
  file: GeneratedFile;
  diagnostics: CodegenDiagnostic[];
  mappingsUsed: number;
}

interface PropBinding {
  propName: string;
  fieldName: string;
  type: string;
  required: boolean;
}

interface PreparedMapping {
  mapping: ComponentMapping;
  importPath: string;
  baseSymbol: string;
  propBindings: PropBinding[];
}

interface RenderContext {
  mappingsByNode: Map<string, PreparedMapping>;
  renderedMappings: Set<PreparedMapping>;
  importedPaths: Map<string, string>;
  imports: Set<string>;
  usedSymbols: Set<string>;
}

const SUPPORTED_COMPONENT_EXTENSIONS = new Set([".astro", ".tsx", ".jsx"]);
const TEMPLATE_DIRECTORY = "src/components/templates";
const RESERVED_IDENTIFIERS = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "enum", "export", "extends", "false",
  "finally", "for", "function", "if", "implements", "import", "in", "instanceof",
  "interface", "let", "new", "null", "package", "private", "protected", "public",
  "return", "static", "super", "switch", "this", "throw", "true", "try", "typeof",
  "var", "void", "while", "with", "yield", "arguments", "eval",
]);

/**
 * Generate an Astro page template from enriched tree and component mappings.
 * Invalid registry metadata is diagnosed and excluded instead of producing invalid syntax.
 */
export function emitAstroTemplate(options: EmitOptions): AstroEmitResult {
  const { mappings, tree, templateType, schemaId } = options;
  const diagnostics: CodegenDiagnostic[] = [];
  const mappingsByNode = prepareMappings(mappings, diagnostics);
  const bodyLines: string[] = [];
  const context: RenderContext = {
    mappingsByNode,
    renderedMappings: new Set(),
    importedPaths: new Map(),
    imports: new Set([
      'import Section from "@/components/ui/Section.astro";',
      'import Container from "@/components/ui/Container.astro";',
      'import Heading from "@/components/ui/Heading.astro";',
      'import Text from "@/components/ui/Text.astro";',
    ]),
    usedSymbols: new Set(["Section", "Container", "Heading", "Text"]),
  };

  emitNodeContent(tree, context, bodyLines, 0);
  diagnoseUnrenderedMappings(tree, mappingsByNode, context.renderedMappings, diagnostics);

  const propsInterface = generatePropsInterface(templateType, context.renderedMappings);
  const sortedImports = [...context.imports].sort();
  const content = `---
${sortedImports.join("\n")}

${propsInterface}
---

<main
  data-content-collection="${schemaId || templateType}"
  data-content-id={data.id}
>
${bodyLines.join("\n")}
</main>
`;

  return {
    file: {
      path: `src/components/templates/${toPascal(templateType)}Template.astro`,
      content,
      type: "astro",
    },
    diagnostics,
    mappingsUsed: context.renderedMappings.size,
  };
}

function prepareMappings(
  mappings: ComponentMapping[],
  diagnostics: CodegenDiagnostic[]
): Map<string, PreparedMapping> {
  const mappingsByNode = new Map<string, PreparedMapping>();

  for (const mapping of mappings) {
    if (mappingsByNode.has(mapping.figmaNodeId)) {
      diagnostics.push(diagnostic(
        mapping,
        "DUPLICATE_NODE_MAPPING",
        `Figma node ${JSON.stringify(mapping.figmaNodeId)} has more than one component mapping; only one component can be rendered for a node.`
      ));
      continue;
    }

    const importPath = registryPathToImport(mapping, diagnostics);
    const propBindings = preparePropBindings(mapping, diagnostics);
    const validName = validateComponentName(mapping, diagnostics);
    if (!importPath || !propBindings || !validName) continue;

    mappingsByNode.set(mapping.figmaNodeId, {
      mapping,
      importPath,
      baseSymbol: componentSymbol(mapping),
      propBindings,
    });
  }

  return mappingsByNode;
}

function preparePropBindings(
  mapping: ComponentMapping,
  diagnostics: CodegenDiagnostic[]
): PropBinding[] | null {
  if (!Array.isArray(mapping.componentProps)) {
    diagnostics.push(diagnostic(
      mapping,
      "INVALID_COMPONENT_PROP",
      `Registry component ${mapping.cmsComponent} has a non-array props declaration.`
    ));
    return null;
  }
  if (
    !mapping.propMappings || typeof mapping.propMappings !== "object" ||
    Array.isArray(mapping.propMappings)
  ) {
    diagnostics.push(diagnostic(
      mapping,
      "INVALID_PROP_MAPPINGS",
      `Registry component ${mapping.cmsComponent} has a non-object schema-field mapping.`
    ));
    return null;
  }

  const propsByName = new Map<string, ComponentMapping["componentProps"][number]>();
  let valid = true;

  for (const prop of mapping.componentProps) {
    if (
      !prop || typeof prop.name !== "string" || typeof prop.type !== "string" ||
      typeof prop.required !== "boolean"
    ) {
      diagnostics.push(diagnostic(
        mapping,
        "INVALID_COMPONENT_PROP",
        `Registry component ${mapping.cmsComponent} has a prop declaration without a string name/type and boolean required flag.`
      ));
      valid = false;
      continue;
    }
    if (propsByName.has(prop.name)) {
      diagnostics.push(diagnostic(
        mapping,
        "DUPLICATE_COMPONENT_PROP",
        `Registry component ${mapping.cmsComponent} declares prop ${JSON.stringify(prop.name)} more than once.`
      ));
      valid = false;
      continue;
    }
    propsByName.set(prop.name, prop);
  }

  for (const prop of mapping.componentProps) {
    if (!prop || typeof prop.name !== "string" || typeof prop.required !== "boolean") continue;
    if (prop.required && !Object.hasOwn(mapping.propMappings, prop.name)) {
      diagnostics.push(diagnostic(
        mapping,
        "MISSING_REQUIRED_PROP_MAPPING",
        `Required prop ${JSON.stringify(prop.name)} on registry component ${mapping.cmsComponent} has no schema-field mapping.`
      ));
      valid = false;
    }
  }

  const propBindings: PropBinding[] = [];
  for (const [propName, fieldName] of Object.entries(mapping.propMappings)) {
    const prop = propsByName.get(propName);
    if (!prop) {
      diagnostics.push(diagnostic(
        mapping,
        "UNKNOWN_COMPONENT_PROP",
        `Schema field ${JSON.stringify(fieldName)} maps to undeclared prop ${JSON.stringify(propName)} on registry component ${mapping.cmsComponent}.`
      ));
      valid = false;
      continue;
    }
    if (typeof fieldName !== "string" || fieldName.length === 0) {
      diagnostics.push(diagnostic(
        mapping,
        "INVALID_SCHEMA_FIELD",
        `Prop ${JSON.stringify(propName)} on registry component ${mapping.cmsComponent} maps to an empty schema-field name.`
      ));
      valid = false;
      continue;
    }

    const type = representableType(prop.type);
    if (!type) {
      diagnostics.push(diagnostic(
        mapping,
        "UNSUPPORTED_COMPONENT_PROP_TYPE",
        `Prop ${JSON.stringify(propName)} on registry component ${mapping.cmsComponent} uses type ${JSON.stringify(prop.type)}, which Astro codegen cannot emit without an external type declaration. Use primitives, literals, arrays, tuples, unions, intersections, Array, ReadonlyArray, or Record.`
      ));
      valid = false;
      continue;
    }

    propBindings.push({ propName, fieldName, type, required: prop.required });
  }

  return valid ? propBindings : null;
}

function generatePropsInterface(
  templateType: string,
  renderedMappings: Set<PreparedMapping>
): string {
  const typeName = `${toPascal(templateType)}Data`;
  const fields = new Map<string, { types: Set<string>; required: boolean }>();
  addDataField(fields, "id", "string", true);
  addDataField(fields, "title", "string", false);
  addDataField(fields, "description", "string", false);
  addDataField(fields, "image", "{ url?: string; alt?: string }", false);

  for (const prepared of renderedMappings) {
    for (const binding of prepared.propBindings) {
      addDataField(fields, binding.fieldName, binding.type, binding.required);
    }
  }

  const fieldLines = [...fields.entries()].map(([name, field]) => {
    const types = [...field.types];
    const type = types.length === 1
      ? types[0]
      : types.map((entry) => `(${entry})`).join(" & ");
    return `  ${JSON.stringify(name)}${field.required ? "" : "?"}: ${type};`;
  });

  return `interface ${typeName} {
${fieldLines.join("\n")}
}

interface Props {
  data: ${typeName};
  isPreview?: boolean;
}

const { data, isPreview = false } = Astro.props;`;
}

function addDataField(
  fields: Map<string, { types: Set<string>; required: boolean }>,
  name: string,
  type: string,
  required: boolean
): void {
  const existing = fields.get(name);
  if (existing) {
    existing.types.add(type);
    existing.required ||= required;
    return;
  }
  fields.set(name, { types: new Set([type]), required });
}

function emitNodeContent(
  node: EnrichedNode,
  context: RenderContext,
  lines: string[],
  indent: number
): void {
  const pad = "  ".repeat(indent);
  const prepared = context.mappingsByNode.get(node.id);

  if (prepared) {
    const compName = registerRenderedMapping(prepared, context);
    if (prepared.propBindings.length > 0) {
      lines.push(`${pad}<${compName}`);
      lines.push(`${pad}  {...{`);
      for (const binding of prepared.propBindings) {
        lines.push(
          `${pad}    [${JSON.stringify(binding.propName)}]: data[${JSON.stringify(binding.fieldName)}],`
        );
      }
      lines.push(`${pad}  }}`);
      lines.push(`${pad}/>`);
    } else {
      lines.push(`${pad}<${compName} />`);
    }
    lines.push("");
    return;
  }

  if (node.classification === "section" && node.children.length > 0) {
    lines.push(`${pad}<Section>`);
    lines.push(`${pad}  <Container>`);
    for (const child of node.children) emitNodeContent(child, context, lines, indent + 2);
    lines.push(`${pad}  </Container>`);
    lines.push(`${pad}</Section>`);
    lines.push("");
    return;
  }

  if (node.classification === "heading" && node.textContent) {
    const level = node.depth <= 1 ? 1 : node.depth <= 3 ? 2 : 3;
    lines.push(`${pad}<Heading level={${level}}>`);
    lines.push(`${pad}  {data.title}`);
    lines.push(`${pad}</Heading>`);
    return;
  }

  if (node.classification === "text-block" && node.textContent) {
    lines.push(`${pad}<Text>`);
    lines.push(`${pad}  {data.description}`);
    lines.push(`${pad}</Text>`);
    return;
  }

  if (node.classification === "image") {
    lines.push(`${pad}<img`);
    lines.push(`${pad}  src={data.image?.url}`);
    lines.push(`${pad}  alt={data.image?.alt || ""}`);
    lines.push(`${pad}  class="w-full object-cover"`);
    lines.push(`${pad}  loading="lazy"`);
    lines.push(`${pad}/>`);
    return;
  }

  for (const child of node.children) emitNodeContent(child, context, lines, indent);
}

function registerRenderedMapping(prepared: PreparedMapping, context: RenderContext): string {
  context.renderedMappings.add(prepared);
  const existing = context.importedPaths.get(prepared.importPath);
  if (existing) return existing;

  const symbol = uniqueSymbol(prepared.baseSymbol, context.usedSymbols);
  context.usedSymbols.add(symbol);
  context.importedPaths.set(prepared.importPath, symbol);
  context.imports.add(`import ${symbol} from ${JSON.stringify(prepared.importPath)};`);
  return symbol;
}

function diagnoseUnrenderedMappings(
  tree: EnrichedNode,
  mappingsByNode: Map<string, PreparedMapping>,
  renderedMappings: Set<PreparedMapping>,
  diagnostics: CodegenDiagnostic[]
): void {
  const treeNodeIds = new Set<string>();
  collectNodeIds(tree, treeNodeIds);
  for (const prepared of mappingsByNode.values()) {
    if (renderedMappings.has(prepared)) continue;
    const exists = treeNodeIds.has(prepared.mapping.figmaNodeId);
    diagnostics.push({
      ...diagnostic(
        prepared.mapping,
        "MAPPING_NOT_RENDERED",
        exists
          ? `Mapping for Figma node ${JSON.stringify(prepared.mapping.figmaNodeId)} was skipped because an ancestor mapping rendered the enclosing subtree.`
          : `Mapping references Figma node ${JSON.stringify(prepared.mapping.figmaNodeId)}, which is not present in the emitted tree.`
      ),
      severity: "warning",
    });
  }
}

function collectNodeIds(node: EnrichedNode, nodeIds: Set<string>): void {
  nodeIds.add(node.id);
  for (const child of node.children) collectNodeIds(child, nodeIds);
}

function registryPathToImport(
  mapping: ComponentMapping,
  diagnostics: CodegenDiagnostic[]
): string | null {
  const registryPath = mapping.componentPath;
  if (
    typeof registryPath !== "string" || !registryPath ||
    registryPath.includes("\\") || registryPath.includes("\0") ||
    registryPath.includes("\n") || registryPath.includes("\r") ||
    registryPath.includes("?") || registryPath.includes("#") ||
    posix.isAbsolute(registryPath) || /^[A-Za-z]:/.test(registryPath)
  ) {
    diagnostics.push(diagnostic(
      mapping,
      "INVALID_COMPONENT_PATH",
      `Registry path ${JSON.stringify(registryPath)} is not a portable project-relative component path.`
    ));
    return null;
  }

  const normalized = registryPath.replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    diagnostics.push(diagnostic(
      mapping,
      "INVALID_COMPONENT_PATH",
      `Registry path ${JSON.stringify(registryPath)} escapes the target project.`
    ));
    return null;
  }

  const extension = extname(normalized).toLowerCase();
  if (!SUPPORTED_COMPONENT_EXTENSIONS.has(extension)) {
    diagnostics.push(diagnostic(
      mapping,
      "UNSUPPORTED_COMPONENT_EXTENSION",
      `Astro codegen cannot represent registry component ${mapping.cmsComponent} at ${JSON.stringify(registryPath)}; supported extensions are .astro, .tsx, and .jsx.`
    ));
    return null;
  }

  if (normalized.startsWith("src/")) return `@/${normalized.slice(4)}`;
  const relativePath = posix.relative(TEMPLATE_DIRECTORY, normalized);
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function validateComponentName(
  mapping: ComponentMapping,
  diagnostics: CodegenDiagnostic[]
): boolean {
  if (typeof mapping.componentName === "string") return true;
  diagnostics.push(diagnostic(
    mapping,
    "INVALID_COMPONENT_NAME",
    `Registry component ${mapping.cmsComponent} has a non-string component name, which cannot be emitted as an import symbol.`
  ));
  return false;
}

function componentSymbol(mapping: ComponentMapping): string {
  if (isAstroComponentIdentifier(mapping.componentName)) return mapping.componentName;
  if (isSafeIdentifier(mapping.componentName)) {
    const capitalized = `${mapping.componentName.charAt(0).toUpperCase()}${mapping.componentName.slice(1)}`;
    if (isAstroComponentIdentifier(capitalized)) return capitalized;
  }

  const pascalName = toPascal(mapping.componentName || mapping.cmsComponent.replace(/-/g, " "));
  let symbol = pascalName || "MappedComponent";
  if (!/^[A-Za-z_$]/.test(symbol)) symbol = `Component${symbol}`;
  if (RESERVED_IDENTIFIERS.has(mapping.componentName) || RESERVED_IDENTIFIERS.has(symbol)) {
    symbol = `${symbol.charAt(0).toUpperCase()}${symbol.slice(1)}Component`;
  }
  return isAstroComponentIdentifier(symbol) ? symbol : "MappedComponent";
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) && !RESERVED_IDENTIFIERS.has(value);
}

function isAstroComponentIdentifier(value: string): boolean {
  return /^[A-Z][A-Za-z0-9_$]*$/.test(value) && isSafeIdentifier(value);
}

function uniqueSymbol(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}${suffix}`)) suffix++;
  return `${base}${suffix}`;
}

type TypeToken = { kind: "word" | "number" | "string" | "punctuation"; value: string };

function representableType(source: string): string | null {
  const tokens = tokenizeType(source);
  if (!tokens) return null;
  const parser = new RegistryTypeParser(tokens);
  const type = parser.parse();
  return type && parser.atEnd() ? type : null;
}

function tokenizeType(source: string): TypeToken[] | null {
  const tokens: TypeToken[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if ("[]()<>,|&".includes(char)) {
      tokens.push({ kind: "punctuation", value: char });
      index++;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      const start = index++;
      let escaped = false;
      let closed = false;
      while (index < source.length) {
        const current = source[index++];
        if (current === "\n" || current === "\r") return null;
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === quote) {
          closed = true;
          break;
        }
      }
      if (!closed) return null;
      const literal = normalizeStringTypeLiteral(source.slice(start, index));
      if (!literal) return null;
      tokens.push({ kind: "string", value: literal });
      continue;
    }
    const word = source.slice(index).match(/^[A-Za-z_$][A-Za-z0-9_$]*/)?.[0];
    if (word) {
      tokens.push({ kind: "word", value: word });
      index += word.length;
      continue;
    }
    const number = source
      .slice(index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)?.[0];
    if (number) {
      tokens.push({ kind: "number", value: number });
      index += number.length;
      continue;
    }
    return null;
  }
  return tokens.length > 0 ? tokens : null;
}

function normalizeStringTypeLiteral(source: string): string | null {
  if (source.startsWith('"')) {
    try {
      const value: unknown = JSON.parse(source);
      return typeof value === "string" ? JSON.stringify(value) : null;
    } catch {
      return null;
    }
  }

  const value = source.slice(1, -1);
  if (value.includes("\\") || value.includes("'") || /[\r\n]/.test(value)) return null;
  return JSON.stringify(value);
}

class RegistryTypeParser {
  private index = 0;

  constructor(private readonly tokens: TypeToken[]) {}

  parse(): string | null {
    return this.parseUnion();
  }

  atEnd(): boolean {
    return this.index === this.tokens.length;
  }

  private parseUnion(): string | null {
    const parts: string[] = [];
    const first = this.parseIntersection();
    if (!first) return null;
    parts.push(first);
    while (this.consume("|")) {
      const next = this.parseIntersection();
      if (!next) return null;
      parts.push(next);
    }
    return parts.join(" | ");
  }

  private parseIntersection(): string | null {
    const parts: string[] = [];
    const first = this.parsePostfix();
    if (!first) return null;
    parts.push(first);
    while (this.consume("&")) {
      const next = this.parsePostfix();
      if (!next) return null;
      parts.push(next);
    }
    return parts.join(" & ");
  }

  private parsePostfix(): string | null {
    let type = this.parsePrimary();
    if (!type) return null;
    while (this.consume("[")) {
      if (!this.consume("]")) return null;
      if (type.includes(" | ") || type.includes(" & ")) type = `(${type})`;
      type += "[]";
    }
    return type;
  }

  private parsePrimary(): string | null {
    const token = this.tokens[this.index];
    if (!token) return null;
    if (token.kind === "string" || token.kind === "number") {
      this.index++;
      return token.value;
    }
    if (this.consume("(")) {
      const inner = this.parseUnion();
      return inner && this.consume(")") ? `(${inner})` : null;
    }
    if (this.consume("[")) {
      const entries: string[] = [];
      if (!this.matches("]")) {
        do {
          const entry = this.parseUnion();
          if (!entry) return null;
          entries.push(entry);
        } while (this.consume(","));
      }
      return this.consume("]") ? `[${entries.join(", ")}]` : null;
    }
    if (token.kind !== "word") return null;

    const primitiveTypes = new Set([
      "string", "number", "boolean", "bigint", "symbol", "null", "undefined",
      "never", "object", "true", "false",
    ]);
    if (primitiveTypes.has(token.value)) {
      this.index++;
      return token.value;
    }

    if (["Array", "ReadonlyArray"].includes(token.value)) {
      this.index++;
      if (!this.consume("<")) return null;
      const element = this.parseUnion();
      return element && this.consume(">") ? `${token.value}<${element}>` : null;
    }

    if (token.value === "Record") {
      this.index++;
      if (!this.consume("<")) return null;
      const key = this.parseUnion();
      if (!key || !this.consume(",")) return null;
      const value = this.parseUnion();
      return value && this.consume(">") ? `Record<${key}, ${value}>` : null;
    }

    return null;
  }

  private matches(value: string): boolean {
    return this.tokens[this.index]?.value === value;
  }

  private consume(value: string): boolean {
    if (!this.matches(value)) return false;
    this.index++;
    return true;
  }
}

function diagnostic(
  mapping: ComponentMapping,
  code: CodegenDiagnostic["code"],
  message: string
): CodegenDiagnostic {
  return {
    severity: "error",
    code,
    message,
    figmaNodeId: mapping.figmaNodeId,
    component: mapping.cmsComponent,
    path: mapping.componentPath,
  };
}
