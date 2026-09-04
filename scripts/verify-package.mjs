#!/usr/bin/env node

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { basename, dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const EXPECTED_PACKAGE_NAME = "@spetex/figma-design-pipeline";
const TAR_BLOCK_SIZE = 512;
const REQUIRED_PATHS = [
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

function fail(message) {
  throw new Error(message);
}

function readJson(path, description) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Could not read ${description} ${path}: ${error.message}`);
  }
}

function requireSafePath(path, description) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\\") ||
    path.includes("\0") ||
    posix.isAbsolute(path)
  ) {
    fail(`${description} is not a safe relative POSIX path: ${JSON.stringify(path)}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`${description} is not normalized: ${JSON.stringify(path)}`);
  }
  if (posix.normalize(path) !== path) {
    fail(`${description} is not normalized: ${JSON.stringify(path)}`);
  }
  return path;
}

function requireInteger(value, description) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${description} must be a non-negative safe integer`);
  }
  return value;
}

function requireMode(value, description) {
  const mode = requireInteger(value, description);
  if (mode > 0o7777) {
    fail(`${description} contains bits outside a tar permission mode`);
  }
  return mode;
}

function parseTarNumber(header, offset, length, description) {
  const field = header.subarray(offset, offset + length);
  if ((field[0] & 0x80) !== 0) {
    fail(`${description} uses an unsupported base-256 tar number`);
  }

  let index = 0;
  while (index < field.length && field[index] === 0x20) index += 1;

  let value = 0n;
  let digitCount = 0;
  while (index < field.length && field[index] >= 0x30 && field[index] <= 0x37) {
    value = value * 8n + BigInt(field[index] - 0x30);
    digitCount += 1;
    index += 1;
  }

  if (digitCount === 0) {
    if (field.every((byte) => byte === 0 || byte === 0x20)) return 0;
    fail(`${description} is not a valid octal tar number`);
  }
  if (
    index === field.length ||
    field.subarray(index).some((byte) => byte !== 0 && byte !== 0x20)
  ) {
    fail(`${description} is not a valid octal tar number`);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(`${description} exceeds the safe integer range`);
  }
  return requireInteger(Number(value), description);
}

function parseTarString(header, offset, length, description) {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  const content = nul === -1 ? field : field.subarray(0, nul);
  if (nul !== -1 && field.subarray(nul).some((byte) => byte !== 0)) {
    fail(`${description} contains data after its NUL terminator`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    fail(`${description} is not valid UTF-8`);
  }
}

function tarChecksum(header) {
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return sum;
}

function parseArchive(tarball) {
  let archive;
  try {
    archive = gunzipSync(tarball);
  } catch (error) {
    fail(`Tarball is not a valid gzip stream: ${error.message}`);
  }
  if (archive.length < TAR_BLOCK_SIZE * 2 || archive.length % TAR_BLOCK_SIZE !== 0) {
    fail("Tar archive is truncated or incorrectly padded");
  }

  const entries = [];
  const contents = new Map();
  const seen = new Set();
  let offset = 0;
  let endBlocks = 0;
  while (offset < archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      endBlocks += 1;
      offset += TAR_BLOCK_SIZE;
      if (endBlocks === 2) {
        if (archive.subarray(offset).some((byte) => byte !== 0)) {
          fail("Tar archive contains data after its end marker");
        }
        break;
      }
      continue;
    }
    if (endBlocks !== 0) {
      fail("Tar archive contains an entry after a zero block");
    }

    const storedChecksum = parseTarNumber(header, 148, 8, "Tar header checksum");
    if (storedChecksum !== tarChecksum(header)) {
      fail("Tar archive contains a header with an invalid checksum");
    }
    if (parseTarString(header, 257, 6, "Tar magic") !== "ustar") {
      fail("Tar archive entry is not in ustar format");
    }

    const name = parseTarString(header, 0, 100, "Tar entry name");
    const prefix = parseTarString(header, 345, 155, "Tar entry prefix");
    const archivePath = prefix ? `${prefix}/${name}` : name;
    if (!archivePath.startsWith("package/")) {
      fail(`Tar entry is outside the package root: ${JSON.stringify(archivePath)}`);
    }
    const path = requireSafePath(archivePath.slice("package/".length), "Tar entry path");
    if (`package/${path}` !== archivePath) {
      fail(`Tar entry path is not canonical: ${JSON.stringify(archivePath)}`);
    }
    if (seen.has(path)) {
      fail(`Tar archive contains a duplicate entry: ${path}`);
    }
    seen.add(path);

    const type = header[156];
    if (type !== 0 && type !== 0x30) {
      const typeName = type === 0x31 || type === 0x32
        ? "link"
        : `type ${JSON.stringify(String.fromCharCode(type))}`;
      fail(`Tar entry ${path} has forbidden ${typeName}`);
    }
    const linkName = parseTarString(header, 157, 100, "Tar link name");
    if (linkName !== "") {
      fail(`Regular tar entry ${path} has a link target`);
    }

    const mode = requireMode(parseTarNumber(header, 100, 8, `Mode for ${path}`), `Mode for ${path}`);
    parseTarNumber(header, 108, 8, `UID for ${path}`);
    parseTarNumber(header, 116, 8, `GID for ${path}`);
    const size = parseTarNumber(header, 124, 12, `Size for ${path}`);
    parseTarNumber(header, 136, 12, `Modification time for ${path}`);
    parseTarNumber(header, 329, 8, `Device major number for ${path}`);
    parseTarNumber(header, 337, 8, `Device minor number for ${path}`);
    const dataOffset = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataOffset + size;
    const nextOffset = dataOffset + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    if (dataEnd > archive.length || nextOffset > archive.length) {
      fail(`Tar entry ${path} extends beyond the archive`);
    }
    if (archive.subarray(dataEnd, nextOffset).some((byte) => byte !== 0)) {
      fail(`Tar entry ${path} has non-zero data padding`);
    }
    const data = Buffer.from(archive.subarray(dataOffset, dataEnd));
    entries.push({ path, size, mode });
    contents.set(path, data);
    offset = nextOffset;
  }

  if (endBlocks < 2) {
    fail("Tar archive is missing its two-block end marker");
  }
  return { entries, contents };
}

function comparePathSets(actual, expected, description) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((path) => !actualSet.has(path));
  const unexpected = actual.filter((path) => !expectedSet.has(path));
  if (missing.length || unexpected.length) {
    const details = [];
    if (missing.length) details.push(`missing:\n${missing.join("\n")}`);
    if (unexpected.length) details.push(`unexpected:\n${unexpected.join("\n")}`);
    fail(`${description} does not match exactly (${details.join("\n")})`);
  }
}

function verifyDigest(tarball, algorithm, expected, description) {
  const actual = createHash(algorithm).update(tarball).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    fail(`${description} does not match the actual tarball`);
  }
}

function parseIntegrity(integrity) {
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    fail("npm pack metadata must include SHA-512 integrity");
  }
  const encoded = integrity.slice("sha512-".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    fail("npm pack SHA-512 integrity is not valid base64");
  }
  const digest = Buffer.from(encoded, "base64");
  if (digest.length !== 64 || digest.toString("base64") !== encoded) {
    fail("npm pack SHA-512 integrity has an invalid digest length or encoding");
  }
  return digest;
}

function readTarball(path) {
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    fail(`Tarball does not exist or cannot be inspected: ${path} (${error.message})`);
  }
  if (before.isSymbolicLink()) {
    fail(`Tarball candidate must not be a symbolic link: ${path}`);
  }
  if (!before.isFile()) {
    fail(`Tarball candidate must be a regular file: ${path}`);
  }

  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail(`Tarball candidate changed while it was being opened: ${path}`);
    }
    const data = readFileSync(fd);
    const after = fstatSync(fd);
    if (after.size !== data.length || after.size !== opened.size) {
      fail(`Tarball candidate changed while it was being read: ${path}`);
    }
    return data;
  } catch (error) {
    fail(`Could not safely read tarball candidate ${path}: ${error.message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function verifyPackage(manifestPath) {
  const rootPackagePath = fileURLToPath(new URL("../package.json", import.meta.url));
  const rootPackage = readJson(rootPackagePath, "repository package metadata");
  if (rootPackage.name !== EXPECTED_PACKAGE_NAME || typeof rootPackage.version !== "string") {
    fail(`Repository package identity must be ${EXPECTED_PACKAGE_NAME}@<version>`);
  }
  const expectedVersion = rootPackage.version;
  const expectedId = `${EXPECTED_PACKAGE_NAME}@${expectedVersion}`;
  const expectedFilename = `${EXPECTED_PACKAGE_NAME.slice(1).replace("/", "-")}-${expectedVersion}.tgz`;

  const packResults = readJson(manifestPath, "npm pack metadata");
  if (!Array.isArray(packResults) || packResults.length !== 1) {
    fail("Expected npm pack metadata for exactly one package");
  }
  const [metadata] = packResults;
  if (!metadata || typeof metadata !== "object") {
    fail("npm pack metadata entry must be an object");
  }
  if (metadata.name !== EXPECTED_PACKAGE_NAME || metadata.version !== expectedVersion || metadata.id !== expectedId) {
    fail(`npm pack metadata identity must be exactly ${expectedId}`);
  }
  if (metadata.filename !== expectedFilename || basename(metadata.filename) !== metadata.filename) {
    fail(`npm pack filename must be exactly ${expectedFilename} with no directory components`);
  }
  if (!Array.isArray(metadata.files)) {
    fail("npm pack metadata must include its file list");
  }

  const manifestDirectory = dirname(resolve(manifestPath));
  const tarballPath = resolve(manifestDirectory, metadata.filename);
  if (dirname(tarballPath) !== manifestDirectory) {
    fail("npm pack filename escapes the metadata directory");
  }
  const tarball = readTarball(tarballPath);
  if (requireInteger(metadata.size, "npm pack size") !== tarball.length) {
    fail("npm pack size does not match the actual tarball");
  }
  if (typeof metadata.shasum !== "string" || !/^[a-f0-9]{40}$/.test(metadata.shasum)) {
    fail("npm pack metadata must include a lowercase SHA-1 shasum");
  }
  verifyDigest(tarball, "sha1", Buffer.from(metadata.shasum, "hex"), "npm pack shasum");
  verifyDigest(tarball, "sha512", parseIntegrity(metadata.integrity), "npm pack integrity");

  const jsonEntries = metadata.files.map((file, index) => {
    if (!file || typeof file !== "object") {
      fail(`npm pack file entry ${index} must be an object`);
    }
    return {
      path: requireSafePath(file.path, `npm pack file entry ${index}`),
      size: requireInteger(file.size, `Size for npm pack file entry ${index}`),
      mode: requireMode(file.mode, `Mode for npm pack file entry ${index}`),
    };
  });
  const jsonPaths = jsonEntries.map(({ path }) => path);
  if (new Set(jsonPaths).size !== jsonPaths.length) {
    fail("npm pack metadata contains duplicate file entries");
  }
  if (requireInteger(metadata.entryCount, "npm pack entryCount") !== jsonEntries.length) {
    fail("npm pack entryCount does not match its file list");
  }
  const jsonUnpackedSize = jsonEntries.reduce((total, entry) => total + entry.size, 0);
  if (requireInteger(metadata.unpackedSize, "npm pack unpackedSize") !== jsonUnpackedSize) {
    fail("npm pack unpackedSize does not match its file list");
  }
  comparePathSets(jsonPaths, REQUIRED_PATHS, "npm pack metadata file list");

  const { entries: archiveEntries, contents } = parseArchive(tarball);
  const archivePaths = archiveEntries.map(({ path }) => path);
  comparePathSets(archivePaths, REQUIRED_PATHS, "Tar archive file list");
  comparePathSets(archivePaths, jsonPaths, "Tar archive and npm pack metadata file lists");

  const jsonByPath = new Map(jsonEntries.map((entry) => [entry.path, entry]));
  for (const entry of archiveEntries) {
    const jsonEntry = jsonByPath.get(entry.path);
    if (entry.size !== jsonEntry.size || entry.mode !== jsonEntry.mode) {
      fail(`Tar entry metadata differs from npm pack metadata for ${entry.path}`);
    }
  }
  const archiveUnpackedSize = archiveEntries.reduce((total, entry) => total + entry.size, 0);
  if (archiveUnpackedSize !== metadata.unpackedSize) {
    fail("Tar archive unpacked size does not match npm pack metadata");
  }

  let archivedPackage;
  try {
    archivedPackage = JSON.parse(contents.get("package.json").toString("utf8"));
  } catch (error) {
    fail(`Archived package.json is invalid: ${error.message}`);
  }
  if (archivedPackage.name !== EXPECTED_PACKAGE_NAME || archivedPackage.version !== expectedVersion) {
    fail(`Archived package identity must be exactly ${expectedId}`);
  }

  return { filename: metadata.filename, path: tarballPath, entryCount: archiveEntries.length };
}

const manifestPath = process.argv[2];
if (!manifestPath) {
  fail("Usage: node scripts/verify-package.mjs <npm-pack-json> [--print-path]");
}
const printPath = process.argv[3] === "--print-path";
if (process.argv.length > (printPath ? 4 : 3)) {
  fail("Usage: node scripts/verify-package.mjs <npm-pack-json> [--print-path]");
}
const result = verifyPackage(manifestPath);
if (printPath) {
  console.log(result.path);
} else {
  console.log(`Verified ${result.filename}: ${result.entryCount} intended regular files and matching digests`);
}
