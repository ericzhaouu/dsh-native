import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { link, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PATCH_ID as CHAT_FINAL_TEXT_PATCH_ID } from "../host-patch/chat-final-text/spec.mjs";
import { createReleaseManifest, toCliError, verifyReleaseManifest } from "../scripts/lib/release-manifest.mjs";

const execFile = promisify(execFileCallback);
const project = dirname(dirname(fileURLToPath(import.meta.url)));
const stateDir = join(project, ".test-state", `release-manifest-${process.pid}-${randomUUID()}`);
const cli = join(project, "scripts", "release-manifest.mjs");

function checksum(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function writeString(buffer, offset, length, value) {
  buffer.fill(0, offset, offset + length);
  buffer.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
}

function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0");
  writeString(buffer, offset, length, text);
}

function tarEntry(path, data, type = "0", linkName = "") {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, path);
  writeOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, type === "5" ? 0 : body.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, type);
  writeString(header, 157, 100, linkName);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  const sum = header.reduce((total, byte) => total + byte, 0);
  writeString(header, 148, 8, sum.toString(8).padStart(6, "0"));
  header[154] = 0;
  header[155] = 0x20;
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return type === "5" ? header : Buffer.concat([header, body, padding]);
}

function packageJson(version = "1.2.3-test.0") {
  return JSON.stringify({
    name: "openclaw-dsh-native",
    version,
    type: "module",
    files: ["dist", "openclaw.plugin.json", "host-patch", "scripts/inspect-state.mjs", "npm-shrinkwrap.json", "examples", "README.md", "LICENSE", "USAGE.txt"],
    exports: { ".": "./dist/index.js", "./bridge": "./dist/bridge/index.js" },
    openclaw: { extensions: ["./dist/index.js"], compat: { pluginApi: ">=2026.9.2 <2026.10.0" } },
    peerDependencies: { openclaw: ">=2026.9.2 <2026.10.0" },
    peerDependenciesMeta: { openclaw: { optional: true } },
    dependencies: { "@deepseek-ai/dsh": "0.1.2-alpha.2" },
  }, null, 2);
}

function shrinkwrap(version = "1.2.3-test.0") {
  return JSON.stringify({ name: "openclaw-dsh-native", version, lockfileVersion: 3, packages: { "": { name: "openclaw-dsh-native", version } } }, null, 2);
}

function baseFiles(version = "1.2.3-test.0") {
  return {
    ".gitignore": "dist/\nartifacts/\n.test-state/\n*.tgz\nnode_modules/\n",
    "package.json": packageJson(version),
    "npm-shrinkwrap.json": shrinkwrap(version),
    "openclaw.plugin.json": JSON.stringify({ id: "dsh-native", activation: { onAgentHarnesses: ["dsh-native"] } }, null, 2),
    "README.md": "# fixture\n",
    "USAGE.txt": "usage\n",
    "LICENSE": "MIT\n",
    "examples/openclaw.enabled.json": "{}\n",
    "scripts/inspect-state.mjs": "export function inspectState() { return 'ok'; }\n",
    "host-patch/apply.mjs": "export const APPLY = 'agent-harness';\n",
    "host-patch/spec.mjs": [
      'export const PATCH_ID = "openclaw-agent-harness-pin-v1";',
      'export const HOST_VERSION = "2026.9.2";',
      'export const SOURCE_COMMIT = "3928bad9badfcb6c7d140530435e806fb8092190";',
      "export const edits = [];",
    ].join("\n") + "\n",
    "host-patch/engine.mjs": "export function engine() { return 'shared'; }\n",
    "host-patch/USAGE.txt": "agent harness usage\n",
    "host-patch/compact-auth/apply.mjs": "export const APPLY = 'compact-auth';\n",
    "host-patch/compact-auth/spec.mjs": [
      'export const PATCH_ID = "openclaw-compaction-auth-gap-v2";',
      'export const HOST_VERSION = "2026.9.2";',
      'export const SOURCE_COMMIT = "3928bad9badfcb6c7d140530435e806fb8092190";',
      "export const edits = [];",
    ].join("\n") + "\n",
    "host-patch/source-reply/apply.mjs": "export const APPLY = 'source-reply';\n",
    "host-patch/source-reply/spec.mjs": [
      'import { replaceExactly } from "../spec.mjs";',
      'export const PATCH_ID = "openclaw-native-source-reply-owner-v1";',
      'export const HOST_VERSION = "2026.9.2";',
      'export const SOURCE_COMMIT = "3928bad9badfcb6c7d140530435e806fb8092190";',
      "export { replaceExactly };",
      "export const edits = [];",
    ].join("\n") + "\n",
    "host-patch/source-reply/USAGE.txt": "source reply usage\n",
    "host-patch/table-policy/apply.mjs": "export const APPLY = 'table-policy';\n",
    "host-patch/table-policy/spec.mjs": [
      'export const PATCH_ID = "openclaw-dsh-native-table-policy-v1";',
      'export const HOST_VERSION = "2026.9.2";',
      'export const SOURCE_COMMIT = "3928bad9badfcb6c7d140530435e806fb8092190";',
      "export const edits = [];",
    ].join("\n") + "\n",
    "host-patch/table-policy/USAGE.txt": "table policy usage\n",
    "host-patch/chat-final-text/apply.mjs": "export const APPLY = 'chat-final-text';\n",
    "host-patch/chat-final-text/spec.mjs": [
      'import { replaceExactly } from "../spec.mjs";',
      `export const PATCH_ID = "${CHAT_FINAL_TEXT_PATCH_ID}";`,
      'export const HOST_VERSION = "2026.9.2";',
      'export const SOURCE_COMMIT = "3928bad9badfcb6c7d140530435e806fb8092190";',
      "export { replaceExactly };",
      "export const edits = [];",
    ].join("\n") + "\n",
    "host-patch/chat-final-text/USAGE.txt": "chat final text usage\n",
    "notes/tracked.txt": "tracked\n",
    "dist/index.js": "export {};\n",
    "dist/index.d.ts": "export {};\n",
    "dist/index.js.map": "{}\n",
    "dist/bridge/index.js": "export {};\n",
    "dist/bridge/index.d.ts": "export {};\n",
    "dist/bridge/index.js.map": "{}\n",
  };
}

const packageMembers = [
  "package.json",
  "npm-shrinkwrap.json",
  "openclaw.plugin.json",
  "README.md",
  "USAGE.txt",
  "LICENSE",
  "examples/openclaw.enabled.json",
  "scripts/inspect-state.mjs",
  "host-patch/apply.mjs",
  "host-patch/spec.mjs",
  "host-patch/engine.mjs",
  "host-patch/USAGE.txt",
  "host-patch/compact-auth/apply.mjs",
  "host-patch/compact-auth/spec.mjs",
  "host-patch/source-reply/apply.mjs",
  "host-patch/source-reply/spec.mjs",
  "host-patch/source-reply/USAGE.txt",
  "host-patch/table-policy/apply.mjs",
  "host-patch/table-policy/spec.mjs",
  "host-patch/table-policy/USAGE.txt",
  "host-patch/chat-final-text/apply.mjs",
  "host-patch/chat-final-text/spec.mjs",
  "host-patch/chat-final-text/USAGE.txt",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/index.js.map",
  "dist/bridge/index.js",
  "dist/bridge/index.d.ts",
  "dist/bridge/index.js.map",
];

async function git(root, ...args) {
  return execFile("git", ["-C", root, ...args], { windowsHide: true });
}

async function writeFiles(root, files) {
  for (const [relPath, contents] of Object.entries(files)) {
    const diskPath = join(root, ...relPath.split("/"));
    await mkdir(dirname(diskPath), { recursive: true });
    await writeFile(diskPath, contents);
  }
}

async function createArchive(root, archivePath, selectedMembers = packageMembers) {
  const entries = [];
  for (const relPath of selectedMembers) {
    const contents = await readFile(join(root, ...relPath.split("/")));
    entries.push(tarEntry(`package/${relPath.replace(/\\/g, "/")}`, contents));
  }
  const tgz = gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, tgz);
  return { bytes: tgz, sha256: checksum(tgz) };
}

async function createFixture(name, {
  version,
  mutateFiles,
  trackedExtra = {},
  forceTrackedExtra = {},
  omitFromCommit = [],
} = {}) {
  const root = join(stateDir, name, randomUUID());
  const files = { ...baseFiles(version), ...trackedExtra, ...forceTrackedExtra, ...mutateFiles };
  await writeFiles(root, files);
  await git(root, "init");
  await git(root, "config", "user.name", "release-manifest-test");
  await git(root, "config", "user.email", "release-manifest-test@example.com");
  const commitCandidates = [
    ".gitignore",
    ...packageMembers.filter((path) => !path.startsWith("dist/")),
    "notes/tracked.txt",
    ...Object.keys(trackedExtra),
    ...Object.keys(forceTrackedExtra),
  ];
  const omit = new Set(omitFromCommit);
  const normalPaths = [...new Set(commitCandidates.filter((path) => !omit.has(path) && !Object.hasOwn(forceTrackedExtra, path)))];
  if (normalPaths.length > 0) await git(root, "add", ...normalPaths);
  const forcedPaths = Object.keys(forceTrackedExtra).filter((path) => !omit.has(path));
  if (forcedPaths.length > 0) await git(root, "add", "-f", ...forcedPaths);
  await git(root, "-c", "core.hooksPath=NUL", "-c", "commit.gpgsign=false", "commit", "-m",
    "fixture\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>");
  return { root };
}

async function runCli(args, { env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr, error }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const pendingCompanionPaths = [
  "host-patch/source-reply/apply.mjs",
  "host-patch/source-reply/spec.mjs",
  "host-patch/source-reply/USAGE.txt",
  "host-patch/table-policy/apply.mjs",
  "host-patch/table-policy/spec.mjs",
  "host-patch/table-policy/USAGE.txt",
  "host-patch/chat-final-text/apply.mjs",
  "host-patch/chat-final-text/spec.mjs",
  "host-patch/chat-final-text/USAGE.txt",
];

function toCrLf(text) {
  return text.replace(/\n/g, "\r\n");
}

function findPatch(manifest, id) {
  return manifest.companions.patches.find((patch) => patch.id === id);
}

test.after(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

test("create --release succeeds on a clean root and verify re-audits package, source, and companions", async () => {
  const { root } = await createFixture("clean-release");
  const archivePath = join(root, "artifacts", "release", "product.tgz");
  const { sha256 } = await createArchive(root, archivePath);
  const manifestPath = join(root, "artifacts", "release", "release-manifest.json");
  const createResult = await runCli(["create", "--root", root, "--package", archivePath, "--expected-sha", sha256, "--output", manifestPath, "--release"]);
  assert.equal(createResult.code, 0, createResult.stdout);
  const manifest = JSON.parse(createResult.stdout);
  assert.equal(manifest.schema, "openclaw-dsh-native-release-manifest/v073-release-01");
  assert.equal(manifest.source.clean, true);
  assert.equal(manifest.source.releaseReady, true);
  assert.match(manifest.source.indexSha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.source.flagSha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.source.status.flaggedPaths, 0);
  assert.equal(manifest.package.version, "1.2.3-test.0");
  assert.deepEqual(manifest.companions.patches.map((patch) => patch.id), [
    "openclaw-agent-harness-pin-v1",
    "openclaw-compaction-auth-gap-v2",
    "openclaw-native-source-reply-owner-v1",
    "openclaw-dsh-native-table-policy-v1",
    CHAT_FINAL_TEXT_PATCH_ID,
  ]);
  assert.deepEqual(findPatch(manifest, "openclaw-native-source-reply-owner-v1").files.map((file) => file.path), [
    "host-patch/source-reply/apply.mjs",
    "host-patch/source-reply/spec.mjs",
    "host-patch/source-reply/USAGE.txt",
    "host-patch/spec.mjs",
    "host-patch/engine.mjs",
  ]);
  const chatFinalText = findPatch(manifest, CHAT_FINAL_TEXT_PATCH_ID);
  assert.deepEqual(chatFinalText.files.map((file) => file.path), [
    "host-patch/chat-final-text/apply.mjs",
    "host-patch/chat-final-text/spec.mjs",
    "host-patch/chat-final-text/USAGE.txt",
    "host-patch/spec.mjs",
    "host-patch/engine.mjs",
  ]);
  assert.equal(chatFinalText.hostVersion, "2026.9.2");
  assert.equal(chatFinalText.sourceCommit, "3928bad9badfcb6c7d140530435e806fb8092190");
  for (const file of chatFinalText.files) {
    assert.equal(file.sha256, checksum(await readFile(join(root, ...file.path.split("/")))));
  }
  assert.match(chatFinalText.aggregateSha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.sdk.approvedSha256, "3431f4cd2d8dbd6b936def2694ac27e19fa0256295cf4ada0f652ecf1c9ee520");
  assert.match(manifest.claims.limitations, /source\.releaseReady|CI\/test|compiler provenance/i);
  const verifyOutput = join(stateDir, "clean-release-verify.json");
  const verifyResult = await runCli(["verify", "--root", root, "--package", archivePath, "--manifest", manifestPath, "--expected-sha", sha256, "--output", verifyOutput]);
  assert.equal(verifyResult.code, 0, verifyResult.stdout);
  const verification = JSON.parse(verifyResult.stdout);
  assert.equal(verification.ok, true);
  assert.equal(verification.command, "verify");
  assert.equal(verification.manifest.package.sha256, sha256);
  assert.equal(JSON.parse(await readFile(verifyOutput, "utf8")).manifest.source.snapshotSha256, manifest.source.snapshotSha256);
});

test("local create succeeds for dirty staged, untracked, and missing source drift while --release fails", async () => {
  const { root } = await createFixture("dirty-local", {
    trackedExtra: { "docs/obsolete.txt": "obsolete\n" },
    omitFromCommit: pendingCompanionPaths,
  });
  const archivePath = join(root, "artifacts", "release", "product.tgz");
  const { sha256 } = await createArchive(root, archivePath);
  await writeFile(join(root, "notes", "tracked.txt"), "index-only change\n");
  await git(root, "add", "notes/tracked.txt");
  await writeFile(join(root, "local-untracked.txt"), "local only\n");
  await rm(join(root, "docs", "obsolete.txt"));
  const localResult = await runCli(["create", "--root", root, "--package", archivePath, "--expected-sha", sha256]);
  assert.equal(localResult.code, 0, localResult.stdout);
  const manifest = JSON.parse(localResult.stdout);
  assert.equal(manifest.source.clean, false);
  assert.equal(manifest.source.releaseReady, false);
  assert.ok(manifest.source.status.indexChanges >= 1);
  assert.ok(manifest.source.status.untrackedFiles >= pendingCompanionPaths.length + 1);
  assert.ok(manifest.source.status.missingFiles >= 1);
  assert.ok(findPatch(manifest, "openclaw-native-source-reply-owner-v1").files.some((file) => file.path === "host-patch/spec.mjs"));
  assert.ok(findPatch(manifest, CHAT_FINAL_TEXT_PATCH_ID).files.some((file) => file.path === "host-patch/spec.mjs"));
  const releaseResult = await runCli(["create", "--root", root, "--package", archivePath, "--expected-sha", sha256, "--release"]);
  assert.notEqual(releaseResult.code, 0);
  assert.equal(JSON.parse(releaseResult.stdout).error.code, "package_untracked_source");
});

test("local create rejects ignored packaged source that was not captured as nonignored untracked", async () => {
  const ignoredGitignore = `${baseFiles()[".gitignore"]}host-patch/table-policy/\n`;
  const { root } = await createFixture("ignored-untracked", {
    mutateFiles: { ".gitignore": ignoredGitignore },
    omitFromCommit: [
      "host-patch/table-policy/apply.mjs",
      "host-patch/table-policy/spec.mjs",
      "host-patch/table-policy/USAGE.txt",
    ],
  });
  const archivePath = join(root, "artifacts", "release", "product.tgz");
  const { sha256 } = await createArchive(root, archivePath);
  const result = await runCli(["create", "--root", root, "--package", archivePath, "--expected-sha", sha256]);
  assert.notEqual(result.code, 0);
  assert.equal(JSON.parse(result.stdout).error.code, "package_untracked_source");
});

test("create accepts CRLF companion specs", async () => {
  const base = baseFiles();
  const { root } = await createFixture("crlf-specs", {
    mutateFiles: {
      "host-patch/spec.mjs": toCrLf(base["host-patch/spec.mjs"]),
      "host-patch/compact-auth/spec.mjs": toCrLf(base["host-patch/compact-auth/spec.mjs"]),
      "host-patch/source-reply/spec.mjs": toCrLf(base["host-patch/source-reply/spec.mjs"]),
      "host-patch/table-policy/spec.mjs": toCrLf(base["host-patch/table-policy/spec.mjs"]),
      "host-patch/chat-final-text/spec.mjs": toCrLf(base["host-patch/chat-final-text/spec.mjs"]),
    },
  });
  const archivePath = join(root, "artifacts", "release", "product.tgz");
  const { sha256 } = await createArchive(root, archivePath);
  const result = await runCli(["create", "--root", root, "--package", archivePath, "--expected-sha", sha256, "--release"]);
  assert.equal(result.code, 0, result.stdout);
  const manifest = JSON.parse(result.stdout);
  assert.equal(findPatch(manifest, "openclaw-native-source-reply-owner-v1").files[3].path, "host-patch/spec.mjs");
  assert.equal(findPatch(manifest, CHAT_FINAL_TEXT_PATCH_ID).files[3].path, "host-patch/spec.mjs");
});

test("an additional group-readonly companion is bound when present and cannot be omitted from the archive", async () => {
  const { root } = await createFixture("extra-companion");
  const groupFiles = {
    "host-patch/group-readonly/apply.mjs": "export {};\n",
    "host-patch/group-readonly/spec.mjs": 'export const PATCH_ID = "openclaw-dsh-group-readonly-v1";\nexport const HOST_VERSION = "2026.9.2";\nexport const SOURCE_COMMIT = "3928bad9badfcb6c7d140530435e806fb8092190";\n',
    "host-patch/group-readonly/USAGE.txt": "generated fixture\n",
  };
  await writeFiles(root, groupFiles);
  const archivePath = join(root, "artifacts", "release", "product.tgz");
  const { sha256 } = await createArchive(root, archivePath, [...packageMembers, ...Object.keys(groupFiles)]);
  const manifest = await createReleaseManifest({ root, packagePath: archivePath, expectedSha: sha256 });
  const group = findPatch(manifest, "openclaw-dsh-group-readonly-v1");
  assert.equal(manifest.companions.patches.length, 6);
  assert.ok(findPatch(manifest, CHAT_FINAL_TEXT_PATCH_ID));
  assert.equal(group.files.length, 5);
  assert.equal(manifest.source.clean, false);
  const omitted = await createArchive(root, archivePath);
  await assert.rejects(createReleaseManifest({ root, packagePath: archivePath, expectedSha: omitted.sha256 }),
    (error) => error.code === "package_validation_failed");
});

test("chat-final-text is mandatory even if its entire archive bundle is missing", async () => {
  const { root } = await createFixture("missing-chat-final-text");
  const archivePath = join(root, "artifacts", "release", "product.tgz");
  for (const omitted of [undefined, "apply.mjs", "spec.mjs", "USAGE.txt"]) {
    const members = packageMembers.filter((path) => omitted
      ? path !== `host-patch/chat-final-text/${omitted}`
      : !path.startsWith("host-patch/chat-final-text/"));
    const { sha256 } = await createArchive(root, archivePath, members);
    await assert.rejects(createReleaseManifest({ root, packagePath: archivePath, expectedSha: sha256 }),
      (error) => error.code === "package_validation_failed");
  }
});

test("chat-final-text specs must match the shipped patch identity and pinned SDK", async () => {
  const { root } = await createFixture("wrong-chat-final-text-pin");
  const archivePath = join(root, "artifacts", "release", "product.tgz");
  const specPath = "host-patch/chat-final-text/spec.mjs";
  for (const [name, invalid] of [
    ["PATCH_ID", "wrong-chat-final-text-id"],
    ["HOST_VERSION", "2026.9.3"],
    ["SOURCE_COMMIT", "0".repeat(40)],
  ]) {
    const spec = baseFiles()[specPath].replace(new RegExp(`export const ${name} = "[^"]+";`),
      `export const ${name} = "${invalid}";`);
    await writeFile(join(root, ...specPath.split("/")), spec);
    const { sha256 } = await createArchive(root, archivePath);
    await assert.rejects(createReleaseManifest({ root, packagePath: archivePath, expectedSha: sha256 }),
      (error) => error.code === "companion_pin_invalid");
  }
});

test("verification rejects removing chat-final-text from an otherwise valid manifest", async () => {
  const { root } = await createFixture("omitted-chat-final-text-manifest");
  const archivePath = join(root, "artifacts", "release", "product.tgz");
  const { sha256 } = await createArchive(root, archivePath);
  const manifestPath = join(root, "artifacts", "release", "release-manifest.json");
  const manifest = await createReleaseManifest({ root, packagePath: archivePath, expectedSha: sha256, outputPath: manifestPath });
  manifest.companions.patches = manifest.companions.patches.filter((patch) => patch.id !== CHAT_FINAL_TEXT_PATCH_ID);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(verifyReleaseManifest({ root, packagePath: archivePath, expectedSha: sha256, manifestPath }),
    (error) => error.code === "manifest_mismatch");
});

test("create rejects unsafe output paths", async () => {
  const { root } = await createFixture("output-path", {
    forceTrackedExtra: { "artifacts/release/tracked.json": "{}\n" },
  });
  const archivePath = join(root, "artifacts", "release", "product.tgz");
  const { sha256 } = await createArchive(root, archivePath);

  const insideRoot = await runCli(["create", "--root", root, "--package", archivePath, "--expected-sha", sha256, "--output", join(root, "release-manifest.json")]);
  assert.notEqual(insideRoot.code, 0);
  assert.equal(JSON.parse(insideRoot.stdout).error.code, "output_not_ignored");

  const trackedIgnored = await runCli(["create", "--root", root, "--package", archivePath, "--expected-sha", sha256, "--output", join(root, "artifacts", "release", "tracked.json")]);
  assert.notEqual(trackedIgnored.code, 0);
  assert.equal(JSON.parse(trackedIgnored.stdout).error.code, "output_not_ignored");

  const gitDir = await runCli(["create", "--root", root, "--package", archivePath, "--expected-sha", sha256, "--output", join(root, ".git", "manifest.json")]);
  assert.notEqual(gitDir.code, 0);
  assert.equal(JSON.parse(gitDir.stdout).error.code, "output_unsafe");

  const overwrite = await runCli(["create", "--root", root, "--package", archivePath, "--expected-sha", sha256, "--output", archivePath]);
  assert.notEqual(overwrite.code, 0);
  assert.equal(JSON.parse(overwrite.stdout).error.code, "output_overwrite");
});

test("create rejects output hardlinks to inputs when supported", async (t) => {
  const { root } = await createFixture("output-hardlink");
  const archivePath = join(root, "artifacts", "release", "product.tgz");
  const { sha256 } = await createArchive(root, archivePath);
  const outputPath = join(stateDir, `hardlink-${randomUUID()}.json`);
  try {
    await link(archivePath, outputPath);
  } catch (error) {
    t.skip(`hardlinks unavailable: ${error.code}`);
    return;
  }
  const result = await runCli(["create", "--root", root, "--package", archivePath, "--expected-sha", sha256, "--output", outputPath]);
  assert.notEqual(result.code, 0);
  assert.equal(JSON.parse(result.stdout).error.code, "output_unsafe");
});

test("create rejects output through junction ancestors when supported", async (t) => {
  const { root } = await createFixture("output-junction");
  const archivePath = join(root, "artifacts", "release", "product.tgz");
  const { sha256 } = await createArchive(root, archivePath);
  const junctionRoot = join(stateDir, `junction-${randomUUID()}`);
  try {
    await symlink(root, junctionRoot, "junction");
  } catch (error) {
    t.skip(`junctions unavailable: ${error.code}`);
    return;
  }
  const result = await runCli(["create", "--root", root, "--package", archivePath, "--expected-sha", sha256, "--output", join(junctionRoot, "artifacts", "release", "manifest.json")]);
  assert.notEqual(result.code, 0);
  assert.equal(JSON.parse(result.stdout).error.code, "output_unsafe");
});

test("create detects missing companions, archive mismatches, and wrong pinned spec identities", async () => {
  const missingArchive = await createFixture("missing-archive-companion");
  const missingArchivePath = join(missingArchive.root, "artifacts", "release", "product.tgz");
  const missingMembers = packageMembers.filter((path) => !path.startsWith("host-patch/compact-auth/"));
  const { sha256: missingSha } = await createArchive(missingArchive.root, missingArchivePath, missingMembers);
  const missingResult = await runCli(["create", "--root", missingArchive.root, "--package", missingArchivePath, "--expected-sha", missingSha]);
  assert.notEqual(missingResult.code, 0);
  assert.equal(JSON.parse(missingResult.stdout).error.code, "package_validation_failed");

  const mismatch = await createFixture("root-mismatch");
  const mismatchArchivePath = join(mismatch.root, "artifacts", "release", "product.tgz");
  const { sha256: mismatchSha } = await createArchive(mismatch.root, mismatchArchivePath);
  await writeFile(join(mismatch.root, "README.md"), "changed after pack\n");
  const mismatchResult = await runCli(["create", "--root", mismatch.root, "--package", mismatchArchivePath, "--expected-sha", mismatchSha]);
  assert.notEqual(mismatchResult.code, 0);
  assert.equal(JSON.parse(mismatchResult.stdout).error.code, "package_validation_failed");

  const wrongPin = await createFixture("wrong-pin", {
    mutateFiles: {
      "host-patch/spec.mjs": [
        'export const PATCH_ID = "wrong-patch-id";',
        'export const HOST_VERSION = "2026.9.2";',
        'export const SOURCE_COMMIT = "3928bad9badfcb6c7d140530435e806fb8092190";',
        "export const edits = [];",
      ].join("\n") + "\n",
    },
  });
  const wrongPinArchivePath = join(wrongPin.root, "artifacts", "release", "product.tgz");
  const { sha256: wrongPinSha } = await createArchive(wrongPin.root, wrongPinArchivePath);
  const wrongPinResult = await runCli(["create", "--root", wrongPin.root, "--package", wrongPinArchivePath, "--expected-sha", wrongPinSha]);
  assert.notEqual(wrongPinResult.code, 0);
  assert.equal(JSON.parse(wrongPinResult.stdout).error.code, "companion_pin_invalid");
});

test("create rejects source mutation after the initial audit capture", async () => {
  const { root } = await createFixture("mutation-hook");
  const archivePath = join(root, "artifacts", "release", "product.tgz");
  const { sha256 } = await createArchive(root, archivePath);
  await assert.rejects(() => createReleaseManifest({
    root,
    packagePath: archivePath,
    expectedSha: sha256,
    hooks: {
      afterInitialAudit: async () => {
        await writeFile(join(root, "notes", "tracked.txt"), "mutated after capture\n");
      },
    },
  }), (error) => error.code === "source_changed");
});

test("create rejects index-only mutation after the initial audit capture", async () => {
  const { root } = await createFixture("index-mutation-hook");
  const archivePath = join(root, "artifacts", "release", "product.tgz");
  const { sha256 } = await createArchive(root, archivePath);
  const readmePath = join(root, "README.md");
  const original = await readFile(readmePath, "utf8");
  await assert.rejects(() => createReleaseManifest({
    root,
    packagePath: archivePath,
    expectedSha: sha256,
    hooks: {
      afterInitialAudit: async () => {
        await writeFile(readmePath, "# staged only\n");
        await git(root, "add", "README.md");
        await writeFile(readmePath, original);
      },
    },
  }), (error) => error.code === "source_changed");
});

test("create marks assume-unchanged and skip-worktree paths dirty while --release fails", async () => {
  const { root } = await createFixture("hidden-flags");
  const archivePath = join(root, "artifacts", "release", "product.tgz");
  const { sha256 } = await createArchive(root, archivePath);
  await git(root, "update-index", "--assume-unchanged", "README.md");
  await git(root, "update-index", "--skip-worktree", "USAGE.txt");
  const localResult = await runCli(["create", "--root", root, "--package", archivePath, "--expected-sha", sha256]);
  assert.equal(localResult.code, 0, localResult.stdout);
  const manifest = JSON.parse(localResult.stdout);
  assert.equal(manifest.source.clean, false);
  assert.equal(manifest.source.releaseReady, false);
  assert.equal(manifest.source.status.flaggedPaths, 2);
  const releaseResult = await runCli(["create", "--root", root, "--package", archivePath, "--expected-sha", sha256, "--release"]);
  assert.notEqual(releaseResult.code, 0);
  assert.equal(JSON.parse(releaseResult.stdout).error.code, "release_source_dirty");
});

test("verify detects manifest tampering and false cleanliness claims", async () => {
  const { root } = await createFixture("tamper", { trackedExtra: { "docs/unused.txt": "unused\n" } });
  const archivePath = join(root, "artifacts", "release", "product.tgz");
  const { sha256 } = await createArchive(root, archivePath);
  await writeFile(join(root, "local-untracked.txt"), "local only\n");
  const manifestPath = join(root, "artifacts", "release", "release-manifest.json");
  const manifest = await createReleaseManifest({ root, packagePath: archivePath, expectedSha: sha256, outputPath: manifestPath });
  assert.equal(manifest.source.clean, false);
  const untampered = await verifyReleaseManifest({ root, packagePath: archivePath, expectedSha: sha256, manifestPath });
  assert.equal(untampered.ok, true);
  const tampered = JSON.parse(await readFile(manifestPath, "utf8"));
  tampered.source.clean = true;
  tampered.source.releaseReady = true;
  await writeFile(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`);
  await assert.rejects(() => verifyReleaseManifest({ root, packagePath: archivePath, expectedSha: sha256, manifestPath }),
    (error) => error.code === "manifest_mismatch");
});

test("CLI failures do not echo secret sentinels from manifests or environment", async () => {
  const { root } = await createFixture("secret-sentinel");
  const archivePath = join(root, "artifacts", "release", "product.tgz");
  const { sha256 } = await createArchive(root, archivePath);
  const manifestPath = join(root, "artifacts", "release", "invalid-manifest.json");
  const sentinel = `ghp_${"S".repeat(36)}`;
  await writeFile(manifestPath, `{"token":"${sentinel}"`);
  const result = await runCli(["verify", "--root", root, "--package", archivePath, "--manifest", manifestPath, "--expected-sha", sha256], {
    env: { RELEASE_MANIFEST_SENTINEL: sentinel },
  });
  assert.notEqual(result.code, 0);
  assert.equal(JSON.parse(result.stdout).error.code, "manifest_invalid");
  assert.ok(!result.stdout.includes(sentinel));
  assert.ok(!result.stderr.includes(sentinel));
});

test("CLI rejects duplicate or missing flags and whitelists error codes", async () => {
  const { root } = await createFixture("cli-args");
  const archivePath = join(root, "artifacts", "release", "product.tgz");
  const { sha256 } = await createArchive(root, archivePath);
  const duplicate = await runCli(["create", "--root", root, "--root", root, "--package", archivePath, "--expected-sha", sha256]);
  assert.notEqual(duplicate.code, 0);
  assert.equal(JSON.parse(duplicate.stdout).error.code, "invalid_arguments");
  const missing = await runCli(["create", "--root", root, "--package"]);
  assert.notEqual(missing.code, 0);
  assert.equal(JSON.parse(missing.stdout).error.code, "invalid_arguments");
  const wrongCommandFlag = await runCli(["create", "--root", root, "--package", archivePath, "--expected-sha", sha256, "--manifest", join(root, "artifacts", "release", "ignored.json")]);
  assert.notEqual(wrongCommandFlag.code, 0);
  assert.equal(JSON.parse(wrongCommandFlag.stdout).error.code, "invalid_arguments");
  assert.equal(toCliError({ code: "not_whitelisted" }).error.code, "internal_error");
});
