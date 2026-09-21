#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  createReleaseManifest,
  toCliError,
  verifyReleaseManifest,
} from "./lib/release-manifest.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts\\release-manifest.mjs create --root <source-root> --package <product.tgz> --expected-sha <sha256> [--output <manifest.json>] [--release]",
    "  node scripts\\release-manifest.mjs verify --root <source-root> --package <product.tgz> --manifest <manifest.json> --expected-sha <sha256> [--output <verification.json>]",
  ].join("\n");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") return { help: true };
  if (!["create", "verify"].includes(command)) {
    const error = new Error("Unknown subcommand.");
    error.code = "invalid_arguments";
    throw error;
  }
  const args = { command, release: false };
  const seen = new Set();
  const valueFlags = new Set(["--root", "--package", "--output", "--manifest", "--expected-sha"]);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--release") {
      if (seen.has(arg)) {
        const error = new Error(`Duplicate argument ${arg}`);
        error.code = "invalid_arguments";
        throw error;
      }
      seen.add(arg);
      args.release = true;
      continue;
    }
    if (!valueFlags.has(arg)) {
      const error = new Error(`Unknown argument ${arg}`);
      error.code = "invalid_arguments";
      throw error;
    }
    if (seen.has(arg)) {
      const error = new Error(`Duplicate argument ${arg}`);
      error.code = "invalid_arguments";
      throw error;
    }
    const value = rest[i + 1];
    if (!value || value.startsWith("--")) {
      const error = new Error(`Missing value for ${arg}`);
      error.code = "invalid_arguments";
      throw error;
    }
    seen.add(arg);
    i += 1;
    if (arg === "--root") args.root = value;
    else if (arg === "--package") args.packagePath = value;
    else if (arg === "--output") args.outputPath = value;
    else if (arg === "--manifest") args.manifestPath = value;
    else if (arg === "--expected-sha") args.expectedSha = value;
  }
  if (args.command === "verify" && args.release) {
    const error = new Error("--release is only supported with create.");
    error.code = "invalid_arguments";
    throw error;
  }
  if (args.command === "create" && args.manifestPath) {
    const error = new Error("--manifest is only supported with verify.");
    error.code = "invalid_arguments";
    throw error;
  }
  return args;
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    const result = toCliError(error);
    result.usage = usage();
    return result;
  }
  if (args.help) return { ok: true, usage: usage() };
  if (args.command === "create") {
    return createReleaseManifest(args);
  }
  return verifyReleaseManifest(args);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  Promise.resolve(main(process.argv.slice(2)))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok === false ? 1 : 0;
    })
    .catch((error) => {
      console.log(JSON.stringify(toCliError(error), null, 2));
      process.exitCode = 1;
    });
}

export { main, parseArgs, usage };
