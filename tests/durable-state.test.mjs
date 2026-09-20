import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import ts from "typescript";
import { join, resolve } from "node:path";

const directory = resolve("artifacts", "mock-durable-state");
const stateFile = join(directory, "state.json");
const tempFile = join(directory, ".state.json.4242.uuid.tmp");
const ownerFile = join(directory, "owner.lock");

const sourceModules = new Map([[
  new URL("../dist/durable-state.js", import.meta.url).href,
  new URL("../src/durable-state.ts", import.meta.url),
]]);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const url = context.parentURL && new URL(specifier, context.parentURL).href;
    return sourceModules.has(url) ? { url, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return sourceModules.has(url) ? {
      format: "module",
      shortCircuit: true,
      source: ts.transpileModule(readFileSync(sourceModules.get(url), "utf8"),
        { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText,
    } : next(url, context);
  },
});
const { createDurableStateIO } = await import("../dist/durable-state.js");
hooks.deregister();

function errno(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class MockHandle {
  constructor(path, events, options = {}) {
    this.path = path;
    this.events = events;
    this.options = options;
    this.content = "";
    this.closed = false;
    this.statValue = options.statValue ?? { dev: 1, ino: Math.floor(Math.random() * 10000) + 1, size: 0 };
  }
  async writeFile(data) {
    this.events.push(["writeFile", this.path, String(data)]);
    if (this.options.writeFileError) throw this.options.writeFileError;
    this.content = String(data);
    this.statValue = { ...this.statValue, size: Buffer.byteLength(this.content) };
  }
  async sync() {
    this.events.push(["sync", this.path]);
    if (this.options.syncError) throw this.options.syncError;
  }
  async close() {
    this.events.push(["close", this.path]);
    this.closed = true;
    if (this.options.closeError) throw this.options.closeError;
  }
  async stat() {
    this.events.push(["fstat", this.path]);
    return this.statValue;
  }
}

function createMockDeps(options = {}) {
  const events = [];
  const handles = new Map();
  const files = new Map(Object.entries(options.files ?? {}));
  const stats = new Map(Object.entries(options.stats ?? {}));
  const warnings = [];
  const deps = {
    platform: options.platform ?? "linux",
    pid: 4242,
    processStart: "test-start",
    hostname: () => "test-host",
    randomUUID: () => options.uuid ?? "uuid",
    now: () => new Date("2026-09-20T00:00:00.000Z"),
    emitWarning: (warning, warningOptions) => warnings.push({ warning: String(warning), options: warningOptions }),
    constants: { O_DIRECTORY: 0x10000 },
    async open(path, flags, mode) {
      events.push(["open", path, flags, mode]);
      const queued = options.openErrors?.[path]?.shift?.();
      if (queued) throw queued;
      if (flags === "wx" && files.has(path)) throw errno("EEXIST");
      const handle = new MockHandle(path, events, options.handleOptions?.[path]);
      handles.set(path, handle);
      return handle;
    },
    async readFile(path) {
      events.push(["readFile", path]);
      if (options.readFileErrors?.[path]) throw options.readFileErrors[path];
      if (!files.has(path)) throw errno("ENOENT");
      return files.get(path);
    },
    async rename(from, to) {
      events.push(["rename", from, to]);
      if (options.renameError) throw options.renameError;
      files.set(to, handles.get(from)?.content ?? files.get(from));
      files.delete(from);
    },
    async stat(path) {
      events.push(["stat", path]);
      if (options.statError) throw options.statError;
      return stats.get(path) ?? handles.get(path)?.statValue ?? { dev: 1, ino: 7, size: Buffer.byteLength(files.get(path) ?? "") };
    },
    async unlink(path) {
      events.push(["unlink", path]);
      if (options.unlinkError) throw options.unlinkError;
      files.delete(path);
    },
  };
  return { deps, events, handles, files, stats, warnings };
}

test("writeDurableJson writes an exclusive 0600 temp file, fsyncs it, renames, then syncs the parent directory", async () => {
  const { deps, events, files } = createMockDeps();
  const io = createDurableStateIO(deps);
  await io.writeDurableJson(stateFile, { ok: true });

  assert.equal(files.get(stateFile), "{\"ok\":true}\n");
  assert.deepEqual(events, [
    ["open", tempFile, "wx", 0o600],
    ["writeFile", tempFile, "{\"ok\":true}\n"],
    ["sync", tempFile],
    ["close", tempFile],
    ["rename", tempFile, stateFile],
    ["open", directory, 0x10000, 0o600],
    ["sync", directory],
    ["close", directory],
  ]);
});

test("writeDurableJson preserves the primary failure and temp evidence when cleanup also fails", async () => {
  const primary = new Error("disk write failed");
  const cleanup = new Error("close failed");
  const temp = tempFile;
  const { deps, events } = createMockDeps({ handleOptions: { [temp]: { writeFileError: primary, closeError: cleanup } } });
  const io = createDurableStateIO(deps);

  await assert.rejects(() => io.writeDurableJson(stateFile, { ok: true }), primary);
  assert.equal(events.some((event) => event[0] === "rename"), false);
  assert.equal(events.some((event) => event[0] === "unlink"), false);
});

test("rename failure retains the previous binding and cannot advertise the candidate as committed", async () => {
  const previous = '{"status":"ready","lastRunId":"previous"}';
  const f = createMockDeps({ files: { [stateFile]: previous }, renameError: errno("ENOSPC") });
  await assert.rejects(createDurableStateIO(f.deps).writeDurableJson(stateFile,
    { status: "running", lastRunId: "candidate" }), /ENOSPC/);
  assert.equal(f.files.get(stateFile), previous);
  assert.equal(f.events.some(([operation]) => operation === "unlink"), false);
});

test("parent sync failure after rename is reported, never converted to durable success", async () => {
  const f = createMockDeps({ handleOptions: { [directory]: { syncError: errno("EIO") } } });
  await assert.rejects(createDurableStateIO(f.deps).writeDurableJson(stateFile, { status: "running" }), /EIO/);
  assert.equal(JSON.parse(f.files.get(stateFile)).status, "running");
});

test("syncParentDirectory rethrows real Linux I/O errors but warns once for known Windows directory fsync limits", async () => {
  const linux = createMockDeps({ openErrors: { [directory]: [errno("ENOSPC")] } });
  await assert.rejects(() => createDurableStateIO(linux.deps).syncParentDirectory(stateFile), /ENOSPC/);

  const windows = createMockDeps({ platform: "win32", openErrors: { [directory]: [errno("EPERM"), errno("EPERM")] } });
  const io = createDurableStateIO(windows.deps);
  await io.syncParentDirectory(join(directory, "one.json"));
  await io.syncParentDirectory(join(directory, "two.json"));
  assert.equal(windows.warnings.length, 1);
  assert.equal(windows.warnings[0].options.code, "DSH_DURABLE_STATE_DIR_FSYNC_UNSUPPORTED");
  assert.match(windows.warnings[0].warning, /not power-loss certified/);
});

test("createDurableOwnership creates a sanitized exclusive owner lock and surfaces existing owners", async () => {
  const existing = JSON.stringify({ pid: 7, runId: "other", operation: "run" });
  const locked = createMockDeps({ files: { [ownerFile]: existing } });
  const lockedIO = createDurableStateIO(locked.deps);
  await assert.rejects(
    () => lockedIO.createDurableOwnership(ownerFile, { runId: "run", operation: "run", stateKey: "secret-workspace-path" }),
    (error) => error.code === "ELOCKED" && error.existingOwner.runId === "other",
  );

  const created = createMockDeps();
  const io = createDurableStateIO(created.deps);
  const owner = await io.createDurableOwnership(ownerFile,
    { runId: "run-1", operation: "compact", stateKey: "secret-workspace-path" });
  const record = JSON.parse(created.handles.get(ownerFile).content);
  assert.equal(record.runId, "run-1");
  assert.equal(record.operation, "compact");
  assert.equal(record.pid, 4242);
  assert.equal(record.hostname, "test-host");
  assert.equal(record.processStart, "test-start");
  assert.equal(record.stateKey, undefined);
  assert.match(record.stateKeySha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(owner.identity, record);
});

test("createDurableOwnership leaves a created lock for inspection when later durability fails", async () => {
  const dir = directory;
  const { deps, events } = createMockDeps({ openErrors: { [dir]: [errno("EIO")] } });
  const io = createDurableStateIO(deps);

  await assert.rejects(() => io.createDurableOwnership(ownerFile,
    { runId: "run", stateKey: "state" }), /EIO/);
  assert.equal(events.some((event) => event[0] === "unlink"), false);
});

test("ownership release removes only the same owner file and syncs the parent directory", async () => {
  const path = ownerFile;
  const fixture = createMockDeps();
  const io = createDurableStateIO(fixture.deps);
  const owner = await io.createDurableOwnership(path, { runId: "run", operation: "run", stateKey: "state" });
  fixture.files.set(path, JSON.stringify(owner.identity));
  fixture.stats.set(path, fixture.handles.get(path).statValue);

  await owner.release();
  assert.deepEqual(fixture.events.slice(-7), [
    ["stat", path],
    ["sync", path],
    ["close", path],
    ["unlink", path],
    ["open", directory, 0x10000, 0o600],
    ["sync", directory],
    ["close", directory],
  ]);
  assert.equal(fixture.files.has(path), false);
});

test("ownership release refuses to delete a foreign or rewritten lock", async () => {
  const path = ownerFile;
  const fixture = createMockDeps();
  const io = createDurableStateIO(fixture.deps);
  const owner = await io.createDurableOwnership(path, { runId: "run", stateKey: "state" });
  fixture.files.set(path, JSON.stringify({ ...owner.identity, runId: "other" }));
  fixture.stats.set(path, fixture.handles.get(path).statValue);

  await assert.rejects(() => owner.release(), /foreign owner/);
  assert.equal(fixture.events.some((event) => event[0] === "unlink"), false);
});
