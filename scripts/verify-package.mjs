#!/usr/bin/env node

import { readFileSync } from "node:fs";

const manifestPath = process.argv[2];

if (!manifestPath) {
  throw new Error("Usage: node scripts/verify-package.mjs <npm-pack-json>");
}

const packResults = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!Array.isArray(packResults) || packResults.length !== 1) {
  throw new Error("Expected npm pack metadata for exactly one package");
}

const [{ filename, files }] = packResults;
if (typeof filename !== "string" || !Array.isArray(files)) {
  throw new Error("npm pack metadata is missing its filename or file list");
}

const paths = files.map((file) => file.path);
const requiredPaths = [
  "CHANGELOG.md",
  "INSTALL.md",
  "LICENSE",
  "PUBLISHING.md",
  "README.md",
  "USAGE.md",
  "bin/spetex-figma-design-pipeline",
  "bin/spetex-figma-design-pipeline-install",
  "bin/spfr-figma-design-pipeline",
  "bin/spfr-figma-design-pipeline-install",
  "dist/index.js",
  "package.json",
  "plugin/dist/code.js",
  "plugin/dist/manifest.json",
  "plugin/dist/ui.html",
  "scripts/build-plugin.mjs",
  "scripts/build-server.mjs",
  "scripts/install.mjs",
  "skill/README.md",
  "skill/references/design-guidance.md",
  "skill/SKILL.md",
];

const missingPaths = requiredPaths.filter((path) => !paths.includes(path));
if (missingPaths.length > 0) {
  throw new Error(`Package is missing required files:\n${missingPaths.join("\n")}`);
}

const unexpectedPaths = paths.filter((path) => !requiredPaths.includes(path));
if (unexpectedPaths.length > 0) {
  throw new Error(`Package contains unexpected files:\n${unexpectedPaths.join("\n")}`);
}

const forbiddenPaths = paths.filter(
  (path) => /(?:^|\/)(?:__fixtures__|[^/]+\.(?:test|spec)\.[^/]+)$/.test(path),
);
if (forbiddenPaths.length > 0) {
  throw new Error(`Package contains tests or fixtures:\n${forbiddenPaths.join("\n")}`);
}

console.log(`Verified ${filename}: ${paths.length} intended files`);
