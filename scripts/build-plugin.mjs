import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const pluginDir = resolve(root, "plugin");
const distDir = resolve(pluginDir, "dist");

mkdirSync(distDir, { recursive: true });

// Build plugin code (Figma sandbox — browser IIFE)
await build({
  entryPoints: [resolve(pluginDir, "code.ts")],
  bundle: true,
  platform: "browser",
  target: "es2017",
  format: "iife",
  outfile: resolve(distDir, "code.js"),
  // Figma rejects any `import(` token in the controller bundle, including
  // TypeScript import-type examples preserved inside dependency comments.
  // Whitespace minification strips comments without mangling useful names.
  minifyWhitespace: true,
  legalComments: "none",
});

const controllerCode = readFileSync(resolve(distDir, "code.js"), "utf8");
if (/\bimport\s*\(/.test(controllerCode)) {
  throw new Error("Figma plugin bundle contains a forbidden import expression");
}

// Copy UI and manifest
cpSync(resolve(pluginDir, "ui.html"), resolve(distDir, "ui.html"));
cpSync(resolve(pluginDir, "manifest.json"), resolve(distDir, "manifest.json"));

console.log("Plugin build complete: plugin/dist/");
