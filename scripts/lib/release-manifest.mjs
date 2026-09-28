import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { PATCH_ID as CHAT_FINAL_TEXT_PATCH_ID } from "../../host-patch/chat-final-text/spec.mjs";
import { checkPackage } from "../check-package.mjs";

const execFile = promisify(execFileCallback);

export const RELEASE_MANIFEST_SCHEMA = "openclaw-dsh-native-release-manifest/v073-release-01";
export const APPROVED_SDK_SHA256 = "3431f4cd2d8dbd6b936def2694ac27e19fa0256295cf4ada0f652ecf1c9ee520";
export const REQUIRED_HOST_VERSION = "2026.9.2";
export const REQUIRED_SOURCE_COMMIT = "3928bad9badfcb6c7d140530435e806fb8092190";

const EXPECTED_PACKAGE_NAME = "openclaw-dsh-native";
const SPEC_EXPORT_RE = /^export const (PATCH_ID|HOST_VERSION|SOURCE_COMMIT) = "([^"\r\n]+)";\r?$/gm;
const CLI_ERROR_MESSAGES = {
  invalid_arguments: "Invalid release-manifest arguments.",
  root_invalid: "Root must be a readable real directory.",
  root_not_git: "Root must be a committed git worktree root.",
  root_invalid_package_json: "Root package.json must be valid JSON.",
  source_unsafe: "Source audit refused an unsafe path or file type.",
  source_unreadable: "Source audit could not read a required file.",
  source_version_mismatch: "Source package.json must match the package archive version.",
  package_validation_failed: "Package validation failed.",
  package_untracked_source: "Non-dist package files must come from tracked or captured nonignored source files.",
  package_changed: "Package changed during manifest audit.",
  companion_missing: "A required companion file is missing.",
  companion_untracked: "Release companions must be tracked or captured nonignored source files.",
  companion_pin_invalid: "A companion spec does not match the pinned release identity.",
  release_source_dirty: "Release mode requires a clean, nonignored source tree.",
  source_changed: "Source changed during manifest audit.",
  manifest_invalid: "Manifest JSON does not match the expected schema.",
  manifest_mismatch: "Manifest no longer matches the audited source and package inputs.",
  manifest_changed: "Manifest changed during verification.",
  output_invalid: "Output must be a regular file path.",
  output_overwrite: "Output must not overwrite an input file.",
  output_not_ignored: "Output inside the source root must be gitignored and untracked.",
  output_unsafe: "Output path must avoid .git directories and linked paths.",
  internal_error: "Release manifest failed safely.",
};
const COMPANION_DEFS = [
  {
    key: "agent-harness",
    id: "openclaw-agent-harness-pin-v1",
    specPath: "host-patch/spec.mjs",
    files: ["host-patch/apply.mjs", "host-patch/spec.mjs", "host-patch/engine.mjs", "host-patch/USAGE.txt"],
  },
  {
    key: "compact-auth",
    id: "openclaw-compaction-auth-gap-v2",
    specPath: "host-patch/compact-auth/spec.mjs",
    files: ["host-patch/compact-auth/apply.mjs", "host-patch/compact-auth/spec.mjs", "host-patch/engine.mjs"],
  },
  {
    key: "source-reply",
    id: "openclaw-native-source-reply-owner-v1",
    specPath: "host-patch/source-reply/spec.mjs",
    files: ["host-patch/source-reply/apply.mjs", "host-patch/source-reply/spec.mjs", "host-patch/source-reply/USAGE.txt", "host-patch/spec.mjs", "host-patch/engine.mjs"],
  },
  {
    key: "table-policy",
    id: "openclaw-dsh-native-table-policy-v1",
    specPath: "host-patch/table-policy/spec.mjs",
    files: ["host-patch/table-policy/apply.mjs", "host-patch/table-policy/spec.mjs", "host-patch/table-policy/USAGE.txt", "host-patch/engine.mjs"],
  },
  {
    key: "chat-final-text",
    id: CHAT_FINAL_TEXT_PATCH_ID,
    specPath: "host-patch/chat-final-text/spec.mjs",
    files: ["host-patch/chat-final-text/apply.mjs", "host-patch/chat-final-text/spec.mjs", "host-patch/chat-final-text/USAGE.txt", "host-patch/spec.mjs", "host-patch/engine.mjs"],
  },
  {
    key: "group-readonly",
    id: "openclaw-dsh-group-readonly-v1",
    specPath: "host-patch/group-readonly/spec.mjs",
    optional: true,
    files: ["host-patch/group-readonly/apply.mjs", "host-patch/group-readonly/spec.mjs", "host-patch/group-readonly/USAGE.txt", "host-patch/spec.mjs", "host-patch/engine.mjs"],
  },
];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRelative(path) {
  return path.replace(/\\/g, "/");
}

function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isWithinPath(root, target) {
  const rel = relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJsonText(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

async function runGit(root, args, encoding = "buffer") {
  try {
    const result = await execFile("git", ["-C", root, ...args], {
      encoding,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return result.stdout;
  } catch {
    throw fail("root_not_git", "Root must be a committed git worktree.");
  }
}

function ensureSha256Hex(value, flagName) {
  if (!value) throw fail("invalid_arguments", `${flagName} is required.`);
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw fail("invalid_arguments", `${flagName} must be a SHA-256 hex digest.`);
  return value.toLowerCase();
}

async function gitBoolean(root, args) {
  try {
    await execFile("git", ["-C", root, ...args], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

async function resolveRoot(rootPath) {
  if (!rootPath) throw fail("invalid_arguments", "--root is required.");
  const root = resolve(rootPath);
  let info;
  try {
    info = await lstat(root);
  } catch {
    throw fail("root_invalid", "Root must be a readable directory.");
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw fail("root_invalid", "Root must be a real directory.");
  const realRoot = await realpath(root);
  const gitTop = (await runGit(realRoot, ["rev-parse", "--show-toplevel"], "utf8")).trim();
  if (!gitTop) throw fail("root_not_git", "Root must be a committed git worktree.");
  const realGitTop = await realpath(resolve(gitTop));
  if (normalizeRelative(realGitTop) !== normalizeRelative(realRoot)) {
    throw fail("root_not_git", "Root must be the git worktree root.");
  }
  return { root, realRoot };
}

async function readJsonFile(path, invalidCode, invalidMessage) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw fail(invalidCode, invalidMessage);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw fail(invalidCode, invalidMessage);
  }
}

function ensureWithin(root, realRoot, path) {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw fail("source_unsafe", "Source audit refused a path outside the root.");
  }
  return absolute;
}

async function auditSnapshotFile({ root, realRoot, relPath, gitMode }) {
  const diskPath = ensureWithin(root, realRoot, relPath);
  let info;
  try {
    info = await lstat(diskPath);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw fail("source_unreadable", "Source audit could not read a required file.");
  }
  if (info.isSymbolicLink()) throw fail("source_unsafe", "Source audit refuses symbolic links and junctions.");
  if (!info.isFile()) throw fail("source_unsafe", "Source audit only supports regular files.");
  const resolved = await realpath(diskPath);
  const rel = relative(realRoot, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw fail("source_unsafe", "Source audit refused a path outside the root.");
  }
  const bytes = await readFile(resolved);
  const mode = gitMode ?? ((info.mode & 0o111) !== 0 ? "100755" : "100644");
  return { path: normalizeRelative(relPath), mode, bytes };
}

function parseStatus(raw) {
  const entries = raw.split("\0");
  const status = {
    trackedChanges: 0,
    indexChanges: 0,
    worktreeChanges: 0,
    untrackedFiles: 0,
    missingFiles: 0,
  };
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.startsWith("? ")) {
      status.untrackedFiles += 1;
      continue;
    }
    if (entry.startsWith("! ")) continue;
    if (entry.startsWith("1 ") || entry.startsWith("2 ") || entry.startsWith("u ")) {
      const xy = entry.slice(2, 4);
      const staged = xy[0];
      const worktree = xy[1];
      if (staged && staged !== ".") {
        status.trackedChanges += 1;
        status.indexChanges += 1;
      }
      if (worktree && worktree !== ".") {
        status.trackedChanges += 1;
        status.worktreeChanges += 1;
      }
      if (staged === "D" || worktree === "D") status.missingFiles += 1;
      if (entry.startsWith("2 ")) i += 1;
      continue;
    }
  }
  return status;
}

function parseTrackedEntries(raw) {
  const entries = raw.toString("utf8").split("\0").filter(Boolean);
  const tracked = new Map();
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    if (tab < 0) throw fail("root_not_git", "Root must be a committed git worktree.");
    const meta = entry.slice(0, tab).split(" ");
    const relPath = normalizeRelative(entry.slice(tab + 1));
    const mode = meta[0];
    const stage = meta[2];
    if (stage !== "0") throw fail("source_unsafe", "Source audit refuses conflicted index entries.");
    if (mode === "120000" || mode === "160000") throw fail("source_unsafe", "Source audit refuses symlinks and submodules.");
    tracked.set(relPath, { mode });
  }
  return tracked;
}

function parseUntrackedEntries(raw) {
  return raw.toString("utf8").split("\0").filter(Boolean).map(normalizeRelative);
}

function parseFlagEntries(raw) {
  return raw.toString("utf8").split("\0").filter(Boolean).flatMap((entry) => {
    if (entry.length < 3 || entry[1] !== " ") throw fail("root_not_git", "Root must be a committed git worktree.");
    const flag = entry[0];
    const relPath = normalizeRelative(entry.slice(2));
    if (flag.toUpperCase() === "S") return [{ path: relPath, flag: "skip-worktree" }];
    if (flag !== flag.toUpperCase()) return [{ path: relPath, flag: "assume-unchanged" }];
    return [];
  });
}

async function captureSourceAudit(root) {
  const { realRoot } = await resolveRoot(root);
  // Bound Git subprocess fan-out on Windows; both complete audits still must agree.
  const commit = await runGit(realRoot, ["rev-parse", "HEAD"], "utf8");
  const tree = await runGit(realRoot, ["rev-parse", "HEAD^{tree}"], "utf8");
  const trackedRaw = await runGit(realRoot, ["ls-files", "--stage", "-z"]);
  const untrackedRaw = await runGit(realRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const statusRaw = await runGit(realRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], "utf8");
  const flagsRaw = await runGit(realRoot, ["ls-files", "-t", "-v", "-z"]);
  const tracked = parseTrackedEntries(trackedRaw);
  const untracked = parseUntrackedEntries(untrackedRaw);
  const flags = parseFlagEntries(flagsRaw);
  const snapshotEntries = [];
  for (const [relPath, { mode }] of tracked) {
    const audited = await auditSnapshotFile({ root: realRoot, realRoot, relPath, gitMode: mode });
    if (audited) snapshotEntries.push(audited);
  }
  for (const relPath of untracked) {
    const audited = await auditSnapshotFile({ root: realRoot, realRoot, relPath });
    if (audited) snapshotEntries.push(audited);
  }
  snapshotEntries.sort((a, b) => compareUtf8Bytes(a.path, b.path));
  const snapshot = createHash("sha256");
  for (const entry of snapshotEntries) {
    snapshot.update(entry.path);
    snapshot.update("\0");
    snapshot.update(entry.mode);
    snapshot.update("\0");
    snapshot.update(String(entry.bytes.length));
    snapshot.update("\0");
    snapshot.update(entry.bytes);
    snapshot.update("\0");
  }
  const status = parseStatus(statusRaw);
  status.flaggedPaths = flags.length;
  return {
    commit: commit.trim(),
    tree: tree.trim(),
    snapshotSha256: snapshot.digest("hex"),
    indexSha256: sha256(trackedRaw),
    flagSha256: sha256(flagsRaw),
    status,
    clean: status.trackedChanges === 0 && status.untrackedFiles === 0 && status.flaggedPaths === 0,
    tracked,
    untracked: new Set(untracked),
    statusFingerprint: sha256(statusRaw),
  };
}

async function validateOutputPath(root, outputPath, protectedPaths = []) {
  if (!outputPath) return undefined;
  const resolved = resolve(outputPath);
  const protectedComparable = new Set(protectedPaths.filter(Boolean).map((path) => normalizeRelative(resolve(path)).toLowerCase()));
  if (protectedComparable.has(normalizeRelative(resolved).toLowerCase())) {
    throw fail("output_overwrite", "Output must not overwrite an input file.");
  }
  const chain = [];
  for (let current = resolved; ; current = dirname(current)) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) break;
  }
  for (const candidate of chain.reverse()) {
    if (basename(candidate).toLowerCase() === ".git") throw fail("output_unsafe", "Output path must stay outside .git directories.");
    let candidateInfo;
    try {
      candidateInfo = await lstat(candidate);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw fail("output_invalid", "Output must be a regular file path.");
    }
    if (candidateInfo.isSymbolicLink()) throw fail("output_unsafe", "Output path must not traverse symlinks or junctions.");
    if (candidate !== resolved && !candidateInfo.isDirectory()) throw fail("output_invalid", "Output must be a regular file path.");
  }
  for (const path of protectedPaths) {
    if (path && resolved === resolve(path)) throw fail("output_overwrite", "Output must not overwrite an input file.");
  }
  let info;
  try {
    info = await lstat(resolved);
  } catch {}
  if (info?.isDirectory()) throw fail("output_invalid", "Output must be a regular file path.");
  if (info) {
    if (!info.isFile() || info.isSymbolicLink()) throw fail("output_invalid", "Output must be a regular file path.");
    if ((info.nlink ?? 1) !== 1) throw fail("output_unsafe", "Output path must not reuse linked files.");
    const outputRealPath = await realpath(resolved);
    for (const path of protectedPaths.filter(Boolean)) {
      try {
        if (normalizeRelative(await realpath(resolve(path))).toLowerCase() === normalizeRelative(outputRealPath).toLowerCase()) {
          throw fail("output_overwrite", "Output must not overwrite an input file.");
        }
      } catch (error) {
        if (error?.code) throw error;
      }
    }
  }
  const rel = relative(root, resolved);
  const insideRoot = isWithinPath(root, resolved);
  if (insideRoot) {
    const relPath = normalizeRelative(rel);
    const tracked = await gitBoolean(root, ["ls-files", "--error-unmatch", "--", relPath]);
    if (tracked) throw fail("output_not_ignored", "Output inside the source root must be gitignored and untracked.");
    const ignored = await gitBoolean(root, ["check-ignore", "--quiet", "--", relPath]);
    if (!ignored) throw fail("output_not_ignored", "Output inside the source root must be gitignored and untracked.");
  }
  return resolved;
}

async function readRequiredFile(root, relPath) {
  const absolute = resolve(root, relPath);
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    throw fail("companion_missing", "A required companion file is missing.");
  }
  if (!info.isFile() || info.isSymbolicLink()) throw fail("source_unsafe", "Companion audit requires regular files.");
  const bytes = await readFile(absolute);
  return { path: relPath, bytes, sha256: sha256(bytes), size: bytes.length };
}

function parseSpecConstants(text) {
  const constants = {};
  for (const match of text.matchAll(SPEC_EXPORT_RE)) constants[match[1]] = match[2];
  return constants;
}

function allowCapturedSource(relPath, trackedFiles, untrackedFiles, release) {
  if (trackedFiles.has(relPath)) return true;
  return !release && untrackedFiles.has(relPath);
}

async function auditCompanions(root, trackedFiles, untrackedFiles, archiveFiles, release) {
  const sharedEngine = await readRequiredFile(root, "host-patch/engine.mjs");
  const patches = [];
  for (const def of COMPANION_DEFS) {
    if (def.optional && ![...trackedFiles.keys(), ...untrackedFiles, ...archiveFiles]
      .some((path) => path.includes(`host-patch/${def.key}/`))) continue;
    const fileReports = [];
    for (const relPath of def.files) {
      if (!allowCapturedSource(relPath, trackedFiles, untrackedFiles, release)) {
        throw fail("companion_untracked", "Release companions must be tracked or captured nonignored source files.");
      }
      if (!archiveFiles.has(`package/${relPath}`)) throw fail("package_validation_failed", "Archive is missing a required companion file.");
      fileReports.push(await readRequiredFile(root, relPath));
    }
    const specFile = fileReports.find((file) => file.path === def.specPath);
    const constants = parseSpecConstants(specFile.bytes.toString("utf8"));
    if (constants.PATCH_ID !== def.id || constants.HOST_VERSION !== REQUIRED_HOST_VERSION || constants.SOURCE_COMMIT !== REQUIRED_SOURCE_COMMIT) {
      throw fail("companion_pin_invalid", "A companion spec does not match the required pinned identity.");
    }
    const aggregate = createHash("sha256");
    for (const file of [...fileReports].sort((a, b) => compareUtf8Bytes(a.path, b.path))) {
      aggregate.update(file.path);
      aggregate.update("\0");
      aggregate.update(file.sha256);
      aggregate.update("\0");
      aggregate.update(String(file.size));
      aggregate.update("\0");
    }
    patches.push({
      id: def.id,
      hostVersion: REQUIRED_HOST_VERSION,
      sourceCommit: REQUIRED_SOURCE_COMMIT,
      files: fileReports.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.size })),
      aggregateSha256: aggregate.digest("hex"),
    });
  }
  return {
    hostVersion: REQUIRED_HOST_VERSION,
    sourceCommit: REQUIRED_SOURCE_COMMIT,
    sharedEngine: { path: sharedEngine.path, sha256: sharedEngine.sha256, bytes: sharedEngine.size },
    patches,
  };
}

function sanitizePackageReport(report) {
  if (!report.ok || !report.package) throw fail("package_validation_failed", "Package validation failed.");
  return {
    name: report.package.name,
    version: report.package.version,
    sha256: report.archive.sha256,
    bytes: report.archive.bytes,
    fileCount: report.totals.files,
  };
}

function ensureTrackedPackagedSources(report, trackedFiles, untrackedFiles, release) {
  for (const file of report.files) {
    const relPath = file.path.slice("package/".length);
    if (!relPath || relPath.startsWith("dist/")) continue;
    if (!allowCapturedSource(relPath, trackedFiles, untrackedFiles, release)) {
      throw fail("package_untracked_source", "Non-dist package files must come from tracked or captured nonignored source files.");
    }
  }
}

async function buildManifestInternal({ root, packagePath, expectedSha, release = false, hooks = {} }) {
  const packageFile = resolve(packagePath ?? "");
  if (!packagePath) throw fail("invalid_arguments", "--package is required.");
  const sourceBefore = await captureSourceAudit(root);
  if (hooks.afterInitialAudit) await hooks.afterInitialAudit();
  const packageReport = await checkPackage({ packagePath: packageFile, root, expectedSha });
  const packageSummary = sanitizePackageReport(packageReport);
  if (packageSummary.name !== EXPECTED_PACKAGE_NAME) throw fail("package_validation_failed", "Package validation failed.");
  ensureTrackedPackagedSources(packageReport, sourceBefore.tracked, sourceBefore.untracked, release);
  const sourcePackage = await readJsonFile(resolve(root, "package.json"), "root_invalid", "Root package.json must be valid JSON.");
  if (sourcePackage.name !== EXPECTED_PACKAGE_NAME || sourcePackage.version !== packageSummary.version) {
    throw fail("source_version_mismatch", "Source package.json must match the package archive version.");
  }
  const companions = await auditCompanions(root, sourceBefore.tracked, sourceBefore.untracked, new Set(packageReport.files.map((file) => file.path)), release);
  if (release && !sourceBefore.clean) throw fail("release_source_dirty", "Release mode requires a clean, nonignored source tree.");
  const sourceAfter = await captureSourceAudit(root);
  if (sourceBefore.commit !== sourceAfter.commit || sourceBefore.tree !== sourceAfter.tree ||
      sourceBefore.snapshotSha256 !== sourceAfter.snapshotSha256 ||
      sourceBefore.indexSha256 !== sourceAfter.indexSha256 ||
      sourceBefore.flagSha256 !== sourceAfter.flagSha256 ||
      sourceBefore.statusFingerprint !== sourceAfter.statusFingerprint) {
    throw fail("source_changed", "Source changed during manifest audit.");
  }
  const packageBytes = await readFile(packageFile);
  if (sha256(packageBytes) !== packageSummary.sha256) throw fail("package_changed", "Package changed during manifest audit.");
  return {
    schema: RELEASE_MANIFEST_SCHEMA,
    package: packageSummary,
    source: {
      commit: sourceBefore.commit,
      tree: sourceBefore.tree,
      snapshotSha256: sourceBefore.snapshotSha256,
      indexSha256: sourceBefore.indexSha256,
      flagSha256: sourceBefore.flagSha256,
      clean: sourceBefore.clean,
      releaseReady: sourceBefore.clean,
      status: sourceBefore.status,
    },
    companions,
    sdk: {
      hostVersion: REQUIRED_HOST_VERSION,
      approvedSha256: APPROVED_SDK_SHA256,
      declaredOnly: true,
    },
    claims: {
      binding: "This manifest binds the explicit package archive to a deterministic source snapshot and pinned companion files.",
      limitations: "source.releaseReady only reflects source-tree cleanliness and tracking checks; it does not prove CI/test status, compiler provenance, byte-for-byte rebuilt reproducibility, signing, or live-account SDK verification.",
    },
  };
}

async function writeJsonOutput(path, value) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stableJsonText(value), "utf8");
}

export async function createReleaseManifest(options) {
  const { realRoot } = await resolveRoot(options.root);
  const expectedSha = ensureSha256Hex(options.expectedSha, "--expected-sha");
  const manifest = await buildManifestInternal({
    root: realRoot,
    packagePath: options.packagePath,
    expectedSha,
    release: Boolean(options.release),
    hooks: options.hooks ?? {},
  });
  const outputPath = await validateOutputPath(realRoot, options.outputPath, [options.packagePath]);
  await writeJsonOutput(outputPath, manifest);
  return manifest;
}

function validateManifestShape(value) {
  if (!value || typeof value !== "object" || value.schema !== RELEASE_MANIFEST_SCHEMA) {
    throw fail("manifest_invalid", "Manifest JSON does not match the expected schema.");
  }
}

export async function verifyReleaseManifest(options) {
  const { realRoot } = await resolveRoot(options.root);
  const expectedSha = ensureSha256Hex(options.expectedSha, "--expected-sha");
  if (!options.manifestPath) throw fail("invalid_arguments", "--manifest is required.");
  const manifestPath = resolve(options.manifestPath);
  const manifestBytesBefore = await readFile(manifestPath).catch(() => { throw fail("manifest_invalid", "Manifest JSON must exist and be readable."); });
  let actualManifest;
  try {
    actualManifest = JSON.parse(manifestBytesBefore.toString("utf8"));
  } catch {
    throw fail("manifest_invalid", "Manifest JSON does not match the expected schema.");
  }
  validateManifestShape(actualManifest);
  const expectedManifest = await buildManifestInternal({
    root: realRoot,
    packagePath: options.packagePath,
    expectedSha,
    release: false,
    hooks: options.hooks ?? {},
  });
  if (stableJsonText(actualManifest) !== stableJsonText(expectedManifest)) {
    throw fail("manifest_mismatch", "Manifest no longer matches the audited source and package inputs.");
  }
  const manifestBytesAfter = await readFile(manifestPath).catch(() => { throw fail("manifest_invalid", "Manifest JSON must exist and be readable."); });
  if (sha256(manifestBytesBefore) !== sha256(manifestBytesAfter)) throw fail("manifest_changed", "Manifest changed during verification.");
  const report = {
    ok: true,
    command: "verify",
    manifestSha256: sha256(manifestBytesBefore),
    manifest: expectedManifest,
  };
  const outputPath = await validateOutputPath(realRoot, options.outputPath, [options.packagePath, manifestPath]);
  await writeJsonOutput(outputPath, report);
  return report;
}

export function toCliError(error) {
  const code = typeof error?.code === "string" && Object.hasOwn(CLI_ERROR_MESSAGES, error.code) ? error.code : "internal_error";
  return { ok: false, error: { code, message: CLI_ERROR_MESSAGES[code] } };
}
