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

const SUPPORTED_COMPONENT_EXTENSIONS = new Set([".astro", ".tsx", ".jsx"]);
const TEMPLATE_DIRECTORY = "src/components/templates";

/**
 * Generate an Astro page template from enriched tree and component mappings.
 * Emits a generic Astro-style page template from mapped Figma structure.
 */
export function emitAstroTemplate(options: EmitOptions): AstroEmitResult {
  const { mappings, tree, templateType, schemaId } = options;

  const imports = new Set<string>();
  const bodyLines: string[] = [];
  const diagnostics: CodegenDiagnostic[] = [];
  const componentSymbols = new Map<string, string>();

  // Always import base components
  imports.add('import Section from "@/components/ui/Section.astro";');
  imports.add('import Container from "@/components/ui/Container.astro";');
  imports.add('import Heading from "@/components/ui/Heading.astro";');
  imports.add('import Text from "@/components/ui/Text.astro";');

  const usedSymbols = new Set(["Section", "Container", "Heading", "Text"]);
  const importedPaths = new Map<string, string>();

  // Add imports for mapped components, retaining each registry entry's canonical path.
  for (const mapping of mappings) {
    const importPath = registryPathToImport(mapping, diagnostics);
    const baseSymbol = componentSymbol(mapping);
    if (!importPath || !baseSymbol) {
      if (!baseSymbol) {
        diagnostics.push(diagnostic(
          mapping,
          "INVALID_COMPONENT_NAME",
          `Registry component ${mapping.cmsComponent} has no name that can be represented as an Astro import identifier.`
        ));
      }
      continue;
    }

    let symbol = importedPaths.get(importPath);
    if (!symbol) {
      symbol = uniqueSymbol(baseSymbol, usedSymbols);
      usedSymbols.add(symbol);
      importedPaths.set(importPath, symbol);
      imports.add(`import ${symbol} from ${JSON.stringify(importPath)};`);
    }
    componentSymbols.set(mapping.figmaNodeId, symbol);
  }

  // Generate Props interface
  const propsInterface = generatePropsInterface(templateType);

  // Walk tree and emit component usage
  emitNodeContent(tree, mappings, componentSymbols, bodyLines, 0);

  // Assemble template
  const sortedImports = [...imports].sort();

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
    mappingsUsed: componentSymbols.size,
  };
}

function generatePropsInterface(templateType: string): string {
  const typeName = `${toPascal(templateType)}Data`;
  return `interface ${typeName} {
  id: string;
  title?: string;
  description?: string;
  image?: {
    url?: string;
    alt?: string;
  };
  [field: string]: any;
}

interface Props {
  data: ${typeName};
  isPreview?: boolean;
}

const { data, isPreview = false } = Astro.props;`;
}

function emitNodeContent(
  node: EnrichedNode,
  mappings: ComponentMapping[],
  componentSymbols: Map<string, string>,
  lines: string[],
  indent: number
): void {
  const pad = "  ".repeat(indent);
  const mapping = mappings.find((m) => m.figmaNodeId === node.id);
  const compName = mapping ? componentSymbols.get(mapping.figmaNodeId) : undefined;

  if (mapping && compName) {
    // Emit mapped component
    const props = Object.entries(mapping.propMappings)
      .map(([prop, field]) => `${prop}={data.${field}}`)
      .join("\n    ");

    if (props) {
      lines.push(`${pad}<${compName}`);
      lines.push(`${pad}  ${props}`);
      lines.push(`${pad}/>`);
    } else {
      lines.push(`${pad}<${compName} />`);
    }
    lines.push("");
    return;
  }

  // For sections, wrap in Section component
  if (node.classification === "section" && node.children.length > 0) {
    lines.push(`${pad}<Section>`);
    lines.push(`${pad}  <Container>`);
    for (const child of node.children) {
      emitNodeContent(child, mappings, componentSymbols, lines, indent + 2);
    }
    lines.push(`${pad}  </Container>`);
    lines.push(`${pad}</Section>`);
    lines.push("");
    return;
  }

  // For headings
  if (node.classification === "heading" && node.textContent) {
    const level = node.depth <= 1 ? 1 : node.depth <= 3 ? 2 : 3;
    lines.push(`${pad}<Heading level={${level}}>`);
    lines.push(`${pad}  {data.title}`);
    lines.push(`${pad}</Heading>`);
    return;
  }

  // For text blocks
  if (node.classification === "text-block" && node.textContent) {
    lines.push(`${pad}<Text>`);
    lines.push(`${pad}  {data.description}`);
    lines.push(`${pad}</Text>`);
    return;
  }

  // For images
  if (node.classification === "image") {
    lines.push(`${pad}<img`);
    lines.push(`${pad}  src={data.image?.url}`);
    lines.push(`${pad}  alt={data.image?.alt || ""}`);
    lines.push(`${pad}  class="w-full object-cover"`);
    lines.push(`${pad}  loading="lazy"`);
    lines.push(`${pad}/>`);
    return;
  }

  // For container nodes, recurse into children
  if (node.children.length > 0) {
    for (const child of node.children) {
      emitNodeContent(child, mappings, componentSymbols, lines, indent);
    }
  }
}

function registryPathToImport(
  mapping: ComponentMapping,
  diagnostics: CodegenDiagnostic[]
): string | null {
  const registryPath = mapping.componentPath;
  if (
    !registryPath ||
    registryPath.includes("\\") ||
    registryPath.includes("\0") ||
    registryPath.includes("\n") ||
    registryPath.includes("\r") ||
    registryPath.includes("?") ||
    registryPath.includes("#") ||
    posix.isAbsolute(registryPath) ||
    /^[A-Za-z]:/.test(registryPath)
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

function componentSymbol(mapping: ComponentMapping): string | null {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(mapping.componentName)) {
    return mapping.componentName;
  }
  const fallback = toPascal(mapping.componentName || mapping.cmsComponent.replace(/-/g, " "));
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(fallback) ? fallback : null;
}

function uniqueSymbol(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}${suffix}`)) suffix++;
  return `${base}${suffix}`;
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
