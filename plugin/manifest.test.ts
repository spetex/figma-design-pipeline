import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("plugin manifest", () => {
  it("enables the local private API required for figma.fileKey", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;

    expect(manifest.enablePrivatePluginApi).toBe(true);
    expect(manifest.name).toBe("Design Pipeline");
  });
});
