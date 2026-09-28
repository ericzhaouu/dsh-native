import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHostPatcher } from "../host-patch/engine.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const original = "original\n";
const spec = {
  PATCH_ID: "permission-fixture", HOST_VERSION: "2026.9.2", SOURCE_COMMIT: "fixture",
  stateName: ".permission-fixture",
  edits: ["first.js", "second.js"].map((file) => ({ file, sha256: hash(original) })),
  transform: (text) => text.replace("original", "patched"),
};
const { patchHost, inspectHost } = createHostPatcher(spec);
const mutate = (root, action) => patchHost(root, { action, offlineConfirmed: true });
const modeOf = async (path) => (await lstat(path)).mode & 0o777;

async function fixture(t, mode) {
  const root = await mkdtemp(join(tmpdir(), "dsh-permissions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "openclaw", version: spec.HOST_VERSION }));
  for (const edit of spec.edits) {
    const file = await open(join(root, edit.file), "wx", 0o600);
    try { await file.writeFile(original); await file.chmod(mode); }
    finally { await file.close(); }
  }
  return root;
}

async function snapshot(root) {
  return Promise.all(spec.edits.map(async ({ file }) => {
    const path = join(root, file);
    const info = await lstat(path);
    return { bytes: await readFile(path), mode: info.mode, ino: info.ino, mtimeMs: info.mtimeMs };
  }));
}

async function assertFiles(root, mode, patched) {
  for (const edit of spec.edits) {
    assert.equal(await modeOf(join(root, edit.file)), mode, edit.file);
    assert.equal(await readFile(join(root, edit.file), "utf8"), patched ? spec.transform(original) : original);
    assert.equal(await modeOf(join(root, spec.stateName, edit.file)), 0o600);
  }
  const receipt = JSON.parse(await readFile(join(root, spec.stateName, "receipt.json"), "utf8"));
  assert.equal(await modeOf(join(root, spec.stateName, "receipt.json")), 0o600);
  assert.deepEqual(receipt.files.map((file) => file.mode), spec.edits.map(() => mode));
}

test("POSIX host patch permissions survive umask, read-only targets and legacy partial receipts", {
  skip: process.platform === "win32" && "Windows chmod cannot certify POSIX permission bits",
}, async (t) => {
  const previous = process.umask();
  t.after(() => process.umask(previous));
  for (const umask of [0o022, 0o077]) {
    for (const mode of [0o600, 0o644, 0o400, 0o444]) {
      for (const action of ["apply", "restore"]) {
        await t.test(`umask ${umask.toString(8)}, original ${mode.toString(8)}, recover ${action}`, async (t) => {
          process.umask(umask);
          const root = await fixture(t, mode);
          const before = await snapshot(root);
          assert.equal((await patchHost(root)).status, "unpatched");
          assert.equal((await mutate(root, "restore")).status, "unpatched");
          assert.deepEqual(await snapshot(root), before);
          await mutate(root, "apply");
          await assertFiles(root, mode, true);
          const applied = await snapshot(root);
          await mutate(root, "apply");
          assert.deepEqual(await snapshot(root), applied);

          const first = spec.edits[0].file;
          await rm(join(root, first));
          await cp(join(root, spec.stateName, first), join(root, first));
          const receiptPath = join(root, spec.stateName, "receipt.json");
          const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
          // Historical receipts need no new schema or status field to retain their original mode.
          delete receipt.status;
          await writeFile(receiptPath, JSON.stringify(receipt));
          const partial = await snapshot(root);
          assert.equal((await patchHost(root)).status, "partial");
          assert.deepEqual((await inspectHost(root)).files.map((file) => file.mode), [mode, mode]);
          assert.deepEqual(await snapshot(root), partial);
          await mutate(root, action);
          await assertFiles(root, mode, action === "apply");
          await mutate(root, "restore");
          await assertFiles(root, mode, false);
          for (const edit of spec.edits) {
            await rm(join(root, edit.file));
            await cp(join(root, spec.stateName, edit.file), join(root, edit.file));
          }
          await writeFile(receiptPath, JSON.stringify({ ...receipt, status: "applying" }));
          const originalBytes = await snapshot(root);
          assert.equal((await patchHost(root)).status, "unpatched");
          assert.deepEqual(await snapshot(root), originalBytes);
          await mutate(root, action);
          await assertFiles(root, mode, action === "apply");
          await mutate(root, "restore");
          await assertFiles(root, mode, false);
          await mutate(root, "apply");
          await assertFiles(root, mode, true);
          await mutate(root, "restore");
          await assertFiles(root, mode, false);
        });
      }
    }
  }
});

test("original-byte recovery rejects an invalid receipt before trusting its mode", async (t) => {
  const root = await fixture(t, 0o600);
  await mkdir(join(root, spec.stateName));
  const receipt = {
    patchId: spec.PATCH_ID, hostVersion: spec.HOST_VERSION, sourceCommit: spec.SOURCE_COMMIT,
    files: spec.edits.map((edit) => ({ file: edit.file, original: edit.sha256,
      patched: hash(spec.transform(original)), mode: 0o600 })),
  };
  for (const invalid of [-1, 0o1000, 0o100644, "644", null]) {
    const bad = structuredClone(receipt);
    bad.files[0].mode = invalid;
    await writeFile(join(root, spec.stateName, "receipt.json"), JSON.stringify(bad));
    await assert.rejects(inspectHost(root), /Invalid host-patch receipt/);
  }
  receipt.files[0].patched = "0".repeat(64);
  await writeFile(join(root, spec.stateName, "receipt.json"), JSON.stringify(receipt));
  const before = await snapshot(root);
  for (const action of ["check", "apply", "restore"]) {
    await assert.rejects(mutate(root, action), /does not match this patch implementation/);
    assert.deepEqual(await snapshot(root), before);
  }
});
