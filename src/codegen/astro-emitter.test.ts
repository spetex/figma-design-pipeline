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
    expect(file.content).toContain("interface LandingData {");

    const projectRoot = await mkdtemp(join(fixtureWorkspace, ".figma-codegen-astro-"));
    temporaryRoots.push(projectRoot);
    await cp(fixtureRoot, projectRoot, { recursive: true });
    const generatedPath = join(projectRoot, file.path);
    await mkdir(dirname(generatedPath), { recursive: true });
    await writeFile(generatedPath, file.content);

    const astroCheckCli = resolve("node_modules/@astrojs/check/bin/astro-check.js");
    const { stdout } = await execFileAsync(process.execPath, [astroCheckCli], {
      cwd: projectRoot,
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
    });
    expect(stdout).toContain("- 0 errors");
  }, 30_000);

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
});

async function loadFixtureRegistry(): Promise<ComponentRegistry> {
  return JSON.parse(
    await readFile(join(fixtureRoot, "registry/default-components.json"), "utf8")
  ) as ComponentRegistry;
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
