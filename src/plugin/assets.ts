import { lookup } from "node:dns/promises";
import { readFile, realpath, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { delimiter, isAbsolute, relative, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { decode as decodeJpeg } from "jpeg-js";
import { decode as decodeGif, decodeUndisposedFrame as decodeGifFrame } from "modern-gif";
import type { Action } from "../shared/actions.js";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_SVG_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const MAX_IMAGE_DIMENSION = 4096;
const MAX_DECODED_PIXELS = MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION;
const MAX_JPEG_MEMORY_MB = 128;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif"]);

export const GIF_DECODE_BUDGET = Object.freeze({
  maxFrames: 256,
  maxDecodedPixels: MAX_DECODED_PIXELS,
  maxDecodedBytes: MAX_DECODED_PIXELS * 4,
  // Structural LZW validation and local-frame decoding each visit every
  // decoded pixel once; compressed bytes are scanned once as well.
  maxWorkUnits: MAX_DECODED_PIXELS * 2 + MAX_IMAGE_BYTES,
});

export interface AssetPolicy {
  /** Explicit directories from which server-local image paths may be read. */
  assetRoots?: string[];
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized.startsWith("::ffff:")) return isPrivateIpv4(normalized.slice(7));
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc")
    || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9")
    || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff");
}

async function resolvePublicAddresses(url: URL): Promise<Array<{ address: string; family: 4 | 6 }>> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Image URL must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("Image URL credentials are not allowed");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname.toLowerCase() === "localhost") throw new Error("Image URL resolves to a private address");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true }) as Array<{ address: string; family: 4 | 6 }>;
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Image URL resolves to a private, loopback, link-local, or reserved address");
  }
  return addresses;
}

type HttpResult = { status: number; location?: string; contentType?: string; bytes: Buffer };

async function requestPinned(url: URL): Promise<HttpResult> {
  const addresses = await resolvePublicAddresses(url);
  return new Promise<HttpResult>((resolve, reject) => {
    const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = requester(url, {
      headers: { accept: "image/png,image/jpeg,image/gif" },
      // Pin the connection to the addresses already checked above. This closes
      // the DNS-rebinding window between validation and the actual socket.
      lookup: ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (options?.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      }) as never,
    }, (response) => {
      const status = response.statusCode ?? 0;
      const rawLocation = response.headers.location;
      const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
      const rawType = response.headers["content-type"];
      const contentType = (Array.isArray(rawType) ? rawType[0] : rawType)?.split(";", 1)[0].trim().toLowerCase();
      if (status >= 300 && status < 400) {
        response.resume();
        resolve({ status, location, contentType, bytes: Buffer.alloc(0) });
        return;
      }
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
        response.destroy();
        reject(new Error("Image exceeds the 10 MiB limit"));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > MAX_IMAGE_BYTES) {
          response.destroy(new Error("Image exceeds the 10 MiB limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status, location, contentType, bytes: Buffer.concat(chunks, total) }));
      response.on("error", reject);
    });
    const timer = setTimeout(() => request.destroy(new Error("Image request timed out after 10 seconds")), FETCH_TIMEOUT_MS);
    request.on("close", () => clearTimeout(timer));
    request.on("error", reject);
    request.end();
  });
}

async function fetchPublicImage(input: string): Promise<{ bytes: Buffer; contentType?: string }> {
  let current = new URL(input);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await requestPinned(current);
    if (response.status >= 300 && response.status < 400) {
      const location = response.location;
      if (!location) throw new Error(`Image redirect ${response.status} has no Location header`);
      if (redirects === MAX_REDIRECTS) throw new Error(`Image URL exceeded ${MAX_REDIRECTS} redirects`);
      current = new URL(location, current);
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`Image request failed with HTTP ${response.status}`);
    const contentType = response.contentType;
    if (contentType && !ALLOWED_IMAGE_TYPES.has(contentType)) throw new Error(`Unsupported image content type: ${contentType}`);
    return { bytes: response.bytes, contentType };
  }
  throw new Error(`Image URL exceeded ${MAX_REDIRECTS} redirects`);
}

function decodeBase64(input: string): Buffer {
  const compact = input.replace(/\s/g, "");
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error("imageBase64 is not valid base64");
  }
  return Buffer.from(compact, "base64");
}

type ImageMetadata = { type: "image/png" | "image/jpeg" | "image/gif"; width: number; height: number };
type GifMetadata = ImageMetadata & { type: "image/gif"; frameCount: number };

function assertDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("Image dimensions must be positive integers");
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new Error(`Image dimensions exceed ${MAX_IMAGE_DIMENSION}x${MAX_IMAGE_DIMENSION}`);
  }
}

let crcTable: Uint32Array | undefined;
function pngCrc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let value = n;
      for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[n] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function parsePng(bytes: Buffer): ImageMetadata {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)) throw new Error("Invalid or truncated PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let sawPalette = false;
  const compressedData: Buffer[] = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error("Truncated PNG chunk");
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error("Truncated PNG chunk data");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!sawHeader && type === "IHDR" && length === 13) {
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      assertDimensions(width, height);
      bitDepth = bytes[offset + 16];
      colorType = bytes[offset + 17];
      const validDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!validDepths[colorType]?.includes(bitDepth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0) {
        throw new Error("PNG has an unsupported IHDR encoding");
      }
      interlace = bytes[offset + 20];
      if (interlace !== 0 && interlace !== 1) throw new Error("PNG has an invalid interlace method");
    }
    const crcInput = bytes.subarray(offset + 4, offset + 8 + length);
    if (pngCrc32(crcInput) !== bytes.readUInt32BE(offset + 8 + length)) throw new Error(`Invalid PNG ${type} checksum`);
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) throw new Error("PNG must start with a 13-byte IHDR chunk");
      sawHeader = true;
    } else if (type === "IHDR") throw new Error("PNG contains multiple IHDR chunks");
    if (type === "PLTE") sawPalette = true;
    if (type === "IDAT") {
      sawData = true;
      compressedData.push(bytes.subarray(offset + 8, offset + 8 + length));
    }
    if (type === "IEND") {
      if (length !== 0 || end !== bytes.length) throw new Error("Invalid PNG IEND chunk");
      sawEnd = true;
      break;
    }
    offset = end;
  }
  if (!sawHeader || !sawData || !sawEnd) throw new Error("PNG is missing required image data or IEND");
  if (colorType === 3 && !sawPalette) throw new Error("Indexed PNG is missing its palette");
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  const bitsPerPixel = channels * bitDepth;
  const passes = interlace === 0
    ? [[0, 0, 1, 1]]
    : [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  const scanlines: Array<{ rows: number; bytesPerRow: number }> = [];
  let expectedBytes = 0;
  for (const [startX, startY, stepX, stepY] of passes) {
    const passWidth = width <= startX ? 0 : Math.ceil((width - startX) / stepX);
    const rows = height <= startY ? 0 : Math.ceil((height - startY) / stepY);
    if (passWidth === 0 || rows === 0) continue;
    const bytesPerRow = Math.ceil(passWidth * bitsPerPixel / 8);
    scanlines.push({ rows, bytesPerRow });
    expectedBytes += rows * (bytesPerRow + 1);
  }
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(compressedData), { maxOutputLength: expectedBytes });
  } catch {
    throw new Error("PNG contains invalid compressed image data");
  }
  if (inflated.length !== expectedBytes) throw new Error("PNG image data length does not match its dimensions");
  let scanlineOffset = 0;
  for (const pass of scanlines) {
    for (let row = 0; row < pass.rows; row++) {
      if (inflated[scanlineOffset] > 4) throw new Error("PNG contains an invalid scanline filter");
      scanlineOffset += pass.bytesPerRow + 1;
    }
  }
  return { type: "image/png", width, height };
}

function readGifSubBlocks(bytes: Buffer, start: number): { end: number; data: Buffer } {
  let offset = start;
  const blocks: Buffer[] = [];
  while (true) {
    if (offset >= bytes.length) throw new Error("Truncated GIF data blocks");
    const length = bytes[offset++];
    if (length === 0) return { end: offset, data: Buffer.concat(blocks) };
    if (offset + length > bytes.length) throw new Error("Truncated GIF data block");
    blocks.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
}

function validateGifLzw(data: Buffer, minimumCodeSize: number, expectedPixels: number): void {
  if (minimumCodeSize < 2 || minimumCodeSize > 8 || data.length === 0) {
    throw new Error("GIF contains invalid or empty LZW image data");
  }
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;
  const lengths = new Uint16Array(4096);
  for (let code = 0; code < clearCode; code++) lengths[code] = 1;
  let codeSize = minimumCodeSize + 1;
  let nextCode = endCode + 1;
  let previousCode = -1;
  let bitOffset = 0;
  let outputPixels = 0;
  let sawClear = false;

  const readCode = (): number | undefined => {
    if (bitOffset + codeSize > data.length * 8) return undefined;
    let value = 0;
    for (let bit = 0; bit < codeSize; bit++) {
      value |= ((data[(bitOffset + bit) >> 3]! >> ((bitOffset + bit) & 7)) & 1) << bit;
    }
    bitOffset += codeSize;
    return value;
  };

  for (let code = readCode(); code !== undefined; code = readCode()) {
    if (code === clearCode) {
      codeSize = minimumCodeSize + 1;
      nextCode = endCode + 1;
      previousCode = -1;
      sawClear = true;
      continue;
    }
    if (code === endCode) {
      if (!sawClear || outputPixels !== expectedPixels) {
        throw new Error("GIF LZW image data does not decode to the declared frame size");
      }
      return;
    }
    if (!sawClear || code > nextCode || (code === nextCode && previousCode < 0)) {
      throw new Error("GIF contains an invalid LZW code stream");
    }
    const decodedLength = code < nextCode ? lengths[code] : lengths[previousCode] + 1;
    if (!decodedLength || outputPixels + decodedLength > expectedPixels) {
      throw new Error("GIF LZW image data exceeds the declared frame size");
    }
    outputPixels += decodedLength;
    if (previousCode >= 0 && nextCode < 4096) {
      lengths[nextCode++] = lengths[previousCode] + 1;
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize++;
    }
    previousCode = code;
  }
  throw new Error("GIF LZW image data is truncated or missing an end code");
}

function parseGif(bytes: Buffer): GifMetadata {
  if (bytes.length < 14 || !["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) throw new Error("Invalid or truncated GIF");
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  assertDimensions(width, height);
  let offset = 13;
  if (bytes[10] & 0x80) offset += 3 * (1 << ((bytes[10] & 0x07) + 1));
  if (offset > bytes.length) throw new Error("Truncated GIF global color table");
  let sawImage = false;
  let frameCount = 0;
  let decodedPixels = 0;
  let decodedBytes = 0;
  let decodeWorkUnits = 0;
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) {
      if (!sawImage || offset !== bytes.length) throw new Error("Invalid GIF trailer or missing image data");
      return { type: "image/gif", width, height, frameCount };
    }
    if (marker === 0x21) {
      if (offset >= bytes.length) throw new Error("Truncated GIF extension");
      offset = readGifSubBlocks(bytes, offset + 1).end;
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) throw new Error("Invalid or truncated GIF image descriptor");
    const left = bytes.readUInt16LE(offset);
    const top = bytes.readUInt16LE(offset + 2);
    const frameWidth = bytes.readUInt16LE(offset + 4);
    const frameHeight = bytes.readUInt16LE(offset + 6);
    if (frameWidth < 1 || frameHeight < 1 || left + frameWidth > width || top + frameHeight > height) {
      throw new Error("GIF frame lies outside its declared dimensions");
    }
    frameCount++;
    if (frameCount > GIF_DECODE_BUDGET.maxFrames) throw new Error("GIF frame count exceeds the resource limit");
    const framePixels = frameWidth * frameHeight;
    decodedPixels += framePixels;
    decodedBytes += framePixels * 4;
    if (decodedPixels > GIF_DECODE_BUDGET.maxDecodedPixels) throw new Error("GIF decoded pixels exceed the resource limit");
    if (decodedBytes > GIF_DECODE_BUDGET.maxDecodedBytes) throw new Error("GIF decoded bytes exceed the resource limit");
    const packed = bytes[offset + 8];
    offset += 9;
    if (packed & 0x80) offset += 3 * (1 << ((packed & 0x07) + 1));
    if (offset >= bytes.length) throw new Error("Truncated GIF image data");
    const minimumCodeSize = bytes[offset++];
    const blocks = readGifSubBlocks(bytes, offset);
    decodeWorkUnits += framePixels * 2 + blocks.data.byteLength;
    if (decodeWorkUnits > GIF_DECODE_BUDGET.maxWorkUnits) throw new Error("GIF decode work exceeds the resource limit");
    validateGifLzw(blocks.data, minimumCodeSize, framePixels);
    offset = blocks.end;
    sawImage = true;
  }
  throw new Error("GIF is missing its trailer");
}

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
function parseJpeg(bytes: Buffer): ImageMetadata {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Invalid or truncated JPEG");
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawScan = false;
  let sawScanData = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) throw new Error("Invalid JPEG marker framing");
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) throw new Error("Truncated JPEG marker");
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!width || !sawScan || !sawScanData || offset !== bytes.length) throw new Error("Invalid JPEG end marker or missing image data/dimensions");
      try {
        const decoded = decodeJpeg(bytes, {
          useTArray: true,
          formatAsRGBA: false,
          tolerantDecoding: false,
          maxResolutionInMP: MAX_DECODED_PIXELS / 1_000_000,
          maxMemoryUsageInMB: MAX_JPEG_MEMORY_MB,
        });
        if (decoded.width !== width || decoded.height !== height || decoded.data.length === 0) {
          throw new Error("decoded dimensions do not match the frame header");
        }
      } catch (error) {
        throw new Error(`JPEG decode failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { type: "image/jpeg", width, height };
    }
    if (marker === 0x00 || marker === 0xd8) throw new Error("Invalid JPEG marker");
    if (marker >= 0xd0 && marker <= 0xd7 || marker === 0x01) continue;
    if (offset + 2 > bytes.length) throw new Error("Truncated JPEG segment");
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw new Error("Invalid or truncated JPEG segment");
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 8) throw new Error("Invalid JPEG frame header");
      height = bytes.readUInt16BE(offset + 3);
      width = bytes.readUInt16BE(offset + 5);
      assertDimensions(width, height);
    }
    offset += length;
    if (marker === 0xda) {
      sawScan = true;
      // Scan entropy-coded bytes to the next real marker. FF00 is escaped data;
      // restart markers are in-stream and do not terminate the scan.
      while (offset < bytes.length) {
        if (bytes[offset++] !== 0xff) {
          sawScanData = true;
          continue;
        }
        while (offset < bytes.length && bytes[offset] === 0xff) offset++;
        if (offset >= bytes.length) throw new Error("Truncated JPEG scan");
        const scanMarker = bytes[offset];
        if (scanMarker === 0x00 || scanMarker >= 0xd0 && scanMarker <= 0xd7) {
          sawScanData = true;
          offset++;
          continue;
        }
        offset--;
        break;
      }
    }
  }
  throw new Error("JPEG is missing its end marker");
}

export function inspectImage(bytes: Uint8Array): ImageMetadata {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return parsePng(buffer);
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return parseJpeg(buffer);
  if (["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) {
    const metadata = parseGif(buffer);
    try {
      // modern-gif reads an ArrayBuffer from offset zero; copy the bounded
      // Buffer view so pooled Node backing bytes cannot become parser input.
      const gifSource = Uint8Array.from(buffer).buffer;
      const decoded = decodeGif(gifSource);
      if (decoded.width !== metadata.width || decoded.height !== metadata.height
        || decoded.frames.length !== metadata.frameCount) {
        throw new Error("decoded dimensions or frame count are invalid");
      }
      for (let frame = 0; frame < decoded.frames.length; frame++) {
        const expected = decoded.frames[frame]!;
        const local = decodeGifFrame(gifSource, decoded, frame);
        if (local.width !== expected.width || local.height !== expected.height
          || local.data.byteLength !== expected.width * expected.height * 4) {
          throw new Error(`decoded frame ${frame} has invalid dimensions or byte length`);
        }
      }
    } catch (error) {
      throw new Error(`GIF decode failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { type: metadata.type, width: metadata.width, height: metadata.height };
  }
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    throw new Error("WebP is not supported by the installed Figma Plugin API contract");
  }
  throw new Error("Image bytes are not a supported PNG, JPEG, or GIF");
}

function configuredAssetRoots(policy: AssetPolicy): string[] {
  return policy.assetRoots ?? (process.env.FIGMA_ASSET_ROOTS ?? "").split(delimiter).filter(Boolean);
}

async function resolveLocalAsset(input: string, policy: AssetPolicy): Promise<string> {
  const roots = configuredAssetRoots(policy);
  if (roots.length === 0) throw new Error("Local image paths require at least one configured FIGMA_ASSET_ROOTS directory");
  const realRoots = await Promise.all(roots.map((root) => realpath(resolve(root))));
  const candidates = isAbsolute(input) ? [input] : roots.map((root) => resolve(root, input));
  let resolvedPath: string | undefined;
  for (const candidate of candidates) {
    try {
      resolvedPath = await realpath(candidate);
      break;
    } catch {
      // Try the next configured root for relative paths.
    }
  }
  if (!resolvedPath) throw new Error("Local image path does not exist in a configured asset root");
  const contained = realRoots.some((root) => {
    const pathFromRoot = relative(root, resolvedPath!);
    return pathFromRoot !== "" && !pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      && pathFromRoot !== ".." && !isAbsolute(pathFromRoot);
  });
  if (!contained) throw new Error("Local image path escapes the configured asset roots");
  return resolvedPath;
}

async function loadImage(action: Extract<Action, { type: "set_image_fill" }>, policy: AssetPolicy): Promise<string> {
  let bytes: Buffer;
  let declaredType: string | undefined;
  if (action.imageBase64 !== undefined) {
    bytes = decodeBase64(action.imageBase64);
  } else if (action.path !== undefined) {
    const allowedPath = await resolveLocalAsset(action.path, policy);
    const metadata = await stat(allowedPath);
    if (!metadata.isFile()) throw new Error("Image path must identify a regular file");
    if (metadata.size > MAX_IMAGE_BYTES) throw new Error("Image exceeds the 10 MiB limit");
    bytes = await readFile(allowedPath);
  } else if (action.url !== undefined) {
    ({ bytes, contentType: declaredType } = await fetchPublicImage(action.url));
  } else {
    throw new Error("set_image_fill requires one image source");
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Image exceeds the 10 MiB limit");
  const detected = inspectImage(bytes);
  if (declaredType && declaredType !== detected.type) throw new Error(`Image content type ${declaredType} does not match ${detected.type} bytes`);
  return bytes.toString("base64");
}

export function validateSvg(svg: string): void {
  if (Buffer.byteLength(svg, "utf8") > MAX_SVG_BYTES) throw new Error("SVG exceeds the 1 MiB limit");
  if (!/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(svg)) throw new Error("SVG input must have an <svg> root");
  const forbidden = [
    /<!DOCTYPE/i, /<!ENTITY/i, /<script\b/i, /<foreignObject\b/i, /<iframe\b/i,
    /\son[a-z]+\s*=/i, /\b(?:href|xlink:href)\s*=\s*["'](?!#)/i,
    /url\(\s*["']?(?!#)/i, /@import\b/i,
  ];
  if (forbidden.some((pattern) => pattern.test(svg))) {
    throw new Error("SVG scripts, active content, and external resource references are not allowed");
  }
}

/** Perform all filesystem/network/asset checks before a mutation batch is compiled or sent. */
export async function preprocessActions(actions: Action[], policy: AssetPolicy = {}): Promise<Action[]> {
  const processed: Action[] = [];
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index];
    try {
      if (action.type === "set_image_fill") {
        const imageBase64 = await loadImage(action, policy);
        const { path: _path, url: _url, ...rest } = action;
        processed.push({ ...rest, imageBase64 } as Action);
      } else {
        if (action.type === "create_from_svg") validateSvg(action.svg);
        processed.push(action);
      }
    } catch (error) {
      throw new Error(`Action ${index}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return processed;
}
