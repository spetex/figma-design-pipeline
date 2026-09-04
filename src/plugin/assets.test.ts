import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { actionSchema, type Action } from "../shared/actions.js";
import { IMAGE_FIXTURES } from "./__fixtures__/images.js";
import { MAX_IMAGE_BYTES, inspectImage, preprocessActions, validateSvg } from "./assets.js";

const PNG = Buffer.from(IMAGE_FIXTURES.png, "base64");
const JPEG = Buffer.from(IMAGE_FIXTURES.jpeg, "base64");
const GIF = Buffer.from(IMAGE_FIXTURES.gif, "base64");
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

    const [processed] = await preprocessActions([imageAction({ path })], { assetRoots: [directory] });

    expect(processed).toMatchObject({ type: "set_image_fill", imageBase64: PNG.toString("base64") });
    expect(processed).not.toHaveProperty("path");
    expect(processed).not.toHaveProperty("url");
  });

  it.each(Object.entries(IMAGE_FIXTURES))("accepts complete 1x1 %s image bytes", async (_label, encoded) => {
    const bytes = Buffer.from(encoded, "base64");
    const [processed] = await preprocessActions([imageAction({ imageBase64: bytes.toString("base64") })]);
    expect(processed).toMatchObject({ imageBase64: bytes.toString("base64") });
    expect(inspectImage(bytes)).toMatchObject({ width: 1, height: 1 });
  });

  it.each(Object.entries(IMAGE_FIXTURES))("rejects truncated %s image content", async (_label, encoded) => {
    const bytes = Buffer.from(encoded, "base64");
    await expect(preprocessActions([imageAction({ imageBase64: bytes.subarray(0, -1).toString("base64") })]))
      .rejects.toThrow();
  });

  it("rejects the empty-data GIF and 19-byte structural-shell JPEG probes", async () => {
    const emptyDataGif = Buffer.from("47494638396101000100800000ffffff0000002c00000000010001000002003b", "hex");
    const structuralShellJpeg = Buffer.from("ffd8ffc00008080001000101ffda000200ffd9", "hex");
    expect(structuralShellJpeg).toHaveLength(19);

    await expect(preprocessActions([imageAction({ imageBase64: emptyDataGif.toString("base64") })]))
      .rejects.toThrow("empty LZW");
    await expect(preprocessActions([imageAction({ imageBase64: structuralShellJpeg.toString("base64") })]))
      .rejects.toThrow("JPEG decode failed");
  });

  it("rejects corrupt and oversized-dimension GIF/JPEG inputs after bounded decode validation", async () => {
    const corruptGif = Buffer.from(GIF);
    corruptGif[corruptGif.length - 4] ^= 0xff;
    const corruptJpeg = Buffer.from(JPEG);
    corruptJpeg[corruptJpeg.length - 4] ^= 0xff;
    const oversizedGif = Buffer.from(GIF);
    oversizedGif.writeUInt16LE(4097, 6);
    const oversizedJpeg = Buffer.from(JPEG);
    const sof = oversizedJpeg.indexOf(Buffer.from([0xff, 0xc0]));
    expect(sof).toBeGreaterThan(0);
    oversizedJpeg.writeUInt16BE(4097, sof + 7);

    await expect(preprocessActions([imageAction({ imageBase64: corruptGif.toString("base64") })])).rejects.toThrow();
    await expect(preprocessActions([imageAction({ imageBase64: corruptJpeg.toString("base64") })])).rejects.toThrow();
    await expect(preprocessActions([imageAction({ imageBase64: oversizedGif.toString("base64") })])).rejects.toThrow("4096x4096");
    await expect(preprocessActions([imageAction({ imageBase64: oversizedJpeg.toString("base64") })])).rejects.toThrow("4096x4096");
  });

  it("rejects corrupt, truncated, oversized-byte, oversized-dimension, WebP, and private-network sources", async () => {
    const corrupt = Buffer.from(PNG);
    corrupt[corrupt.length - 5] ^= 0xff;
    const oversizedDimensions = Buffer.from(PNG);
    oversizedDimensions.writeUInt32BE(4097, 16);
    await expect(preprocessActions([imageAction({ imageBase64: corrupt.toString("base64") })])).rejects.toThrow("checksum");
    await expect(preprocessActions([imageAction({ imageBase64: PNG.subarray(0, -1).toString("base64") })])).rejects.toThrow("PNG");
    await expect(preprocessActions([imageAction({ imageBase64: oversizedDimensions.toString("base64") })])).rejects.toThrow("4096x4096");
    await expect(preprocessActions([imageAction({ imageBase64: Buffer.from("RIFF0000WEBP", "ascii").toString("base64") })])).rejects.toThrow("WebP is not supported");
    await expect(preprocessActions([imageAction({ imageBase64: "AQID" })])).rejects.toThrow("supported PNG, JPEG, or GIF");
    await expect(preprocessActions([imageAction({ imageBase64: Buffer.alloc(MAX_IMAGE_BYTES + 1, 1).toString("base64") })])).rejects.toThrow("10 MiB");
    await expect(preprocessActions([imageAction({ url: "http://127.0.0.1/image.png" })])).rejects.toThrow("private");
  });

  it("requires configured roots and rejects traversal and symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "figma-assets-root-"));
    const outside = await mkdtemp(join(tmpdir(), "figma-assets-outside-"));
    tempDirectories.push(root, outside);
    await writeFile(join(root, "pixel.png"), PNG);
    await writeFile(join(outside, "outside.png"), PNG);
    await symlink(join(outside, "outside.png"), join(root, "escape.png"));

    await expect(preprocessActions([imageAction({ path: join(root, "pixel.png") })], { assetRoots: [] }))
      .rejects.toThrow("FIGMA_ASSET_ROOTS");
    await expect(preprocessActions([imageAction({ path: "../" + outside.split("/").at(-1) + "/outside.png" })], { assetRoots: [root] }))
      .rejects.toThrow("escapes");
    await expect(preprocessActions([imageAction({ path: join(root, "escape.png") })], { assetRoots: [root] }))
      .rejects.toThrow("escapes");
    await expect(preprocessActions([imageAction({ path: "pixel.png" })], { assetRoots: [root] }))
      .resolves.toEqual([expect.objectContaining({ imageBase64: IMAGE_FIXTURES.png })]);
  });

  it("accepts inert SVG and rejects active or externally referenced SVG before transport", () => {
    expect(() => validateSvg('<svg><defs><linearGradient id="g"/></defs><path fill="url(#g)"/></svg>')).not.toThrow();
    expect(() => validateSvg('<svg><script>alert(1)</script></svg>')).toThrow("external resource");
    expect(() => validateSvg('<svg><image href="https://example.com/a.png"/></svg>')).toThrow("external resource");
    expect(() => validateSvg(`<svg><!-- ${"x".repeat(1024 * 1024)} --></svg>`)).toThrow("1 MiB");
  });
});
