import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { ComponentMapping, ComponentRegistry, EnrichedNode } from "../shared/types.js";
import { mapComponentsInTree } from "../tools/codegen/map-components.js";
import { emitAstroTemplate } from "./astro-emitter.js";

const execFileAsync = promisify(execFile);
const fixtureRoot = resolve("src/codegen/__fixtures__/astro-project");
const fixtureWorkspace = resolve("src/codegen/__fixtures__");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Astro codegen", () => {
  it("retains registry metadata and imports UI, block, section, and TSX mappings by canonical path", async () => {
    const registry = await loadFixtureRegistry();
    const tree = fixtureTree();
    const hints = registry.components.map((component, index) => ({
      nodeId: tree.children[index].id,
      component: component.id,
    }));

    const { mappings } = mapComponentsInTree(tree, registry, hints);

    expect(mappings).toHaveLength(4);
    expect(mappings.map(({ componentPath, componentCategory }) => ({
      componentPath,
      componentCategory,
    }))).toEqual([
      { componentPath: "src/components/ui/ActionLink.astro", componentCategory: "ui" },
      { componentPath: "src/components/blocks/FeatureGrid.astro", componentCategory: "blocks" },
      { componentPath: "src/components/sections/StorySection.astro", componentCategory: "sections" },
      { componentPath: "src/components/sections/StatsPanel.tsx", componentCategory: "sections" },
    ]);

    const { file, diagnostics, mappingsUsed } = emitAstroTemplate({
      mappings,
      tree,
      templateType: "landing",
      schemaId: "landing",
    });

    expect(diagnostics).toEqual([]);
    expect(mappingsUsed).toBe(4);
    expect(file.content).toContain('import ActionLink from "@/components/ui/ActionLink.astro";');
    expect(file.content).toContain('import FeatureGrid from "@/components/blocks/FeatureGrid.astro";');
    expect(file.content).toContain('import StorySection from "@/components/sections/StorySection.astro";');
    expect(file.content).toContain('import StatsPanel from "@/components/sections/StatsPanel.tsx";');
    expect(file.content).toContain('"actionLabel": string;');
    expect(file.content).toContain('"features": string[];');
    expect(file.content).toContain('"story": string;');
    expect(file.content).toContain('"stats": number[];');
    expect(file.content).not.toContain("[field: string]: any");

    const { stdout } = await checkGeneratedFile(file, `---
import LandingTemplate from "@/components/templates/LandingTemplate.astro";
---
<LandingTemplate data={{
  id: "landing",
  actionLabel: "Read more",
  features: ["Fast", "Typed"],
  story: "A concrete story",
  stats: [12, 24],
}} />`);
    expect(stdout).toContain("- 0 errors");

    await expect(checkGeneratedFile(file, `---
import LandingTemplate from "@/components/templates/LandingTemplate.astro";
---
<LandingTemplate data={{
  id: "landing",
  actionLabel: 42,
  features: ["Fast"],
  story: "A concrete story",
  stats: [12],
}} />`)).rejects.toMatchObject({
      stdout: expect.stringContaining("Type 'number' is not assignable to type 'string'"),
    });
  }, 30_000);

  it("emits reserved component names and hyphenated prop/data names syntax-safely", async () => {
    const node = fixtureNode("default-cta", "Default CTA", "cta", 1);
    const mapping = mappingFor(node, {
      cmsComponent: "default",
      componentName: "default",
      componentPath: "src/components/ui/Default.astro",
      componentProps: [{ name: "cta-label", type: "string", required: true }],
      propMappings: { "cta-label": "cta-label" },
    });

    const { file, diagnostics, mappingsUsed } = emitAstroTemplate({
      mappings: [mapping],
      tree: node,
      templateType: "generic",
    });

    expect(diagnostics).toEqual([]);
    expect(mappingsUsed).toBe(1);
    expect(file.content).toContain('import DefaultComponent from "@/components/ui/Default.astro";');
    expect(file.content).toContain('["cta-label"]: data["cta-label"]');
    expect(file.content).toContain('"cta-label": string;');
    const { stdout } = await checkGeneratedFile(file, `---
import GenericTemplate from "@/components/templates/GenericTemplate.astro";
---
<GenericTemplate data={{ id: "cta", "cta-label": "Start" }} />`);
    expect(stdout).toContain("- 0 errors");
  }, 30_000);

  it("diagnoses unrepresentable prop metadata and excludes the mapping", () => {
    const node = fixtureNode("unsafe", "Unsafe", "cta", 1);
    const mapping = mappingFor(node, {
      componentProps: [{ name: "label", type: "ExternalType", required: true }],
      propMappings: { label: "ctaLabel" },
    });

    const { file, diagnostics, mappingsUsed } = emitAstroTemplate({
      mappings: [mapping],
      tree: node,
      templateType: "generic",
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "UNSUPPORTED_COMPONENT_PROP_TYPE",
        figmaNodeId: node.id,
      }),
    ]);
    expect(file.content).not.toContain("ExternalType");
    expect(mappingsUsed).toBe(0);
  });

  it("diagnoses malformed raw string and numeric literal prop types", async () => {
    const invalidTypes = ['"\\xZZ"', '"\\u{ZZ}"', "01", "-01"];
    const children = invalidTypes.map((_, index) =>
      fixtureNode(`invalid-type-${index}`, `Invalid Type ${index}`, "cta", 1)
    );
    const tree = {
      ...fixtureNode("invalid-types", "Invalid Types", "unknown", 0),
      childCount: children.length,
      children,
    };
    const mappings = children.map((node, index) => mappingFor(node, {
      componentProps: [{ name: "label", type: invalidTypes[index], required: true }],
      propMappings: { label: `invalidField${index}` },
    }));

    const { file, diagnostics, mappingsUsed } = emitAstroTemplate({
      mappings,
      tree,
      templateType: "generic",
    });

    expect(diagnostics).toHaveLength(4);
    expect(diagnostics).toEqual(invalidTypes.map((type, index) =>
      expect.objectContaining({
        severity: "error",
        code: "UNSUPPORTED_COMPONENT_PROP_TYPE",
        figmaNodeId: children[index].id,
        message: expect.stringContaining(JSON.stringify(type)),
      })
    ));
    expect(mappingsUsed).toBe(0);
    for (const type of invalidTypes) expect(file.content).not.toContain(type);

    const { stdout } = await checkGeneratedFile(file, `---
import GenericTemplate from "@/components/templates/GenericTemplate.astro";
---
<GenericTemplate data={{ id: "invalid-types" }} />`);
    expect(stdout).toContain("- 0 errors");
  }, 30_000);

  it("accepts only valid property-key types in Record declarations", async () => {
    const validTypes = [
      "Record<string, string>",
      "Record<number, string>",
      "Record<symbol, string>",
      'Record<"fixed", string>',
      "Record<1, string>",
      'Record<string | number | symbol | "fixed" | 1, string>',
      "Record<(string | number), string>",
    ];
    const children = validTypes.map((_, index) =>
      fixtureNode(`valid-record-${index}`, `Valid Record ${index}`, "cta", 1)
    );
    const tree = {
      ...fixtureNode("valid-records", "Valid Records", "unknown", 0),
      childCount: children.length,
      children,
    };
    const mappings = children.map((node, index) => mappingFor(node, {
      cmsComponent: "record-value",
      componentName: "RecordValue",
      componentPath: "src/components/ui/RecordValue.astro",
      componentProps: [{ name: "value", type: validTypes[index], required: true }],
      propMappings: { value: `record${index}` },
    }));

    const { file, diagnostics, mappingsUsed } = emitAstroTemplate({
      mappings,
      tree,
      templateType: "generic",
    });

    expect(diagnostics).toEqual([]);
    expect(mappingsUsed).toBe(validTypes.length);
    for (const type of validTypes) expect(file.content).toContain(type);
    const { stdout } = await checkGeneratedFile(file, "<p>Record key types compile</p>");
    expect(stdout).toContain("- 0 errors");
  }, 30_000);

  it("diagnoses invalid primitive and nested Record key types", async () => {
    const invalidTypes = [
      "Record<boolean, string>",
      "Record<true, string>",
      "Record<string | false, string>",
      "Record<string[], string>",
      "Record<Array<string>, string>",
      "Record<ReadonlyArray<number>, string>",
      "Record<[string], string>",
      "Record<Record<string, string>, string>",
      "Record<object, string>",
      "Record<undefined, string>",
      "Record<null, string>",
    ];
    const children = invalidTypes.map((_, index) =>
      fixtureNode(`invalid-record-${index}`, `Invalid Record ${index}`, "cta", 1)
    );
    const tree = {
      ...fixtureNode("invalid-records", "Invalid Records", "unknown", 0),
      childCount: children.length,
      children,
    };
    const mappings = children.map((node, index) => mappingFor(node, {
      componentProps: [{ name: "label", type: invalidTypes[index], required: true }],
      propMappings: { label: `invalidRecord${index}` },
    }));

    const { file, diagnostics, mappingsUsed } = emitAstroTemplate({
      mappings,
      tree,
      templateType: "generic",
    });

    expect(diagnostics).toHaveLength(invalidTypes.length);
    expect(diagnostics).toEqual(invalidTypes.map((type, index) =>
      expect.objectContaining({
        severity: "error",
        code: "UNSUPPORTED_COMPONENT_PROP_TYPE",
        figmaNodeId: children[index].id,
        message: expect.stringContaining(JSON.stringify(type)),
      })
    ));
    expect(mappingsUsed).toBe(0);
    for (const type of invalidTypes) expect(file.content).not.toContain(type);
    const { stdout } = await checkGeneratedFile(file, `---
import GenericTemplate from "@/components/templates/GenericTemplate.astro";
---
<GenericTemplate data={{ id: "invalid-records" }} />`);
    expect(stdout).toContain("- 0 errors");
  }, 30_000);

  it("capitalizes lowercase and native-tag component aliases", async () => {
    const action = fixtureNode("lower-action", "Lower Action", "cta", 1);
    const nativeDiv = fixtureNode("native-div", "Native Div", "cta", 1);
    const tree = {
      ...fixtureNode("lowercase-components", "Lowercase Components", "unknown", 0),
      childCount: 2,
      children: [action, nativeDiv],
    };
    const mappings = [
      mappingFor(action, {
        componentName: "actionLink",
        componentProps: [{ name: "label", type: "string", required: true }],
        propMappings: { label: "actionLabel" },
      }),
      mappingFor(nativeDiv, {
        cmsComponent: "native-div",
        componentName: "div",
        componentPath: "src/components/ui/NativeDiv.astro",
      }),
    ];

    const { file, diagnostics, mappingsUsed } = emitAstroTemplate({
      mappings,
      tree,
      templateType: "generic",
    });

    expect(diagnostics).toEqual([]);
    expect(mappingsUsed).toBe(2);
    expect(file.content).toContain('import ActionLink from "@/components/ui/ActionLink.astro";');
    expect(file.content).toContain('import Div from "@/components/ui/NativeDiv.astro";');
    expect(file.content).toContain("<ActionLink");
    expect(file.content).toContain("<Div />");
    expect(file.content).not.toContain("<actionLink");
    expect(file.content).not.toContain("<div />");

    const { stdout } = await checkGeneratedFile(file, `---
import GenericTemplate from "@/components/templates/GenericTemplate.astro";
---
<GenericTemplate data={{ id: "lowercase", actionLabel: "Start" }} />`);
    expect(stdout).toContain("- 0 errors");
  }, 30_000);

  it("counts only mappings rendered into the emitted tree", () => {
    const child = fixtureNode("child", "Child", "cta", 1);
    const tree = {
      ...fixtureNode("parent", "Parent", "hero", 0),
      childCount: 1,
      children: [child],
    };
    const parentMapping = mappingFor(tree);
    const childMapping = mappingFor(child, {
      cmsComponent: "feature-grid",
      componentName: "FeatureGrid",
      componentPath: "src/components/blocks/FeatureGrid.astro",
    });
    const missingMapping = mappingFor(fixtureNode("missing", "Missing", "cta", 1), {
      cmsComponent: "story-section",
      componentName: "StorySection",
      componentPath: "src/components/sections/StorySection.astro",
    });

    const { file, diagnostics, mappingsUsed } = emitAstroTemplate({
      mappings: [parentMapping, childMapping, missingMapping],
      tree,
      templateType: "generic",
    });

    expect(mappingsUsed).toBe(1);
    expect(file.content).toContain("<ActionLink />");
    expect(file.content).not.toContain("FeatureGrid");
    expect(file.content).not.toContain("StorySection");
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "MAPPING_NOT_RENDERED", figmaNodeId: child.id }),
      expect.objectContaining({ code: "MAPPING_NOT_RENDERED", figmaNodeId: "missing" }),
    ]);
  });

  it("returns an explicit diagnostic and falls back when a registry entry is unsupported", () => {
    const tree = fixtureTree();
    const unsupported = mappingFor(tree.children[0], {
      componentPath: "src/components/sections/LegacyPanel.vue",
    });

    const { file, diagnostics, mappingsUsed } = emitAstroTemplate({
      mappings: [unsupported],
      tree,
      templateType: "generic",
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "UNSUPPORTED_COMPONENT_EXTENSION",
        figmaNodeId: tree.children[0].id,
        component: unsupported.cmsComponent,
        path: unsupported.componentPath,
      }),
    ]);
    expect(file.content).not.toContain("LegacyPanel.vue");
    expect(file.content).not.toContain("<ActionLink");
    expect(mappingsUsed).toBe(0);
  });

  it("rejects trailing separators and non-canonical component path segments", async () => {
    const invalidPaths = [
      "src/components/ui/ActionLink.astro/",
      "src/components/ui/ActionLink.astro//",
      "src/components/ui/ActionLink.astro/.",
      "src/components/ui/ActionLink.astro/..",
      "src/components/ui/ActionLink.astro\\",
      "src/components/ui//ActionLink.astro",
      "src/components/ui/./ActionLink.astro",
      "src/components/ui/../ui/ActionLink.astro",
    ];
    const children = invalidPaths.map((_, index) =>
      fixtureNode(`invalid-path-${index}`, `Invalid Path ${index}`, "cta", 1)
    );
    const tree = {
      ...fixtureNode("invalid-paths", "Invalid Paths", "unknown", 0),
      childCount: children.length,
      children,
    };
    const mappings = children.map((node, index) => mappingFor(node, {
      componentPath: invalidPaths[index],
    }));

    const { file, diagnostics, mappingsUsed } = emitAstroTemplate({
      mappings,
      tree,
      templateType: "generic",
    });

    expect(diagnostics).toHaveLength(invalidPaths.length);
    expect(diagnostics).toEqual(invalidPaths.map((path, index) =>
      expect.objectContaining({
        severity: "error",
        code: "INVALID_COMPONENT_PATH",
        figmaNodeId: children[index].id,
        path,
      })
    ));
    expect(mappingsUsed).toBe(0);
    for (const path of invalidPaths) expect(file.content).not.toContain(path);
    const { stdout } = await checkGeneratedFile(file, `---
import GenericTemplate from "@/components/templates/GenericTemplate.astro";
---
<GenericTemplate data={{ id: "invalid-paths" }} />`);
    expect(stdout).toContain("- 0 errors");
  }, 30_000);
});

async function loadFixtureRegistry(): Promise<ComponentRegistry> {
  return JSON.parse(
    await readFile(join(fixtureRoot, "registry/default-components.json"), "utf8")
  ) as ComponentRegistry;
}

async function checkGeneratedFile(
  file: ReturnType<typeof emitAstroTemplate>["file"],
  caller: string
) {
  const projectRoot = await mkdtemp(join(fixtureWorkspace, ".figma-codegen-astro-"));
  temporaryRoots.push(projectRoot);
  await cp(fixtureRoot, projectRoot, { recursive: true });
  const generatedPath = join(projectRoot, file.path);
  await mkdir(dirname(generatedPath), { recursive: true });
  await writeFile(generatedPath, file.content);
  const callerPath = join(projectRoot, "src/pages/index.astro");
  await mkdir(dirname(callerPath), { recursive: true });
  await writeFile(callerPath, caller);

  const astroCheckCli = resolve("node_modules/@astrojs/check/bin/astro-check.js");
  return execFileAsync(process.execPath, [astroCheckCli], {
    cwd: projectRoot,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
  });
}

function fixtureTree(): EnrichedNode {
  const children = [
    fixtureNode("action", "Action", "cta", 1),
    fixtureNode("features", "Features", "hero", 1),
    fixtureNode("story", "Story", "section", 1),
    fixtureNode("stats", "Stats", "card-grid", 1),
  ];
  return {
    ...fixtureNode("root", "Fixture Page", "unknown", 0),
    childCount: children.length,
    children,
  };
}

function fixtureNode(
  id: string,
  name: string,
  classification: EnrichedNode["classification"],
  depth: number
): EnrichedNode {
  return {
    id,
    name,
    type: "FRAME",
    classification,
    depth,
    childCount: 0,
    tokens: [],
    isComponent: false,
    isInstance: false,
    children: [],
  };
}

function mappingFor(
  node: EnrichedNode,
  overrides: Partial<ComponentMapping> = {}
): ComponentMapping {
  return {
    figmaNodeId: node.id,
    figmaNodeName: node.name,
    cmsComponent: "action-link",
    componentName: "ActionLink",
    componentPath: "src/components/ui/ActionLink.astro",
    componentCategory: "ui",
    componentProps: [],
    confidence: 1,
    propMappings: {},
    ...overrides,
  };
}
