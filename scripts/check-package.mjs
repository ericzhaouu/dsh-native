#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const PACKAGE_NAME = "openclaw-dsh-native";
const SDK_PEER = ">=2026.9.2 <2026.10.0";
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_TAR_BYTES = 64 * 1024 * 1024;
const DISALLOWED_SEGMENTS = new Set(["node_modules", "tests", "__tests__", ".git", ".github"]);
const WINDOWS_DEVICE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const SECRET_PATTERNS = [
  { id: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)?PRIVATE KEY-----/ },
  { id: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { id: "openai-style-token", pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { id: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { id: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36,}\b/ },
];

function usage() {
  return "Usage: node scripts\\check-package.mjs --package <path-to-built-openclaw-dsh-native.tgz> [--expected-sha <sha256>] [--root <built-workspace>] [--json]\n\n--package is required. The checker never assumes a historical archive name; pass the package produced by npm pack or an explicit release-candidate path.";
}

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--package") args.packagePath = argv[++i];
    else if (arg === "--expected-sha") args.expectedSha = argv[++i]?.toLowerCase();
    else if (arg === "--root") args.root = argv[++i];
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new TypeError(`Unknown argument ${arg}\n${usage()}`);
    }
  }
  if (!args.packagePath) throw new TypeError(`--package is required\n${usage()}`);
  if (args.expectedSha && !/^[a-f0-9]{64}$/.test(args.expectedSha)) throw new TypeError("--expected-sha must be a lowercase or uppercase SHA-256 hex digest");
  return args;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function cString(buffer, start, end) {
  const slice = buffer.subarray(start, end);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString("utf8");
}

function parseOctal(buffer, start, end, fieldName = "tar octal field") {
  const raw = buffer.subarray(start, end).toString("ascii").replace(/\0/g, " ").trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new Error(`Invalid ${fieldName}`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${fieldName} is too large`);
  return value;
}

function validateHeaderChecksum(header) {
  const stored = parseOctal(header, 148, 156, "tar header checksum");
  const checkHeader = Buffer.from(header);
  checkHeader.fill(0x20, 148, 156);
  const actual = checkHeader.reduce((total, byte) => total + byte, 0);
  if (stored !== actual) throw new Error("Invalid tar header checksum");
}

function parsePax(data) {
  const result = {};
  let offset = 0;
  while (offset < data.length) {
    let space = offset;
    while (space < data.length && data[space] !== 0x20) space++;
    if (space === data.length) throw new Error("Malformed PAX record: missing length separator");
    const lengthText = data.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new Error("Malformed PAX record length");
    const length = Number.parseInt(lengthText, 10);
    if (!Number.isSafeInteger(length) || length <= 0) throw new Error("Malformed PAX record length");
    const end = offset + length;
    if (end > data.length) throw new Error("Truncated PAX record");
    if (data[end - 1] !== 0x0a) throw new Error("Malformed PAX record: missing newline");
    const record = data.subarray(space + 1, end - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals <= 0) throw new Error("Malformed PAX record: missing key");
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error("Malformed PAX record key");
    if (!["path", "linkpath"].includes(key)) throw new Error(`Unsupported PAX attribute ${key}`);
    if (!value || value.includes("\0")) throw new Error(`Invalid PAX attribute ${key}`);
    result[key] = value;
    offset = end;
  }
  return result;
}

export function parseTarGz(tgzBuffer) {
  if (tgzBuffer.length > MAX_ARCHIVE_BYTES) throw new Error(`Compressed archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
  const tar = gunzipSync(tgzBuffer, { maxOutputLength: MAX_TAR_BYTES });
  if (tar.length > MAX_TAR_BYTES) throw new Error(`Expanded archive exceeds ${MAX_TAR_BYTES} bytes`);
  const entries = [];
  let offset = 0;
  let nextPax = undefined;
  let ended = false;
  while (offset < tar.length) {
    if (offset + 512 > tar.length) throw new Error("Truncated tar header");
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      if (offset + 512 > tar.length) throw new Error("Archive missing required end marker");
      const second = tar.subarray(offset, offset + 512);
      if (!second.every((byte) => byte === 0)) throw new Error("Archive missing required end marker");
      offset += 512;
      if (!tar.subarray(offset).every((byte) => byte === 0)) throw new Error("Archive contains trailing junk after end markers");
      ended = true;
      break;
    }
    validateHeaderChecksum(header);
    const name = cString(header, 0, 100);
    const prefix = cString(header, 345, 500);
    const size = parseOctal(header, 124, 136, "tar size field");
    const type = cString(header, 156, 157) || "0";
    const linkName = cString(header, 157, 257);
    const path = nextPax?.path ?? (prefix ? `${prefix}/${name}` : name);
    const linkPath = nextPax?.linkpath ?? linkName;
    if (offset + size > tar.length) throw new Error("Truncated tar payload");
    const data = tar.subarray(offset, offset + size);
    const paddedSize = Math.ceil(size / 512) * 512;
    if (offset + paddedSize > tar.length) throw new Error("Truncated tar payload padding");
    offset += paddedSize;
    if (type === "x") {
      nextPax = parsePax(data);
      continue;
    }
    if (type === "g") throw new Error("Global PAX headers are not supported");
    entries.push({ path, type, linkPath, size, data: Buffer.from(data) });
    nextPax = undefined;
  }
  if (!ended) throw new Error("Archive missing required end markers");
  if (nextPax) throw new Error("PAX header without following entry");
  return entries;
}

function normalizeMemberPath(rawPath) {
  const errors = [];
  if (!rawPath || rawPath.includes("\\")) errors.push("path must use portable forward slashes inside the tarball");
  if (rawPath.startsWith("/") || /^[A-Za-z]:/.test(rawPath)) errors.push("absolute archive path is forbidden");
  const parts = rawPath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) errors.push("empty, current or parent path segment is forbidden");
  if (parts[0] !== "package") errors.push("npm package members must be rooted under package/");
  for (const segment of parts) {
    if (DISALLOWED_SEGMENTS.has(segment)) errors.push(`disallowed path segment ${segment}`);
    if (segment.includes(":")) errors.push("Windows alternate data stream or drive syntax is forbidden");
    if (/[. ]$/.test(segment)) errors.push("Windows-unsafe trailing dot or space is forbidden");
    if (WINDOWS_DEVICE_NAMES.test(segment)) errors.push("Windows device name path segment is forbidden");
  }
  if (/(^|\/)(?:\.env(?:\.|$)|\.npmrc$|auth(?:-profiles)?\.json$|credentials\.json$|openclaw\.json$)/i.test(rawPath)) {
    errors.push("private configuration or credential-like file is forbidden");
  }
  return { normalized: parts.join("/"), errors };
}

function isAllowedPackageFile(path) {
  if (["package/package.json", "package/npm-shrinkwrap.json", "package/README.md", "package/LICENSE", "package/USAGE.txt", "package/openclaw.plugin.json"].includes(path)) return true;
  if (/^package\/dist\/[A-Za-z0-9._/-]+\.(?:js|d\.ts|js\.map)$/.test(path)) return true;
  if (/^package\/examples\/[A-Za-z0-9._-]+\.json$/.test(path)) return true;
  if (/^package\/host-patch\/(?:apply|spec)\.mjs$/.test(path)) return true;
  if (path === "package/host-patch/USAGE.txt") return true;
  return false;
}

function scanSecrets(entry) {
  const text = entry.data.toString("utf8");
  return SECRET_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ id }) => ({
    code: "secret-pattern",
    path: entry.path,
    detail: `matched ${id}`,
  }));
}

function parseJsonEntry(entry, name, findings) {
  try {
    return JSON.parse(entry.data.toString("utf8"));
  } catch (error) {
    findings.push({ code: "invalid-json", path: entry.path, detail: `${name} is not valid JSON` });
    return undefined;
  }
}

function packagePathFromManifestValue(value) {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("./")) return undefined;
  return `package/${value.slice(2)}`;
}

function collectExportTargets(exportsValue, targets = new Set()) {
  if (typeof exportsValue === "string") {
    const target = packagePathFromManifestValue(exportsValue);
    if (target) targets.add(target);
  } else if (exportsValue && typeof exportsValue === "object") {
    for (const value of Object.values(exportsValue)) collectExportTargets(value, targets);
  }
  return targets;
}

function requireFile(byPath, findings, path, code = "missing-entrypoint") {
  if (!byPath.has(path)) findings.push({ code, path, detail: "required package entrypoint is absent" });
}

async function compareWithRoot(root, entries, findings) {
  const workspaceRoot = resolve(root);
  let realRoot;
  try {
    const rootInfo = await lstat(workspaceRoot);
    if (!rootInfo.isDirectory()) {
      findings.push({ code: "root-invalid", path: workspaceRoot, detail: "--root must be a directory" });
      return;
    }
    if (rootInfo.isSymbolicLink()) findings.push({ code: "root-symlink", path: workspaceRoot, detail: "--root must not be a symlink or junction" });
    realRoot = await realpath(workspaceRoot);
  } catch (error) {
    findings.push({ code: "root-invalid", path: workspaceRoot, detail: "--root is missing or unreadable" });
    return;
  }
  for (const entry of entries.filter((item) => item.type === "0")) {
    const rel = entry.path.slice("package/".length);
    const diskPath = resolve(workspaceRoot, ...rel.split("/"));
    const relativePath = relative(workspaceRoot, diskPath);
    if (relativePath === ".." || relativePath.startsWith(`..\\`) || relativePath.startsWith("../") || resolve(relativePath) === relativePath) {
      findings.push({ code: "root-traversal", path: entry.path, detail: "resolved outside --root" });
      continue;
    }
    try {
      const info = await lstat(diskPath);
      if (info.isSymbolicLink()) {
        findings.push({ code: "root-symlink", path: entry.path, detail: "workspace file is a symlink or junction" });
        continue;
      }
      if (!info.isFile()) {
        findings.push({ code: "root-missing", path: entry.path, detail: "workspace path is not a regular file" });
        continue;
      }
      const realDiskPath = await realpath(diskPath);
      const realRelative = relative(realRoot, realDiskPath);
      if (realRelative === ".." || realRelative.startsWith(`..\\`) || realRelative.startsWith("../") || resolve(realRelative) === realRelative) {
        findings.push({ code: "root-traversal", path: entry.path, detail: "real path escapes --root" });
        continue;
      }
      const disk = await readFile(realDiskPath);
      const actual = sha256(disk);
      const expected = sha256(entry.data);
      if (actual !== expected) findings.push({ code: "root-mismatch", path: entry.path, detail: `archive ${expected} != workspace ${actual}` });
    } catch (error) {
      findings.push({ code: "root-missing", path: entry.path, detail: "workspace file missing or unreadable" });
    }
  }
}

export async function checkPackage(options) {
  const packagePath = resolve(options.packagePath);
  const tgz = await readFile(packagePath);
  const packageSha256 = sha256(tgz);
  const findings = [];
  if (options.expectedSha && packageSha256 !== options.expectedSha) {
    findings.push({ code: "archive-sha-mismatch", path: packagePath, detail: `expected ${options.expectedSha}, got ${packageSha256}` });
  }

  let entries = [];
  try {
    entries = parseTarGz(tgz);
  } catch (error) {
    findings.push({ code: "archive-parse-failed", path: packagePath, detail: error.message });
  }

  const seen = new Set();
  const fileEntries = [];
  for (const entry of entries) {
    const normalized = normalizeMemberPath(entry.path);
    for (const detail of normalized.errors) findings.push({ code: "bad-path", path: entry.path, detail });
    if (seen.has(normalized.normalized)) findings.push({ code: "duplicate-member", path: entry.path, detail: "duplicate archive member after path normalization" });
    seen.add(normalized.normalized);
    if (entry.type === "2" || entry.type === "1") findings.push({ code: "link-member", path: entry.path, detail: `tar link type ${entry.type} is forbidden` });
    else if (entry.type !== "0" && entry.type !== "5") findings.push({ code: "unsupported-member", path: entry.path, detail: `tar type ${entry.type} is not allowed` });
    if (entry.type === "0") {
      fileEntries.push(entry);
      if (!isAllowedPackageFile(entry.path)) findings.push({ code: "unexpected-file", path: entry.path, detail: "file is outside the immutable package allowlist" });
      findings.push(...scanSecrets(entry));
    }
  }

  const byPath = new Map(fileEntries.map((entry) => [entry.path, entry]));
  for (const required of ["package/package.json", "package/npm-shrinkwrap.json", "package/openclaw.plugin.json", "package/README.md", "package/USAGE.txt", "package/LICENSE"]) {
    if (!byPath.has(required)) findings.push({ code: "missing-required-file", path: required, detail: "required package member is absent" });
  }

  const manifest = byPath.get("package/package.json") && parseJsonEntry(byPath.get("package/package.json"), "package.json", findings);
  const shrinkwrap = byPath.get("package/npm-shrinkwrap.json") && parseJsonEntry(byPath.get("package/npm-shrinkwrap.json"), "npm-shrinkwrap.json", findings);
  const plugin = byPath.get("package/openclaw.plugin.json") && parseJsonEntry(byPath.get("package/openclaw.plugin.json"), "openclaw.plugin.json", findings);
  if (manifest) {
    if (manifest.name !== PACKAGE_NAME) findings.push({ code: "manifest-name", path: "package/package.json", detail: `expected ${PACKAGE_NAME}` });
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(manifest.version))) findings.push({ code: "manifest-version", path: "package/package.json", detail: "version must be an explicit semver value" });
    if (manifest.dependencies?.openclaw || manifest.devDependencies?.openclaw) findings.push({ code: "bundled-host-dependency", path: "package/package.json", detail: "OpenClaw must not be a dependency bundled by the plugin" });
    if (manifest.peerDependencies?.openclaw !== SDK_PEER) findings.push({ code: "peer-range", path: "package/package.json", detail: `expected optional peer ${SDK_PEER}` });
    if (manifest.peerDependenciesMeta?.openclaw?.optional !== true) findings.push({ code: "peer-optional", path: "package/package.json", detail: "OpenClaw peer must be marked optional" });
    if (!manifest.files?.includes("dist") || !manifest.files?.includes("npm-shrinkwrap.json")) findings.push({ code: "files-list", path: "package/package.json", detail: "package files list must include dist and npm-shrinkwrap.json" });
    for (const target of collectExportTargets(manifest.exports)) requireFile(byPath, findings, target);
    for (const target of Array.isArray(manifest.openclaw?.extensions) ? manifest.openclaw.extensions.map(packagePathFromManifestValue).filter(Boolean) : []) {
      requireFile(byPath, findings, target);
    }
  }
  requireFile(byPath, findings, "package/dist/index.js");
  requireFile(byPath, findings, "package/dist/index.d.ts");
  requireFile(byPath, findings, "package/host-patch/apply.mjs");
  requireFile(byPath, findings, "package/host-patch/spec.mjs");
  if (manifest && shrinkwrap) {
    if (shrinkwrap.name !== manifest.name || shrinkwrap.version !== manifest.version) findings.push({ code: "shrinkwrap-root", path: "package/npm-shrinkwrap.json", detail: "root shrinkwrap name/version must match package.json" });
    if (shrinkwrap.packages?.[""]?.version !== manifest.version) findings.push({ code: "shrinkwrap-root-package", path: "package/npm-shrinkwrap.json", detail: "packages[''].version must match package.json" });
  }
  if (plugin) {
    if (plugin.id !== "dsh-native") findings.push({ code: "plugin-id", path: "package/openclaw.plugin.json", detail: "plugin id must be dsh-native" });
    const extensions = plugin.activation?.onAgentHarnesses;
    if (!Array.isArray(extensions) || !extensions.includes("dsh-native")) findings.push({ code: "plugin-harness", path: "package/openclaw.plugin.json", detail: "activation must include dsh-native harness" });
  }
  if (fileEntries.some((entry) => entry.path.startsWith("package/node_modules/") || /(^|\/)openclaw\//.test(entry.path))) {
    findings.push({ code: "host-bundled", path: "package/node_modules/openclaw", detail: "host SDK must not be bundled in plugin archive" });
  }

  if (options.root) await compareWithRoot(options.root, fileEntries, findings);

  const files = fileEntries.map((entry) => ({ path: entry.path, bytes: entry.size, sha256: sha256(entry.data) })).sort((a, b) => a.path.localeCompare(b.path));
  return {
    ok: findings.length === 0,
    archive: { path: packagePath, sha256: packageSha256, bytes: tgz.length },
    package: manifest ? { name: manifest.name, version: manifest.version } : undefined,
    totals: { files: fileEntries.length, bytes: fileEntries.reduce((sum, entry) => sum + entry.size, 0) },
    files,
    findings,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  Promise.resolve()
    .then(() => parseArgs(process.argv.slice(2)))
    .then((args) => checkPackage(args))
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
    })
    .catch((error) => {
      console.log(JSON.stringify({ ok: false, findings: [{ code: "checker-error", detail: error.message }] }, null, 2));
      process.exitCode = 1;
    });
}
