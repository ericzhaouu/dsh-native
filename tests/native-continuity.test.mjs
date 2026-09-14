import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareNativeContinuity } from "../dist/native/continuity.js";
import { BRIDGE_VERSION, DSH_VERSION } from "../dist/protocol.js";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const previousRunId = "previous:run-1";
const recovery = /\/new\b/;
const assistant = (runId = previousRunId) => ({
  role: "assistant",
  content: [{ type: "text", text: "Retained native answer" }],
  idempotencyKey: `dsh-native:${runId}:assistant`,
  timestamp: 1,
});
const user = () => ({ role: "user", content: "Next request", timestamp: 2 });

function fixture(t) {
  const root = join(projectDir, "artifacts", `native-continuity-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = {
    stateDir: join(root, "state"),
    startupTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
    streamIdleTimeoutMs: 1000,
    allowedBaseUrls: [],
  };
  const p = {
    sessionId: `openclaw-session:${randomUUID()}`,
    sessionKey: "agent:main:continuity",
    runId: "current:run-2",
    workspaceDir: join(root, "workspace"),
  };
  const pathFor = (sessionId) => join(
    config.stateDir, createHash("sha256").update(sessionId).digest("hex"), "binding.json",
  );
  const bindingPath = pathFor(p.sessionId);
  const binding = (overrides = {}) => ({
    version: BRIDGE_VERSION,
    dshVersion: DSH_VERSION,
    sessionId: "private-native-session",
    workspaceDir: p.cwd ?? p.workspaceDir,
    status: "ready",
    lastRunId: previousRunId,
    consumedRunIds: [previousRunId],
    ...overrides,
  });
  const writeRaw = (text, path = bindingPath) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf8");
  };
  // Only the fixture simulates runtime writes; the guard must leave these bytes intact.
  const writeBinding = (overrides = {}) => writeRaw(`${JSON.stringify(binding(overrides), null, 2)}\n`);
  const prepare = (messages = [assistant(), user()]) => prepareNativeContinuity(config, p, messages);
  return { root, config, p, pathFor, bindingPath, binding, writeRaw, writeBinding, prepare };
}

for (const [name, messages] of [
  ["empty mirror", []],
  ["user-only mirror", [user()]],
]) {
  test(`first /new with ${name} allows missing state without creating runtime files`, (t) => {
    const f = fixture(t);
    const assertActive = f.prepare(messages);
    assert.equal(typeof assertActive, "function");
    assert.doesNotThrow(assertActive);
    assert.doesNotThrow(assertActive);
    assert.equal(existsSync(f.config.stateDir), false);
    assert.deepEqual(readdirSync(f.root), []);
  });
}

for (const directoryExists of [false, true]) {
  test(`retained DSH assistant rejects missing binding (${directoryExists ? "file" : "state directory"}) with /new`, (t) => {
    const f = fixture(t);
    if (directoryExists) mkdirSync(dirname(f.bindingPath), { recursive: true });
    assert.throws(() => f.prepare(), recovery);
    assert.equal(existsSync(f.bindingPath), false);
  });
}

test("matching ready binding uses the hashed OpenClaw session and remains read-only", (t) => {
  const f = fixture(t);
  f.writeBinding();
  assert.notEqual(f.p.sessionId, f.binding().sessionId);
  const before = readFileSync(f.bindingPath, "utf8");
  const files = readdirSync(f.root, { recursive: true }).sort();
  const assertActive = f.prepare();
  assert.doesNotThrow(assertActive);
  assert.doesNotThrow(assertActive);
  assert.equal(readFileSync(f.bindingPath, "utf8"), before);
  assert.deepEqual(readdirSync(f.root, { recursive: true }).sort(), files);
});

test("a binding for another OpenClaw session, native ID or session key cannot replace the missing binding", (t) => {
  const f = fixture(t);
  const text = JSON.stringify(f.binding());
  for (const sessionId of ["another-openclaw-session", f.binding().sessionId, f.p.sessionKey]) {
    f.writeRaw(text, f.pathFor(sessionId));
  }
  f.writeRaw(text, join(f.config.stateDir, "binding.json"));
  assert.throws(() => f.prepare(), recovery);
  assert.equal(existsSync(f.bindingPath), false);
});

test("the latest assistant determines continuity, ignoring older assistants and subsequent non-assistants", (t) => {
  const f = fixture(t);
  f.writeBinding();
  const assertActive = f.prepare([
    assistant("older-run"),
    assistant(),
    { role: "toolResult", content: [], idempotencyKey: "not-an-assistant" },
    user(),
  ]);
  assert.doesNotThrow(assertActive);
});

for (const [name, key] of [
  ["missing", undefined],
  ["null", null],
  ["non-string", 42],
  ["foreign runtime", "other:previous:run-1:assistant"],
  ["embedded prefix", "other:dsh-native:previous:run-1:assistant"],
  ["missing assistant suffix", "dsh-native:previous:run-1"],
  ["wrong role suffix", "dsh-native:previous:run-1:user"],
  ["trailing suffix data", "dsh-native:previous:run-1:assistant:extra"],
  ["empty run ID", "dsh-native::assistant"],
]) {
  test(`latest assistant with ${name} idempotency key rejects instead of using an older matching assistant`, (t) => {
    const f = fixture(t);
    f.writeBinding();
    assert.throws(() => f.prepare([
      assistant(), { ...assistant(), idempotencyKey: key }, user(),
    ]), recovery);
  });
}

const invalidBindings = [
  ["another branch's lastRunId", { lastRunId: "branched-run" }],
  ["missing lastRunId", { lastRunId: undefined }],
  ["non-string lastRunId", { lastRunId: 42 }],
  ["running previous run", { status: "running" }],
  ["blocked previous run", { status: "blocked" }],
  ["unknown status", { status: "unknown" }],
  ["missing status", { status: undefined }],
  ["incompatible bridge version", { version: BRIDGE_VERSION + 1 }],
  ["string bridge version", { version: String(BRIDGE_VERSION) }],
  ["missing bridge version", { version: undefined }],
  ["incompatible DSH version", { dshVersion: `${DSH_VERSION}-incompatible` }],
  ["missing DSH version", { dshVersion: undefined }],
  ["changed workspace", { workspaceDir: join(projectDir, "other-workspace") }],
  ["missing workspace", { workspaceDir: undefined }],
  ["empty native session ID", { sessionId: "" }],
  ["missing native session ID", { sessionId: undefined }],
  ["non-string native session ID", { sessionId: 42 }],
];

for (const [name, changes] of invalidBindings) {
  test(`preflight rejects ${name} with /new`, (t) => {
    const f = fixture(t);
    f.writeBinding(changes);
    const before = readFileSync(f.bindingPath, "utf8");
    assert.throws(() => f.prepare(), recovery);
    assert.equal(readFileSync(f.bindingPath, "utf8"), before);
  });

  test(`assertActive rejects ${name} introduced after preflight`, (t) => {
    const f = fixture(t);
    f.writeBinding();
    const assertActive = f.prepare();
    f.writeBinding(changes);
    assert.throws(assertActive, recovery);
  });
}

test("a retained previous assistant cannot preflight against an already-current ready binding", (t) => {
  const f = fixture(t);
  f.writeBinding({ lastRunId: f.p.runId });
  assert.throws(() => f.prepare(), recovery);
});

test("cwd takes precedence over workspaceDir when matching native state", (t) => {
  const f = fixture(t);
  f.p.cwd = join(f.root, "effective-cwd");
  f.writeBinding();
  const assertActive = f.prepare();
  assert.doesNotThrow(assertActive);
  f.writeBinding({ workspaceDir: f.p.workspaceDir });
  assert.throws(() => f.prepare(), recovery);
  assert.throws(assertActive, recovery);
});

test("null cwd falls back to workspaceDir", (t) => {
  const f = fixture(t);
  f.p.cwd = null;
  f.writeBinding();
  assert.doesNotThrow(f.prepare());
});

for (const [mirrorName, messages] of [["empty", []], ["user-only", [user()]]]) {
  for (const status of ["ready", "running", "blocked"]) {
    for (const current of [false, true]) {
      test(`cleared ${mirrorName} mirror cannot reuse existing ${status} ${current ? "current" : "previous"} binding`, (t) => {
        const f = fixture(t);
        f.writeBinding({ status, lastRunId: current ? f.p.runId : previousRunId });
        const before = readFileSync(f.bindingPath, "utf8");
        assert.throws(() => f.prepare(messages), recovery);
        assert.equal(readFileSync(f.bindingPath, "utf8"), before);
      });
    }
  }
}

test("removing the retained binding between preflight and assertActive fails", (t) => {
  const f = fixture(t);
  f.writeBinding();
  const assertActive = f.prepare();
  rmSync(f.bindingPath);
  assert.throws(assertActive, recovery);
  assert.equal(existsSync(f.bindingPath), false);
});

for (const [name, changes] of [
  ["still-ready previous", {}],
  ["running current", { status: "running", lastRunId: "current:run-2" }],
  ["ready current", { status: "ready", lastRunId: "current:run-2" }],
]) {
  test(`changing the native session ID after preflight fails for ${name} binding`, (t) => {
    const f = fixture(t);
    f.writeBinding();
    const assertActive = f.prepare();
    f.writeBinding({ ...changes, sessionId: "replacement-native-session" });
    assert.throws(assertActive, recovery);
  });
}

for (const retained of [false, true]) {
  test(`${retained ? "retained ready previous" : "fresh missing"} binding accepts runtime running current -> ready current on one native session`, (t) => {
    const f = fixture(t);
    if (retained) f.writeBinding();
    const assertActive = f.prepare(retained ? [assistant(), user()] : []);
    assert.doesNotThrow(assertActive);
    assert.doesNotThrow(assertActive);
    for (const status of ["running", "ready"]) {
      f.writeBinding({
        status, lastRunId: f.p.runId,
        consumedRunIds: retained ? [previousRunId, f.p.runId] : [f.p.runId],
      });
      const before = readFileSync(f.bindingPath, "utf8");
      const files = readdirSync(f.root, { recursive: true }).sort();
      assert.doesNotThrow(assertActive);
      assert.doesNotThrow(assertActive);
      assert.equal(readFileSync(f.bindingPath, "utf8"), before);
      assert.deepEqual(readdirSync(f.root, { recursive: true }).sort(), files);
    }
  });
}

test("retained ready previous may advance directly to ready current between observations", (t) => {
  const f = fixture(t);
  f.writeBinding();
  const assertActive = f.prepare();
  f.writeBinding({ lastRunId: f.p.runId, consumedRunIds: [previousRunId, f.p.runId] });
  assert.doesNotThrow(assertActive);
});

for (const status of ["running", "ready"]) {
  for (const [name, changes] of [
    ["rewind to ready previous", {}],
    ["switch to another run", { lastRunId: "another-run" }],
    ["blocked current", { status: "blocked", lastRunId: "current:run-2" }],
    ["binding removal", null],
  ]) {
    test(`after observing ${status} current, ${name} fails`, (t) => {
      const f = fixture(t);
      f.writeBinding();
      const assertActive = f.prepare();
      f.writeBinding({ status, lastRunId: f.p.runId });
      assert.doesNotThrow(assertActive);
      if (changes === null) rmSync(f.bindingPath);
      else f.writeBinding(changes);
      assert.throws(assertActive, recovery);
    });
  }

  test(`first observed ${status} current pins its native session ID`, (t) => {
    const f = fixture(t);
    const assertActive = f.prepare([]);
    f.writeBinding({ status, lastRunId: f.p.runId });
    assert.doesNotThrow(assertActive);
    f.writeBinding({ status: "ready", lastRunId: f.p.runId, sessionId: "replacement-native-session" });
    assert.throws(assertActive, recovery);
  });

  test(`fresh missing binding is no longer safe after observing ${status} current`, (t) => {
    const f = fixture(t);
    const assertActive = f.prepare([]);
    f.writeBinding({ status, lastRunId: f.p.runId });
    assert.doesNotThrow(assertActive);
    rmSync(f.bindingPath);
    assert.throws(assertActive, recovery);
  });
}

for (const [name, changes] of [
  ["unrelated ready run", {}],
  ["unrelated running run", { status: "running" }],
  ["unrelated blocked run", { status: "blocked" }],
  ["blocked current run", { status: "blocked", lastRunId: "current:run-2" }],
]) {
  test(`initially missing binding does not allow a subsequently appearing ${name}`, (t) => {
    const f = fixture(t);
    const assertActive = f.prepare([]);
    f.writeBinding(changes);
    assert.throws(assertActive, recovery);
  });
}

for (const [name, text] of [
  ["empty file", ""],
  ["truncated JSON", '{"version":'],
  ["null JSON", "null"],
  ["array JSON", "[]"],
  ["string JSON", '"binding"'],
  ["number JSON", "42"],
  ["boolean JSON", "true"],
  ["empty object", "{}"],
]) {
  for (const retained of [false, true]) {
    test(`${retained ? "retained" : "fresh"} preflight rejects ${name}, not treating it as missing state`, (t) => {
      const f = fixture(t);
      f.writeRaw(text);
      assert.throws(() => f.prepare(retained ? [assistant()] : []), recovery);
      assert.equal(readFileSync(f.bindingPath, "utf8"), text);
    });

    test(`${retained ? "retained" : "fresh"} assertActive rejects ${name} appearing after preflight`, (t) => {
      const f = fixture(t);
      if (retained) f.writeBinding();
      const assertActive = f.prepare(retained ? [assistant()] : []);
      f.writeRaw(text);
      assert.throws(assertActive, recovery);
      assert.equal(readFileSync(f.bindingPath, "utf8"), text);
    });
  }
}

for (const retained of [false, true]) {
  for (const afterPreflight of [false, true]) {
    test(`${retained ? "retained" : "fresh"} ${afterPreflight ? "assertActive" : "preflight"} rejects non-ENOENT read errors`, (t) => {
      const f = fixture(t);
      const messages = retained ? [assistant()] : [];
      let assertActive;
      if (afterPreflight) {
        if (retained) f.writeBinding();
        assertActive = f.prepare(messages);
        rmSync(f.bindingPath, { force: true });
      }
      mkdirSync(f.bindingPath, { recursive: true });
      assert.throws(() => readFileSync(f.bindingPath, "utf8"), { code: "EISDIR" });
      assert.throws(afterPreflight ? assertActive : () => f.prepare(messages), recovery);
      assert.deepEqual(readdirSync(f.bindingPath), []);
    });
  }
}
