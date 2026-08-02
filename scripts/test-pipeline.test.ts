import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("test-pipeline script", () => {
  it("imports its current runtime dependency graph without executing the live pipeline", async () => {
    const pipeline = await import("./test-pipeline.js");

    expect(pipeline.main).toBeTypeOf("function");
  });

  it("imports through the Node tsx loader when argv has no entrypoint", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "-e", 'import("./scripts/test-pipeline.ts")'],
      { cwd: repoRoot, encoding: "utf8" }
    );

    expect(result.status, result.stderr).toBe(0);
  });
});
