import { lookup } from "node:dns/promises";
import { readFile, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Action } from "../shared/actions.js";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_SVG_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

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
      headers: { accept: "image/png,image/jpeg,image/webp,image/gif" },
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

export function detectImageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const prefix = Buffer.from(bytes.subarray(0, 12)).toString("ascii");
  if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) return "image/gif";
  if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") return "image/webp";
  return null;
}

async function loadImage(action: Extract<Action, { type: "set_image_fill" }>): Promise<string> {
  let bytes: Buffer;
  let declaredType: string | undefined;
  if (action.imageBase64 !== undefined) {
    bytes = decodeBase64(action.imageBase64);
  } else if (action.path !== undefined) {
    const metadata = await stat(action.path);
    if (!metadata.isFile()) throw new Error("Image path must identify a regular file");
    if (metadata.size > MAX_IMAGE_BYTES) throw new Error("Image exceeds the 10 MiB limit");
    bytes = await readFile(action.path);
  } else if (action.url !== undefined) {
    ({ bytes, contentType: declaredType } = await fetchPublicImage(action.url));
  } else {
    throw new Error("set_image_fill requires one image source");
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Image exceeds the 10 MiB limit");
  const detected = detectImageType(bytes);
  if (!detected) throw new Error("Image bytes are not PNG, JPEG, WebP, or GIF");
  if (declaredType && declaredType !== detected) throw new Error(`Image content type ${declaredType} does not match ${detected} bytes`);
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
export async function preprocessActions(actions: Action[]): Promise<Action[]> {
  const processed: Action[] = [];
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index];
    try {
      if (action.type === "set_image_fill") {
        const imageBase64 = await loadImage(action);
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
