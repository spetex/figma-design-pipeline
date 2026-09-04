import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verifierPath = join(repoRoot, "scripts", "verify-release-tag.mjs");
const packagePath = join(repoRoot, "package.json");
const workflowPath = join(repoRoot, ".github", "workflows", "publish-npm.yml");
const packageMetadata = JSON.parse(readFileSync(packagePath, "utf8"));
const expectedTag = `figma-design-pipeline-v${packageMetadata.version}`;
const validEnvironment = {
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF_TYPE: "tag",
  GITHUB_REF_NAME: expectedTag,
  GITHUB_REF: `refs/tags/${expectedTag}`,
};
const importProbe = `
  const imported = await import(${JSON.stringify(pathToFileURL(verifierPath).href)});
  if (typeof imported.verifyReleaseTag !== "function") {
    throw new Error("verifyReleaseTag must be exported");
  }
`;

describe("release tag verifier", () => {
  it("can be imported without CLI arguments, output, or a usage error", () => {
    const result = runImport();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("does not execute the CLI when an importer has CLI-shaped arguments", () => {
    const result = runImport(["importer-placeholder", packagePath], validEnvironment);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("fails closed when directly executed without the package path", () => {
    const result = spawnSync(process.execPath, [verifierPath], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Usage: node scripts\/verify-release-tag\.mjs <package-json>/);
  });

  it.each(["push", "workflow_dispatch"])("accepts the exact package-derived tag for %s", (eventName) => {
    const result = runVerifier({ ...validEnvironment, GITHUB_EVENT_NAME: eventName });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Verified refs/tags/${expectedTag}`);
    expect(result.stdout).toContain(`${packageMetadata.name}@${packageMetadata.version}`);
  });

  it("rejects a tag for a different package version", () => {
    expectFailure({
      ...validEnvironment,
      GITHUB_REF_NAME: "figma-design-pipeline-v9.9.9",
      GITHUB_REF: "refs/tags/figma-design-pipeline-v9.9.9",
    });
  });

  it.each([
    ["missing event", { GITHUB_EVENT_NAME: undefined }],
    ["missing ref type", { GITHUB_REF_TYPE: undefined }],
    ["missing ref name", { GITHUB_REF_NAME: undefined }],
    ["missing full ref", { GITHUB_REF: undefined }],
    ["branch ref", { GITHUB_REF_TYPE: "branch", GITHUB_REF: `refs/heads/${expectedTag}` }],
    ["malformed tag", { GITHUB_REF_NAME: `figma-design-pipeline-${packageMetadata.version}` }],
    ["malformed full ref", { GITHUB_REF: `refs/tags/wrong/${expectedTag}` }],
  ])("fails closed for %s", (_description, environment) => {
    expectFailure({ ...validEnvironment, ...environment });
  });

  it.each([
    `${expectedTag}-suffix`,
    `${expectedTag}/extra`,
    `${expectedTag};npm publish`,
    `${expectedTag}\nmalicious`,
  ])("rejects injected or suffixed ref name %j", (refName) => {
    expectFailure({
      ...validEnvironment,
      GITHUB_REF_NAME: refName,
      GITHUB_REF: `refs/tags/${refName}`,
    });
  });

  it("rejects events other than tag push and explicitly gated manual dispatch", () => {
    expectFailure({ ...validEnvironment, GITHUB_EVENT_NAME: "pull_request" });
  });

  it("runs the identity gate before dependency installation and publication", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const gateIndex = workflow.indexOf("node scripts/verify-release-tag.mjs package.json");

    expect(gateIndex).toBeGreaterThan(0);
    expect(gateIndex).toBeLessThan(workflow.indexOf("npm ci"));
    expect(gateIndex).toBeLessThan(workflow.indexOf("npm publish"));
  });
});

function runVerifier(environment: Record<string, string | undefined>) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return spawnSync(process.execPath, [verifierPath, packagePath], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
}

function runImport(
  args: string[] = [],
  environment: Record<string, string | undefined> = {},
) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(validEnvironment)) delete env[name];
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return spawnSync(process.execPath, ["--input-type=module", "--eval", importProbe, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
}

function expectFailure(environment: Record<string, string | undefined>) {
  const result = runVerifier(environment);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/release publication|exact package tag/i);
}
