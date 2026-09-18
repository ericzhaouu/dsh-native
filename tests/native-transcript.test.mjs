import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import test from "node:test";
import { prepareNativeTranscript, readNativeMaintenanceContext } from "../dist/native/transcript.js";

const USER_KEY = "run-1:user";
const ASSISTANT_KEY = "dsh-native:run-1:assistant";
const PROMPT = "Current user prompt";
const METHODS = [
  "readSessionTranscriptEvents",
  "readVisibleSessionTranscriptMessageEntries",
  "appendSessionTranscriptMessageByIdentityStrict",
  "publishSessionTranscriptUpdateByIdentity",
  "runAgentHarnessBeforeMessageWriteHook",
];
const clone = (value) => structuredClone(value);
const user = (text = PROMPT, key = USER_KEY) => ({
  role: "user", content: [{ type: "text", text }], timestamp: 1,
  ...(key === undefined ? {} : { idempotencyKey: key }),
});
const assistant = (text = "Answer", key) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "deepseek",
  model: "deepseek-chat",
  usage: {
    input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 2,
  ...(key === undefined ? {} : { idempotencyKey: key }),
});
const textOf = (message) => typeof message.content === "string"
  ? message.content
  : message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
const mirror = (messages) => messages.map((message) => [message.role, textOf(message)]);
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture(overrides = {}) {
  const calls = { read: [], strict: [], hook: [], publish: [], resolve: [], persist: [], sent: [], forbidden: [] };
  const state = {
    entries: [], events: [], resolved: user(), persisted: undefined, receipt: undefined,
    persistedResult: undefined, blocked: false, activeError: undefined, nextId: 1,
  };
  const p = {
    sessionId: "session-1", sessionKey: "agent:main:chat:test", agentId: "main", runId: "run-1",
    sessionFile: "sqlite:fixture-not-a-file", sessionPersistence: "durable",
    prompt: PROMPT, workspaceDir: process.cwd(), cwd: process.cwd(), config: {},
    ...overrides,
  };
  const scope = () => ({
    sessionId: p.sessionTarget?.sessionId ?? p.sessionId,
    sessionKey: p.sessionTarget?.sessionKey ?? p.sessionKey,
    agentId: p.sessionTarget?.agentId ?? p.agentId ?? p.sessionKey?.split(":")[1],
    ...(p.sessionTarget?.storePath === undefined ? {} : { storePath: p.sessionTarget.storePath }),
    ...(p.sessionTarget?.threadId === undefined ? {} : { threadId: p.sessionTarget.threadId }),
    ...(p.sessionTarget?.expectedLifecycleRevision === undefined ? {} : { expectedLifecycleRevision: p.sessionTarget.expectedLifecycleRevision }),
    ...(p.sessionTarget?.expectedWriterRunId === undefined ? {} : { expectedWriterRunId: p.sessionTarget.expectedWriterRunId }),
  });
  const assertActive = () => {
    state.events.push("active");
    if (state.activeError) throw state.activeError;
  };
  const add = (message, fields = {}) => {
    const entry = {
      entryId: `entry-${state.nextId++}`,
      parentId: state.entries.at(-1)?.entryId ?? null,
      seq: state.entries.length + 1,
      role: message.role,
      message: clone(message),
      ...(message.idempotencyKey === undefined ? {} : { idempotencyKey: message.idempotencyKey }),
      ...fields,
    };
    state.entries.push(entry);
    return entry;
  };
  const rawOf = (entry) => ({
    type: "message",
    id: entry.entryId,
    parentId: entry.parentId,
    timestamp: entry.message.timestamp ?? entry.seq,
    message: clone(entry.message),
  });
  const admission = (entry, fields = {}) => ({
    agentId: scope().agentId, sessionId: scope().sessionId, sessionKey: scope().sessionKey,
    storePath: "C:\\fixture-only\\physical-transcript.sqlite",
    generation: "generation-1", entryId: entry.entryId, rawSeq: entry.seq,
    effectiveParentId: entry.parentId, activeMessagePosition: state.entries.indexOf(entry),
    ...(entry.idempotencyKey === undefined ? {} : { idempotencyKey: entry.idempotencyKey }),
    logicalTurnId: "logical-turn-1", role: "user", ...fields,
  });
  const adopt = (entry, fields = {}) => {
    state.persisted = clone(entry.message);
    state.receipt = admission(entry, fields);
    state.persistedResult = {
      message: state.persisted, admission: state.receipt, messageId: entry.entryId,
      sessionEntry: { sessionId: scope().sessionId, updatedAt: 1 },
      sessionFile: "sqlite:fixture-not-a-file", appended: true,
    };
    return state.receipt;
  };
  const forbidden = (name) => (...args) => {
    calls.forbidden.push([name, ...args]);
    assert.fail(`Unexpected recorder fallback: ${name}`);
  };
  const recorder = {
    get message() { return state.resolved; },
    resolveMessage: async () => {
      calls.resolve.push(true);
      state.events.push("resolve");
      await state.beforeResolve?.();
      return state.resolved;
    },
    getPersistedMessage: () => state.persisted,
    getAdmissionReceipt: () => state.receipt,
    hasPersisted: () => state.persisted !== undefined,
    isBlocked: () => state.blocked,
    markSentToProvider: () => { calls.sent.push(true); state.events.push("sent"); },
    markBlocked: () => { state.blocked = true; },
    markRuntimePersisted: forbidden("markRuntimePersisted"),
    persistFallback: forbidden("persistFallback"),
    persistBlocked: forbidden("persistBlocked"),
    hasRuntimePersistencePending: () => state.runtimePersistencePending !== undefined,
    waitForRuntimePersistence: async () => { await state.runtimePersistencePending; },
    markRuntimePersistencePending: (pending) => { state.runtimePersistencePending = pending; },
    persistApproved: async (params) => {
      calls.persist.push(params);
      state.events.push("user:start");
      await state.beforeUserPersist?.(params);
      if (state.blocked || state.suppressUser) return undefined;
      if (state.persistedResult) return state.persistedResult;
      const target = typeof params.target === "function" ? await params.target() : params.target;
      let canonical = clone(state.resolved);
      if (target?.beforeMessageWrite) {
        canonical = target.beforeMessageWrite({
          message: canonical, agentId: target.agentId, sessionKey: target.sessionKey,
        });
        assert.equal(typeof canonical?.then, "undefined", "user write hook must be synchronous");
        if (canonical?.role !== "user") return undefined;
        canonical = { ...canonical, idempotencyKey: state.resolved.idempotencyKey };
      }
      if (state.transformUser) canonical = state.transformUser(canonical);
      const existing = state.entries.find((entry) => entry.idempotencyKey === canonical.idempotencyKey);
      const entry = existing ?? add(canonical);
      adopt(entry);
      state.persistedResult.appended = !existing;
      state.events.push("user:committed");
      await state.afterUserPersist?.(state.persistedResult);
      return state.persistedResult;
    },
  };
  p.userTurnTranscriptRecorder = recorder;
  const transport = {
    readSessionTranscriptEvents: async (params) => {
      calls.read.push(params);
      state.events.push("read:raw");
      await state.beforeRawRead?.(params);
      const raw = typeof state.rawEvents === "function" ? state.rawEvents() : state.rawEvents;
      return clone(raw ?? state.entries.map(rawOf));
    },
    readVisibleSessionTranscriptMessageEntries: async (params) => {
      calls.read.push(params);
      state.events.push("read:visible");
      await state.beforeRead?.(params);
      return clone(state.entries);
    },
    appendSessionTranscriptMessageByIdentityStrict: async (params) => {
      calls.strict.push(params);
      state.events.push("assistant:start");
      assert.equal(params.idempotencyLookup, "scan");
      assert.equal(typeof params.prepareMessageAfterIdempotencyCheck, "function");
      await state.beforeStrict?.(params);
      // The real SDK returns the durable message before running preparation on a duplicate.
      const existing = state.entries.find((entry) => entry.idempotencyKey === params.message.idempotencyKey);
      if (existing) {
        state.events.push("assistant:duplicate");
        return {
          kind: "result",
          result: { appended: false, messageId: existing.entryId, message: clone(existing.message) },
        };
      }
      if (state.strictOutcome) return state.strictOutcome;
      state.events.push("assistant:prepare");
      let canonical = params.prepareMessageAfterIdempotencyCheck(params.message);
      assert.equal(typeof canonical?.then, "undefined", "SDK preparation callback must not return a Promise");
      assert.notEqual(canonical, null, "SDK suppression is undefined, not the hook's null");
      if (canonical === undefined) return { kind: "suppressed" };
      if (state.transformAssistant) canonical = state.transformAssistant(canonical);
      await state.beforeAssistantCommit?.(canonical);
      const entry = add(canonical);
      state.events.push("assistant:committed");
      const result = {
        kind: "result",
        result: { appended: true, messageId: entry.entryId, message: clone(entry.message) },
      };
      await state.afterAssistantCommit?.(result);
      return result;
    },
    publishSessionTranscriptUpdateByIdentity: async (params) => {
      calls.publish.push(params);
      state.events.push(`publish:${params.update?.message?.role}`);
      assert.ok(params.update?.messageId, "publication requires the authoritative message ID");
      const entry = state.entries.find((candidate) => candidate.entryId === params.update.messageId);
      assert.ok(entry, "publication must follow the authoritative append");
      assert.deepEqual(params.update.message, entry.message);
      await state.beforePublish?.(params);
    },
    runAgentHarnessBeforeMessageWriteHook: (params) => {
      calls.hook.push(params);
      state.events.push(`hook:${params.message.role}`);
      return state.onHook ? state.onHook(params) : params.message;
    },
  };
  const prepare = () => prepareNativeTranscript(p, assertActive, transport);
  const ready = async () => {
    const transcript = await prepare();
    await transcript.persistUser();
    transcript.markSentToProvider();
    return transcript;
  };
  return { p, state, calls, recorder, transport, scope, assertActive, add, rawOf, adopt, admission, prepare, ready };
}

function assertScope(actual, expected) {
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, key);
  assert.equal(Object.hasOwn(actual, "sessionFile"), false, "legacy sessionFile must not route storage");
}

test("maintenance reads a reset-scoped snapshot without admitting or persisting a user turn", async () => {
  const f = fixture();
  const oldUser = f.add(user("old", "old:user"));
  const oldAssistant = f.add(assistant("foreign", "foreign:assistant"));
  const reset = { type: "reset", id: "reset-maint", parentId: oldAssistant.entryId, context: "clear" };
  f.add(user("retained constraint", "retained:user"), { parentId: reset.id });
  f.add(assistant("retained answer", "dsh-native:reset:reset-maint:retained:assistant"));
  f.state.rawEvents = () => [oldUser, oldAssistant].map(f.rawOf).concat(reset, f.state.entries.slice(2).map(f.rawOf));
  const before = clone(f.state.entries);
  const snapshot = await readNativeMaintenanceContext(f.p, f.assertActive, f.transport);
  assert.equal(snapshot.nativeStateId, "session-1\0reset\0reset-maint");
  assert.deepEqual(mirror(snapshot.contextMessages), [["user", "retained constraint"], ["assistant", "retained answer"]]);
  assert.equal(snapshot.messages.length, 4);
  await snapshot.assertCurrent();
  assert.deepEqual(f.state.entries, before);
  assertNoWrites(f);
  assert.equal(f.calls.resolve.length, 0);
  f.add(user("new admission", "new:user"));
  await assert.rejects(snapshot.assertCurrent(), /transcript changed/u);
});

test("maintenance rejects foreign compaction and mismatched session scopes", async () => {
  const f = fixture();
  const boundary = { type: "compaction", id: "foreign", parentId: null };
  f.state.rawEvents = [boundary];
  await assert.rejects(readNativeMaintenanceContext(f.p, f.assertActive, f.transport), /active compaction/u);
  await assert.rejects(readNativeMaintenanceContext({
    ...f.p, sessionTarget: { sessionId: "different" },
  }, f.assertActive, f.transport), /mismatched/u);
  assertNoWrites(f);
});

test("active clear reset filters old visible transcript for native context while preserving full snapshot", async () => {
  const f = fixture();
  const oldUser = f.add(user("old request", "old:user"));
  const oldAssistant = f.add(assistant("foreign old assistant", "foreign:assistant"));
  const reset = { type: "reset", id: "reset-1", parentId: oldAssistant.entryId, timestamp: 3, reason: "new", context: "clear" };
  const current = f.add(user(PROMPT), { parentId: reset.id });
  f.adopt(current);
  f.state.rawEvents = () => [oldUser, oldAssistant].map(f.rawOf).concat(reset, f.state.entries.slice(2).map(f.rawOf));
  const transcript = await f.prepare();
  assert.deepEqual(mirror(transcript.messages), [
    ["user", "old request"], ["assistant", "foreign old assistant"], ["user", PROMPT],
  ]);
  assert.deepEqual(mirror(transcript.contextMessages), [["user", PROMPT]]);
  assert.match(transcript.nativeStateId, /^session-1\0reset\0reset-1$/u);
  await transcript.persistUser();
  transcript.markSentToProvider();
  const persisted = await transcript.persistAssistant(assistant());
  assert.equal(persisted.idempotencyKey, "dsh-native:reset:reset-1:run-1:assistant");
  assert.deepEqual(mirror(transcript.contextMessages), [["user", PROMPT], ["assistant", "Answer"]]);
  assert.deepEqual(mirror(transcript.messages).at(1), ["assistant", "foreign old assistant"]);
});

test("inactive branch reset cannot authorize discarding current visible history", async () => {
  const f = fixture();
  const prior = f.add(user("prior", "prior:user"));
  const old = f.add(assistant("Existing DSH answer", "dsh-native:old-run:assistant"));
  const current = f.add(user(PROMPT));
  f.adopt(current);
  const branchedReset = { type: "reset", id: "reset-inactive", parentId: null, timestamp: 3, reason: "new", context: "clear" };
  const leaf = { type: "leaf", id: "leaf-active", parentId: branchedReset.id, targetId: current.entryId, appendParentId: current.entryId };
  f.state.rawEvents = () => [f.rawOf(prior), f.rawOf(old), f.rawOf(current), branchedReset, leaf];
  const transcript = await f.prepare();
  assert.equal(transcript.nativeStateId, undefined);
  assert.deepEqual(mirror(transcript.contextMessages), [
    ["user", "prior"], ["assistant", "Existing DSH answer"], ["user", PROMPT],
  ]);
});

test("forged reset-looking text is not treated as a reset boundary", async () => {
  const f = fixture();
  f.add(user("/new", "old:user"));
  f.add(assistant("New session started", "foreign:assistant"));
  f.adopt(f.add(user(PROMPT)));
  await assert.rejects(f.prepare(), /non-DSH assistant|history/u);
});

for (const [name, reset] of [
  ["preserve tail", { type: "reset", id: "reset-1", parentId: null, timestamp: 1, reason: "idle", firstKeptEntryId: "entry-1" }],
  ["unknown context", { type: "reset", id: "reset-1", parentId: null, timestamp: 1, reason: "new", context: "mystery" }],
]) {
  test(`active ${name} reset fails closed`, async () => {
    const f = fixture();
    const current = f.add(user(PROMPT), { parentId: reset.id });
    f.adopt(current);
    f.state.rawEvents = () => [reset, f.rawOf(current)];
    await assert.rejects(f.prepare(), /reset boundary|retained-tail/u);
  });
}

test("active compaction boundary is not silently treated as native history", async () => {
  const f = fixture();
  const compaction = { type: "compaction", id: "compact-1", parentId: null, timestamp: 1, firstKeptEntryId: "compact-1" };
  const current = f.add(user(PROMPT), { parentId: compaction.id });
  f.adopt(current);
  f.state.rawEvents = () => [compaction, f.rawOf(current)];
  await assert.rejects(f.prepare(), /compaction boundary/u);
});

test("malformed reset boundary fails closed even before text history validation", async () => {
  const f = fixture();
  const current = f.add(user(PROMPT));
  f.adopt(current);
  f.state.rawEvents = () => [{ type: "reset", id: " ", parentId: null }, f.rawOf(current)];
  await assert.rejects(f.prepare(), /malformed reset/u);
});

test("raw reset projection mismatch fails closed instead of guessing a filtered context", async () => {
  const f = fixture();
  const current = f.add(user(PROMPT));
  f.adopt(current);
  const reset = { type: "reset", id: "reset-1", parentId: null, timestamp: 1, reason: "new", context: "clear" };
  f.state.rawEvents = () => [reset, { ...f.rawOf(current), id: "different-visible-id", parentId: reset.id }];
  await assert.rejects(f.prepare(), /reset boundary does not match/u);
});

test("reset projection cannot silently omit a pre-admitted current user", async () => {
  const f = fixture();
  const reset = { type: "reset", id: "reset-1", parentId: null, timestamp: 1, reason: "new" };
  const current = f.add(user(PROMPT), { parentId: reset.id });
  f.adopt(current);
  f.state.rawEvents = () => [reset];
  await assert.rejects(f.prepare(), /reset.*(match|projection|admission)/u);
  assertNoWrites(f);
});

test("clear reset segment rejects assistants from another native epoch", async () => {
  const f = fixture();
  const reset = { type: "reset", id: "reset-1", parentId: null, timestamp: 1, reason: "new", context: "clear" };
  const current = f.add(user(PROMPT), { parentId: reset.id });
  f.add(assistant("wrong epoch", "dsh-native:old-run:assistant"));
  f.adopt(current);
  f.state.rawEvents = () => [reset, ...f.state.entries.map(f.rawOf)];
  await assert.rejects(f.prepare(), /non-DSH assistant|history/u);
});

test("reset boundary mutation between admission reads fails closed", async () => {
  const f = fixture();
  const current = f.add(user(PROMPT));
  f.adopt(current);
  const reset = { type: "reset", id: "reset-1", parentId: null, timestamp: 1, reason: "new", context: "clear" };
  let resetActive = false;
  f.state.rawEvents = () => resetActive ? [reset, { ...f.rawOf(current), parentId: reset.id }] : [f.rawOf(current)];
  const transcript = await f.prepare();
  resetActive = true;
  current.parentId = reset.id;
  await assert.rejects(transcript.persistUser(), /active reset boundary changed/u);
});

function assertNoWrites(f) {
  assert.equal(f.calls.persist.length, 0);
  assert.equal(f.calls.strict.length, 0);
  assert.equal(f.calls.publish.length, 0);
  assert.equal(f.calls.sent.length, 0);
  assert.deepEqual(f.calls.forbidden, []);
}

test("uses SDK-shaped scoped reads, recorder admission, strict append and authoritative publication", async () => {
  const f = fixture();
  const originalUser = clone(f.state.resolved);
  const input = assistant();
  const originalAssistant = clone(input);
  const transcript = await f.prepare();
  const live = transcript.messages;
  assert.ok(Array.isArray(live));
  assert.deepEqual(live, []);
  assert.equal(transcript.getAssistantPersistence(), undefined);
  assert.equal(Object.hasOwn(transcript, "prompt"), false);
  assertNoWrites(f);
  await transcript.persistUser();
  assert.equal(transcript.messages, live);
  assert.deepEqual(mirror(live), [["user", PROMPT]]);
  assert.equal(f.state.persisted.idempotencyKey, USER_KEY);
  const params = f.calls.persist[0];
  assert.equal(params.updateMode, "none");
  assert.equal(params.expectedSessionId, f.p.sessionId);
  assert.equal(params.cwd, f.p.cwd);
  const target = typeof params.target === "function" ? await params.target() : params.target;
  assertScope(target, f.scope());
  assert.equal(target.config, f.p.config);
  transcript.markSentToProvider();
  transcript.markSentToProvider();
  assert.equal(f.calls.sent.length, 1);
  const result = await transcript.persistAssistant(input);
  assert.equal(result.owned, true);
  assert.equal(result.idempotencyKey, ASSISTANT_KEY);
  assert.deepEqual(result.message, f.state.entries[1].message);
  assert.deepEqual(transcript.getAssistantPersistence(), result);
  assert.equal(transcript.messages, live);
  assert.deepEqual(mirror(live), [["user", PROMPT], ["assistant", "Answer"]]);
  assert.equal(f.calls.strict.length, 1);
  const strict = f.calls.strict[0];
  assertScope(strict, f.scope());
  assert.equal(strict.message.idempotencyKey, ASSISTANT_KEY);
  assert.equal(strict.config, f.p.config);
  assert.equal(strict.cwd, f.p.cwd);
  assert.deepEqual(f.calls.publish.map((call) => call.update.messageId), f.state.entries.map((entry) => entry.entryId));
  for (const call of [...f.calls.read, ...f.calls.publish]) assertScope(call, f.scope());
  for (const call of f.calls.hook) {
    assert.equal(call.agentId, f.p.agentId);
    assert.equal(call.sessionKey, f.p.sessionKey);
  }
  assert.deepEqual(input, originalAssistant);
  assert.deepEqual(f.state.resolved, originalUser);
  assert.deepEqual(f.calls.forbidden, []);
});

for (const sessionFile of ["sqlite:opaque-transcript-handle", "agent:main:chat:opaque", undefined]) {
  test(`ignores legacy sessionFile ${String(sessionFile)}`, async () => {
    const f = fixture({ sessionFile });
    const transcript = await f.ready();
    assert.equal((await transcript.persistAssistant(assistant())).owned, true);
    for (const params of [...f.calls.read, ...f.calls.strict, ...f.calls.publish]) assertScope(params, f.scope());
  });
}

test("preserves explicit target store alias and thread without confusing physical receipt path", async () => {
  const f = fixture({
    sessionTarget: {
      sessionId: "session-1", sessionKey: "agent:main:chat:test", agentId: "main",
      storePath: "C:\\fixture-only\\session-store-alias.json", threadId: "thread-7",
    },
  });
  const transcript = await f.ready();
  await transcript.persistAssistant(assistant());
  assert.notEqual(f.state.receipt.storePath, f.p.sessionTarget.storePath);
  for (const params of [...f.calls.read, ...f.calls.strict, ...f.calls.publish]) assertScope(params, f.scope());
  assertScope(f.calls.persist[0].target, f.scope());
});

test("derives an omitted agentId only from the scoped session key", async () => {
  const f = fixture({ agentId: undefined });
  const transcript = await f.ready();
  await transcript.persistAssistant(assistant());
  for (const params of [...f.calls.read, ...f.calls.strict, ...f.calls.publish]) assert.equal(params.agentId, "main");
});

for (const revision of [undefined, "revision-7"]) {
  test(`binds the exact inherited writer scope with lifecycle revision ${String(revision)}`, async () => {
    const f = fixture({
      sessionTarget: {
        agentId: "main", sessionId: "session-1", sessionKey: "agent:main:chat:test",
        storePath: "C:\\fixture-only\\sessions.json", threadId: "thread-7",
        expectedWriterRunId: "run-1",
        ...(revision === undefined ? {} : { expectedLifecycleRevision: revision }),
      },
    });
    const context = new AsyncLocalStorage();
    const host = { writerRunId: f.p.runId, lifecycleRevision: "revision-7" };
    let activeChecks = 0;
    const assertActive = () => {
      assert.equal(context.getStore(), host, "every callback must retain the original host context object");
      activeChecks++;
      f.assertActive();
    };
    for (const [object, methods] of [[f.transport, METHODS], [f.recorder, ["resolveMessage", "persistApproved"]]]) {
      for (const name of methods) {
        const original = object[name];
        object[name] = (...args) => { assertActive(); return original(...args); };
      }
    }
    const transcript = await context.run(host, () => prepareNativeTranscript(f.p, assertActive, f.transport));
    assert.equal(context.getStore(), undefined);
    await transcript.persistUser();
    const replacement = { ...host };
    await context.run(replacement, async () => {
      transcript.markSentToProvider();
      assert.equal(context.getStore(), replacement, "a synchronous callback must restore the caller's context");
      const result = await transcript.persistAssistant(assistant());
      assert.equal(result.owned, true);
      assert.equal(result.idempotencyKey, ASSISTANT_KEY);
      assert.equal(result.suppressed, undefined);
      assert.equal(context.getStore(), replacement, "an asynchronous callback must restore the caller's context");
    });
    assert.ok(activeChecks > 10);
    assert.equal(context.getStore(), undefined);
    for (const params of [...f.calls.read, ...f.calls.strict, ...f.calls.publish, f.calls.persist[0].target]) {
      assertScope(params, f.scope());
      assert.equal(Object.hasOwn(params, "expectedLifecycleRevision"), revision !== undefined);
    }
    assert.equal(f.calls.persist.length, 1);
    assert.equal(f.calls.strict.length, 1);
    assert.deepEqual(f.calls.forbidden, []);
  });
}

for (const stage of ["user", "assistant"]) {
  test(`a matching writer runId does not bypass revoked host authority before ${stage} persistence`, async () => {
    const f = fixture({ sessionTarget: { expectedWriterRunId: "run-1", expectedLifecycleRevision: "revision-1" } });
    const transcript = await f.prepare();
    if (stage === "assistant") {
      await transcript.persistUser();
      transcript.markSentToProvider();
    }
    const writes = [f.calls.persist.length, f.calls.strict.length, f.calls.publish.length, f.calls.hook.length];
    f.state.activeError = new Error("host mutation authority revoked");
    await assert.rejects(stage === "user" ? transcript.persistUser() : transcript.persistAssistant(assistant()), /authority revoked/);
    assert.equal(transcript.getAssistantPersistence(), undefined);
    assert.deepEqual([f.calls.persist.length, f.calls.strict.length, f.calls.publish.length, f.calls.hook.length], writes);
  });
}

test("a matching writer runId does not swallow the SDK's commit-time writer rejection", async () => {
  const f = fixture({ sessionTarget: { expectedWriterRunId: "run-1", expectedLifecycleRevision: "revision-1" } });
  const transcript = await f.ready();
  const hooksBefore = f.calls.hook.length;
  f.state.beforeStrict = () => { throw new Error("session writer claim changed before transcript persistence"); };
  await assert.rejects(transcript.persistAssistant(assistant()), /session writer claim changed/);
  assert.equal(f.calls.hook.length, hooksBefore);
  assert.equal(f.calls.strict.length, 1);
  assert.equal(f.calls.publish.length, 1);
  assert.equal(f.state.entries.length, 1);
  assert.equal(transcript.getAssistantPersistence(), undefined);
  assert.deepEqual(f.calls.forbidden, []);
});

for (const field of ["expectedLifecycleRevision", "expectedWriterRunId"]) {
  for (const stage of ["user", "assistant"]) {
    test(`the persistence API rejects stale inherited ${field} during ${stage} writes`, async () => {
      const host = { expectedLifecycleRevision: "revision-1", expectedWriterRunId: "run-1" };
      const current = { ...host };
      const context = new AsyncLocalStorage();
      const f = fixture({ sessionTarget: { ...host } });
      const transcript = await context.run(host, f.prepare);
      if (stage === "assistant") {
        await transcript.persistUser();
        transcript.markSentToProvider();
      }
      current[field] = `${current[field]}-superseded`;
      const rejectStaleFence = (params) => {
        assert.equal(context.getStore(), host, "the callback must not borrow its caller's newer authority");
        assertScope(params, f.scope());
        assert.notEqual(context.getStore()[field], current[field]);
        throw new Error(`SDK rejected stale ${field}`);
      };
      if (stage === "user") f.state.beforeUserPersist = ({ target }) => rejectStaleFence(target);
      else f.state.beforeStrict = rejectStaleFence;
      const hooks = f.calls.hook.length;
      await assert.rejects(context.run(current, () => stage === "user"
        ? transcript.persistUser() : transcript.persistAssistant(assistant())), /SDK rejected stale/);
      assert.equal(f.calls.persist.length, 1);
      assert.equal(f.calls.strict.length, stage === "assistant" ? 1 : 0);
      assert.equal(f.calls.hook.length, hooks);
      assert.equal(f.calls.publish.length, stage === "assistant" ? 1 : 0);
      assert.equal(f.state.entries.length, stage === "assistant" ? 1 : 0);
      assert.equal(transcript.getAssistantPersistence(), undefined);
      assert.deepEqual(f.calls.forbidden, []);
    });
  }
}

test("a syntactically valid host fence does not bypass a scoped read API rejection", async () => {
  const f = fixture({ sessionTarget: { expectedLifecycleRevision: "stale-revision", expectedWriterRunId: "run-1" } });
  f.state.beforeRead = (params) => {
    assertScope(params, f.scope());
    throw new Error("SDK rejected stale read fence");
  };
  await assert.rejects(f.prepare(), /SDK rejected stale read fence/);
  assert.equal(f.calls.read.length, 2);
  assertNoWrites(f);
});

for (const [name, change] of [
  ["detached persistence", (f) => { f.p.sessionPersistence = "detached"; }],
  ["in-memory sessionManager", (f) => { f.p.sessionManager = { getBranch: () => [] }; }],
  ["missing recorder", (f) => { delete f.p.userTurnTranscriptRecorder; }],
  ["missing session key", (f) => { delete f.p.sessionKey; }],
  ["blank session key", (f) => { f.p.sessionKey = " "; }],
  ["missing session ID", (f) => { delete f.p.sessionId; }],
  ["blank session ID", (f) => { f.p.sessionId = " "; }],
  ["missing run ID", (f) => { delete f.p.runId; }],
  ["unscoped key without agent", (f) => { f.p.sessionKey = "chat:test"; delete f.p.agentId; }],
  ["conflicting scoped agent", (f) => { f.p.agentId = "other"; }],
  ["target session ID mismatch", (f) => { f.p.sessionTarget = { sessionId: "other" }; }],
  ["target session key mismatch", (f) => { f.p.sessionTarget = { sessionKey: "agent:main:chat:other" }; }],
  ["target agent mismatch", (f) => { f.p.sessionTarget = { agentId: "other" }; }],
  ["lifecycle revision without writer claim", (f) => { f.p.sessionTarget = { expectedLifecycleRevision: "revision-1" }; }],
  ["lifecycle revision with mismatched writer", (f) => { f.p.sessionTarget = { expectedLifecycleRevision: "revision-1", expectedWriterRunId: "other-run" }; }],
  ["mismatched writer claim", (f) => { f.p.sessionTarget = { expectedWriterRunId: "other-run" }; }],
  ["blank writer claim", (f) => { f.p.sessionTarget = { expectedWriterRunId: "" }; }],
  ["null writer claim", (f) => { f.p.sessionTarget = { expectedWriterRunId: null }; }],
  ["non-string writer claim", (f) => { f.p.sessionTarget = { expectedWriterRunId: 1 }; }],
  ["whitespace writer claim", (f) => { f.p.sessionTarget = { expectedLifecycleRevision: "revision-1", expectedWriterRunId: " run-1 " }; }],
  ["null session target", (f) => { f.p.sessionTarget = null; }],
  ["array session target", (f) => { f.p.sessionTarget = []; }],
]) {
  test(`rejects ${name} before invoking transport`, async () => {
    const f = fixture();
    change(f);
    await assert.rejects(f.prepare());
    assert.equal(f.calls.read.length, 0);
    assert.equal(f.calls.hook.length, 0);
    assertNoWrites(f);
  });
}

for (const revision of [0, 7, null, false, {}, [], "", " ", "\t", " revision-1", "revision-1 ", "revision-1\n"]) {
  test(`rejects malformed lifecycle fence ${JSON.stringify(revision)} alongside a matching writer`, async () => {
    const f = fixture({ sessionTarget: { expectedWriterRunId: "run-1", expectedLifecycleRevision: revision } });
    await assert.rejects(f.prepare(), /expectedLifecycleRevision must be nonblank/);
    assert.equal(f.calls.read.length, 0);
    assertNoWrites(f);
  });
}

for (const method of METHODS) {
  for (const value of [undefined, 42]) {
    test(`validates transport ${method} is callable (${String(value)})`, async () => {
      const f = fixture();
      f.transport[method] = value;
      await assert.rejects(f.prepare(), /transport|function|support|SDK/i);
      assert.equal(f.calls.read.length, 0);
      assertNoWrites(f);
    });
  }
}

test("compares the resolved user to transcriptPrompt rather than runtime prompt", async () => {
  const f = fixture({ prompt: "Runtime-only context", transcriptPrompt: PROMPT });
  const transcript = await f.ready();
  assert.deepEqual(mirror(transcript.messages), [["user", PROMPT]]);
  assert.equal(Object.hasOwn(transcript, "prompt"), false);
});

test("an empty transcriptPrompt does not fall back to the nonempty runtime prompt", async () => {
  const f = fixture({ transcriptPrompt: "" });
  await assert.rejects(f.prepare(), /prompt|text|match/i);
  assertNoWrites(f);
});

test("accepts a single string user without changing its recorder-owned key", async () => {
  const f = fixture();
  f.state.resolved.content = PROMPT;
  const transcript = await f.ready();
  assert.deepEqual(mirror(transcript.messages), [["user", PROMPT]]);
  assert.equal(f.state.persisted.idempotencyKey, USER_KEY);
});

for (const text of ["Rewritten user prompt", `${PROMPT} `, ` ${PROMPT}`, `${PROMPT}\n`]) {
  test(`rejects non-exact resolved prompt ${JSON.stringify(text)}`, async () => {
    const f = fixture();
    f.state.resolved = user(text);
    await assert.rejects(f.prepare(), /prompt|rewrit|text|match/i);
    assertNoWrites(f);
  });
}

for (const [name, change] of [
  ["missing resolved message", (f) => { f.state.resolved = undefined; }],
  ["hidden user", (f) => { f.state.resolved.display = false; }],
  ["context-excluded user", (f) => { f.state.resolved.excludeFromContext = true; }],
  ["media metadata", (f) => { f.state.resolved.__openclaw = { media: [{ kind: "image", url: "https://example.invalid/image" }] }; }],
  ["image block", (f) => { f.state.resolved.content.push({ type: "image", data: "image", mimeType: "image/png" }); }],
  ["multiple text blocks", (f) => { f.state.resolved.content = [{ type: "text", text: "Current " }, { type: "text", text: "user prompt" }]; }],
  ["non-user role", (f) => { f.state.resolved.role = "assistant"; }],
]) {
  test(`rejects ${name} before user persistence`, async () => {
    const f = fixture();
    change(f);
    await assert.rejects(f.prepare());
    assertNoWrites(f);
  });
}

test("rejects a canonical persisted prompt rewrite before provider submission", async () => {
  const f = fixture();
  f.state.transformUser = (message) => ({ ...message, content: [{ type: "text", text: "Redacted user" }] });
  const transcript = await f.prepare();
  await assert.rejects(transcript.persistUser(), /prompt|rewrit|text|match/i);
  assert.throws(() => transcript.markSentToProvider());
  await assert.rejects(transcript.persistAssistant(assistant()));
  assert.equal(f.calls.sent.length, 0);
  assert.equal(f.calls.strict.length, 0);
  assert.deepEqual(f.calls.forbidden, []);
});

for (const [name, transform] of [
  ["hidden canonical user", (message) => ({ ...message, display: false })],
  ["context-excluded canonical user", (message) => ({ ...message, excludeFromContext: true })],
  ["media-bearing canonical user", (message) => ({ ...message, __openclaw: { media: [{ kind: "audio", url: "https://example.invalid/audio" }] } })],
  ["non-user canonical message", (message) => ({ ...message, role: "assistant" })],
]) {
  test(`rejects ${name} returned by recorder persistence`, async () => {
    const f = fixture();
    const transcript = await f.prepare();
    f.state.transformUser = transform;
    await assert.rejects(transcript.persistUser());
    assert.throws(() => transcript.markSentToProvider());
    assert.equal(f.calls.sent.length, 0);
    assert.equal(f.calls.strict.length, 0);
  });
}

for (const mode of ["blocked", "undefined persistence", "user hook null"]) {
  test(`fails closed on ${mode}, with no fallback append or provider mark`, async () => {
    const f = fixture();
    if (mode === "user hook null") f.state.onHook = ({ message }) => message.role === "user" ? null : message;
    const transcript = await f.prepare();
    if (mode === "blocked") f.state.blocked = true;
    if (mode === "undefined persistence") f.state.suppressUser = true;
    await assert.rejects(transcript.persistUser());
    assert.throws(() => transcript.markSentToProvider());
    await assert.rejects(transcript.persistAssistant(assistant()));
    assert.equal(f.state.entries.length, 0);
    assert.equal(f.calls.strict.length, 0);
    assert.equal(f.calls.publish.length, 0);
    assert.equal(f.calls.sent.length, 0);
    assert.deepEqual(f.calls.forbidden, []);
  });
}

test("requires successful persistence before marking, and marking before assistant persistence", async () => {
  const f = fixture();
  const transcript = await f.prepare();
  assert.throws(() => transcript.markSentToProvider());
  await assert.rejects(transcript.persistAssistant(assistant()));
  await transcript.persistUser();
  await assert.rejects(transcript.persistAssistant(assistant()));
  assert.equal(f.calls.strict.length, 0);
  transcript.markSentToProvider();
  await transcript.persistAssistant(assistant());
  assert.equal(f.calls.sent.length, 1);
});

test("mirrors only alternating user and own-key final assistant history", async () => {
  const f = fixture();
  f.add(user("Old question", "host-old:user"));
  f.add(assistant("Old answer", "dsh-native:old-run:assistant"));
  const transcript = await f.prepare();
  assert.deepEqual(mirror(transcript.messages), [["user", "Old question"], ["assistant", "Old answer"]]);
  await transcript.persistUser();
  assert.deepEqual(mirror(transcript.messages), [["user", "Old question"], ["assistant", "Old answer"], ["user", PROMPT]]);
});

for (const [name, messages] of [
  ["foreign assistant key", [user("Old"), assistant("Foreign", "other:assistant")]],
  ["unkeyed assistant", [user("Old"), assistant("Foreign")]],
  ["non-final assistant key", [user("Old"), assistant("Interim", "dsh-native:old:tool")]],
  ["assistant-only history", [assistant("Old", "dsh-native:old:assistant")]],
  ["two assistant rows", [user("Old"), assistant("A", "dsh-native:old:assistant"), assistant("B", "dsh-native:other:assistant")]],
  ["foreign system role", [{ role: "system", content: "Foreign instructions" }]],
  ["foreign tool result", [{ role: "toolResult", toolCallId: "call", content: [{ type: "text", text: "Foreign tool" }] }]],
  ["assistant tool call", [user("Old"), { ...assistant("Old", "dsh-native:old:assistant"), content: [{ type: "toolCall", id: "call", name: "exec", arguments: {} }], stopReason: "toolUse" }]],
]) {
  test(`rejects unsupported history: ${name}`, async () => {
    const f = fixture();
    for (const message of messages) f.add(message);
    await assert.rejects(f.prepare());
    assertNoWrites(f);
  });
}

test("accepts the sole trailing user only with the exact recorder receipt", async () => {
  const f = fixture();
  f.add(user("Old question", "old:user"));
  f.add(assistant("Old answer", "dsh-native:old:assistant"));
  const current = f.add(user());
  f.adopt(current);
  const transcript = await f.prepare();
  await transcript.persistUser();
  transcript.markSentToProvider();
  assert.deepEqual(mirror(transcript.messages), [["user", "Old question"], ["assistant", "Old answer"], ["user", PROMPT]]);
  assert.equal(f.state.entries.length, 3);
  assert.equal(f.calls.publish.length, 0, "pre-admitted rows are not new appends");
});

for (const when of ["before preparation", "during persistence revalidation"]) {
  test(`does not republish a cached appended:true user admitted ${when}`, async () => {
    const f = fixture();
    const admit = () => { f.adopt(f.add(user())); };
    if (when === "before preparation") admit();
    const transcript = await f.prepare();
    if (when === "during persistence revalidation") {
      f.state.beforeRead = () => {
        f.state.beforeRead = undefined;
        admit();
      };
    }
    await Promise.all([transcript.persistUser(), transcript.persistUser()]);
    assert.equal(f.state.persistedResult.appended, true, "recorder caches the original append result");
    assert.equal(f.calls.persist.length, 1);
    assert.equal(f.calls.publish.length, 0);
    assert.deepEqual(mirror(transcript.messages), [["user", PROMPT]]);
    transcript.markSentToProvider();
    await transcript.persistAssistant(assistant());
    assert.deepEqual(f.calls.publish.map(({ update }) => update.message.role), ["assistant"]);
    assert.equal(f.state.entries.length, 2);
  });
}

for (const [name, setup] of [
  ["same text but no receipt", (f) => { f.add(user()); }],
  ["prior unresolved user before current admission", (f) => { f.add(user("Unresolved", "old:user")); f.adopt(f.add(user())); }],
  ["earlier admission with a later unresolved user", (f) => { f.adopt(f.add(user())); f.add(user("Another user", "next:user")); }],
]) {
  test(`rejects unresolved history (${name}) with /new guidance`, async () => {
    const f = fixture();
    setup(f);
    await assert.rejects(f.prepare(), /\/new/);
    assertNoWrites(f);
  });
}

for (const [field, value] of [
  ["agentId", "other"], ["sessionId", "other"], ["sessionKey", "agent:main:chat:other"],
  ["entryId", "not-visible"], ["idempotencyKey", "other:user"], ["role", "assistant"],
]) {
  test(`rejects a mismatched pre-admission receipt ${field}`, async () => {
    const f = fixture();
    f.adopt(f.add(user()), { [field]: value });
    await assert.rejects(f.prepare());
    assertNoWrites(f);
  });
}

test("receipt identity cannot authorize a scoped row with different canonical user text", async () => {
  const f = fixture();
  f.adopt(f.add(user()));
  f.state.entries[0].message.content[0].text = "Different scoped prompt";
  await assert.rejects(f.prepare());
  assertNoWrites(f);
});

test("recorder hasPersisted alone does not replace an admission receipt", async () => {
  const f = fixture();
  f.adopt(f.add(user()));
  f.state.receipt = undefined;
  await assert.rejects(f.prepare());
  assertNoWrites(f);
});

for (const [field, value] of [
  ["agentId", "other"], ["sessionId", "rebound"], ["sessionKey", "agent:main:chat:other"],
  ["entryId", "not-in-scoped-read"], ["idempotencyKey", "different:user"],
]) {
  test(`revalidates ${field} on the receipt returned from user persistence`, async () => {
    const f = fixture();
    const transcript = await f.prepare();
    f.state.afterUserPersist = (result) => {
      f.state.receipt = { ...result.admission, [field]: value };
      result.admission = f.state.receipt;
    };
    await assert.rejects(transcript.persistUser());
    assert.throws(() => transcript.markSentToProvider());
    assert.equal(f.calls.sent.length, 0);
    assert.equal(f.calls.strict.length, 0);
  });
}

test("revalidates scoped history between preparation and user persistence", async () => {
  const f = fixture();
  const transcript = await f.prepare();
  const readsBefore = f.calls.read.length;
  f.add(user("An unresolved concurrent turn", "other:user"));
  await assert.rejects(transcript.persistUser(), /\/new/);
  assert.ok(f.calls.read.length > readsBefore);
  assertNoWrites(f);
});

test("revalidates a recorder receipt changed after preparation", async () => {
  const f = fixture();
  f.adopt(f.add(user()));
  const transcript = await f.prepare();
  f.state.receipt = { ...f.state.receipt, sessionId: "rebound" };
  await assert.rejects(transcript.persistUser());
  assert.throws(() => transcript.markSentToProvider());
  assert.equal(f.calls.sent.length, 0);
  assert.equal(f.calls.publish.length, 0);
});

test("rejects a persisted user that is not present in the authoritative scoped read", async () => {
  const f = fixture();
  const transcript = await f.prepare();
  f.state.afterUserPersist = () => { f.state.entries.length = 0; };
  await assert.rejects(transcript.persistUser());
  assert.throws(() => transcript.markSentToProvider());
  assert.equal(f.calls.sent.length, 0);
  assert.equal(f.calls.strict.length, 0);
});

test("completed current run replays canonical assistant without hooks, duplication or publication", async () => {
  const f = fixture();
  f.adopt(f.add(user()));
  const existing = f.add(assistant("Already persisted", ASSISTANT_KEY));
  f.state.onHook = () => assert.fail("Idempotent replay must bypass the write hook");
  const transcript = await f.ready();
  const before = clone(transcript.messages);
  const result = await transcript.persistAssistant(assistant("New candidate must not replace the row"));
  assert.equal(result.owned, true);
  assert.equal(result.idempotencyKey, ASSISTANT_KEY);
  assert.deepEqual(result.message, existing.message);
  assert.deepEqual(transcript.getAssistantPersistence(), result);
  assert.deepEqual(transcript.messages, before);
  assert.equal(f.calls.hook.length, 0);
  assert.equal(f.calls.publish.length, 0);
  assert.equal(f.state.entries.length, 2);
});

test("strict idempotency scan wins a race before the synchronous hook", async () => {
  const f = fixture();
  const transcript = await f.ready();
  const publicationsBefore = f.calls.publish.length;
  const hooksBefore = f.calls.hook.length;
  f.state.beforeStrict = () => { f.add(assistant("Race winner", ASSISTANT_KEY)); };
  f.state.onHook = () => assert.fail("Duplicate must be detected before hook preparation");
  const result = await transcript.persistAssistant(assistant("Race loser"));
  assert.equal(result.owned, true);
  assert.equal(textOf(result.message), "Race winner");
  assert.equal(f.calls.hook.length, hooksBefore);
  assert.equal(f.calls.publish.length, publicationsBefore);
  assert.deepEqual(mirror(transcript.messages), [["user", PROMPT], ["assistant", "Race winner"]]);
  assert.equal(f.state.entries.length, 2);
});

test("concurrent user persistence is single-flight and publishes one new row", async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  f.state.beforeUserPersist = async () => { entered.resolve(); await release.promise; };
  const transcript = await f.prepare();
  const pending = Array.from({ length: 5 }, () => transcript.persistUser());
  const settled = Promise.all(pending);
  try {
    await Promise.race([entered.promise, settled.then(() => assert.fail("Recorder persistence was bypassed"))]);
    assert.equal(f.calls.persist.length, 1);
    assert.deepEqual(transcript.messages, []);
    assert.throws(() => transcript.markSentToProvider());
  } finally {
    release.resolve();
  }
  await settled;
  await transcript.persistUser();
  assert.equal(f.calls.persist.length, 1);
  assert.equal(f.calls.publish.length, 1);
  assert.equal(f.state.entries.length, 1);
  assert.deepEqual(mirror(transcript.messages), [["user", PROMPT]]);
});

test("assistant writes are single-flight and expose only authoritative transformed persistence", async () => {
  const f = fixture();
  const transcript = await f.ready();
  const live = transcript.messages;
  const entered = deferred();
  const release = deferred();
  const input = assistant("Private candidate");
  const before = clone(input);
  f.state.onHook = ({ message }) => {
    message.content[0].text = "Hook rewrite";
    return message;
  };
  f.state.transformAssistant = (message) => ({ ...message, content: [{ type: "text", text: "[redacted durable reply]" }] });
  f.state.beforeAssistantCommit = async () => { entered.resolve(); await release.promise; };
  const hooksBefore = f.calls.hook.length;
  const pending = Array.from({ length: 5 }, () => transcript.persistAssistant(input));
  const settled = Promise.all(pending);
  try {
    await Promise.race([entered.promise, settled.then(() => assert.fail("Strict persistence was bypassed"))]);
    assert.equal(f.calls.strict.length, 1);
    assert.equal(f.calls.hook.length, hooksBefore + 1);
    assert.deepEqual(mirror(live), [["user", PROMPT]]);
    assert.equal(transcript.getAssistantPersistence(), undefined, "an in-flight append is not an owned decision");
  } finally {
    release.resolve();
  }
  const results = await settled;
  for (const result of results) {
    assert.equal(result.owned, true);
    assert.deepEqual(result.message, f.state.entries[1].message);
    assert.equal(textOf(result.message), "[redacted durable reply]");
  }
  await transcript.persistAssistant(assistant("Late retry"));
  assert.equal(f.calls.strict.length, 1);
  assert.equal(f.calls.publish.length, 2);
  assert.equal(transcript.messages, live);
  assert.deepEqual(mirror(live), [["user", PROMPT], ["assistant", "[redacted durable reply]"]]);
  assert.deepEqual(input, before, "mutating hooks cannot mutate the caller's assistant");
});

test("assistant ownership key is adapter-owned without mutating a caller-provided key", async () => {
  const f = fixture();
  const transcript = await f.ready();
  const input = assistant("Answer", "caller-owned-key");
  const original = clone(input);
  const result = await transcript.persistAssistant(input);
  assert.equal(result.idempotencyKey, ASSISTANT_KEY);
  assert.equal(result.message.idempotencyKey, ASSISTANT_KEY);
  assert.deepEqual(input, original);
});

test("a null hook reports explicit owned suppression for terminal /new handling without a fabricated row", async () => {
  const f = fixture();
  const transcript = await f.ready();
  const hooksBefore = f.calls.hook.length;
  f.state.onHook = () => null;
  const results = await Promise.all([
    transcript.persistAssistant(assistant()), transcript.persistAssistant(assistant()),
  ]);
  for (const result of results) {
    assert.deepEqual(result, { owned: true, message: undefined, suppressed: true });
  }
  assert.deepEqual(transcript.getAssistantPersistence(), results[0]);
  assert.deepEqual(await transcript.persistAssistant(assistant("Retry")), results[0]);
  assert.equal(f.calls.hook.length, hooksBefore + 1);
  assert.equal(f.calls.strict.length, 1);
  assert.equal(f.calls.publish.length, 1);
  assert.equal(f.state.entries.length, 1);
  assert.deepEqual(mirror(transcript.messages), [["user", PROMPT]]);
  assert.deepEqual(f.calls.forbidden, [], "deliberate omission must not trigger host fallback persistence");
});

test("suppression remains an unresolved mirror requiring /new rather than permitting continued native replay", async () => {
  const f = fixture();
  const transcript = await f.ready();
  f.state.onHook = () => null;
  const result = await transcript.persistAssistant(assistant());
  assert.deepEqual(result, { owned: true, message: undefined, suppressed: true });
  const next = fixture({ runId: "run-2" });
  next.add(f.state.entries[0].message);
  next.state.resolved = user("Next user prompt", "run-2:user");
  next.p.prompt = "Next user prompt";
  next.adopt(next.add(next.state.resolved));
  await assert.rejects(next.prepare(), /earlier unresolved user.*\/new/);
  assertNoWrites(next);
});

for (const [name, configure] of [
  ["bare suppression without hook", (f) => { f.state.strictOutcome = { kind: "suppressed" }; }],
  ["session rebound", (f) => { f.state.strictOutcome = { kind: "rejected", reason: "session-rebound" }; }],
  ["strict append throw", (f) => { f.state.beforeStrict = () => { throw new Error("strict write failed"); }; }],
  ["write hook throw", (f) => { f.state.onHook = () => { throw new Error("hook failed"); }; }],
]) {
  test(`does not claim ownership after ${name}`, async () => {
    const f = fixture();
    const transcript = await f.ready();
    configure(f);
    await assert.rejects(transcript.persistAssistant(assistant()));
    assert.equal(transcript.getAssistantPersistence(), undefined);
    assert.equal(f.calls.publish.length, 1);
    assert.equal(f.state.entries.length, 1);
    assert.deepEqual(mirror(transcript.messages), [["user", PROMPT]]);
  });
}

test("undefined hook output is not equivalent to explicit null suppression", async () => {
  const f = fixture();
  const transcript = await f.ready();
  f.state.onHook = () => undefined;
  await assert.rejects(transcript.persistAssistant(assistant()));
  assert.equal(f.state.entries.length, 1);
  assert.equal(f.calls.publish.length, 1);
});

for (const [name, transform] of [
  ["wrong role", (message) => ({ ...message, role: "user" })],
  ["wrong key", (message) => ({ ...message, idempotencyKey: "foreign:assistant" })],
  ["missing key", (message) => { const result = { ...message }; delete result.idempotencyKey; return result; }],
]) {
  test(`rejects strict persisted assistant with ${name}`, async () => {
    const f = fixture();
    const transcript = await f.ready();
    f.state.transformAssistant = transform;
    await assert.rejects(transcript.persistAssistant(assistant()));
    assert.equal(transcript.getAssistantPersistence(), undefined);
    assert.equal(f.calls.publish.length, 1);
    assert.deepEqual(mirror(transcript.messages), [["user", PROMPT]]);
  });
}

for (const [name, change] of [
  ["missing canonical row", (f) => { f.state.entries.pop(); }],
  ["different canonical row", (f) => { f.state.entries.at(-1).message.content[0].text = "Different stored reply"; }],
  ["wrong result entry ID", (_f, outcome) => { outcome.result.messageId = "missing-entry"; }],
]) {
  test(`the ownership getter stays unset after ${name} fails verification`, async () => {
    const f = fixture();
    const transcript = await f.ready();
    f.state.afterAssistantCommit = (outcome) => change(f, outcome);
    await assert.rejects(transcript.persistAssistant(assistant()), /does not match the scoped visible transcript/);
    assert.equal(transcript.getAssistantPersistence(), undefined);
    assert.equal(f.calls.publish.length, 1);
    assert.deepEqual(mirror(transcript.messages), [["user", PROMPT]]);
  });
}

for (const role of ["user", "assistant"]) {
  test(`${role} publication failure retries publication only, with persisted live snapshot retained`, async () => {
    const f = fixture();
    const transcript = role === "assistant" ? await f.ready() : await f.prepare();
    const live = transcript.messages;
    const input = assistant();
    const persist = () => role === "assistant" ? transcript.persistAssistant(input) : transcript.persistUser();
    let failed = false;
    f.state.beforePublish = ({ update }) => {
      if (update.message.role === role && !failed) {
        failed = true;
        throw new Error("publication unavailable");
      }
    };
    await assert.rejects(persist(), /publication unavailable/);
    assert.equal(transcript.messages, live);
    assert.equal(live.at(-1).role, role);
    assert.equal(textOf(live.at(-1)), role === "user" ? PROMPT : "Answer");
    const committed = transcript.getAssistantPersistence();
    assert.deepEqual(committed, role === "assistant"
      ? { owned: true, idempotencyKey: ASSISTANT_KEY, message: f.state.entries.at(-1).message }
      : undefined);
    const writes = { persist: f.calls.persist.length, strict: f.calls.strict.length, hook: f.calls.hook.length };
    const publications = f.calls.publish.length;
    const result = await persist();
    if (role === "assistant") assert.deepEqual(result, committed);
    assert.equal(f.calls.persist.length, writes.persist);
    assert.equal(f.calls.strict.length, writes.strict);
    assert.equal(f.calls.hook.length, writes.hook);
    assert.equal(f.calls.publish.length, publications + 1);
    assert.deepEqual(f.calls.publish.at(-1), f.calls.publish.at(-2));
    await persist();
    assert.equal(f.calls.publish.length, publications + 1);
  });
}

test("committed assistant publication failure retains exact getter ownership independently of authority", async () => {
  const f = fixture();
  const transcript = await f.ready();
  const { getAssistantPersistence } = transcript;
  assert.equal(getAssistantPersistence(), undefined);
  f.state.transformAssistant = (message) => ({ ...message, content: [{ type: "text", text: "Canonical redaction" }] });
  const notificationError = new Error("assistant notification failed after commit");
  f.state.beforePublish = ({ update }) => {
    assert.equal(update.message.role, "assistant");
    assert.deepEqual(getAssistantPersistence(), {
      owned: true, idempotencyKey: ASSISTANT_KEY, message: update.message,
    }, "ownership must already be committed before notification");
    throw notificationError;
  };
  await assert.rejects(transcript.persistAssistant(assistant("Private candidate", "caller-key")), (error) => error === notificationError);
  const expected = { owned: true, idempotencyKey: ASSISTANT_KEY, message: clone(f.state.entries.at(-1).message) };
  assert.equal(textOf(expected.message), "Canonical redaction");
  const events = [...f.state.events];
  const cancelled = new Error("cancelled after publication failure");
  f.state.activeError = cancelled;
  const committed = getAssistantPersistence();
  assert.deepEqual(committed, expected);
  committed.owned = false;
  committed.idempotencyKey = "caller-mutated-key";
  committed.message.content[0].text = "Caller mutation";
  assert.deepEqual(getAssistantPersistence(), expected, "the getter must defensively clone the committed decision");
  assert.deepEqual(f.state.events, events, "reading ownership must neither assert authority nor invoke the SDK");
  await assert.rejects(transcript.persistAssistant(assistant()), (error) => error === cancelled);
  assert.equal(f.calls.strict.length, 1);
  assert.equal(f.calls.publish.length, 2);
  f.state.activeError = undefined;
  f.state.beforePublish = undefined;
  const retried = await transcript.persistAssistant(assistant("Must not replace canonical reply"));
  assert.deepEqual(retried, expected);
  retried.message.content[0].text = "Another caller mutation";
  assert.deepEqual(getAssistantPersistence(), expected);
  assert.equal(f.calls.strict.length, 1);
  assert.equal(f.calls.publish.length, 3, "only notification is retried");
});

for (const suppressed of [false, true]) {
  test(`a returned ${suppressed ? "suppression" : "assistant"} decision survives a later caller active assertion`, async () => {
    const controller = new AbortController();
    const f = fixture({ abortSignal: controller.signal });
    const transcript = await f.ready();
    if (suppressed) f.state.onHook = () => null;
    const persisted = await transcript.persistAssistant(assistant());
    const { owned, idempotencyKey } = persisted;
    assert.equal(owned, true);
    assert.equal(idempotencyKey, suppressed ? undefined : ASSISTANT_KEY);
    const cancelled = new Error("cancelled after persistence callback returned");
    f.state.activeError = cancelled;
    controller.abort(cancelled);
    assert.throws(f.assertActive, (error) => error === cancelled);
    const events = [...f.state.events];
    assert.deepEqual(transcript.getAssistantPersistence(), persisted);
    assert.deepEqual(f.state.events, events);
    await assert.rejects(transcript.persistAssistant(assistant()), (error) => error === cancelled);
    assert.equal(f.calls.strict.length, 1);
    assert.equal(f.calls.publish.length, suppressed ? 1 : 2);
  });
}

test("already cancelled preparation invokes no recorder or transport async stages", async () => {
  const f = fixture();
  f.state.activeError = new Error("cancelled before preparation");
  await assert.rejects(f.prepare(), /cancelled before preparation/);
  assert.equal(f.calls.resolve.length, 0);
  assert.equal(f.calls.read.length, 0);
  assertNoWrites(f);
});

test("cancellation after resolved user prevents every later asynchronous stage", async () => {
  const f = fixture();
  f.state.beforeResolve = () => { f.state.activeError = new Error("cancelled during resolve"); };
  await assert.rejects(f.prepare(), /cancelled during resolve/);
  assertNoWrites(f);
  const index = f.state.events.indexOf("resolve");
  assert.ok(index >= 0);
  assert.equal(f.state.events.slice(index + 1).some((event) => event.startsWith("read:")), false);
});

test("cancellation after initial scoped read prevents persistence", async () => {
  const f = fixture();
  f.state.beforeRead = () => { f.state.activeError = new Error("cancelled during read"); };
  await assert.rejects(f.prepare(), /cancelled during read/);
  assertNoWrites(f);
});

test("cancellation during persistence revalidation prevents recorder writes", async () => {
  const f = fixture();
  const transcript = await f.prepare();
  f.state.beforeRead = () => { f.state.activeError = new Error("cancelled during revalidation"); };
  await assert.rejects(transcript.persistUser(), /cancelled during revalidation/);
  assertNoWrites(f);
});

test("cancellation after user commit prevents publication, provider mark and assistant writes", async () => {
  const f = fixture();
  const transcript = await f.prepare();
  f.state.afterUserPersist = () => { f.state.activeError = new Error("cancelled after user commit"); };
  await assert.rejects(transcript.persistUser(), /cancelled after user commit/);
  assert.throws(() => transcript.markSentToProvider(), /cancelled|persist/i);
  await assert.rejects(transcript.persistAssistant(assistant()));
  assert.equal(f.calls.publish.length, 0);
  assert.equal(f.calls.sent.length, 0);
  assert.equal(f.calls.strict.length, 0);
  assert.equal(f.state.entries.length, 1);
});

test("cancellation before provider mark never calls the recorder mark", async () => {
  const f = fixture();
  const transcript = await f.prepare();
  await transcript.persistUser();
  f.state.activeError = new Error("cancelled before send");
  assert.throws(() => transcript.markSentToProvider(), /cancelled before send/);
  assert.equal(f.calls.sent.length, 0);
});

test("cancellation before assistant persistence never calls strict append or hook", async () => {
  const f = fixture();
  const transcript = await f.ready();
  const hooks = f.calls.hook.length;
  f.state.activeError = new Error("cancelled before assistant");
  await assert.rejects(transcript.persistAssistant(assistant()), /cancelled before assistant/);
  assert.equal(f.calls.strict.length, 0);
  assert.equal(f.calls.hook.length, hooks);
});

test("synchronous strict preparation checks cancellation before invoking the hook", async () => {
  const f = fixture();
  const transcript = await f.ready();
  const hooks = f.calls.hook.length;
  f.state.beforeStrict = () => { f.state.activeError = new Error("cancelled inside strict append"); };
  await assert.rejects(transcript.persistAssistant(assistant()), /cancelled inside strict append/);
  assert.equal(f.calls.hook.length, hooks);
  assert.equal(f.state.entries.length, 1);
  assert.equal(f.calls.publish.length, 1);
});

test("cancellation inside synchronous assistant hook prevents the append", async () => {
  const f = fixture();
  const transcript = await f.ready();
  f.state.onHook = ({ message }) => {
    f.state.activeError = new Error("cancelled inside hook");
    return message;
  };
  await assert.rejects(transcript.persistAssistant(assistant()), /cancelled inside hook/);
  assert.equal(f.state.entries.length, 1);
  assert.equal(f.calls.publish.length, 1);
});

test("cancellation inside a suppressing hook still rejects instead of reporting owned suppression", async () => {
  const f = fixture();
  const transcript = await f.ready();
  f.state.onHook = () => {
    f.state.activeError = new Error("cancelled inside suppressing hook");
    return null;
  };
  await assert.rejects(transcript.persistAssistant(assistant()), /cancelled inside suppressing hook/);
  assert.equal(f.state.entries.length, 1);
  assert.equal(f.calls.publish.length, 1);
});

test("cancellation after append but before canonical verification prevents publication and verified ownership", async () => {
  const f = fixture();
  const transcript = await f.ready();
  f.state.afterAssistantCommit = () => { f.state.activeError = new Error("cancelled after assistant commit"); };
  await assert.rejects(transcript.persistAssistant(assistant()), /cancelled after assistant commit/);
  assert.equal(transcript.getAssistantPersistence(), undefined);
  assert.equal(f.state.entries.length, 2);
  assert.equal(f.calls.publish.length, 1);
});

test("checks cancellation after publication resolves and forbids further writes", async () => {
  const f = fixture();
  const transcript = await f.ready();
  f.state.beforePublish = ({ update }) => {
    if (update.message.role === "assistant") f.state.activeError = new Error("cancelled during publication");
  };
  await assert.rejects(transcript.persistAssistant(assistant()), /cancelled during publication/);
  const expected = { owned: true, idempotencyKey: ASSISTANT_KEY, message: clone(f.state.entries.at(-1).message) };
  assert.deepEqual(transcript.getAssistantPersistence(), expected);
  const writes = f.calls.strict.length;
  const publications = f.calls.publish.length;
  await assert.rejects(transcript.persistAssistant(assistant()), /cancelled during publication/);
  assert.deepEqual(transcript.getAssistantPersistence(), expected);
  assert.equal(f.calls.strict.length, writes);
  assert.equal(f.calls.publish.length, publications);
});

test("uses the installed public JS-only export and real assistant preparation helper", async () => {
  const modulePath = "openclaw/plugin-sdk/session-transcript-runtime";
  const [runtime, harness] = await Promise.all([
    import(modulePath), import("openclaw/plugin-sdk/agent-harness-runtime"),
  ]);
  for (const name of METHODS.slice(0, 3)) assert.equal(typeof runtime[name], "function");
  for (const suppress of [false, true]) {
    let preparations = 0;
    const f = fixture({
      prepareAssistantTranscriptMessage: (message, sourceText) => {
        preparations++;
        assert.equal(sourceText, "Answer");
        assert.equal(message.role, "assistant");
        return suppress ? null : { ...message, content: [{ type: "text", text: "Canonical SDK preparation" }] };
      },
    });
    f.transport.runAgentHarnessBeforeMessageWriteHook = harness.runAgentHarnessBeforeMessageWriteHook;
    const transcript = await f.ready();
    const result = await transcript.persistAssistant(assistant());
    assert.equal(result.owned, true);
    assert.equal(preparations, 1);
    if (suppress) {
      assert.deepEqual(result, { owned: true, message: undefined, suppressed: true });
      assert.equal(transcript.messages.length, 1);
    } else {
      assert.equal(result.suppressed, undefined);
      assert.equal(textOf(result.message), "Canonical SDK preparation");
      assert.equal(result.idempotencyKey, ASSISTANT_KEY);
    }
  }
});

test("accepts host runtime persistence returning undefined only with its verified admission", async () => {
  const f = fixture();
  f.adopt(f.add(user()));
  f.recorder.persistApproved = async (params) => {
    f.calls.persist.push(params);
    return undefined;
  };
  const transcript = await f.ready();
  assert.equal(f.calls.persist.length, 1);
  assert.equal(f.calls.publish.length, 0);
  assert.equal((await transcript.persistAssistant(assistant())).owned, true);
});

test("does not race another runtime's pending user persistence", async () => {
  const f = fixture();
  f.state.runtimePersistencePending = Promise.resolve();
  await assert.rejects(f.prepare(), /pending user persistence/);
  assertNoWrites(f);
});

test("propagates user persistence failures and never retries or submits", async () => {
  const f = fixture();
  const transcript = await f.prepare();
  f.state.beforeUserPersist = () => { throw new Error("recorder write failed"); };
  await assert.rejects(transcript.persistUser(), /recorder write failed/);
  await assert.rejects(transcript.persistUser(), /recorder write failed/);
  assert.equal(f.calls.persist.length, 1);
  assert.throws(() => transcript.markSentToProvider());
  assert.equal(f.calls.sent.length, 0);
  assert.equal(f.calls.strict.length, 0);
  assert.equal(f.calls.publish.length, 0);
});

for (const [field, value] of [
  ["activeMessagePosition", 99], ["effectiveParentId", "foreign-parent"],
  ["logicalTurnId", ""], ["generation", ""], ["storePath", ""],
]) {
  test(`rejects invalid authoritative receipt ${field}`, async () => {
    const f = fixture();
    f.adopt(f.add(user()), { [field]: value });
    await assert.rejects(f.prepare(), /receipt/);
    assertNoWrites(f);
  });
}

for (const suppress of [false, true]) {
  test(`rejects in-place admission mutation during ${suppress ? "suppression" : "assistant persistence"}`, async () => {
    const f = fixture();
    const transcript = await f.ready();
    f.state.onHook = ({ message }) => {
      f.state.receipt.logicalTurnId = "replacement-admission";
      return suppress ? null : message;
    };
    await assert.rejects(transcript.persistAssistant(assistant()), /admission changed/);
    assert.equal(f.calls.publish.length, 1);
  });
}

test("snapshots admission identity before provider submission", async () => {
  const f = fixture();
  const transcript = await f.prepare();
  await transcript.persistUser();
  f.state.receipt.logicalTurnId = "mutated-after-persistence";
  assert.throws(() => transcript.markSentToProvider(), /admission changed/);
  assert.equal(f.calls.sent.length, 0);
});
