import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { edits, HOST_VERSION, PATCH_ID, SOURCE_COMMIT, transform } from "./spec.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stateName = ".dsh-agent-harness-patch";

async function regularFile(root, path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`Patch target must be a regular, unlinked file: ${path}`);
  }
  const resolved = await realpath(path);
  const fromRoot = relative(root, resolved);
  if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new Error("Patch target escapes the selected OpenClaw installation.");
  }
  return info;
}

async function atomicWrite(path, contents, mode = 0o600) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx", mode);
    try { await file.writeFile(contents); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

async function directoryWithin(root, path, create = false) {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Patch directory escapes its installation.");
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Patch directory is not a real directory: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!create) return false;
      await mkdir(current, { mode: 0o700 });
    }
  }
  return true;
}

async function receiptAt(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function validateReceipt(receipt) {
  if (receipt?.patchId !== PATCH_ID || receipt?.hostVersion !== HOST_VERSION ||
      receipt?.sourceCommit !== SOURCE_COMMIT || !Array.isArray(receipt.files) ||
      receipt.files.length !== edits.length ||
      !receipt.files.every((file, i) => file.file === edits[i].file && file.original === edits[i].sha256 &&
        /^[a-f0-9]{64}$/.test(file.patched) && Number.isInteger(file.mode))) {
    throw new Error("Invalid host-patch receipt; refusing to overwrite or restore host files.");
  }
}

async function acquireLock(root, recoverStaleLock) {
  const path = join(root, `${stateName}.lock`);
  try { return await open(path, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!recoverStaleLock) throw new Error("A patch lock exists. Inspect its owner; use --recover-stale-lock only after it exits.");
  }
  const recoveryPath = `${path}.recovery`;
  const recovery = await open(recoveryPath, "wx", 0o600);
  try {
    await recovery.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), patchId: PATCH_ID }));
    await regularFile(root, path);
    const bytes = await readFile(path);
    const owner = JSON.parse(bytes.toString("utf8"));
    if (owner.patchId !== PATCH_ID || owner.hostname !== hostname() ||
        !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
      throw new Error("Cannot establish the stale patch lock's owner on this machine.");
    }
    let alive = true;
    try { process.kill(owner.pid, 0); }
    catch (error) {
      if (error.code !== "ESRCH") throw new Error("Cannot establish whether the patch owner is alive.", { cause: error });
      alive = false;
    }
    if (alive) throw new Error("The patch lock owner is still alive; refusing recovery.");
    if (hash(await readFile(path)) !== hash(bytes)) throw new Error("Patch lock changed during recovery.");
    // Preserve the old owner record. A concurrent normal acquisition can win
    // after rename; wx then refuses to steal its new lock.
    await rename(path, `${path}.stale-${randomUUID()}`);
    return await open(path, "wx", 0o600);
  } finally {
    await recovery.close();
    await rm(recoveryPath, { force: true });
  }
}

export async function inspectHost(rootPath) {
  const root = await realpath(rootPath);
  const packagePath = join(root, "package.json");
  await regularFile(root, packagePath);
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  if (pkg.name !== "openclaw" || pkg.version !== HOST_VERSION) {
    throw new Error(`This patch requires the exact OpenClaw ${HOST_VERSION} release.`);
  }
  const state = join(root, stateName);
  await directoryWithin(root, state);
  const receipt = await receiptAt(join(state, "receipt.json"));
  if (receipt) validateReceipt(receipt);
  const files = [];
  for (const edit of edits) {
    const path = join(root, ...edit.file.split("/"));
    const info = await regularFile(root, path);
    const contents = await readFile(path);
    const currentHash = hash(contents);
    if (currentHash === edit.sha256) {
      const patched = Buffer.from(transform(contents.toString("utf8"), edit));
      files.push({ ...edit, path, contents, patched, mode: info.mode & 0o777, current: "original" });
    } else {
      const recorded = receipt?.files.find((file) => file.file === edit.file);
      if (!recorded || recorded.patched !== currentHash) {
        throw new Error(`Host file has an unsupported build or local changes: ${edit.file}`);
      }
      const backupPath = join(state, ...edit.file.split("/"));
      await regularFile(root, backupPath);
      const original = await readFile(backupPath);
      if (hash(original) !== edit.sha256) throw new Error(`Original backup is corrupt: ${edit.file}`);
      const expected = Buffer.from(transform(original.toString("utf8"), edit));
      if (hash(expected) !== currentHash) throw new Error(`Patched file does not match this patch implementation: ${edit.file}`);
      files.push({ ...edit, path, contents: original, patched: contents, mode: recorded.mode, current: "patched" });
    }
  }
  return { root, state, receipt, files };
}

export async function patchHost(rootPath, { action = "check", offlineConfirmed = false, recoverStaleLock = false } = {}) {
  if (!["check", "apply", "restore"].includes(action)) throw new Error("Unknown host patch action.");
  if (action !== "check" && !offlineConfirmed) {
    throw new Error("Stop this installation's Gateway first, then pass --offline-confirmed. This tool never restarts it.");
  }
  const inspected = await inspectHost(rootPath);
  const { root, state, files } = inspected;
  const summary = () => ({
    patchId: PATCH_ID, hostVersion: HOST_VERSION, sourceCommit: SOURCE_COMMIT,
    status: files.every((file) => file.current === "patched") ? "applied"
      : files.every((file) => file.current === "original") ? "unpatched" : "partial",
    files: files.map((file) => ({ file: file.file, state: file.current })),
    restartPerformed: false,
  });
  if (action === "check") return summary();
  if (action === "restore" && !inspected.receipt) {
    if (files.every((file) => file.current === "original")) return summary();
    throw new Error("Cannot restore without an original receipt.");
  }
  if (action === "apply" && files.every((file) => file.current === "patched")) return summary();
  const lock = await acquireLock(root, recoverStaleLock);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), patchId: PATCH_ID, action }));
    // Recheck after owning the lock; another installer may have changed the tree.
    for (const file of files) {
      const current = await readFile(file.path);
      if (hash(current) !== hash(file.current === "patched" ? file.patched : file.contents)) {
        throw new Error(`Host changed while preparing patch: ${file.file}`);
      }
    }
    await directoryWithin(root, state, true);
    if (action === "apply") {
      for (const file of files) {
        const backup = join(state, ...file.file.split("/"));
        await directoryWithin(root, dirname(backup), true);
        try {
          const fd = await open(backup, "wx", 0o600);
          try { await fd.writeFile(file.contents); await fd.sync(); }
          finally { await fd.close(); }
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          await regularFile(root, backup);
          if (hash(await readFile(backup)) !== file.sha256) throw new Error(`Existing patch backup differs: ${file.file}`);
        }
      }
      await atomicWrite(join(state, "receipt.json"), JSON.stringify({
        patchId: PATCH_ID, hostVersion: HOST_VERSION, sourceCommit: SOURCE_COMMIT,
        status: "applying", files: files.map((file) => ({
          file: file.file, original: file.sha256, patched: hash(file.patched), mode: file.mode,
        })),
      }, null, 2));
    }
    for (const file of files) {
      await atomicWrite(file.path, action === "apply" ? file.patched : file.contents, file.mode);
      file.current = action === "apply" ? "patched" : "original";
    }
    const receipt = await receiptAt(join(state, "receipt.json"));
    await atomicWrite(join(state, "receipt.json"), JSON.stringify({
      ...receipt, status: action === "apply" ? "applied" : "restored",
    }, null, 2));
    return summary();
  } finally {
    await lock.close();
    await rm(join(root, `${stateName}.lock`), { force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === await realpath(process.argv[1])) {
  const args = process.argv.slice(2);
  const actions = args.filter((arg) => ["--check", "--apply", "--restore"].includes(arg));
  const rootFlag = args.indexOf("--root");
  const allowed = new Set(["--check", "--apply", "--restore", "--root", "--offline-confirmed", "--recover-stale-lock"]);
  if (actions.length > 1 || rootFlag < 0 || !args[rootFlag + 1] ||
      args.some((arg, index) => index !== rootFlag + 1 && !allowed.has(arg))) {
    console.error("Usage: node host-patch/apply.mjs --root <OpenClaw package directory> --check|--apply|--restore [--offline-confirmed] [--recover-stale-lock]");
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await patchHost(args[rootFlag + 1], {
        action: actions[0]?.slice(2) ?? "check",
        offlineConfirmed: args.includes("--offline-confirmed"),
        recoverStaleLock: args.includes("--recover-stale-lock"),
      }), null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
