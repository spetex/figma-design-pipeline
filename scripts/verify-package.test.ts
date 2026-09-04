import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verifierPath = join(repoRoot, "scripts", "verify-package.mjs");
const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const packageName: string = rootPackage.name;
const packageVersion: string = rootPackage.version;
const filename = `spetex-figma-design-pipeline-${packageVersion}.tgz`;
const requiredPaths = [
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
const tempDirectories: string[] = [];

interface TarEntry {
  path: string;
  contents: Buffer;
  mode: number;
  type?: string;
  linkName?: string;
}

interface PackFile {
  path: string;
  size: number;
  mode: number;
}

interface Fixture {
  directory: string;
  manifestPath: string;
  tarballPath: string;
  metadata: Record<string, unknown> & { files: PackFile[] };
}

afterAll(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release package verifier", () => {
  it("accepts a valid archive and prints its verified path", () => {
    const fixture = createFixture();
    const result = runVerifier(fixture.manifestPath, "--print-path");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(fixture.tarballPath);
  });

  it("rejects a fabricated JSON file list even when its digests describe the archive", () => {
    const fixture = createFixture();
    fixture.metadata.files = fixture.metadata.files.map((file) =>
      file.path === "README.md" ? { ...file, path: "fabricated.md" } : file,
    );
    writeManifest(fixture);

    expectFailure(fixture, /metadata file list does not match exactly/);
  });

  it("rejects a missing tarball", () => {
    const fixture = createFixture();
    rmSync(fixture.tarballPath);

    expectFailure(fixture, /Tarball does not exist/);
  });

  it("rejects a tarball candidate that is a symlink", () => {
    const fixture = createFixture();
    const target = join(fixture.directory, "target.tgz");
    renameSync(fixture.tarballPath, target);
    symlinkSync(target, fixture.tarballPath);

    expectFailure(fixture, /must not be a symbolic link/);
  });

  it("rejects a tarball candidate that is not a regular file", () => {
    const fixture = createFixture();
    rmSync(fixture.tarballPath);
    mkdirSync(fixture.tarballPath);

    expectFailure(fixture, /must be a regular file/);
  });

  it("rejects a filename with directory components", () => {
    const fixture = createFixture();
    fixture.metadata.filename = `../${filename}`;
    writeManifest(fixture);

    expectFailure(fixture, /filename must be exactly/);
  });

  it.each([
    ["name", "@attacker/not-the-package"],
    ["version", "9.9.9"],
    ["id", `${packageName}@9.9.9`],
  ])("rejects wrong npm pack %s identity metadata", (field, value) => {
    const fixture = createFixture();
    fixture.metadata[field] = value;
    writeManifest(fixture);

    expectFailure(fixture, /metadata identity must be exactly/);
  });

  it.each([
    ["name", "@attacker/not-the-package"],
    ["version", "9.9.9"],
  ])("rejects the wrong archived package %s", (field, value) => {
    const entries = makeValidEntries({ [field]: value });
    const fixture = createFixture(entries);

    expectFailure(fixture, /Archived package identity must be exactly/);
  });

  it.each(["shasum", "integrity"])('fails closed when required "%s" metadata is absent', (field) => {
    const fixture = createFixture();
    delete fixture.metadata[field];
    writeManifest(fixture);

    expectFailure(fixture, new RegExp(field === "shasum" ? "must include a lowercase SHA-1" : "must include SHA-512"));
  });

  it.each([
    ["shasum", "0".repeat(40)],
    ["integrity", `sha512-${Buffer.alloc(64).toString("base64")}`],
  ])("rejects a %s digest mismatch", (field, value) => {
    const fixture = createFixture();
    fixture.metadata[field] = value;
    writeManifest(fixture);

    expectFailure(fixture, /does not match the actual tarball/);
  });

  it("rejects an unexpected archive entry even when JSON and digests agree", () => {
    const entries = [...makeValidEntries(), makeEntry("surprise.txt")];
    const fixture = createFixture(entries, entries.slice(0, -1));

    expectFailure(fixture, /Tar archive file list does not match exactly/);
  });

  it("rejects a duplicate archive entry", () => {
    const entries = makeValidEntries();
    const fixture = createFixture(
      [...entries, entries.find((entry) => entry.path === "package/README.md")!],
      entries,
    );

    expectFailure(fixture, /duplicate entry: README\.md/);
  });

  it.each(["package/../escape", "/absolute/path"])('rejects unsafe archive path "%s"', (path) => {
    const entries = [...makeValidEntries(), makeEntry(path, undefined, true)];
    const fixture = createFixture(entries, entries.slice(0, -1));

    expectFailure(fixture, /not normalized|outside the package root/);
  });

  it.each([
    ["hard link", "1"],
    ["symbolic link", "2"],
  ])("rejects a %s archive entry", (_description, type) => {
    const entries = makeValidEntries();
    const readme = entries.find((entry) => entry.path === "package/README.md")!;
    readme.contents = Buffer.alloc(0);
    readme.type = type;
    readme.linkName = "package/LICENSE";
    const fixture = createFixture(entries);

    expectFailure(fixture, /has forbidden link/);
  });

  it("rejects other non-regular archive entry types", () => {
    const entries = makeValidEntries();
    entries.find((entry) => entry.path === "package/README.md")!.type = "6";
    const fixture = createFixture(entries);

    expectFailure(fixture, /has forbidden type/);
  });
});

function makeValidEntries(packageOverrides: Record<string, string> = {}): TarEntry[] {
  return requiredPaths.map((path) => {
    if (path === "package.json") {
      return makeEntry(
        path,
        JSON.stringify({ name: packageName, version: packageVersion, ...packageOverrides }),
      );
    }
    return makeEntry(path);
  });
}

function makeEntry(path: string, contents = `fixture:${path}\n`, alreadyPrefixed = false): TarEntry {
  return {
    path: alreadyPrefixed ? path : `package/${path}`,
    contents: Buffer.from(contents),
    mode: path.includes("/bin/") ? 0o755 : 0o644,
  };
}

function createFixture(archiveEntries = makeValidEntries(), metadataEntries = archiveEntries): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "verify-package-test-"));
  tempDirectories.push(directory);
  const tarballPath = join(directory, filename);
  const manifestPath = join(directory, "npm-pack.json");
  const tarball = gzipSync(buildTar(archiveEntries));
  writeFileSync(tarballPath, tarball);

  const files = metadataEntries.map((entry) => ({
    path: entry.path.startsWith("package/") ? entry.path.slice("package/".length) : entry.path,
    size: entry.contents.length,
    mode: entry.mode,
  }));
  const metadata = {
    id: `${packageName}@${packageVersion}`,
    name: packageName,
    version: packageVersion,
    size: tarball.length,
    unpackedSize: files.reduce((total, file) => total + file.size, 0),
    shasum: createHash("sha1").update(tarball).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    filename,
    files,
    entryCount: files.length,
    bundled: [],
  };
  const fixture = { directory, manifestPath, tarballPath, metadata };
  writeManifest(fixture);
  return fixture;
}

function writeManifest(fixture: Fixture) {
  writeFileSync(fixture.manifestPath, JSON.stringify([fixture.metadata]));
}

function runVerifier(manifestPath: string, ...args: string[]) {
  return spawnSync(process.execPath, [verifierPath, manifestPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function expectFailure(fixture: Fixture, message: RegExp) {
  const result = runVerifier(fixture.manifestPath);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(message);
}

function buildTar(entries: TarEntry[]) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    writeString(header, 0, 100, entry.path);
    writeOctal(header, 100, 8, entry.mode);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.contents.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    writeString(header, 156, 1, entry.type ?? "0");
    if (entry.linkName) writeString(header, 157, 100, entry.linkName);
    writeString(header, 257, 6, "ustar");
    writeString(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    chunks.push(header, entry.contents);
    const padding = (512 - (entry.contents.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function writeString(buffer: Buffer, offset: number, length: number, value: string) {
  const encoded = Buffer.from(value);
  if (encoded.length > length) throw new Error(`Test tar field is too long: ${value}`);
  encoded.copy(buffer, offset);
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number) {
  writeString(buffer, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}
