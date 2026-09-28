import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspectHost, patchHost } from "../host-patch/chat-final-text/apply.mjs";
import { edits, HOST_VERSION, PATCH_ID, SOURCE_COMMIT, stateName, transform } from "../host-patch/chat-final-text/spec.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const genuineHost = join(projectRoot, "node_modules", "openclaw");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const targetPath = (root, edit) => join(root, ...edit.file.split("/"));
const backupPath = (root, edit) => targetPath(join(root, stateName), edit);
const receiptPath = (root) => join(root, stateName, "receipt.json");
const lockPath = (root) => join(root, `${stateName}.lock`);
const mutate = (root, action, options = {}) => patchHost(root, { action, offlineConfirmed: true, ...options });

async function fixture(t) {
  await mkdir(join(projectRoot, "artifacts"), { recursive: true });
  const directory = await mkdtemp(join(projectRoot, "artifacts", "chat-final-text-patch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "openclaw");
  await mkdir(root);
  await cp(join(genuineHost, "package.json"), join(root, "package.json"));
  const originals = new Map();
  const modes = new Map();
  for (const edit of edits) {
    const target = targetPath(root, edit);
    await mkdir(dirname(target), { recursive: true });
    await cp(targetPath(genuineHost, edit), target);
    const bytes = await readFile(target);
    assert.equal(hash(bytes), edit.sha256, `Genuine SDK hash: ${edit.file}`);
    originals.set(edit.file, bytes);
    modes.set(edit.file, (await lstat(target)).mode & 0o777);
  }
  return { root, directory, originals, modes };
}

async function snapshot(path, directoryTimes = false) {
  const info = await lstat(path);
  const metadata = {
    mode: info.mode, mtimeMs: info.mtimeMs, ino: info.ino, nlink: info.nlink,
  };
  if (info.isSymbolicLink()) return { ...metadata, link: await readlink(path) };
  if (info.isDirectory()) {
    const entries = [];
    for (const name of (await readdir(path)).sort()) {
      entries.push([name, await snapshot(join(path, name), directoryTimes)]);
    }
    // Failed mutations may create and remove a lock, changing directory timestamps.
    return { ...(directoryTimes ? metadata : { mode: info.mode }), entries };
  }
  assert.ok(info.isFile(), `Unexpected fixture entry: ${path}`);
  return { ...metadata, sha256: hash(await readFile(path)) };
}

async function rejectsUnchanged(f, operation, expected) {
  const before = await snapshot(f.directory);
  await assert.rejects(operation, expected);
  assert.deepEqual(await snapshot(f.directory), before);
}

async function refusesInspectionAndActions(f, expected) {
  await rejectsUnchanged(f, () => inspectHost(f.root), expected);
  for (const action of ["check", "apply", "restore"]) {
    await rejectsUnchanged(f, () => mutate(f.root, action), expected);
  }
}

function assertSummary(result, status) {
  assert.equal(result.patchId, PATCH_ID);
  assert.equal(result.hostVersion, HOST_VERSION);
  assert.equal(result.sourceCommit, SOURCE_COMMIT);
  assert.equal(result.status, status);
  assert.equal(result.restartPerformed, false);
  assert.deepEqual(result.files.map((file) => file.file), edits.map((edit) => edit.file));
  if (status !== "partial") {
    assert.ok(result.files.every((file) => file.state === (status === "applied" ? "patched" : "original")));
  }
}

async function assertTargets(f, patched) {
  for (const edit of edits) {
    const original = f.originals.get(edit.file);
    const expected = patched ? Buffer.from(transform(original.toString("utf8"), edit)) : original;
    const actual = await readFile(targetPath(f.root, edit));
    assert.deepEqual(actual, expected, edit.file);
    assert.equal(hash(actual), patched ? hash(expected) : edit.sha256, edit.file);
    assert.equal((await lstat(targetPath(f.root, edit))).mode & 0o777, f.modes.get(edit.file), edit.file);
  }
}

async function assertBackups(f) {
  for (const edit of edits) {
    const bytes = await readFile(backupPath(f.root, edit));
    assert.deepEqual(bytes, f.originals.get(edit.file), edit.file);
    assert.equal(hash(bytes), edit.sha256, edit.file);
  }
}

test("chat-final-text: read-only check", async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.directory, true);
  assert.equal(edits.length, 2);
  for (const result of [await patchHost(f.root), await patchHost(f.root, { action: "check" })]) {
    assertSummary(result, "unpatched");
  }
  const inspected = await inspectHost(f.root);
  assert.equal(inspected.receipt, undefined);
  assert.deepEqual(inspected.files.map((file) => file.current), ["original", "original"]);
  for (const file of inspected.files) {
    assert.equal(hash(file.contents), file.sha256);
    assert.deepEqual(file.contents, f.originals.get(file.file));
    assert.equal(hash(file.patched), hash(transform(file.contents.toString("utf8"), file)));
  }
  assert.deepEqual(await snapshot(f.directory, true), before);
  await assert.rejects(lstat(join(f.root, stateName)), { code: "ENOENT" });
  await assert.rejects(lstat(lockPath(f.root)), { code: "ENOENT" });
});

test("chat-final-text: offline confirmation", async (t) => {
  const f = await fixture(t);
  for (const applied of [false, true]) {
    if (applied) await mutate(f.root, "apply");
    for (const action of ["apply", "restore"]) {
      for (const options of [{ action }, { action, offlineConfirmed: false }]) {
        await rejectsUnchanged(f, () => patchHost(f.root, options), /offline-confirmed/);
      }
    }
  }
});

test("chat-final-text: idempotent apply and exact restore", async (t) => {
  const f = await fixture(t);
  const pristine = await snapshot(f.directory, true);
  assertSummary(await mutate(f.root, "restore"), "unpatched");
  assert.deepEqual(await snapshot(f.directory, true), pristine);
  assertSummary(await mutate(f.root, "apply"), "applied");
  await assertTargets(f, true);
  await assertBackups(f);
  const receipt = JSON.parse(await readFile(receiptPath(f.root), "utf8"));
  assert.equal(receipt.patchId, PATCH_ID);
  assert.equal(receipt.hostVersion, HOST_VERSION);
  assert.equal(receipt.sourceCommit, SOURCE_COMMIT);
  assert.equal(receipt.status, "applied");
  assert.equal(receipt.files.length, edits.length);
  for (const [index, edit] of edits.entries()) {
    assert.deepEqual(receipt.files[index], {
      file: edit.file, original: edit.sha256,
      patched: hash(transform(f.originals.get(edit.file).toString("utf8"), edit)), mode: f.modes.get(edit.file),
    });
  }
  const applied = await snapshot(f.directory, true);
  assertSummary(await patchHost(f.root), "applied");
  assertSummary(await mutate(f.root, "apply"), "applied");
  assert.deepEqual(await snapshot(f.directory, true), applied);
  assertSummary(await mutate(f.root, "restore"), "unpatched");
  await assertTargets(f, false);
  await assertBackups(f);
  assert.equal(JSON.parse(await readFile(receiptPath(f.root), "utf8")).status, "restored");
  await assert.rejects(lstat(lockPath(f.root)), { code: "ENOENT" });
});

test("chat-final-text: unsupported artifacts", async (t) => {
  await t.test("unsupported version", async (t) => {
    const f = await fixture(t);
    const packagePath = join(f.root, "package.json");
    const pkg = JSON.parse(await readFile(packagePath, "utf8"));
    await writeFile(packagePath, JSON.stringify({ ...pkg, version: `${HOST_VERSION}-unsupported` }));
    await refusesInspectionAndActions(f, /exact OpenClaw/);
  });
  for (const edit of edits) {
    await t.test(`unsupported hash: ${edit.file}`, async (t) => {
      const f = await fixture(t);
      await writeFile(targetPath(f.root, edit), Buffer.concat([
        f.originals.get(edit.file), Buffer.from("\n// unsupported local build\n"),
      ]));
      await refusesInspectionAndActions(f, /unsupported build or local changes/);
    });
  }
});

test("chat-final-text: partial transaction recovery", async (t) => {
  for (const action of ["apply", "restore"]) {
    for (const original of edits) {
      await t.test(`${action} with original ${original.file}`, async (t) => {
        const f = await fixture(t);
        await mutate(f.root, "apply");
        await cp(backupPath(f.root, original), targetPath(f.root, original));
        const receipt = JSON.parse(await readFile(receiptPath(f.root), "utf8"));
        await writeFile(receiptPath(f.root), JSON.stringify({ ...receipt, status: "applying" }));
        const before = await snapshot(f.directory, true);
        const result = await patchHost(f.root);
        assertSummary(result, "partial");
        assert.deepEqual(result.files, edits.map((edit) => ({
          file: edit.file, state: edit === original ? "original" : "patched",
        })));
        assert.deepEqual(await snapshot(f.directory, true), before);
        assertSummary(await mutate(f.root, action), action === "apply" ? "applied" : "unpatched");
        await assertTargets(f, action === "apply");
        await assertBackups(f);
        assert.equal(JSON.parse(await readFile(receiptPath(f.root), "utf8")).status,
          action === "apply" ? "applied" : "restored");
        await assert.rejects(lstat(lockPath(f.root)), { code: "ENOENT" });
      });
    }
  }
});

test("chat-final-text: modified target refusal", async (t) => {
  for (const edit of edits) {
    await t.test(edit.file, async (t) => {
      const f = await fixture(t);
      await mutate(f.root, "apply");
      const target = targetPath(f.root, edit);
      await writeFile(target, Buffer.concat([await readFile(target), Buffer.from("\n// later local edit\n")]));
      await refusesInspectionAndActions(f, /unsupported build or local changes/);
    });
  }
});

test("chat-final-text: corrupt backups", async (t) => {
  for (const state of ["applied", "restored"]) {
    for (const edit of edits) {
      await t.test(`${state}: ${edit.file}`, async (t) => {
        const f = await fixture(t);
        await mutate(f.root, "apply");
        if (state === "restored") await mutate(f.root, "restore");
        await writeFile(backupPath(f.root, edit), "corrupted original backup");
        if (state === "applied") {
          await refusesInspectionAndActions(f, /backup is corrupt/);
        } else {
          await rejectsUnchanged(f, () => mutate(f.root, "apply"), /Existing patch backup differs/);
          await assertTargets(f, false);
        }
      });
    }
  }
});

test("chat-final-text: corrupt receipts", async (t) => {
  const cases = [
    ["invalid JSON", () => "{", SyntaxError],
    ["wrong patch", (receipt) => ({ ...receipt, patchId: "foreign-patch" })],
    ["wrong version", (receipt) => ({ ...receipt, hostVersion: "unsupported" })],
    ["wrong source", (receipt) => ({ ...receipt, sourceCommit: "0".repeat(40) })],
    ["missing file", (receipt) => ({ ...receipt, files: receipt.files.slice(1) })],
    ["reordered files", (receipt) => ({ ...receipt, files: [...receipt.files].reverse() })],
    ["path traversal", (receipt) => {
      receipt.files[0].file = "../outside";
      return receipt;
    }],
    ["wrong original hash", (receipt) => {
      receipt.files[0].original = "0".repeat(64);
      return receipt;
    }],
    ["invalid patched hash", (receipt) => {
      receipt.files[0].patched = "not-a-hash";
      return receipt;
    }],
    ["wrong patched hash", (receipt) => {
      receipt.files[0].patched = "0".repeat(64);
      return receipt;
    }, /unsupported build or local changes/],
    ["invalid mode", (receipt) => {
      receipt.files[0].mode = "644";
      return receipt;
    }],
  ];
  for (const [name, corrupt, expected = /Invalid host-patch receipt/] of cases) {
    await t.test(name, async (t) => {
      const f = await fixture(t);
      await mutate(f.root, "apply");
      const receipt = corrupt(JSON.parse(await readFile(receiptPath(f.root), "utf8")));
      await writeFile(receiptPath(f.root), typeof receipt === "string" ? receipt : JSON.stringify(receipt));
      await refusesInspectionAndActions(f, expected);
    });
  }
});

test("chat-final-text: forged receipt refusal", async (t) => {
  const f = await fixture(t);
  await mutate(f.root, "apply");
  const edit = edits.at(-1);
  const target = targetPath(f.root, edit);
  const forged = Buffer.concat([await readFile(target), Buffer.from("\n// not this patch implementation\n")]);
  await writeFile(target, forged);
  const receipt = JSON.parse(await readFile(receiptPath(f.root), "utf8"));
  receipt.files.find((file) => file.file === edit.file).patched = hash(forged);
  await writeFile(receiptPath(f.root), JSON.stringify(receipt));
  await refusesInspectionAndActions(f, /does not match this patch implementation/);
});

test("chat-final-text: missing and duplicate anchors", async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.directory, true);
  for (const edit of edits) {
    const original = f.originals.get(edit.file).toString("utf8");
    for (const [index, { before: anchor }] of edit.replacements.entries()) {
      assert.equal(original.split(anchor).length - 1, 1, `${edit.file} anchor ${index}`);
      assert.throws(() => transform(original.replace(anchor, ""), edit), /one patch anchor/);
      assert.throws(() => transform(original.replace(anchor, () => anchor + anchor), edit), /one patch anchor/);
    }
  }
  assert.deepEqual(await snapshot(f.directory, true), before);
});

test("chat-final-text: live locks", async (t) => {
  for (const action of ["apply", "restore"]) {
    await t.test(action, async (t) => {
      const f = await fixture(t);
      if (action === "restore") await mutate(f.root, "apply");
      await writeFile(lockPath(f.root), JSON.stringify({ pid: process.pid, hostname: hostname(), patchId: PATCH_ID }));
      const before = await snapshot(f.directory, true);
      assertSummary(await patchHost(f.root), action === "apply" ? "unpatched" : "applied");
      assert.deepEqual(await snapshot(f.directory, true), before);
      await rejectsUnchanged(f, () => mutate(f.root, action), /lock exists/);
      await rejectsUnchanged(f, () => mutate(f.root, action, { recoverStaleLock: true }), /still alive/);
    });
  }
});

test("chat-final-text: stale locks", async (t) => {
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore", timeout: 10_000 });
  assert.equal(child.status, 0, child.error?.message);
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
  for (const action of ["apply", "restore"]) {
    await t.test(action, async (t) => {
      const f = await fixture(t);
      if (action === "restore") await mutate(f.root, "apply");
      const owner = Buffer.from(JSON.stringify({ pid: child.pid, hostname: hostname(), patchId: PATCH_ID }));
      await writeFile(lockPath(f.root), owner);
      await rejectsUnchanged(f, () => mutate(f.root, action), /lock exists/);
      assertSummary(await mutate(f.root, action, { recoverStaleLock: true }),
        action === "apply" ? "applied" : "unpatched");
      await assertTargets(f, action === "apply");
      await assertBackups(f);
      const stale = (await readdir(f.root)).filter((name) => name.startsWith(`${stateName}.lock.stale-`));
      assert.equal(stale.length, 1);
      assert.deepEqual(await readFile(join(f.root, stale[0])), owner);
      await assert.rejects(lstat(lockPath(f.root)), { code: "ENOENT" });
      await assert.rejects(lstat(`${lockPath(f.root)}.recovery`), { code: "ENOENT" });
    });
  }
});

test("chat-final-text: unverifiable lock owners", async (t) => {
  for (const [name, overrides] of [
    ["foreign patch", { patchId: "foreign-patch" }],
    ["foreign host", { hostname: `${hostname()}-other` }],
    ["invalid pid", { pid: 0 }],
  ]) {
    await t.test(name, async (t) => {
      const f = await fixture(t);
      await writeFile(lockPath(f.root), JSON.stringify({
        pid: process.pid, hostname: hostname(), patchId: PATCH_ID, ...overrides,
      }));
      await rejectsUnchanged(f, () => mutate(f.root, "apply", { recoverStaleLock: true }), /Cannot establish/);
    });
  }
});

test("chat-final-text: linked path defenses", async (t) => {
  const cases = [
    { name: "package symlink", path: (f) => join(f.root, "package.json") },
    { name: "target symlink", path: (f) => targetPath(f.root, edits.at(-1)) },
    { name: "target hard link", path: (f) => targetPath(f.root, edits.at(-1)), hard: true },
    { name: "target directory junction", path: (f) => join(f.root, "dist"), directory: true, escapes: true },
    { name: "state directory junction", path: (f) => join(f.root, stateName), directory: true, state: true },
    { name: "backup symlink", path: (f) => backupPath(f.root, edits.at(-1)), applied: true },
    { name: "backup directory junction", path: (f) => dirname(backupPath(f.root, edits[0])),
      directory: true, applied: true, escapes: true },
    { name: "backup directory junction before apply", path: (f) => dirname(backupPath(f.root, edits[0])),
      directory: true, beforeApply: true },
    { name: "lock symlink", path: (f) => lockPath(f.root), lock: true },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (t) => {
      const f = await fixture(t);
      if (entry.applied) await mutate(f.root, "apply");
      if (entry.state || entry.beforeApply) await mkdir(entry.path(f), { recursive: true });
      if (entry.lock) {
        await writeFile(lockPath(f.root), JSON.stringify({
          pid: process.pid, hostname: hostname(), patchId: PATCH_ID,
        }));
      }
      const path = entry.path(f);
      const outside = join(f.directory, "outside");
      await cp(path, outside, { recursive: Boolean(entry.directory) });
      await rm(path, { recursive: Boolean(entry.directory) });
      try {
        if (entry.hard) await link(outside, path);
        else await symlink(outside, path, entry.directory ? (process.platform === "win32" ? "junction" : "dir") : "file");
      } catch (error) {
        if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(error.code)) throw error;
        t.skip(`Link creation is unavailable: ${error.code}`);
        return;
      }
      const expected = entry.escapes ? /escapes the selected OpenClaw installation/
        : entry.directory ? /not a real directory/ : /regular, unlinked file/;
      if (entry.beforeApply) {
        await rejectsUnchanged(f, () => mutate(f.root, "apply"), expected);
        await assertTargets(f, false);
      } else if (entry.lock) {
        await rejectsUnchanged(f, () => mutate(f.root, "apply"), /lock exists/);
        await rejectsUnchanged(f, () => mutate(f.root, "apply", { recoverStaleLock: true }), expected);
      } else {
        await refusesInspectionAndActions(f, expected);
      }
    });
  }
});
