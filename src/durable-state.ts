import { constants } from "node:fs";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { readFileSync } from "node:fs";

export type DurableOwnershipOperation = "run" | "compact";

export interface DurableOwnershipOwner {
  runId: string;
  operation?: DurableOwnershipOperation;
  stateKey: string;
}

export interface DurableOwnershipIdentity {
  version: 1;
  pid: number;
  hostname: string;
  processInstance: string;
  processStart: string;
  createdAt: string;
  runId: string;
  operation?: DurableOwnershipOperation;
  stateKeySha256: string;
}

export interface DurableOwnership {
  handle: FileHandle;
  release: () => Promise<void>;
  identity: DurableOwnershipIdentity;
}

interface FileStatLike {
  dev?: number;
  ino?: number;
  size?: number;
}

interface DurableFileHandle {
  writeFile(data: string | Uint8Array, options?: { encoding?: BufferEncoding }): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
  stat(): Promise<FileStatLike>;
}

interface DurableStateDeps {
  open?: typeof open;
  readFile?: typeof readFile;
  rename?: typeof rename;
  stat?: typeof stat;
  unlink?: typeof unlink;
  constants?: Pick<typeof constants, "O_DIRECTORY">;
  platform?: NodeJS.Platform;
  pid?: number;
  hostname?: () => string;
  randomUUID?: () => string;
  now?: () => Date;
  emitWarning?: (warning: string | Error, options?: { code?: string; type?: string }) => void;
  processStart?: string;
}

interface DurableStateIO {
  writeDurableJson(path: string, value: unknown): Promise<void>;
  syncParentDirectory(path: string): Promise<void>;
  createDurableOwnership(path: string, owner: DurableOwnershipOwner): Promise<DurableOwnership>;
}

const PROCESS_INSTANCE = randomUUID();
const PROCESS_START = resolveProcessStart();
let warnedWindowsDirectoryFsyncUnsupported = false;

function resolveProcessStart(): string {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync("/proc/self/stat", "utf8");
      const statFields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      const startTicks = statFields[19];
      if (startTicks) return `linux-startticks:${startTicks}`;
    } catch (error) {
      process.emitWarning("Linux process start ticks unavailable; ownership uses process-start timestamp and instance identity.",
        { code: "DSH_PROCESS_START_FALLBACK" });
    }
  }
  return `started-at:${new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString()}`;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function isKnownWindowsDirectoryFsyncUnsupported(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOTSUP" || code === "EINVAL" || code === "EISDIR" || code === "EPERM";
}

function warnWindowsDirectoryFsyncUnsupported(deps: RequiredDeps): void {
  if (warnedWindowsDirectoryFsyncUnsupported) return;
  warnedWindowsDirectoryFsyncUnsupported = true;
  deps.emitWarning(
    "Directory fsync is not supported by this Windows filesystem; rename durability is not power-loss certified.",
    { code: "DSH_DURABLE_STATE_DIR_FSYNC_UNSUPPORTED", type: "DurableStateWarning" },
  );
}

function stateKeySha256(stateKey: string): string {
  return createHash("sha256").update(stateKey, "utf8").digest("hex");
}

function encodeJsonLine(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("Durable JSON value must be serializable as a top-level JSON value.");
  }
  return `${encoded}\n`;
}

type RequiredDeps = Required<Omit<DurableStateDeps, "constants">> & { constants: Pick<typeof constants, "O_DIRECTORY"> };

function resolveDeps(deps: DurableStateDeps = {}): RequiredDeps {
  return {
    open: deps.open ?? open,
    readFile: deps.readFile ?? readFile,
    rename: deps.rename ?? rename,
    stat: deps.stat ?? stat,
    unlink: deps.unlink ?? unlink,
    constants: deps.constants ?? constants,
    platform: deps.platform ?? process.platform,
    pid: deps.pid ?? process.pid,
    hostname: deps.hostname ?? hostname,
    randomUUID: deps.randomUUID ?? randomUUID,
    now: deps.now ?? (() => new Date()),
    emitWarning: deps.emitWarning ?? ((warning, options) => process.emitWarning(warning, options)),
    processStart: deps.processStart ?? PROCESS_START,
  };
}

function sameFile(owned: FileStatLike, current: FileStatLike): boolean {
  if (typeof owned.dev === "number" && typeof owned.ino === "number"
    && typeof current.dev === "number" && typeof current.ino === "number"
    && (owned.ino !== 0 || current.ino !== 0)) {
    return owned.dev === current.dev && owned.ino === current.ino;
  }
  return typeof owned.size !== "number" || typeof current.size !== "number" || owned.size === current.size;
}

function sameIdentity(a: DurableOwnershipIdentity, b: unknown): boolean {
  if (!b || typeof b !== "object") return false;
  const record = b as Partial<DurableOwnershipIdentity>;
  return record.version === a.version
    && record.pid === a.pid
    && record.hostname === a.hostname
    && record.processInstance === a.processInstance
    && record.processStart === a.processStart
    && record.createdAt === a.createdAt
    && record.runId === a.runId
    && record.operation === a.operation
    && record.stateKeySha256 === a.stateKeySha256;
}

function lockedError(existing: unknown): Error {
  const error = new Error("Durable ownership lock already exists; another run may own this state. Verify the recorded owner is stale before removing the lock.");
  (error as NodeJS.ErrnoException).code = "ELOCKED";
  if (existing && typeof existing === "object") {
    const record = existing as Record<string, unknown>;
    (error as Error & { existingOwner?: unknown }).existingOwner = {
      pid: record.pid,
      runId: record.runId,
      operation: record.operation,
      createdAt: record.createdAt,
      stateKeySha256: record.stateKeySha256,
    };
  }
  return error;
}

export function createDurableStateIO(depsInput: DurableStateDeps = {}): DurableStateIO {
  const deps = resolveDeps(depsInput);
  let warnedForThisIO = false;

  async function syncParentDirectory(targetPath: string): Promise<void> {
    const parent = dirname(targetPath);
    let handle: DurableFileHandle | undefined;
    let failure: unknown;
    let unsupportedDirectoryFsync = false;
    try {
      handle = await deps.open(parent, deps.constants.O_DIRECTORY ? constants.O_RDONLY | deps.constants.O_DIRECTORY : "r", 0o600);
      await handle.sync();
    } catch (error) {
      if (deps.platform === "win32" && isKnownWindowsDirectoryFsyncUnsupported(error)) {
        if (!warnedForThisIO) {
          warnedForThisIO = true;
          warnWindowsDirectoryFsyncUnsupported(deps);
        }
        unsupportedDirectoryFsync = true;
      } else {
        failure = error;
      }
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch (error) {
          if (!failure && (!unsupportedDirectoryFsync || !isKnownWindowsDirectoryFsyncUnsupported(error))) {
            failure = error;
          }
        }
      }
    }
    if (failure) throw failure;
  }

  async function writeDurableJson(targetPath: string, value: unknown): Promise<void> {
    const json = encodeJsonLine(value);
    const tempPath = join(dirname(targetPath), `.${basename(targetPath)}.${deps.pid}.${deps.randomUUID()}.tmp`);
    let handle: DurableFileHandle | undefined;
    try {
      handle = await deps.open(tempPath, "wx", 0o600);
      await handle.writeFile(json, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await deps.rename(tempPath, targetPath);
      await syncParentDirectory(targetPath);
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Preserve the primary failure and leave the temp file as operator evidence.
        }
      }
      throw error;
    }
  }

  async function createDurableOwnership(targetPath: string, owner: DurableOwnershipOwner): Promise<DurableOwnership> {
    const identity: DurableOwnershipIdentity = {
      version: 1,
      pid: deps.pid,
      hostname: deps.hostname(),
      processInstance: PROCESS_INSTANCE,
      processStart: deps.processStart,
      createdAt: deps.now().toISOString(),
      runId: owner.runId,
      operation: owner.operation,
      stateKeySha256: stateKeySha256(owner.stateKey),
    };

    let handle: DurableFileHandle;
    try {
      handle = await deps.open(targetPath, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      let existing: unknown;
      try {
        existing = JSON.parse(String(await deps.readFile(targetPath, "utf8")));
      } catch {
        existing = undefined;
      }
      throw lockedError(existing);
    }

    try {
      await handle.writeFile(`${JSON.stringify(identity)}\n`, { encoding: "utf8" });
      await handle.sync();
      const ownedStat = await handle.stat();
      await syncParentDirectory(targetPath);
      let released = false;
      const release = async (): Promise<void> => {
        if (released) throw new Error("Durable ownership lock has already been released.");
        const [currentContent, currentStat] = await Promise.all([
          deps.readFile(targetPath, "utf8"),
          deps.stat(targetPath),
        ]);
        let currentIdentity: unknown;
        try {
          currentIdentity = JSON.parse(String(currentContent));
        } catch {
          throw new Error("Durable ownership lock changed and is no longer valid JSON; refusing to remove it.");
        }
        if (!sameIdentity(identity, currentIdentity) || !sameFile(ownedStat, currentStat)) {
          throw new Error("Durable ownership lock no longer matches this process; refusing to remove a foreign owner.");
        }
        await handle.sync();
        await handle.close();
        await deps.unlink(targetPath);
        await syncParentDirectory(targetPath);
        released = true;
      };
      return { handle: handle as FileHandle, release, identity };
    } catch (error) {
      try {
        await handle.close();
      } catch {
        // Preserve the creation failure and leave the lock for operator inspection.
      }
      throw error;
    }
  }

  return { writeDurableJson, syncParentDirectory, createDurableOwnership };
}

const defaultIO = createDurableStateIO();

export const writeDurableJson = defaultIO.writeDurableJson;
export const syncParentDirectory = defaultIO.syncParentDirectory;
export const createDurableOwnership = defaultIO.createDurableOwnership;
