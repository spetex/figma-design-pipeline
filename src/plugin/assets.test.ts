import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { actionSchema, type Action } from "../shared/actions.js";
import { MAX_IMAGE_BYTES, preprocessActions, validateSvg } from "./assets.js";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function imageAction(source: Record<string, unknown>): Action {
  return actionSchema.parse({ type: "set_image_fill", nodeId: "1:2", ...source });
}

describe("asset preprocessing", () => {
  it("requires exactly one image source before I/O", () => {
    expect(actionSchema.safeParse({ type: "set_image_fill", nodeId: "1:2" }).success).toBe(false);
    expect(actionSchema.safeParse({ type: "set_image_fill", nodeId: "1:2", imageBase64: PNG.toString("base64"), path: "/tmp/image.png" }).success).toBe(false);
  });

  it("normalizes valid local files to bounded base64 without transporting the path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "figma-assets-"));
    tempDirectories.push(directory);
    const path = join(directory, "pixel.png");
    await writeFile(path, PNG);

    const [processed] = await preprocessActions([imageAction({ path })]);

    expect(processed).toMatchObject({ type: "set_image_fill", imageBase64: PNG.toString("base64") });
    expect(processed).not.toHaveProperty("path");
    expect(processed).not.toHaveProperty("url");
  });

  it.each([
    ["PNG", PNG],
    ["JPEG", Buffer.from([0xff, 0xd8, 0xff])],
    ["GIF", Buffer.from("GIF89a", "ascii")],
    ["WebP", Buffer.from("RIFF0000WEBP", "ascii")],
  ])("accepts bounded %s image bytes", async (_label, bytes) => {
    const [processed] = await preprocessActions([imageAction({ imageBase64: bytes.toString("base64") })]);
    expect(processed).toMatchObject({ imageBase64: bytes.toString("base64") });
  });

  it("rejects invalid, oversized, unreadable, and private-network image sources", async () => {
    await expect(preprocessActions([imageAction({ imageBase64: "AQID" })])).rejects.toThrow("not PNG, JPEG, WebP, or GIF");
    await expect(preprocessActions([imageAction({ imageBase64: Buffer.alloc(MAX_IMAGE_BYTES + 1, 1).toString("base64") })])).rejects.toThrow("10 MiB");
    await expect(preprocessActions([imageAction({ path: "/definitely/missing/image.png" })])).rejects.toThrow("Action 0");
    await expect(preprocessActions([imageAction({ url: "http://127.0.0.1/image.png" })])).rejects.toThrow("private");
  });

  it("accepts inert SVG and rejects active or externally referenced SVG before transport", () => {
    expect(() => validateSvg('<svg><defs><linearGradient id="g"/></defs><path fill="url(#g)"/></svg>')).not.toThrow();
    expect(() => validateSvg('<svg><script>alert(1)</script></svg>')).toThrow("external resource");
    expect(() => validateSvg('<svg><image href="https://example.com/a.png"/></svg>')).toThrow("external resource");
    expect(() => validateSvg(`<svg><!-- ${"x".repeat(1024 * 1024)} --></svg>`)).toThrow("1 MiB");
  });
});
