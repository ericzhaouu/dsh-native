import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkPackage, parseTarGz } from "../scripts/check-package.mjs";

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const stateDir = join(project, ".test-state", `package-acceptance-${process.pid}-${randomUUID()}`);
const checker = join(project, "scripts", "check-package.mjs");

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

function paxRecord(key, value) {
  let record = `${key}=${value}\n`;
  let length = Buffer.byteLength(record) + 2;
  while (true) {
    const candidate = `${length} ${record}`;
    const actual = Buffer.byteLength(candidate);
    if (actual === length) return candidate;
    length = actual;
  }
}

function packageJson(overrides = {}) {
  return JSON.stringify({
    name: "openclaw-dsh-native",
    version: "9.9.9-test.0",
    files: ["dist", "openclaw.plugin.json", "host-patch", "npm-shrinkwrap.json", "examples", "README.md", "LICENSE", "USAGE.txt"],
    exports: { ".": "./dist/index.js", "./bridge": "./dist/bridge/index.js" },
    openclaw: { extensions: ["./dist/index.js"], compat: { pluginApi: ">=2026.9.2 <2026.10.0" } },
    peerDependencies: { openclaw: ">=2026.9.2 <2026.10.0" },
    peerDependenciesMeta: { openclaw: { optional: true } },
    dependencies: { "@deepseek-ai/dsh": "0.1.2-alpha.2" },
    ...overrides,
  });
}

function shrinkwrap(version = "9.9.9-test.0") {
  return JSON.stringify({ name: "openclaw-dsh-native", version, lockfileVersion: 3, packages: { "": { name: "openclaw-dsh-native", version } } });
}

function goodEntries(extra = []) {
  return [
    ["package/package.json", packageJson()],
    ["package/npm-shrinkwrap.json", shrinkwrap()],
    ["package/openclaw.plugin.json", JSON.stringify({ id: "dsh-native", activation: { onAgentHarnesses: ["dsh-native"] } })],
    ["package/README.md", "public docs with https://github.com/openclaw/openclaw\n"],
    ["package/USAGE.txt", "usage docs\n"],
    ["package/LICENSE", "MIT\n"],
    ["package/dist/index.js", "export {};\n"],
    ["package/dist/index.d.ts", "export {};\n"],
    ["package/dist/index.js.map", "{}\n"],
    ["package/dist/bridge/index.js", "export {};\n"],
    ["package/dist/bridge/index.d.ts", "export {};\n"],
    ["package/dist/bridge/index.js.map", "{}\n"],
    ["package/examples/openclaw.enabled.json", "{}\n"],
    ["package/host-patch/apply.mjs", "export {};\n"],
    ["package/host-patch/spec.mjs", "export {};\n"],
    ["package/host-patch/USAGE.txt", "usage\n"],
    ...extra,
  ];
}

function tgz(entries, endMarkers = true) {
  return gzipSync(Buffer.concat([...entries.map(([path, data, type, linkName]) => tarEntry(path, data, type, linkName)), endMarkers ? Buffer.alloc(1024) : Buffer.alloc(0)]));
}

async function writeTgz(name, entries) {
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, name);
  await writeFile(path, tgz(entries));
  return path;
}

function runChecker(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [checker, ...args], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr, error }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test.after(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

test("accepts a generated package fixture and reports hashes without historical artifacts", async () => {
  const archive = await writeTgz("good.tgz", goodEntries());
  const data = await import("node:fs/promises").then((fs) => fs.readFile(archive));
  const report = await checkPackage({ packagePath: archive, expectedSha: checksum(data) });
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.equal(report.package.name, "openclaw-dsh-native");
  assert.equal(report.package.version, "9.9.9-test.0");
  assert.ok(report.files.some((file) => file.path === "package/dist/index.js" && /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.ok(report.totals.files > 10);

  const manifest = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(join(project, "package.json"), "utf8")));
  assert.equal(manifest.scripts["package:check"], "node scripts/check-package.mjs");
  assert.ok(!manifest.scripts["package:check"].includes("openclaw-dsh-native-0.5.2.tgz"));
});

test("fails closed for a wrong archive hash", async () => {
  const archive = await writeTgz("wrong-sha.tgz", goodEntries());
  const result = await runChecker(["--package", archive, "--expected-sha", "0".repeat(64)]);
  assert.notEqual(result.code, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.findings[0].code, "archive-sha-mismatch");
});

test("requires explicit --package and gives clear CLI usage", async () => {
  const result = await runChecker([]);
  assert.notEqual(result.code, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.match(report.findings[0].detail, /--package is required/);
  assert.match(report.findings[0].detail, /never assumes a historical archive name/);
});

test("rejects traversal, duplicate members, symlinks and unknown package files", async () => {
  const archive = await writeTgz("bad-paths.tgz", goodEntries([
    ["package/dist/index.js", "duplicate\n"],
    ["package/../escape.txt", "escape\n"],
    ["package/dist/link.js", "", "2", "../target.js"],
    ["package/tests/private.test.mjs", "not allowed\n"],
    ["package/node_modules/openclaw/package.json", "{}\n"],
    ["package/dist/CON.js", "unsafe\n"],
    ["package/dist/name .js", "unsafe\n"],
    ["package/dist/file:ads.js", "unsafe\n"],
  ]));
  const report = await checkPackage({ packagePath: archive });
  assert.equal(report.ok, false);
  const codes = new Set(report.findings.map((finding) => finding.code));
  assert.ok(codes.has("duplicate-member"));
  assert.ok(codes.has("bad-path"));
  assert.ok(codes.has("link-member"));
  assert.ok(codes.has("unexpected-file"));
  assert.ok(codes.has("host-bundled"));
});

test("rejects malformed tar checksums, truncation, missing end markers and bad PAX", async () => {
  const badChecksum = tarEntry("package/package.json", packageJson());
  badChecksum[0] = 0x78;
  let archive = join(stateDir, "bad-checksum.tgz");
  await mkdir(stateDir, { recursive: true });
  await writeFile(archive, gzipSync(Buffer.concat([badChecksum, Buffer.alloc(1024)])));
  let report = await checkPackage({ packagePath: archive });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "archive-parse-failed" && /checksum/.test(finding.detail)));

  archive = join(stateDir, "truncated-payload.tgz");
  await writeFile(archive, gzipSync(tarEntry("package/package.json", packageJson()).subarray(0, 520)));
  report = await checkPackage({ packagePath: archive });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "archive-parse-failed"));

  archive = join(stateDir, "no-end-markers.tgz");
  await writeFile(archive, tgz(goodEntries(), false));
  report = await checkPackage({ packagePath: archive });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "archive-parse-failed" && /end marker/.test(finding.detail)));

  archive = join(stateDir, "bad-pax.tgz");
  await writeFile(archive, gzipSync(Buffer.concat([tarEntry("PaxHeader", "999 path=package/dist/pax.js\n", "x"), tarEntry("package/dist/pax.js", "x\n"), Buffer.alloc(1024)])));
  report = await checkPackage({ packagePath: archive });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "archive-parse-failed" && /PAX/.test(finding.detail)));

  archive = join(stateDir, "trailing-junk.tgz");
  await writeFile(archive, gzipSync(Buffer.concat([tarEntry("package/package.json", packageJson()), Buffer.alloc(1024), Buffer.from("junk")])));
  report = await checkPackage({ packagePath: archive });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "archive-parse-failed" && /trailing junk/.test(finding.detail)));
});

test("rejects oversized compressed and inflated archives", () => {
  assert.throws(() => parseTarGz(Buffer.alloc(64 * 1024 * 1024 + 1)), /Compressed archive exceeds/);
  assert.throws(() => parseTarGz(gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1))), /Buffer larger|Expanded archive exceeds/);
});

test("accepts valid npm-style local PAX path records", async () => {
  const longPath = "package/dist/" + "a".repeat(110) + ".js";
  const archive = join(stateDir, "valid-pax.tgz");
  await mkdir(stateDir, { recursive: true });
  await writeFile(archive, gzipSync(Buffer.concat([
    ...goodEntries().map(([path, data, type, linkName]) => tarEntry(path, data, type, linkName)),
    tarEntry("PaxHeader", paxRecord("path", longPath), "x"),
    tarEntry("short", "export {};\n"),
    Buffer.alloc(1024),
  ])));
  const report = await checkPackage({ packagePath: archive });
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.ok(report.files.some((file) => file.path === longPath));
});

test("rejects credential-like content without flagging ordinary public docs", async () => {
  const fakeCredential = `const token = '${"ghp_" + "A".repeat(36)}';\n`;
  const archive = await writeTgz("secret.tgz", goodEntries([
    ["package/dist/credential.js", fakeCredential],
  ]));
  const report = await checkPackage({ packagePath: archive });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "secret-pattern" && finding.detail.includes("github-token")));
  assert.ok(!report.findings.some((finding) => finding.path === "package/README.md"));
});

test("does not echo invalid JSON payloads in errors", async () => {
  const privatePayload = `{"token":"${"ghp_" + "B".repeat(36)}",`;
  const archive = await writeTgz("invalid-json.tgz", goodEntries([
    ["package/package.json", privatePayload],
  ]));
  const report = await checkPackage({ packagePath: archive });
  assert.equal(report.ok, false);
  const finding = report.findings.find((item) => item.code === "invalid-json");
  assert.ok(finding);
  assert.ok(!finding.detail.includes("ghp_"));
  assert.ok(!finding.detail.includes("token"));
});

test("validates manifest identity, optional peer and shrinkwrap root version", async () => {
  const archive = await writeTgz("manifest.tgz", goodEntries([
    ["package/package.json", packageJson({ name: "wrong-name", dependencies: { openclaw: "2026.9.2" }, peerDependenciesMeta: { openclaw: { optional: false } } })],
    ["package/npm-shrinkwrap.json", shrinkwrap("9.9.9")],
  ]));
  const report = await checkPackage({ packagePath: archive });
  assert.equal(report.ok, false);
  const codes = new Set(report.findings.map((finding) => finding.code));
  assert.ok(codes.has("manifest-name"));
  assert.ok(codes.has("bundled-host-dependency"));
  assert.ok(codes.has("peer-optional"));
  assert.ok(codes.has("shrinkwrap-root"));
});

test("requires declared package entrypoints, plugin extensions and host patch files", async () => {
  const archive = await writeTgz("missing-entrypoint.tgz", goodEntries().filter(([path]) => path !== "package/dist/index.js" && path !== "package/host-patch/spec.mjs"));
  const report = await checkPackage({ packagePath: archive });
  assert.equal(report.ok, false);
  const missing = report.findings.filter((finding) => finding.code === "missing-entrypoint").map((finding) => finding.path);
  assert.ok(missing.includes("package/dist/index.js"));
  assert.ok(missing.includes("package/host-patch/spec.mjs"));
});

test("optionally compares archive payload files with a built workspace root", async () => {
  const archive = await writeTgz("root-compare.tgz", goodEntries());
  const root = join(stateDir, "root");
  for (const [path, data] of goodEntries()) {
    const disk = join(root, ...path.slice("package/".length).split("/"));
    await mkdir(dirname(disk), { recursive: true });
    await writeFile(disk, data);
  }
  const report = await checkPackage({ packagePath: archive, root });
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  await writeFile(join(root, "dist", "index.js"), "changed\n");
  const mismatch = await checkPackage({ packagePath: archive, root });
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.findings.some((finding) => finding.code === "root-mismatch"));
});

test("root comparison refuses symlinked workspace files when supported", async (t) => {
  const archive = await writeTgz("root-symlink.tgz", goodEntries());
  const root = join(stateDir, "symlink-root");
  for (const [path, data] of goodEntries()) {
    if (path === "package/dist/index.js") continue;
    const disk = join(root, ...path.slice("package/".length).split("/"));
    await mkdir(dirname(disk), { recursive: true });
    await writeFile(disk, data);
  }
  const target = join(root, "target.js");
  await writeFile(target, "export {};\n");
  const link = join(root, "dist", "index.js");
  try {
    await symlink(target, link, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
      t.skip(`symlink creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const report = await checkPackage({ packagePath: archive, root });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "root-symlink" && finding.path === "package/dist/index.js"));
});

test("root comparison rejects a directory junction to files outside the workspace", async () => {
  const archive = await writeTgz("root-junction.tgz", goodEntries());
  const root = join(stateDir, "junction-root");
  const outside = join(stateDir, "junction-target");
  await mkdir(outside, { recursive: true });
  for (const [path, data] of goodEntries()) {
    const rel = path.slice("package/".length);
    const disk = rel.startsWith("dist/") ? join(outside, rel.slice("dist/".length)) : join(root, ...rel.split("/"));
    await mkdir(dirname(disk), { recursive: true });
    await writeFile(disk, data);
  }
  await symlink(outside, join(root, "dist"), process.platform === "win32" ? "junction" : "dir");
  const report = await checkPackage({ packagePath: archive, root });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "root-traversal" &&
    finding.path === "package/dist/index.js"));
});
