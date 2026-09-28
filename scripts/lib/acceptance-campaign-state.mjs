import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

export class CampaignError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "CampaignError";
    this.code = code;
  }
}

export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const jsonBytes = (value) => `${JSON.stringify(value)}\n`;
export const identityValid = (value) => Number.isSafeInteger(value?.pid) && value.pid > 0 &&
  typeof value.startId === "string" && value.startId.length > 0;
const canonical = (path) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

export async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export async function assertRealPath(path, directory = false, privateFile = false) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile()) ||
      canonical(await realpath(path)) !== canonical(path) || (!directory && info.nlink !== 1)) {
    throw new CampaignError("unsafe-path");
  }
  if (privateFile && process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new CampaignError("private-permissions-required");
  }
  return info;
}

export async function readBytes(path, privateFile = false) {
  const before = await assertRealPath(path, false, privateFile);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev) throw new CampaignError("file-changed");
    const bytes = await file.readFile();
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== before.size) {
      throw new CampaignError("file-changed");
    }
    await assertRealPath(path, false, privateFile);
    return bytes;
  } finally { await file.close(); }
}

export async function readJson(path, privateFile = false) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBytes(path, privateFile)));
}

export async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    // Windows offers file FlushFileBuffers, but not a portable directory fsync or POSIX ACLs.
    if (process.platform !== "win32" ||
        !["EPERM", "EACCES", "EISDIR", "EINVAL", "ENOTSUP"].includes(error.code)) throw error;
  } finally { await handle?.close(); }
}

export async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700 });
  await assertRealPath(path, true, true);
  await syncDirectory(dirname(path));
}

export async function immutable(path, value) {
  await assertRealPath(dirname(path), true, true);
  const bytes = jsonBytes(value);
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
  await syncDirectory(dirname(path));
  return { path, sha256: hash(bytes) };
}

async function snapshot(path, value) {
  const pending = join(dirname(path), `.snapshot-${randomUUID()}`);
  await immutable(pending, value);
  for (let attempt = 0; ; attempt++) {
    try { await rename(pending, path); break; }
    catch (error) {
      // A Windows reader/virus scanner can briefly deny replace. Never unlink the old snapshot.
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) ||
          attempt >= 5) throw error;
      await delay(10 * 2 ** attempt);
    }
  }
  await syncDirectory(dirname(path));
}

export async function readJournal(root) {
  const bytes = await readBytes(join(root, "controller.jsonl"), true);
  if (bytes.length && bytes.at(-1) !== 10) throw new CampaignError("journal-torn");
  const rows = bytes.length ? bytes.toString("utf8").slice(0, -1).split("\n").map((line) => JSON.parse(line)) : [];
  let previous = null;
  for (const [seq, row] of rows.entries()) {
    const { sha256, ...body } = row;
    if (body.seq !== seq || body.previous !== previous || hash(JSON.stringify(body)) !== sha256) {
      throw new CampaignError("journal-corrupt");
    }
    previous = sha256;
  }
  return rows;
}

export async function createJournal(root) {
  const handle = await open(join(root, "controller.jsonl"), "wx", 0o600);
  try { await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(root);
}

export async function journalWriter(root, owner, assertOwner) {
  let rows = await readJournal(root);
  let tail = Promise.resolve();
  let failure;
  const serialize = (action) => {
    const next = tail.then(async () => {
      if (failure) throw failure;
      try { await assertOwner(); return await action(); }
      catch (error) { failure = error; throw error; }
    });
    tail = next.catch(() => {});
    return next;
  };
  return {
    rows: () => structuredClone(rows),
    append(event, data = {}) {
      return serialize(async () => {
        const body = { seq: rows.length, previous: rows.at(-1)?.sha256 ?? null,
          at: new Date().toISOString(), owner, event, data };
        const row = { ...body, sha256: hash(JSON.stringify(body)) };
        const file = await open(join(root, "controller.jsonl"), constants.O_WRONLY | constants.O_APPEND |
          (constants.O_NOFOLLOW ?? 0));
        try { await file.writeFile(jsonBytes(row)); await file.sync(); }
        finally { await file.close(); }
        rows.push(row);
        return structuredClone(row);
      });
    },
    status(value) {
      return serialize(() => snapshot(join(root, "status.json"), {
        ...value, journalSequence: rows.length - 1, journalSha256: rows.at(-1)?.sha256 ?? null,
      }));
    },
    async flush() { await tail; if (failure) throw failure; },
  };
}

const exec = promisify(execFile);

/** OS creation identity, never a PID-exists approximation. Unsupported hosts fail closed. */
export async function processIdentity(pid = process.pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new CampaignError("invalid-pid");
  if (process.platform === "linux") {
    try {
      const proc = join(sep, "proc");
      const stat = await readFile(join(proc, String(pid), "stat"), "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z" || fields[0] === "X") return null;
      const boot = (await readFile(join(proc, "sys", "kernel", "random", "boot_id"), "utf8")).trim();
      if (!/^\d+$/.test(fields[19])) throw new CampaignError("process-identity-unavailable");
      return { pid, startId: `${boot}:${fields[19]}` };
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  if (process.platform === "win32") {
    const command = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
      "if ($null -eq $p) { 'gone' } else { $p.StartTime.ToUniversalTime().Ticks.ToString() }";
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
      { timeout: 10000, windowsHide: true });
    const start = stdout.trim();
    if (start === "gone") return null;
    if (!/^\d+$/.test(start)) throw new CampaignError("process-identity-unavailable");
    return { pid, startId: start };
  }
  throw new CampaignError("process-identity-unsupported");
}

export async function inspectProcess(identity, identify = processIdentity) {
  if (!identityValid(identity)) return "unknown";
  try {
    const current = await identify(identity.pid);
    if (current === null) return "gone";
    if (!identityValid(current) || current.pid !== identity.pid) return "unknown";
    return current.startId === identity.startId ? "alive" : "gone";
  } catch { return "unknown"; }
}
