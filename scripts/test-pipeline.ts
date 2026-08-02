import "dotenv/config";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { FigmaRestClient } from "../src/shared/figma-rest.js";
import { SnapshotCache } from "../src/pipeline/snapshot.js";
import { handleGetTree } from "../src/tools/inspect/get-tree.js";
import { handleAudit } from "../src/tools/inspect/audit.js";
import { handleExtractTokens } from "../src/tools/inspect/extract-tokens.js";
import { parseFigmaUrl } from "../src/shared/figma-url.js";
import type { ToolContext } from "../src/shared/context.js";

const FIGMA_URL = process.argv[2];

export async function main() {
  const token = process.env.FIGMA_ACCESS_TOKEN;
  if (!token) throw new Error("FIGMA_ACCESS_TOKEN not set");
  if (!FIGMA_URL) {
    throw new Error("Pass a Figma URL as the first argument.");
  }

  const parsed = parseFigmaUrl(FIGMA_URL);
  console.log(`File key: ${parsed.fileKey}`);
  console.log(`Node ID: ${parsed.nodeId}`);
  console.log(`File name: ${parsed.fileName || "(none)"}`);
  console.log();

  const rest = new FigmaRestClient(token, parsed.fileKey);
  const snapshotCache = new SnapshotCache();
  const ctx: ToolContext = { rest, snapshotCache };

  const nodeId = parsed.nodeId || "0:1";

  // 1. Get Tree
  console.log("=== 1. Fetching enriched tree (depth 3)... ===");
  const treeResult = await handleGetTree(ctx, { nodeId, depth: 3, includeStyles: true });
  const tree = treeResult.tree;
  console.log(`Root: "${tree.name}" (${tree.type}), classification: ${tree.classification}`);
  console.log(`Direct children: ${tree.childCount}`);
  console.log(`From cache: ${treeResult.fromCache}`);
  console.log();

  // Classification distribution
  const classMap = new Map<string, number>();
  let totalNodes = 0;
  function walkTree(node: typeof tree) {
    totalNodes++;
    classMap.set(node.classification, (classMap.get(node.classification) || 0) + 1);
    for (const child of node.children) walkTree(child);
  }
  walkTree(tree);

  console.log(`Total nodes in tree: ${totalNodes}`);
  console.log("Classifications:");
  for (const [cls, count] of [...classMap.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cls}: ${count}`);
  }
  console.log();

  // 2. Audit
  console.log("=== 2. Running audit... ===");
  const audit = await handleAudit(ctx, {
    nodeId,
    checks: ["naming", "structure", "layout", "components", "tokens", "accessibility"],
  });
  console.log(`Violations: ${audit.violations.length}`);
  console.log("Summary:", JSON.stringify(audit.summary, null, 2));
  console.log();
  console.log("Top violations:");
  for (const v of audit.violations.slice(0, 15)) {
    console.log(`  [${v.severity}] ${v.category}: ${v.message}`);
  }
  console.log();

  // 3. Token extraction
  console.log("=== 3. Extracting tokens... ===");
  const tokens = await handleExtractTokens(ctx, { nodeId });
  console.log(`Colors: ${tokens.summary.colors}`);
  console.log(`Fonts: ${tokens.summary.fonts}`);
  console.log(`Spacing: ${tokens.summary.spacing}`);
  console.log(`Radii: ${tokens.summary.radii}`);
  console.log();
  console.log("Sample colors:");
  for (const c of tokens.tokens.colors.slice(0, 8)) {
    console.log(`  ${c.raw} → ${c.tailwind}`);
  }
  console.log("Sample fonts:");
  for (const f of tokens.tokens.fonts.slice(0, 5)) {
    console.log(`  ${f.raw} → ${f.tailwind}`);
  }

  console.log();
  console.log("=== Pipeline test complete ===");
}

const entrypoint = process.argv[1];
if (entrypoint && fileURLToPath(import.meta.url) === resolve(entrypoint)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
