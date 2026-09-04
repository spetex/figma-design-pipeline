import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installerPath = join(repoRoot, "scripts", "install.mjs");
const tempHomes: string[] = [];
const forwardedEnvVars = [
  "FIGMA_ACCESS_TOKEN",
  "FIGMA_FILE_KEY",
  "FIGMA_PLUGIN_PORT",
  "FIGMA_ASSET_ROOTS",
  "COMPONENT_REGISTRY_DIR",
] as const;
const setEnvironment = {
  FIGMA_ACCESS_TOKEN: "figd_test_token",
  FIGMA_FILE_KEY: "test-file-key",
  FIGMA_PLUGIN_PORT: "4013",
  FIGMA_ASSET_ROOTS: "/tmp/test-assets:/srv/approved-assets",
  COMPONENT_REGISTRY_DIR: "/tmp/test-component-registry",
};
const environmentCases = [
  ["unset", {}],
  ["set", setEnvironment],
] as const;

afterAll(() => {
  for (const home of tempHomes) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe.each(environmentCases)("installer with %s optional environment variables", (_name, environment) => {
  it("writes Codex env_vars instead of static placeholder values", () => {
    const home = install("codex", environment);
    const config = readFileSync(join(home, ".codex", "config.toml"), "utf8");

    expect(config).toContain(`env_vars = ${JSON.stringify(forwardedEnvVars)}`);
    expect(config).not.toMatch(/^env\s*=/m);
    for (const [name, value] of Object.entries(setEnvironment)) {
      expect(config).not.toContain(`$${name}`);
      expect(config).not.toContain(value);
    }
  });

  it("keeps Gemini expansion syntax for every supported variable", () => {
    const home = install("gemini", environment);
    const config = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8"));
    const server = config.mcpServers["figma-design-pipeline"];

    expect(server.env).toEqual(Object.fromEntries(forwardedEnvVars.map((name) => [name, `$${name}`])));
    for (const value of Object.values(setEnvironment)) {
      expect(JSON.stringify(server)).not.toContain(value);
    }
  });

  it("registers Claude without a static environment override", () => {
    const home = createTempHome();
    const binDir = join(home, "bin");
    const capturedConfigPath = join(home, "claude-config.json");
    mkdirSync(binDir);
    writeFileSync(
      join(binDir, "claude"),
      `#!/bin/sh\nif [ "$2" = "add-json" ]; then\n  printf '%s' "$6" > "$CLAUDE_CAPTURED_CONFIG"\nfi\n`
    );
    chmodSync(join(binDir, "claude"), 0o755);

    install("claude", environment, {
      HOME: home,
      PATH: [binDir, process.env.PATH].filter(Boolean).join(delimiter),
      CLAUDE_CAPTURED_CONFIG: capturedConfigPath,
    });

    const config = JSON.parse(readFileSync(capturedConfigPath, "utf8"));
    expect(config).toEqual({
      command: "node",
      args: [join(home, ".figma-design-pipeline", "server", "index.js")],
    });
  });
});

it("forwards asset roots to clean-home Codex and Gemini configs without leaking unrelated variables", () => {
  const home = createTempHome();
  const emptyBin = join(home, "bin");
  mkdirSync(emptyBin);
  install("all", {
    ...setEnvironment,
    FIGMA_UNRELATED_SETTING: "must-not-leak",
  }, {
    HOME: home,
    PATH: emptyBin,
  });

  const codexConfig = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  expect(codexConfig).toContain(`env_vars = ${JSON.stringify(forwardedEnvVars)}`);
  expect(codexConfig).not.toContain("FIGMA_UNRELATED_SETTING");
  expect(codexConfig).not.toContain("must-not-leak");

  const geminiConfig = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8"));
  expect(geminiConfig.mcpServers["figma-design-pipeline"].env).toEqual(
    Object.fromEntries(forwardedEnvVars.map((name) => [name, `$${name}`])),
  );
  expect(JSON.stringify(geminiConfig)).not.toContain("FIGMA_UNRELATED_SETTING");
  expect(JSON.stringify(geminiConfig)).not.toContain("must-not-leak");
});

function install(client: "all" | "claude" | "codex" | "gemini", environment: Record<string, string>, overrides: Record<string, string> = {}) {
  const home = overrides.HOME ?? createTempHome();
  const env: NodeJS.ProcessEnv = { ...process.env, ...environment, HOME: home, ...overrides };
  for (const name of forwardedEnvVars) {
    if (!(name in environment)) {
      delete env[name];
    }
  }

  const result = spawnSync(process.execPath, [installerPath, "--client", client, "--skip-skill"], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });

  expect(result.status, result.stderr).toBe(0);
  return home;
}

function createTempHome() {
  const home = mkdtempSync(join(tmpdir(), "figma-design-pipeline-install-"));
  tempHomes.push(home);
  return home;
}
