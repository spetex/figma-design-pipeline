#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EXPECTED_PACKAGE_NAME = "@spetex/figma-design-pipeline";
const TAG_PREFIX = "figma-design-pipeline-v";
const ALLOWED_EVENTS = new Set(["push", "workflow_dispatch"]);

function fail(message) {
  throw new Error(message);
}

function requireEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    fail(`${name} must be set for release publication`);
  }
  return value;
}

function readPackage(path) {
  let packageMetadata;
  try {
    packageMetadata = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Could not read package metadata ${path}: ${error.message}`);
  }

  if (
    packageMetadata.name !== EXPECTED_PACKAGE_NAME
    || typeof packageMetadata.version !== "string"
    || packageMetadata.version.length === 0
  ) {
    fail(`Package identity must be ${EXPECTED_PACKAGE_NAME}@<version>`);
  }
  return packageMetadata;
}

export function verifyReleaseTag(packagePath) {
  const packageMetadata = readPackage(resolve(packagePath));
  const eventName = requireEnvironment("GITHUB_EVENT_NAME");
  const refType = requireEnvironment("GITHUB_REF_TYPE");
  const refName = requireEnvironment("GITHUB_REF_NAME");
  const ref = requireEnvironment("GITHUB_REF");
  const expectedRefName = `${TAG_PREFIX}${packageMetadata.version}`;
  const expectedRef = `refs/tags/${expectedRefName}`;

  if (!ALLOWED_EVENTS.has(eventName)) {
    fail(`Release publication is not allowed for GitHub event ${JSON.stringify(eventName)}`);
  }
  if (refType !== "tag" || refName !== expectedRefName || ref !== expectedRef) {
    fail(
      `Release publication requires the exact package tag ${expectedRef}; received `
      + `GITHUB_REF_TYPE=${JSON.stringify(refType)}, GITHUB_REF_NAME=${JSON.stringify(refName)}, `
      + `GITHUB_REF=${JSON.stringify(ref)}`,
    );
  }

  return { eventName, packageName: packageMetadata.name, version: packageMetadata.version, ref };
}

if (process.argv.length !== 3) {
  fail("Usage: node scripts/verify-release-tag.mjs <package-json>");
}

const result = verifyReleaseTag(process.argv[2]);
console.log(`Verified ${result.ref} for ${result.packageName}@${result.version} (${result.eventName})`);
