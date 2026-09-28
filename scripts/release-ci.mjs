#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APPROVED_SDK_SHA256, createReleaseManifest, verifyReleaseManifest } from "./lib/release-manifest.mjs";

const evidenceDirectory = resolve("artifacts", "release-evidence");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function evidence(name, value) {
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(join(evidenceDirectory, name), `${JSON.stringify(value, null, 2)}\n`);
}

function run(program, args, capture = false) {
  const child = spawnSync(program, args, { stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8" });
  if (child.error || child.status !== 0) throw new Error("Release command failed.");
  return child.stdout;
}

function npm(args, capture = false) {
  // Invoke npm's JS entrypoint directly, avoiding Windows execution policy and cmd quoting.
  const npmCli = process.env.npm_execpath || (process.platform === "win32"
    ? join(process.execPath, "..", "node_modules", "npm", "bin", "npm-cli.js")
    : realpathSync(run("which", ["npm"], true).trim()));
  return run(process.execPath, [npmCli, ...args], capture);
}

export function evaluateGate(event, fixtureResult, sdkResult) {
  const manual = event === "workflow_dispatch";
  const supported = manual || event === "pull_request";
  const ok = supported && fixtureResult === "success" && sdkResult === (manual ? "success" : "skipped");
  return {
    ok,
    scope: manual ? "required-linux-sdk-and-fixtures" : "required-linux-fixtures-only",
    sdkAcceptance: manual && ok,
    windows: "experimental-not-a-release-requirement",
    publication: "not-performed",
  };
}

export function verifyRepack(firstSha256, secondSha256) {
  if (!/^[a-f0-9]{64}$/.test(firstSha256) || firstSha256 !== secondSha256) {
    throw new Error("Two fresh packs from the same build did not match.");
  }
  return {
    ok: true, firstSha256, secondSha256, comparison: "two-fresh-packs-of-one-built-workspace",
    independentBuildsCompared: false,
  };
}

export function sdkTransportRequirement(platform, optIn) {
  if (platform === "linux" && optIn !== "1") {
    throw new Error("Required Linux SDK transport coverage must be explicitly enabled.");
  }
  return platform === "linux";
}

export function sdkCompanionPaths(root = process.cwd()) {
  const companions = ["", "compact-auth", "source-reply", "table-policy", "chat-final-text"];
  if (existsSync(join(root, "host-patch", "group-readonly"))) companions.push("group-readonly");
  return companions.map((name) => join(root, "host-patch", name, "apply.mjs"));
}

async function fixtures() {
  let ok = false;
  try {
    const tests = ["tests/package-acceptance.test.mjs", ...readdirSync("tests")
      .filter((name) => /^release-.*\.test\.mjs$/.test(name)).sort().map((name) => join("tests", name))];
    run(process.execPath, ["--test", "--test-concurrency=1", ...tests]);
    ok = true;
  } finally {
    evidence("fixture-results.json", { ok, suite: "generated-package-and-release-fixtures", node: process.version, platform: process.platform });
  }
}

async function pack(release) {
  npm(["run", "build"]);
  const parent = resolve("artifacts", "release-candidate");
  mkdirSync(parent, { recursive: true });
  const freshPack = () => {
    const destination = mkdtempSync(join(parent, "pack-"));
    const result = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", destination], true));
    if (!Array.isArray(result) || result.length !== 1 || typeof result[0].filename !== "string" ||
        !/^openclaw-dsh-native-[0-9A-Za-z.+-]+\.tgz$/.test(result[0].filename) ||
        basename(result[0].filename) !== result[0].filename) throw new Error("Unexpected pack result.");
    const packagePath = join(destination, result[0].filename);
    return { packagePath, expectedSha: hash(readFileSync(packagePath)), filename: result[0].filename };
  };
  const { packagePath, expectedSha, filename } = freshPack();
  const second = freshPack();
  let repack;
  try { repack = verifyRepack(expectedSha, second.expectedSha); }
  finally { rmSync(dirname(second.packagePath), { recursive: true, force: true }); }
  const manifestPath = join(evidenceDirectory, "release-manifest.json");
  const manifest = await createReleaseManifest({ root: process.cwd(), packagePath, expectedSha, release, outputPath: manifestPath });
  await verifyReleaseManifest({
    root: process.cwd(), packagePath, expectedSha, manifestPath,
    outputPath: join(evidenceDirectory, "verification.json"),
  });
  evidence("reproducibility.json", { ...repack, commit: manifest.source.commit, snapshotSha256: manifest.source.snapshotSha256 });
  writeFileSync(join(evidenceDirectory, "SHA256SUMS.txt"), `${expectedSha}  ${filename}\n`);
  // Local-only pointer: this file is NOT part of the workflow upload allowlist.
  writeFileSync(join(parent, "candidate.json"), `${JSON.stringify({ packagePath, expectedSha, manifestPath }, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, packageSha256: expectedSha, source: manifest.source }));
  return manifest;
}

async function full() {
  let ok = false;
  let sdkTransportRequired = false;
  try {
    sdkTransportRequired = sdkTransportRequirement(process.platform, process.env.DSH_RUN_ISOLATED_SDK_TRANSPORT);
    if (!process.env.SDK_PACKAGE || hash(readFileSync(process.env.SDK_PACKAGE)) !== APPROVED_SDK_SHA256) {
      throw new Error("Approved SDK is required.");
    }
    npm(["ci", "--ignore-scripts"]);
    const parent = resolve("artifacts", "release-private");
    mkdirSync(parent, { recursive: true });
    const sdkRoot = mkdtempSync(join(parent, "install-"));
    npm(["install", "--prefix", sdkRoot, "--no-save", "--package-lock=false", "--ignore-scripts", process.env.SDK_PACKAGE]);
    const target = resolve("node_modules", "openclaw");
    if (existsSync(target)) throw new Error("Refusing to replace an existing SDK installation.");
    symlinkSync(join(sdkRoot, "node_modules", "openclaw"), target, process.platform === "win32" ? "junction" : "dir");
    for (const companion of sdkCompanionPaths()) {
      run(process.execPath, [companion, "--root", target, "--check"]);
    }
    npm(["run", "typecheck"]);
    npm(["run", "build"]);
    npm(["test"]);
    await pack(true);
    ok = true;
  } finally {
    evidence("full-sdk-results.json", {
      ok, suite: "generated-fixtures-with-pinned-sdk", sdkSha256: APPROVED_SDK_SHA256,
      node: process.version, platform: process.platform, realAccountTests: false,
      isolatedSdkTransport: {
        required: process.platform === "linux", passed: ok && sdkTransportRequired,
        evidenceClass: "isolated-sdk", channelCertified: false,
      },
    });
  }
}

async function main() {
  const [command, ...options] = process.argv.slice(2);
  if (command === "fixtures" && options.length === 0) return fixtures();
  if (command === "full" && options.length === 0) return full();
  if (command === "pack" && (options.length === 0 || options.length === 1 && options[0] === "--release")) return pack(options.length === 1);
  if (command === "gate" && options.length === 0) {
    const result = evaluateGate(process.env.CI_EVENT, process.env.CI_FIXTURE_RESULT, process.env.CI_SDK_RESULT);
    evidence("linux-gate.json", result);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error("Usage: node scripts\\release-ci.mjs fixtures|full|pack [--release]|gate");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("Release CI check failed. No raw diagnostics or private artifacts are included in evidence.");
    process.exitCode = 1;
  });
}
