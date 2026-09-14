import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { createNativeHarness } from "../dist/native/harness.js";
import { createNativeToolHost } from "../dist/native/host.js";

/** @typedef {import("openclaw/plugin-sdk/agent-harness").AgentHarnessV2} AgentHarnessV2 */
/** @typedef {Parameters<AgentHarnessV2["runAttempt"]>[0]} Attempt */
/** @typedef {Awaited<ReturnType<AgentHarnessV2["runAttempt"]>>} Result */

const config = {
  stateDir: resolve("artifacts", "native-harness-fixture"),
  startupTimeoutMs: 1000,
  shutdownTimeoutMs: 1000,
  streamIdleTimeoutMs: 1000,
  allowedBaseUrls: [],
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => Promise.withResolvers();

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function fixture(t, overrides = {}) {
  const f = {
    events: [],
    errors: {},
    replyAbort: new AbortController(),
    entered: deferred(),
    counts: { startedCount: 0, completedCount: 0, activeCount: 0 },
    replay: { hadPotentialSideEffects: false, replaySafe: true },
    output: {
      sessionId: "dsh-private-session-not-the-openclaw-session",
      text: "Native answer",
      reasoning: "Private reasoning",
      usage: { input: 101, output: 7, cacheRead: 11, cacheWrite: 3 },
      stopReason: "stop",
      toolCalls: 999,
    },
  };
  f.spy = (name, implementation = () => {}) => t.mock.fn((...args) => {
    f.events.push(name);
    if (Object.hasOwn(f.errors, name)) throw f.errors[name];
    return implementation(...args);
  });
  f.p = /** @type {Attempt} */ ({
    sessionId: "openclaw-session",
    sessionKey: "agent:main:harness-fixture",
    agentId: "main",
    runId: "openclaw-run",
    sessionFile: resolve(config.stateDir, "session.jsonl"),
    workspaceDir: process.cwd(),
    prompt: "Prepared user request",
    timeoutMs: 5000,
    startedAtMs: 123,
    lifecycleGeneration: 7,
    agentHarnessId: "dsh-native",
    agentHarnessRuntimeOverride: "dsh-native",
    provider: "deepseek",
    modelId: "operator-alias",
    resolvedApiKey: "fixture-not-a-real-api-key",
    thinkLevel: "high",
    reasoningLevel: "stream",
    config: {},
    model: {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      provider: "deepseek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 2, output: 3, cacheRead: 1, cacheWrite: 4 },
      contextWindow: 1_000_000,
      maxTokens: 4096,
    },
    hostCapabilities: {
      kind: "agent-harness-host-capability",
      version: 1,
      assertActive() {},
      bindToolSurface: (tools) => tools,
      reportOutputTokens: f.spy("reportOutputTokens"),
    },
    permissionChange: {
      owner: {},
      baseExecOverrides: {},
      request: f.spy("permissionRequest", async () => false),
      applied: f.spy("permissionApplied", () => true),
      recordApplied: f.spy("permissionRecordApplied"),
    },
    replyOperation: {
      abortSignal: f.replyAbort.signal,
      attachBackend: f.spy("attach", (handle) => { f.attachedHandle = handle; }),
      detachBackend: f.spy("detach"),
      setPhase: f.spy("setPhase"),
      recordActivity: f.spy("activity"),
    },
    onAttemptAbort: f.spy("attemptAbort"),
    onAttemptTimeout: f.spy("attemptTimeout"),
    onAttemptTimeoutArmed: f.spy("timeoutArmed"),
    onAttemptDeadlineChanged: f.spy("deadline"),
    onExecutionStarted: f.spy("executionStarted"),
    onExecutionPhase: f.spy("executionPhase"),
    onRunProgress: f.spy("progress"),
    onAssistantMessageStart: f.spy("assistantStart"),
    onPartialReply: f.spy("partialReply"),
    onReasoningStream: f.spy("reasoningStream"),
    onReasoningEnd: f.spy("reasoningEnd"),
    onAgentEvent: f.spy("agentEvent"),
    onToolStreamBoundary: f.spy("toolBoundary"),
    ...overrides,
  });
  f.sdk = {
    getModelProviderRequestTransport: () => undefined,
    setActiveEmbeddedRun: f.spy("register", (_sessionId, handle) => { f.handle = handle; }),
    clearActiveEmbeddedRun: f.spy("clear"),
    emitAgentEvent: f.spy("emitAgentEvent"),
    runAgentHarnessLlmInputHook: f.spy("inputHook"),
    runAgentHarnessLlmOutputHook: f.spy("outputHook"),
    runAgentHarnessBeforeAgentFinalizeHook: f.spy("finalizeHook", async () => ({ action: "continue" })),
    awaitAgentHarnessAgentEndHook: f.spy("endHook", async () => {}),
  };
  f.host = {
    systemPrompt: "Host-owned system prompt",
    prompt: f.p.prompt,
    tools: [],
    executeTool: f.spy("executeTool", async () => ({ text: "tool result", isError: false })),
    getReplayState: () => ({ ...f.replay }),
    getToolCounts: () => ({ ...f.counts }),
    dispose: f.spy("hostDispose", async () => {}),
  };
  f.transcript = {
    messages: [
      { role: "user", content: "Earlier request", timestamp: 1 },
      { role: "user", content: f.p.prompt, timestamp: 2 },
    ],
    persistUser: f.spy("persistUser", async () => {}),
    markSentToProvider: f.spy("sentToProvider"),
    persistAssistant: f.spy("persistAssistant", async (assistant) => {
      const idempotencyKey = `dsh-native:${f.p.runId}:assistant`;
      const message = { ...structuredClone(assistant), idempotencyKey };
      f.transcript.messages.push(message);
      return { owned: true, idempotencyKey, message };
    }),
  };
  f.runtime = {
    run: f.spy("runtimeRun", async (input) => {
      f.input = input;
      f.entered.resolve(input);
      return f.run ? f.run(input) : f.output;
    }),
    dispose: f.spy("runtimeDispose", async () => {}),
  };
  f.dependencies = {
    loadSdk: f.spy("loadSdk", async () => f.sdk),
    prepareTranscript: f.spy("prepareTranscript", async () => f.transcript),
    prepareHost: f.spy("prepareHost", async () => f.host),
  };
  /** @type {AgentHarnessV2} */
  f.harness = createNativeHarness(config, f.runtime, f.dependencies);
  t.after(() => f.harness.dispose());
  return f;
}

test("only absent session-control tools are declared safe to deny", async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.harness.conversationToolPolicySafeDenyTools, [
    "sessions_list", "sessions_history", "sessions_send", "session_status",
  ]);
  assert.equal(f.harness.conversationToolPolicySupport, "exact");
  assert.equal(f.harness.conversationToolPolicySafeDenyTools.includes("exec"), false);
  assert.equal(f.harness.conversationToolPolicySafeDenyTools.includes("*"), false);
  const result = await f.harness.runAttempt({ ...f.p, pluginHarnessToolPolicyRestricted: true });
  assert.equal(result.terminal.kind, "failed");
  assert.match(result.terminal.error.message, /explicit tool-policy restriction/);
  assert.equal(f.runtime.run.mock.callCount(), 0);
  assert.equal(f.dependencies.prepareHost.mock.callCount(), 0);
});

/** @param {Result} result */
function noCompletedAssistant(result) {
  assert.deepEqual(result.assistantTexts, []);
  assert.equal(result.currentAttemptCompletedAssistant, undefined);
}

function noMirrorOwnership(result) {
  assert.equal(Object.hasOwn(result, "assistantTranscriptOwned"), false);
  assert.equal(Object.hasOwn(result, "assistantTranscriptIdempotencyKey"), false);
}

test("committed mirror ownership survives publication failure", async (t) => {
  const f = fixture(t);
  let committed;
  f.transcript.getAssistantPersistence = () => committed;
  f.transcript.persistAssistant = async (assistant) => {
    const idempotencyKey = `dsh-native:${f.p.runId}:assistant`;
    const message = { ...assistant, idempotencyKey };
    f.transcript.messages.push(message);
    committed = { owned: true, idempotencyKey, message };
    throw new Error("notification failed after authoritative commit");
  };
  const result = await f.harness.runAttempt(f.p);
  assert.equal(result.terminal.kind, "failed");
  assert.equal(result.assistantTranscriptOwned, true);
  assert.equal(result.assistantTranscriptIdempotencyKey, committed.idempotencyKey);
  assert.equal(result.lastAssistant, committed.message);
  assert.equal(result.replayMetadata.replaySafe, false);
  noCompletedAssistant(result);
});

test("continuity is checked before submitting an approved user turn", async (t) => {
  const f = fixture(t);
  f.dependencies.prepareContinuity = () => { throw new Error("missing native history; /new"); };
  const result = await f.harness.runAttempt(f.p);
  assert.equal(result.terminal.kind, "failed");
  assert.match(result.terminal.error.message, /missing native history/);
  assert.equal(f.runtime.run.mock.callCount(), 0);
  assert.equal(f.transcript.persistUser.mock.callCount(), 0);
});

function before(f, first, second) {
  assert.ok(f.events.includes(first), `missing ${first}`);
  assert.ok(f.events.includes(second), `missing ${second}`);
  assert.ok(f.events.indexOf(first) < f.events.indexOf(second), `${first} must precede ${second}`);
}

function installRealTools(f, tools) {
  const wrapped = new WeakSet();
  const adjusted = new Map();
  f.p.hostCapabilities.bindToolSurface = (surface) => surface.map((tool) => {
    const bound = {
      ...tool,
      execute: async (id, args, signal) => {
        adjusted.set(id, args);
        return tool.execute(id, args, signal);
      },
    };
    wrapped.add(bound);
    return bound;
  });
  f.dependencies.prepareHost = f.spy("prepareHost", async (p, signal, assertActive) => {
    const toolHost = createNativeToolHost({
      tools,
      signal,
      assertActive,
      runId: p.runId,
      sessionId: p.sessionId,
      sessionKey: p.sessionKey,
      cwd: p.workspaceDir,
      bindToolSurface: p.hostCapabilities.bindToolSurface,
      initialReplayState: p.initialReplayState,
      runtime: {
        isAgentToolReplaySafe: (tool) => tool.name === "read",
        getPluginToolMeta: () => undefined,
        getChannelAgentToolMeta: () => undefined,
        isToolWrappedWithBeforeToolCallHook: (tool) => wrapped.has(tool),
        consumeAdjustedParamsForToolCall: (id) => {
          const args = adjusted.get(id);
          adjusted.delete(id);
          return args;
        },
        consumePreExecutionBlockedToolCall: () => false,
        runAgentHarnessAfterToolCallHook: f.spy("afterTool", async () => {}),
        isToolResultError: (result) => result?.isError === true,
        formatToolExecutionErrorMessage: (error) => error.message,
        getBeforeToolCallFailureDisposition: () => undefined,
      },
    });
    Object.assign(f.host, toolHost);
    return f.host;
  });
}

function tool(name, execute) {
  return {
    name,
    label: name,
    description: `Fixture ${name}`,
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    execute,
  };
}

test("construction is deferred and support is strictly opt-in", async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.events, []);
  await tick();
  assert.deepEqual(f.events, []);
  assert.equal(f.harness.id, "dsh-native");
  assert.deepEqual(f.harness.autoSelection, { providerIds: [] });
  const support = {
    provider: "deepseek",
    modelId: f.p.model.id,
    modelProvider: { api: f.p.model.api, baseUrl: f.p.model.baseUrl },
  };
  for (const requestedRuntime of [undefined, "auto", "openclaw", "dsh"]) {
    assert.equal(f.harness.supports({ ...support, requestedRuntime }).supported, false);
  }
  assert.equal(f.harness.supports({ ...support, requestedRuntime: "dsh-native" }).supported, true);
  assert.deepEqual(f.events, []);
});

test("returns the V2 result with OpenClaw identity, canonical assistant usage and unpriced billing", async (t) => {
  const f = fixture(t);
  const started = Date.now();
  const result = await f.harness.runAttempt(f.p);
  assert.deepEqual(result.terminal, { kind: "ok" });
  assert.notEqual(f.p.sessionId, f.output.sessionId);
  assert.equal(result.sessionIdUsed, f.p.sessionId);
  assert.equal(result.sessionFileUsed, f.p.sessionFile);
  assert.equal(result.agentHarnessId, "dsh-native");
  assert.equal(f.input.sessionId, f.p.sessionId);
  assert.equal(f.input.runId, f.p.runId);
  assert.equal(f.input.modelId, f.p.model.id);
  assert.equal(f.input.apiKey, f.p.resolvedApiKey);
  assert.equal(f.input.prompt, f.host.prompt);
  assert.equal(f.input.systemPrompt, f.host.systemPrompt);
  assert.equal(f.input.tools, f.host.tools);
  const assistant = result.currentAttemptCompletedAssistant;
  assert.equal(assistant, result.lastAssistant);
  assert.equal(assistant, result.currentAttemptAssistant);
  assert.equal(assistant.role, "assistant");
  assert.deepEqual(assistant.content, [{ type: "text", text: f.output.text }]);
  assert.equal(assistant.api, f.p.model.api);
  assert.equal(assistant.provider, f.p.provider);
  assert.equal(assistant.model, f.p.model.id);
  assert.equal(assistant.stopReason, "stop");
  assert.ok(assistant.timestamp >= started && assistant.timestamp <= Date.now());
  assert.deepEqual(assistant.usage, {
    ...f.output.usage,
    totalTokens: 122,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  assert.deepEqual(assistant.dshNative, { billing: "unpriced" });
  assert.deepEqual(result.attemptUsage, { ...f.output.usage, total: 122 });
  assert.deepEqual(result.assistantTexts, [f.output.text]);
  assert.equal(result.messagesSnapshot.at(-1), assistant);
  assert.equal(result.assistantTranscriptOwned, true);
  assert.equal(result.assistantTranscriptIdempotencyKey, `dsh-native:${f.p.runId}:assistant`);
  assert.deepEqual(result.toolMetas, []);
  assert.deepEqual(result.itemLifecycle, { startedCount: 0, completedCount: 0, activeCount: 0 });
  assert.deepEqual(result.replayMetadata, { hadPotentialSideEffects: false, replaySafe: false });
  assert.equal(result.didSendViaMessagingTool, false);
  assert.deepEqual(result.messagingToolSentTexts, []);
  assert.deepEqual(result.messagingToolSentMediaUrls, []);
  assert.deepEqual(result.messagingToolSentTargets, []);
  assert.equal(f.p.hostCapabilities.reportOutputTokens.mock.callCount(), 0);
});

test("redacted mirror metadata never replaces the executed candidate's attribution", async (t) => {
  const f = fixture(t, { modelId: "selected-alias-that-did-not-run" });
  const persist = f.transcript.persistAssistant;
  f.transcript.persistAssistant = async (message) => persist({
    ...message, provider: "***", model: "***",
    content: [{ type: "text", text: "Host-approved redacted answer" }],
  });
  const result = await f.harness.runAttempt(f.p);
  assert.equal(result.terminal.kind, "ok");
  assert.equal(result.lastAssistant.provider, "***");
  assert.equal(result.lastAssistant.model, "***");
  assert.equal(result.messagesSnapshot.at(-1), result.lastAssistant);
  assert.notEqual(result.currentAttemptAssistant, result.lastAssistant);
  for (const message of [result.currentAttemptAssistant, result.currentAttemptCompletedAssistant]) {
    assert.equal(message.provider, f.p.provider);
    assert.equal(message.model, f.input.modelId);
    assert.deepEqual(message.content, result.lastAssistant.content);
    assert.deepEqual(message.usage, result.lastAssistant.usage);
    assert.equal(message.idempotencyKey, result.lastAssistant.idempotencyKey);
  }
  assert.equal(result.runtimeModelSelection, undefined, "Host-selected routes do not claim native model ownership");
  assert.equal(f.sdk.emitAgentEvent.mock.calls[0].arguments[0].data.text, "Host-approved redacted answer");
});

test("late failures retain executed attribution and redacted persistence without a final event", async (t) => {
  const f = fixture(t);
  const persist = f.transcript.persistAssistant;
  f.transcript.persistAssistant = async (message) => persist({ ...message, provider: "***", model: "***" });
  f.errors.hostDispose = new Error("drain failed");
  const result = await f.harness.runAttempt(f.p);
  assert.equal(result.terminal.kind, "failed");
  assert.equal(result.lastAssistant.provider, "***");
  assert.equal(result.currentAttemptAssistant.provider, f.p.provider);
  assert.equal(result.currentAttemptAssistant.model, f.input.modelId);
  assert.equal(result.assistantTranscriptOwned, true);
  assert.equal(f.sdk.emitAgentEvent.mock.callCount(), 0);
  noCompletedAssistant(result);
});

test("publishes exactly one approved final assistant event after persistence and successful cleanup", async (t) => {
  const f = fixture(t);
  f.run = async (input) => {
    await input.onEvent({ type: "text", text: "Uncommitted partial" });
    await input.onEvent({ type: "reasoning", text: "Private reasoning" });
    assert.equal(f.sdk.emitAgentEvent.mock.callCount(), 0);
    return f.output;
  };
  const persist = f.transcript.persistAssistant;
  f.transcript.persistAssistant = async (message) => persist({
    ...message, content: [{ type: "text", text: "Short approved final" }],
  });
  const result = await f.harness.runAttempt(f.p);
  assert.equal(result.terminal.kind, "ok");
  assert.equal(f.sdk.emitAgentEvent.mock.callCount(), 1);
  assert.deepEqual(f.sdk.emitAgentEvent.mock.calls[0].arguments[0], {
    runId: f.p.runId, sessionId: f.p.sessionId, sessionKey: f.p.sessionKey,
    agentId: f.p.agentId, lifecycleGeneration: f.p.lifecycleGeneration, stream: "assistant",
    data: { text: "Short approved final", delta: "", phase: "final_answer",
      itemId: `dsh-native:${f.p.runId}:assistant` },
  });
  before(f, "persistAssistant", "emitAgentEvent");
  before(f, "endHook", "emitAgentEvent");
  assert.equal(f.p.onPartialReply.mock.callCount(), 1, "Final snapshot must not be duplicated through partial callbacks");
});

test("suppressed live chunks still produce the approved final snapshot", async (t) => {
  const f = fixture(t, { suppressLiveStreamOutput: true });
  f.run = async (input) => {
    await input.onEvent({ type: "text", text: "Uncommitted partial" });
    return f.output;
  };
  assert.equal((await f.harness.runAttempt(f.p)).terminal.kind, "ok");
  assert.equal(f.p.onPartialReply.mock.callCount(), 0);
  assert.equal(f.sdk.emitAgentEvent.mock.callCount(), 1);
  assert.equal(f.sdk.emitAgentEvent.mock.calls[0].arguments[0].data.text, f.output.text);
});

test("silent, hidden and commentary messages never publish a visible final", async (t) => {
  for (const mode of ["silent", "hidden", "commentary"]) {
    await t.test(mode, async (t) => {
      const f = fixture(t, { silentExpected: mode === "silent" });
      const persist = f.transcript.persistAssistant;
      f.transcript.persistAssistant = async (message) => persist({
        ...message, ...(mode === "hidden" ? { display: false } : {}),
        ...(mode === "commentary" ? { phase: "commentary" } : {}),
      });
      f.run = async (input) => {
        if (mode === "silent") {
          await input.onEvent({ type: "text", text: "Silent text" });
          await input.onEvent({ type: "reasoning", text: "Silent reasoning" });
        }
        return f.output;
      };
      assert.equal((await f.harness.runAttempt(f.p)).terminal.kind, "ok");
      assert.equal(f.sdk.emitAgentEvent.mock.callCount(), 0);
      assert.equal(f.p.onPartialReply.mock.callCount(), 0);
      assert.equal(f.p.onReasoningStream.mock.callCount(), 0);
    });
  }
});

test("final event callback failure or cancellation cannot publish a completed reply", async (t) => {
  for (const kind of ["callback", "cancel", "authority", "emitter"]) {
    await t.test(kind, async (t) => {
      const controller = new AbortController();
      const f = fixture(t, { abortSignal: controller.signal });
      const reason = new Error(`final ${kind} failed`);
      f.p.onAgentEvent = async (event) => {
        assert.equal(event.stream, "assistant");
        if (kind === "callback") throw reason;
        if (kind === "cancel") controller.abort(reason);
        if (kind === "authority") f.p.hostCapabilities.assertActive = () => { throw reason; };
      };
      if (kind === "emitter") f.errors.emitAgentEvent = reason;
      const result = await f.harness.runAttempt(f.p);
      assert.equal(result.terminal.kind, kind === "cancel" ? "aborted" : "failed");
      assert.equal(f.sdk.emitAgentEvent.mock.callCount(), kind === "emitter" ? 1 : 0);
      assert.equal(result.assistantTranscriptOwned, true);
      assert.equal(result.replayMetadata.replaySafe, false);
      noCompletedAssistant(result);
    });
  }
});

test("reset and disposal retain ownership while final publication is awaiting a callback", async (t) => {
  for (const action of ["reset", "dispose"]) {
    await t.test(action, async (t) => {
      const f = fixture(t);
      const reached = deferred();
      const finish = deferred();
      f.p.onAgentEvent = async () => { reached.resolve(); await finish.promise; };
      const pending = f.harness.runAttempt(f.p);
      await reached.promise;
      const competing = await f.harness.runAttempt({ ...f.p, runId: "replacement-run" });
      assert.equal(competing.terminal.kind, "failed");
      assert.match(competing.terminal.error.message, /another DSH native attempt/u);
      let drained = false;
      const cleanup = action === "dispose"
        ? f.harness.dispose().then(() => { drained = true; })
        : f.harness.reset({ sessionId: f.p.sessionId, reason: "reset" });
      await tick();
      assert.equal(f.input.signal.aborted, true);
      if (action === "dispose") assert.equal(drained, false, "Disposal must wait for pending publication");
      finish.resolve();
      const result = await pending;
      await cleanup;
      assert.equal(result.terminal.kind, "aborted");
      assert.equal(f.sdk.emitAgentEvent.mock.callCount(), 0);
      noCompletedAssistant(result);
    });
  }
});

test("awaits the public end-hook barrier before final publication", async (t) => {
  const f = fixture(t);
  const reached = deferred();
  const finish = deferred();
  f.sdk.awaitAgentHarnessAgentEndHook = f.spy("endHook", async () => {
    reached.resolve();
    await finish.promise;
  });
  const pending = f.harness.runAttempt(f.p);
  await reached.promise;
  assert.equal(f.sdk.emitAgentEvent.mock.callCount(), 0);
  assert.equal(f.p.onAgentEvent.mock.callCount(), 0);
  finish.resolve();
  assert.equal((await pending).terminal.kind, "ok");
  assert.equal(f.sdk.emitAgentEvent.mock.callCount(), 1);
});

test("accepts the host's default idle permissionChange object and legacy context engine", async (t) => {
  const f = fixture(t, { contextEngine: { info: { id: "legacy", ownsCompaction: false, hostRequirements: {} } } });
  assert.equal((await f.harness.runAttempt(f.p)).terminal.kind, "ok");
  assert.equal(f.p.permissionChange.request.mock.callCount(), 0);
  assert.equal(f.p.permissionChange.applied.mock.callCount(), 0);
  assert.equal(f.p.permissionChange.recordApplied.mock.callCount(), 0);
});

test("a length stop and an explicit finalize hook decision retain the canonical stop reason", async (t) => {
  const f = fixture(t);
  f.output.stopReason = "length";
  f.sdk.runAgentHarnessBeforeAgentFinalizeHook = f.spy("finalizeHook", async () => ({ action: "finalize" }));
  const result = await f.harness.runAttempt(f.p);
  assert.equal(result.terminal.kind, "ok");
  assert.equal(result.currentAttemptCompletedAssistant.stopReason, "length");
  assert.equal(f.runtime.run.mock.callCount(), 1);
});

test("rejects unsupported attempts before SDK loading, host setup or runtime entry", async (t) => {
  const cases = [
    ["missing opt-in", { agentHarnessId: undefined, agentHarnessRuntimeOverride: undefined }, /explicit/u],
    ["conflicting identity", { agentHarnessId: "openclaw" }, /identity/u],
    ["conflicting plan", { runtimePlan: { resolvedRef: { harnessId: "openclaw" } } }, /identity/u],
    ["missing capability", { hostCapabilities: undefined }, /capability/u],
    ["unversioned capability", { hostCapabilities: { kind: "agent-harness-host-capability", version: 2 } }, /capability/u],
    ["custom engine", { contextEngine: { info: { id: "custom", ownsCompaction: false } } }, /context-engine/u],
    ["legacy compaction owner", { contextEngine: { info: { id: "legacy", ownsCompaction: true } } }, /context-engine/u],
    ["legacy host requirements", { contextEngine: { info: { id: "legacy", hostRequirements: { assembly: true } } } }, /context-engine/u],
    ["permission notice", { permissionChange: { notice: "Permission changed" } }, /permission/u],
    ["continuation", { operation: "compact" }, /continuations/u],
    ["suppressed transcript", { suppressAssistantErrorPersistence: true }, /suppression/u],
    ["native ownership", { expectedSessionRuntimeOwnership: { model: "native", auth: "host" } }, /ownership/u],
  ];
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
    cases.push([`invalid timeout ${timeoutMs}`, { timeoutMs }, /timeout/u]);
  }
  for (const [name, overrides, reason] of cases) {
    await t.test(name, async (t) => {
      const f = fixture(t, overrides);
      const result = await f.harness.runAttempt(f.p);
      assert.equal(result.terminal.kind, "failed");
      assert.equal(result.terminal.source, "precheck");
      assert.match(result.terminal.error.message, reason);
      assert.deepEqual(f.events, []);
      noCompletedAssistant(result);
      noMirrorOwnership(result);
    });
  }
});

test("registers and attaches one live handle before provider execution, then cleans it up", async (t) => {
  const f = fixture(t, { taskSuggestionDeliveryMode: "gateway" });
  f.run = async () => {
    assert.equal(f.handle, f.attachedHandle);
    assert.equal(f.handle.runId, f.p.runId);
    assert.equal(f.handle.startedAtMs, f.p.startedAtMs);
    assert.equal(f.handle.taskSuggestionDeliveryMode, "gateway");
    assert.equal(f.handle.isStopped(), false);
    assert.equal(f.handle.isAbortable(), true);
    assert.equal(f.handle.isAborted(), false);
    assert.equal(f.handle.ownsLiveness(), true);
    return f.output;
  };
  assert.equal((await f.harness.runAttempt(f.p)).terminal.kind, "ok");
  assert.deepEqual(f.sdk.setActiveEmbeddedRun.mock.calls[0].arguments,
    [f.p.sessionId, f.handle, f.p.sessionKey, f.p.sessionFile, f.p.agentId]);
  assert.deepEqual(f.sdk.clearActiveEmbeddedRun.mock.calls[0].arguments,
    [f.p.sessionId, f.handle, f.p.sessionKey, f.p.sessionFile, "dsh-native-settled"]);
  assert.deepEqual(f.p.replyOperation.detachBackend.mock.calls[0].arguments, [f.handle]);
  for (const [first, second] of [
    ["register", "attach"], ["attach", "setPhase"], ["setPhase", "prepareTranscript"],
    ["prepareTranscript", "prepareHost"], ["prepareHost", "persistUser"],
    ["persistUser", "inputHook"], ["inputHook", "sentToProvider"], ["sentToProvider", "executionStarted"],
    ["executionStarted", "runtimeRun"], ["hostDispose", "detach"], ["detach", "clear"], ["clear", "endHook"],
  ]) before(f, first, second);
  assert.equal(f.handle.isStopped(), true);
  assert.equal(f.handle.isStreaming(), false);
  assert.equal(f.handle.isAbortable(), false);
  assert.equal(f.handle.ownsLiveness(), false);
  assert.deepEqual(f.p.onExecutionStarted.mock.calls[0].arguments, [{ lifecycleGeneration: 7 }]);
  assert.equal(f.p.onExecutionPhase.mock.calls[0].arguments[0].firstModelCallStarted, true);
});

test("lifecycle setup failure cleans only acquired resources and never invokes the provider", async (t) => {
  for (const [stage, expected] of [
    ["register", []],
    ["attach", ["clear"]],
    ["setPhase", ["detach", "clear"]],
    ["prepareTranscript", ["detach", "clear"]],
    ["prepareHost", ["detach", "clear"]],
  ]) {
    await t.test(stage, async (t) => {
      const f = fixture(t);
      const primary = f.errors[stage] = new Error(`${stage} failed`);
      const result = await f.harness.runAttempt(f.p);
      assert.equal(result.terminal.kind, "failed");
      assert.equal(result.terminal.source, "precheck");
      assert.equal(result.terminal.error, primary);
      assert.deepEqual(f.events.filter((event) => ["hostDispose", "detach", "clear"].includes(event)), expected);
      assert.equal(f.runtime.run.mock.callCount(), 0);
      noCompletedAssistant(result);
      noMirrorOwnership(result);
    });
  }
});

test("cleanup errors do not replace a primary runtime error and all cleanup steps run", async (t) => {
  const f = fixture(t);
  const primary = f.errors.runtimeRun = new Error("provider failed");
  for (const stage of ["hostDispose", "detach", "clear", "endHook"]) f.errors[stage] = new Error(stage);
  const result = await f.harness.runAttempt(f.p);
  assert.equal(result.terminal.kind, "failed");
  assert.equal(result.terminal.source, "prompt");
  assert.equal(result.terminal.error, primary);
  assert.deepEqual(f.events.filter((event) => ["hostDispose", "detach", "clear", "endHook"].includes(event)),
    ["hostDispose", "detach", "clear", "endHook"]);
  assert.equal(result.lastAssistant, undefined);
  noCompletedAssistant(result);
  noMirrorOwnership(result);
  assert.equal(result.replayMetadata.replaySafe, false);
});

test("late cleanup or agent-end failure must not advertise a completed assistant", async (t) => {
  for (const stage of ["hostDispose", "detach", "clear", "endHook"]) {
    await t.test(stage, async (t) => {
      const f = fixture(t);
      const primary = f.errors[stage] = new Error(stage);
      const result = await f.harness.runAttempt(f.p);
      assert.equal(result.terminal.kind, "failed");
      assert.equal(result.terminal.error, primary);
      assert.equal(result.assistantTranscriptOwned, true);
      assert.equal(f.sdk.emitAgentEvent.mock.callCount(), 0);
      noCompletedAssistant(result);
    });
  }
});

test("user transcript rejection blocks provider submission and preserves replay facts", async (t) => {
  for (const stage of ["prepareTranscript", "persistUser", "sentToProvider"]) {
    await t.test(stage, async (t) => {
      const f = fixture(t);
      const primary = f.errors[stage] = new Error("canonical user admission blocked");
      const result = await f.harness.runAttempt(f.p);
      assert.equal(result.terminal.kind, "failed");
      assert.equal(result.terminal.source, "precheck");
      assert.equal(result.terminal.error, primary);
      assert.equal(f.runtime.run.mock.callCount(), 0);
      assert.equal(f.p.onExecutionStarted.mock.callCount(), 0);
      assert.equal(f.transcript.persistAssistant.mock.callCount(), 0);
      assert.deepEqual(result.replayMetadata, { hadPotentialSideEffects: false, replaySafe: true });
      noCompletedAssistant(result);
      noMirrorOwnership(result);
    });
  }
  for (const initialReplayState of [{ hadPotentialSideEffects: true }, { replayInvalid: true }]) {
    const f = fixture(t, { initialReplayState });
    f.errors.prepareTranscript = new Error("blocked");
    const result = await f.harness.runAttempt(f.p);
    assert.deepEqual(result.replayMetadata, {
      hadPotentialSideEffects: initialReplayState.hadPotentialSideEffects === true,
      replaySafe: false,
    });
  }
});

test("mirror ownership is returned only after persistence settles successfully", async (t) => {
  const f = fixture(t);
  const saving = deferred();
  const saved = deferred();
  f.transcript.persistAssistant = f.spy("persistAssistant", async (message) => {
    saving.resolve(message);
    return saved.promise;
  });
  let settled = false;
  const pending = f.harness.runAttempt(f.p).then((result) => { settled = true; return result; });
  let message;
  try {
    const assistant = await saving.promise;
    await tick();
    assert.equal(settled, false);
    assert.equal(f.host.dispose.mock.callCount(), 0);
    message = { ...assistant, content: [{ type: "text", text: "Authoritative mirror rewrite" }] };
    f.transcript.messages.push(message);
  } finally {
    saved.resolve({ owned: true, idempotencyKey: "authoritative-mirror-key", message });
  }
  const result = await pending;
  assert.equal(result.terminal.kind, "ok");
  assert.equal(result.assistantTranscriptOwned, true);
  assert.equal(result.assistantTranscriptIdempotencyKey, "authoritative-mirror-key");
  assert.equal(result.currentAttemptCompletedAssistant, message);
  assert.deepEqual(result.assistantTexts, ["Authoritative mirror rewrite"]);
});

test("failed mirror persistence cannot claim ownership or a completed assistant", async (t) => {
  const f = fixture(t);
  const primary = f.errors.persistAssistant = new Error("strict append rejected");
  const result = await f.harness.runAttempt(f.p);
  assert.equal(result.terminal.kind, "failed");
  assert.equal(result.terminal.error, primary);
  noMirrorOwnership(result);
  noCompletedAssistant(result);
  assert.equal(result.replayMetadata.replaySafe, false);
});

test("a suppressed native mirror is failed but owned, preventing host fallback persistence", async (t) => {
  const f = fixture(t);
  f.transcript.persistAssistant = f.spy("persistAssistant", async () =>
    ({ owned: true, suppressed: true, message: undefined }));
  const result = await f.harness.runAttempt(f.p);
  assert.equal(result.terminal.kind, "failed");
  assert.match(result.terminal.error.message, /suppressed.*\/new/u);
  assert.equal(result.assistantTranscriptOwned, true);
  assert.equal(result.assistantTranscriptIdempotencyKey, undefined);
  assert.equal(result.lastAssistant, undefined);
  assert.equal(result.currentAttemptAssistant, undefined);
  assert.equal(result.messagesSnapshot.some((message) => message.role === "assistant"), false);
  assert.equal(result.replayMetadata.replaySafe, false);
  assert.equal(f.sdk.emitAgentEvent.mock.callCount(), 0);
  noCompletedAssistant(result);
});

test("input/output/finalize/end hooks receive canonical host context and truthful success", async (t) => {
  const f = fixture(t);
  const history = f.transcript.messages.slice(0, -1);
  const result = await f.harness.runAttempt(f.p);
  const input = f.sdk.runAgentHarnessLlmInputHook.mock.calls[0].arguments[0];
  assert.equal(input.ctx.sessionId, f.p.sessionId);
  assert.equal(input.ctx.runId, f.p.runId);
  assert.equal(input.ctx.agentId, f.p.agentId);
  assert.deepEqual(input.event, {
    runId: f.p.runId, sessionId: f.p.sessionId, provider: f.p.provider, model: f.p.model.id,
    systemPrompt: f.host.systemPrompt, prompt: f.host.prompt, historyMessages: history,
    imagesCount: 0, tools: f.host.tools,
  });
  const output = f.sdk.runAgentHarnessLlmOutputHook.mock.calls[0].arguments[0];
  assert.equal(output.ctx, input.ctx);
  assert.equal(output.event.harnessId, "dsh-native");
  assert.equal(output.event.resolvedRef, `deepseek/${f.p.model.id}`);
  assert.deepEqual(output.event.assistantTexts, [f.output.text]);
  assert.deepEqual(output.event.usage, { ...f.output.usage, total: 122 });
  assert.equal(output.event.contextTokenBudget, f.p.model.contextWindow);
  const finalize = f.sdk.runAgentHarnessBeforeAgentFinalizeHook.mock.calls[0].arguments[0];
  assert.equal(finalize.ctx, input.ctx);
  assert.equal(finalize.event.messages.at(-1), output.event.lastAssistant);
  assert.equal(finalize.event.lastAssistantMessage, f.output.text);
  assert.equal(finalize.event.stopHookActive, false);
  const end = f.sdk.awaitAgentHarnessAgentEndHook.mock.calls[0].arguments[0];
  assert.equal(end.ctx, input.ctx);
  assert.equal(end.event.messages, result.messagesSnapshot);
  assert.equal(end.event.success, true);
  assert.equal(Object.hasOwn(end.event, "error"), false);
  assert.ok(end.event.durationMs >= 0);
  before(f, "runtimeRun", "outputHook");
  before(f, "outputHook", "finalizeHook");
  before(f, "finalizeHook", "persistAssistant");
  before(f, "persistAssistant", "endHook");
});

test("revision requests fail closed without rerunning the provider or persisting a final assistant", async (t) => {
  const f = fixture(t);
  f.sdk.runAgentHarnessBeforeAgentFinalizeHook = f.spy("finalizeHook",
    async () => ({ action: "revise", reason: "Needs another tool" }));
  const result = await f.harness.runAttempt(f.p);
  assert.equal(result.terminal.kind, "failed");
  assert.match(result.terminal.error.message, /revision.*unsupported/u);
  assert.equal(f.runtime.run.mock.callCount(), 1);
  assert.equal(f.transcript.persistAssistant.mock.callCount(), 0);
  noMirrorOwnership(result);
  noCompletedAssistant(result);
  const end = f.sdk.awaitAgentHarnessAgentEndHook.mock.calls[0].arguments[0].event;
  assert.equal(end.success, false);
  assert.match(end.error, /revision/u);
});

test("input/output/finalization hook failures stay failures and never complete a mirror", async (t) => {
  for (const stage of ["inputHook", "outputHook", "finalizeHook"]) {
    await t.test(stage, async (t) => {
      const f = fixture(t);
      const primary = f.errors[stage] = new Error(stage);
      const result = await f.harness.runAttempt(f.p);
      assert.equal(result.terminal.kind, "failed");
      assert.equal(result.terminal.error, primary);
      assert.equal(f.runtime.run.mock.callCount(), stage === "inputHook" ? 0 : 1);
      assert.equal(f.transcript.persistAssistant.mock.callCount(), 0);
      noMirrorOwnership(result);
      noCompletedAssistant(result);
      assert.equal(f.sdk.awaitAgentHarnessAgentEndHook.mock.calls[0].arguments[0].event.success, false);
    });
  }
});

test("real host tools, not the runtime's claimed count, supply tool metadata and lifecycle facts", async (t) => {
  const f = fixture(t);
  const executed = [];
  installRealTools(f, [
    tool("read", async (id, args, signal) => {
      executed.push({ id, args, signal });
      assert.deepEqual(f.host.getToolCounts(), { startedCount: 1, completedCount: 0, activeCount: 1 });
      return { content: [{ type: "text", text: "Read contents" }] };
    }),
    tool("write", async () => { throw new Error("write partially failed"); }),
  ]);
  f.run = async (input) => {
    assert.deepEqual(input.tools.map((tool) => tool.name), ["read", "write"]);
    assert.deepEqual(await input.executeTool({ name: "read", callId: "read-1", arguments: { path: "fixture" } }, input.signal),
      { text: "Read contents", isError: false });
    assert.deepEqual(await input.executeTool({ name: "write", callId: "write-1", arguments: { path: "fixture" } }, input.signal),
      { text: "write partially failed", isError: true });
    return f.output;
  };
  const result = await f.harness.runAttempt(f.p);
  assert.equal(result.terminal.kind, "ok");
  assert.equal(executed.length, 1);
  assert.equal(executed[0].id, "read-1");
  assert.deepEqual(executed[0].args, { path: "fixture" });
  assert.deepEqual(result.toolMetas, [
    { toolName: "read", toolCallId: "read-1", isError: false },
    { toolName: "write", toolCallId: "write-1", isError: true },
  ]);
  assert.deepEqual(result.itemLifecycle, { startedCount: 2, completedCount: 2, activeCount: 0 });
  assert.deepEqual(result.replayMetadata, { hadPotentialSideEffects: true, replaySafe: false });
  assert.equal(f.p.onToolStreamBoundary.mock.callCount(), 2);
});

test("rejected tool dispatch records an error without inventing execution or side effects", async (t) => {
  const f = fixture(t);
  installRealTools(f, []);
  f.run = async (input) => {
    await input.executeTool({ name: "exec", callId: "not-allowed", arguments: {} }, input.signal);
    return f.output;
  };
  const result = await f.harness.runAttempt(f.p);
  assert.equal(result.terminal.kind, "failed");
  assert.match(result.terminal.error.message, /unavailable/u);
  assert.deepEqual(result.toolMetas, [{ toolName: "exec", toolCallId: "not-allowed", isError: true }]);
  assert.deepEqual(result.itemLifecycle, { startedCount: 0, completedCount: 0, activeCount: 0 });
  assert.deepEqual(result.replayMetadata, { hadPotentialSideEffects: false, replaySafe: false });
  noCompletedAssistant(result);
});

test("per-call abort reaches the actual host tool without aborting the whole attempt signal", async (t) => {
  const f = fixture(t);
  const callAbort = new AbortController();
  const started = deferred();
  const reason = new Error("tool call cancelled");
  let toolSignal;
  installRealTools(f, [tool("read", async (_id, _args, signal) => {
    toolSignal = signal;
    started.resolve();
    return waitForAbort(signal);
  })]);
  f.run = async (input) => {
    await input.executeTool({ name: "read", callId: "cancelled-read", arguments: { path: "fixture" } }, callAbort.signal);
    return f.output;
  };
  const pending = f.harness.runAttempt(f.p);
  await started.promise;
  callAbort.abort(reason);
  const result = await pending;
  assert.equal(toolSignal.aborted, true);
  assert.equal(toolSignal.reason, reason);
  assert.equal(f.input.signal.aborted, false);
  assert.equal(result.terminal.kind, "failed");
  assert.equal(result.terminal.error, reason);
  assert.deepEqual(result.toolMetas, [{ toolName: "read", toolCallId: "cancelled-read", isError: true }]);
  assert.deepEqual(result.itemLifecycle, { startedCount: 1, completedCount: 1, activeCount: 0 });
  assert.deepEqual(result.replayMetadata, { hadPotentialSideEffects: false, replaySafe: false });
  noCompletedAssistant(result);
});

test("cancellation inside the tool stream boundary cannot dispatch an actual host tool", async (t) => {
  const caller = new AbortController();
  const f = fixture(t, { abortSignal: caller.signal });
  const execute = t.mock.fn(async () => ({ content: [] }));
  const reason = new Error("cancel before dispatch");
  installRealTools(f, [tool("write", execute)]);
  f.p.onToolStreamBoundary = t.mock.fn(async () => {
    await tick();
    caller.abort(reason);
  });
  f.run = async (input) => {
    await input.executeTool({ name: "write", callId: "blocked-write", arguments: { path: "fixture" } }, input.signal);
    return f.output;
  };
  const result = await f.harness.runAttempt(f.p);
  assert.equal(result.terminal.kind, "aborted");
  assert.equal(result.terminal.failure.error, reason);
  assert.equal(execute.mock.callCount(), 0);
  assert.deepEqual(result.itemLifecycle, { startedCount: 0, completedCount: 0, activeCount: 0 });
  assert.deepEqual(result.replayMetadata, { hadPotentialSideEffects: false, replaySafe: false });
  noCompletedAssistant(result);
});

test("runtime-declared abort is a runtime aborted terminal, never a completed assistant", async (t) => {
  const f = fixture(t);
  f.output.stopReason = "aborted";
  const result = await f.harness.runAttempt(f.p);
  assert.equal(result.terminal.kind, "aborted");
  assert.equal(result.terminal.source, "runtime");
  assert.equal(f.input.signal.aborted, true);
  assert.equal(result.lastAssistant, undefined);
  assert.equal(f.transcript.persistAssistant.mock.callCount(), 0);
  assert.equal(f.sdk.runAgentHarnessLlmOutputHook.mock.callCount(), 0);
  assert.deepEqual(result.attemptUsage, { ...f.output.usage, total: 122 });
  noCompletedAssistant(result);
  noMirrorOwnership(result);
});

test("the bounded deadline aborts the runtime and returns timeout rather than generic failure", { timeout: 3000 }, async (t) => {
  const f = fixture(t, { timeoutMs: 15 });
  f.errors.attemptTimeout = new Error("observer must not escape the timer");
  f.run = ({ signal }) => waitForAbort(signal);
  const beforeStart = Date.now();
  const result = await f.harness.runAttempt(f.p);
  assert.equal(result.terminal.kind, "timeout");
  assert.equal(result.terminal.source, "runtime");
  assert.equal(result.terminal.phase, "prompt");
  assert.equal(result.terminal.aborted, true);
  assert.equal(f.input.signal.aborted, true);
  assert.equal(result.terminal.failure.error, f.input.signal.reason);
  assert.match(f.input.signal.reason.message, /deadline exceeded/u);
  assert.equal(f.p.onAttemptTimeout.mock.callCount(), 1);
  assert.equal(f.p.onAttemptTimeoutArmed.mock.callCount(), 1);
  const deadline = f.p.onAttemptDeadlineChanged.mock.calls[0].arguments[0];
  assert.equal(deadline.kind, "bounded");
  assert.ok(deadline.deadlineAtMs >= beforeStart + 15);
  noCompletedAssistant(result);
  noMirrorOwnership(result);
});

test("timeout during actual tool execution drains the tool and preserves its timeout phase", { timeout: 3000 }, async (t) => {
  const f = fixture(t, { timeoutMs: 100 });
  const started = deferred();
  const finish = deferred();
  let observedToolFailure;
  installRealTools(f, [tool("read", async (_id, _args, signal) => {
    started.resolve(signal);
    await finish.promise;
    signal.throwIfAborted();
    return { content: [] };
  })]);
  f.run = async (input) => {
    const work = input.executeTool({ name: "read", callId: "slow-read", arguments: { path: "fixture" } }, input.signal);
    observedToolFailure = assert.rejects(work, /deadline exceeded/u);
    return waitForAbort(input.signal);
  };
  let settled = false;
  const pending = f.harness.runAttempt(f.p).then((result) => { settled = true; return result; });
  try {
    const signal = await started.promise;
    await assert.rejects(waitForAbort(signal), /deadline exceeded/u);
    await tick();
    assert.equal(settled, false);
    assert.equal(f.host.getToolCounts().activeCount, 1);
  } finally {
    finish.resolve();
  }
  const result = await pending;
  await observedToolFailure;
  assert.equal(result.terminal.kind, "timeout");
  assert.equal(result.terminal.phase, "tool_execution");
  assert.equal(result.terminal.aborted, true);
  assert.deepEqual(result.itemLifecycle, { startedCount: 1, completedCount: 1, activeCount: 0 });
  assert.equal(result.replayMetadata.replaySafe, false);
  noCompletedAssistant(result);
});

test("both caller and reply-operation signals combine with the active handle's cancellation", async (t) => {
  for (const source of ["caller", "reply", "handle"]) {
    await t.test(source, async (t) => {
      const caller = new AbortController();
      const f = fixture(t, { abortSignal: caller.signal });
      f.run = ({ signal }) => waitForAbort(signal);
      const pending = f.harness.runAttempt(f.p);
      const input = await f.entered.promise;
      assert.notEqual(input.signal, caller.signal);
      assert.notEqual(input.signal, f.replyAbort.signal);
      assert.equal(f.dependencies.prepareHost.mock.calls[0].arguments[1], input.signal);
      const reason = new Error(`${source} cancelled`);
      if (source === "caller") caller.abort(reason);
      else if (source === "reply") f.replyAbort.abort(reason);
      else {
        f.errors.attemptAbort = new Error("observer must not replace cancellation");
        f.handle.abort("user_abort");
        f.handle.cancel("duplicate");
      }
      const result = await pending;
      assert.equal(result.terminal.kind, "aborted");
      assert.equal(result.terminal.source, source === "handle" ? "runtime" : "external");
      assert.equal(result.terminal.failure.error, input.signal.reason);
      if (source !== "handle") assert.equal(input.signal.reason, reason);
      assert.equal(f.p.onAttemptAbort.mock.callCount(), source === "handle" ? 1 : 0);
      assert.equal(f.p.onAttemptTimeout.mock.callCount(), 0);
      assert.equal(f.handle.isAborted(), true);
      assert.equal(f.handle.isAbortable(), false);
      assert.equal(f.handle.isStopped(), true);
      noCompletedAssistant(result);
      noMirrorOwnership(result);
    });
  }
});

test("pre-aborted caller and reply signals prevent registration and provider invocation", async (t) => {
  for (const source of ["caller", "reply"]) {
    const caller = new AbortController();
    const f = fixture(t, { abortSignal: caller.signal });
    const reason = new Error("already cancelled");
    (source === "caller" ? caller : f.replyAbort).abort(reason);
    const result = await f.harness.runAttempt(f.p);
    assert.equal(result.terminal.kind, "aborted");
    assert.equal(result.terminal.source, "external");
    assert.equal(result.terminal.failure.source, "precheck");
    assert.equal(result.terminal.failure.error, reason);
    assert.deepEqual(f.events, []);
    noCompletedAssistant(result);
  }
});

test("live steering is explicitly rejected on both handle interfaces", async (t) => {
  const f = fixture(t);
  f.run = async () => {
    const accepted = [];
    assert.equal(f.handle.supportsQueueMessageImages, false);
    assert.equal(f.handle.messageInjection.isAvailable(), false);
    await assert.rejects(f.handle.queueMessage("injected", { onQueueAccepted: (value) => accepted.push(value) }),
      /live steering is unsupported/u);
    await assert.rejects(f.handle.messageInjection.queueMessage("injected"), /live steering is unsupported/u);
    assert.deepEqual(accepted, [false]);
    assert.equal(f.handle.isAborted(), false);
    return f.output;
  };
  assert.equal((await f.harness.runAttempt(f.p)).terminal.kind, "ok");
});

test("reports each completed model response without reporting the attempt total twice", async (t) => {
  const f = fixture(t);
  f.run = async (input) => {
    await input.onEvent({ type: "usage", usage: { input: 30, output: 2, cacheRead: 0, cacheWrite: 0 } });
    await input.onEvent({ type: "usage", usage: { input: 71, output: 5, cacheRead: 11, cacheWrite: 3 } });
    return f.output;
  };
  const result = await f.harness.runAttempt(f.p);
  assert.equal(result.terminal.kind, "ok");
  assert.deepEqual(f.p.hostCapabilities.reportOutputTokens.mock.calls.map((call) => call.arguments), [[2], [5]]);
  assert.equal(result.attemptUsage.output, 7);
});

test("live events deliver cumulative text, reasoning, usage, activity and progress callbacks", async (t) => {
  const f = fixture(t);
  const events = [
    { type: "status", status: "model started" },
    { type: "reasoning", text: "Think " },
    { type: "reasoning", text: "carefully" },
    { type: "text", text: "Native " },
    { type: "text", text: "answer" },
    { type: "usage", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
  ];
  f.run = async (input) => {
    for (const event of events) await input.onEvent(event);
    assert.equal(f.handle.isStreaming(), true);
    return f.output;
  };
  const result = await f.harness.runAttempt(f.p);
  assert.equal(result.terminal.kind, "ok");
  assert.equal(f.p.onAssistantMessageStart.mock.callCount(), 1);
  assert.deepEqual(f.p.onPartialReply.mock.calls.map((call) => call.arguments[0]), [
    { text: "Native ", delta: "Native " },
    { text: "Native answer", delta: "answer" },
  ]);
  assert.deepEqual(f.p.onReasoningStream.mock.calls.map((call) => call.arguments[0]), [
    { text: "Think ", isReasoning: true, isReasoningSnapshot: true },
    { text: "Think carefully", isReasoning: true, isReasoningSnapshot: true },
  ]);
  assert.deepEqual(f.p.onAgentEvent.mock.calls[0].arguments, [{
    stream: "dsh-native", data: { status: "model started" }, sessionKey: f.p.sessionKey,
  }]);
  assert.equal(f.p.replyOperation.recordActivity.mock.callCount(), events.length);
  assert.deepEqual(f.p.onRunProgress.mock.calls.map((call) => call.arguments[0]), events.map((event) => ({
    reason: `dsh:${event.type}`, provider: f.p.provider, model: f.p.model.id, backend: "dsh-native",
  })));
  assert.equal(f.p.onReasoningEnd.mock.callCount(), 1);
  assert.deepEqual(result.attemptUsage, { ...f.output.usage, total: 122 });
  assert.equal(f.handle.isStreaming(), false);
  await assert.rejects(f.input.onEvent({ type: "text", text: "late" }), /authority/u);
  assert.equal(f.p.onPartialReply.mock.callCount(), 2);
});

test("suppressed live output still tracks progress without leaking text or reasoning callbacks", async (t) => {
  const f = fixture(t, { suppressLiveStreamOutput: true });
  f.run = async (input) => {
    await input.onEvent({ type: "text", text: "hidden text" });
    await input.onEvent({ type: "reasoning", text: "hidden reasoning" });
    return f.output;
  };
  const result = await f.harness.runAttempt(f.p);
  assert.equal(result.terminal.kind, "ok");
  assert.equal(f.p.onPartialReply.mock.callCount(), 0);
  assert.equal(f.p.onReasoningStream.mock.callCount(), 0);
  assert.equal(f.p.onRunProgress.mock.callCount(), 2);
  assert.deepEqual(result.assistantTexts, [f.output.text]);
});

test("cancellation during awaited stream callbacks remains cancellation, not successful output", async (t) => {
  for (const [callback, event] of [
    ["onAssistantMessageStart", { type: "text", text: "not yet delivered" }],
    ["onPartialReply", { type: "text", text: "partial" }],
    ["onReasoningStream", { type: "reasoning", text: "thinking" }],
    ["onAgentEvent", { type: "status", status: "working" }],
  ]) {
    await t.test(callback, async (t) => {
      const caller = new AbortController();
      const f = fixture(t, { abortSignal: caller.signal });
      const reason = new Error(`cancel inside ${callback}`);
      f.p[callback] = t.mock.fn(async () => {
        await tick();
        caller.abort(reason);
        await tick();
      });
      f.run = async (input) => {
        await input.onEvent(event);
        return f.output;
      };
      const result = await f.harness.runAttempt(f.p);
      assert.equal(result.terminal.kind, "aborted");
      assert.equal(result.terminal.source, "external");
      assert.equal(result.terminal.failure.error, reason);
      assert.equal(f.transcript.persistAssistant.mock.callCount(), 0);
      assert.equal(f.p[callback].mock.callCount(), 1);
      if (callback === "onAssistantMessageStart") assert.equal(f.p.onPartialReply.mock.callCount(), 0);
      noCompletedAssistant(result);
      noMirrorOwnership(result);
    });
  }
});

test("stream failure preserves observed usage but never synthesizes a completed assistant", async (t) => {
  const f = fixture(t);
  const primary = new Error("stream disconnected");
  const usage = { input: 9, output: 4, cacheRead: 2, cacheWrite: 1 };
  f.run = async (input) => {
    await input.onEvent({ type: "usage", usage });
    await input.onEvent({ type: "text", text: "unfinished" });
    throw primary;
  };
  const result = await f.harness.runAttempt(f.p);
  assert.equal(result.terminal.kind, "failed");
  assert.equal(result.terminal.error, primary);
  assert.deepEqual(result.attemptUsage, { ...usage, total: 16 });
  assert.equal(result.lastAssistant, undefined);
  assert.equal(result.replayMetadata.replaySafe, false);
  noCompletedAssistant(result);
  noMirrorOwnership(result);
});

test("reasoning-end cancellation preserves committed mirror ownership but clears completion", async (t) => {
  const caller = new AbortController();
  const f = fixture(t, { abortSignal: caller.signal });
  const reason = new Error("cancel final reasoning callback");
  f.p.onReasoningEnd = t.mock.fn(async () => {
    await tick();
    caller.abort(reason);
  });
  f.run = async (input) => {
    await input.onEvent({ type: "reasoning", text: "thinking" });
    return f.output;
  };
  const result = await f.harness.runAttempt(f.p);
  assert.equal(result.terminal.kind, "aborted");
  assert.equal(result.terminal.failure.error, reason);
  assert.equal(result.assistantTranscriptOwned, true);
  assert.equal(result.messagesSnapshot.at(-1), result.lastAssistant);
  assert.equal(result.lastAssistant.role, "assistant");
  assert.equal(f.transcript.persistAssistant.mock.callCount(), 1);
  noCompletedAssistant(result);
});

test("invalid native token usage cannot become a canonical completed assistant", async (t) => {
  for (const usage of [
    { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 },
    { input: 1.5, output: 0, cacheRead: 0, cacheWrite: 0 },
    { input: 0, output: NaN, cacheRead: 0, cacheWrite: 0 },
    { input: Number.MAX_SAFE_INTEGER, output: 1, cacheRead: 0, cacheWrite: 0 },
  ]) {
    const f = fixture(t);
    f.output.usage = usage;
    const result = await f.harness.runAttempt(f.p);
    assert.equal(result.terminal.kind, "failed");
    assert.match(result.terminal.error.message, /usage/u);
    assert.equal(f.transcript.persistAssistant.mock.callCount(), 0);
    noCompletedAssistant(result);
    noMirrorOwnership(result);
  }
});

test("concurrent attempts cannot steal session authority; cleanup permits a subsequent attempt", async (t) => {
  const f = fixture(t);
  f.run = ({ signal }) => waitForAbort(signal);
  const first = f.harness.runAttempt(f.p);
  await f.entered.promise;
  const owner = f.handle;
  const rejected = await f.harness.runAttempt({ ...f.p, runId: "contending-run" });
  assert.equal(rejected.terminal.kind, "failed");
  assert.match(rejected.terminal.error.message, /owns this session/u);
  assert.equal(f.sdk.setActiveEmbeddedRun.mock.callCount(), 1);
  assert.equal(f.sdk.clearActiveEmbeddedRun.mock.callCount(), 0);
  assert.equal(f.handle, owner);
  owner.abort();
  assert.equal((await first).terminal.kind, "aborted");
  f.run = undefined;
  assert.equal((await f.harness.runAttempt({ ...f.p, runId: "next-run" })).terminal.kind, "ok");
  assert.equal(f.runtime.run.mock.callCount(), 2);
});

test("dispose aborts every active run, drains host cleanup and is idempotent", async (t) => {
  const f = fixture(t);
  const bothEntered = deferred();
  let entered = 0;
  const inputs = [];
  f.run = async (input) => {
    inputs.push(input);
    if (++entered === 2) bothEntered.resolve();
    return waitForAbort(input.signal);
  };
  const cleanupStarted = deferred();
  const cleanupDone = deferred();
  f.host.dispose = f.spy("hostDispose", async () => {
    cleanupStarted.resolve();
    await cleanupDone.promise;
  });
  const attempts = [
    f.harness.runAttempt(f.p),
    f.harness.runAttempt({ ...f.p, sessionId: "second-session", runId: "second-run" }),
  ];
  await bothEntered.promise;
  let drained = false;
  const disposal = f.harness.dispose();
  void disposal.then(() => { drained = true; });
  try {
    assert.equal(f.harness.dispose(), disposal);
    await cleanupStarted.promise;
    await tick();
    assert.equal(drained, false);
    assert.equal(f.runtime.dispose.mock.callCount(), 1);
    assert.equal(inputs.every((input) => input.signal.aborted), true);
  } finally {
    cleanupDone.resolve();
  }
  await disposal;
  for (const result of await Promise.all(attempts)) {
    assert.equal(result.terminal.kind, "aborted");
    assert.equal(result.terminal.source, "runtime");
    noCompletedAssistant(result);
  }
  assert.equal(f.sdk.clearActiveEmbeddedRun.mock.callCount(), 2);
  assert.equal(f.p.replyOperation.detachBackend.mock.callCount(), 2);
  assert.equal(f.harness.dispose(), disposal);
  const rejected = await f.harness.runAttempt({ ...f.p, runId: "after-disposal" });
  assert.equal(rejected.terminal.kind, "failed");
  assert.match(rejected.terminal.error.message, /disposed/u);
  assert.equal(f.runtime.run.mock.callCount(), 2);
});
