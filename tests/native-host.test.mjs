import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { assertNativeHostSupported, createNativeToolHost, prepareNativeHost, projectNativeToolResult, renderNativeSystemPrompt } from "../src/native/host.ts";

const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false };
const signal = () => new AbortController().signal;
const call = (name = "read", callId = "one", args = { path: "file" }) => ({ name, callId, arguments: args });
const tool = (name = "read", execute = async () => ({ content: [{ type: "text", text: "ok" }] })) =>
  ({ name, label: name, description: name, parameters: schema, execute });

function fixture(tools = [tool()], overrides = {}) {
  const hooks = [];
  const terminal = [];
  const blocked = new Set();
  const adjusted = new Map();
  const wrapped = new WeakSet();
  const runtime = {
    isAgentToolReplaySafe: (t) => ["read", "grep", "glob"].includes(t.name),
    getPluginToolMeta: (t) => t.plugin,
    getChannelAgentToolMeta: (t) => t.channel,
    isToolWrappedWithBeforeToolCallHook: (t) => wrapped.has(t),
    consumeAdjustedParamsForToolCall: (id) => { const args = adjusted.get(id); adjusted.delete(id); return args; },
    consumePreExecutionBlockedToolCall: (id) => blocked.delete(id),
    runAgentHarnessAfterToolCallHook: async (event) => { hooks.push(event); },
    isToolResultError: (result) => result?.isError === true || result?.details?.status === "error",
    formatToolExecutionErrorMessage: (e) => e.message,
    getBeforeToolCallFailureDisposition: (e) => e?.disposition,
  };
  const host = createNativeToolHost({
    tools, runtime, signal: signal(), assertActive() {}, runId: "run", sessionId: "session", cwd: process.cwd(),
    observeToolTerminal: (event) => terminal.push(event),
    bindToolSurface: (surface) => surface.map((t) => {
      const bound = { ...t, execute: async (id, args, abort) => {
        if (overrides.block) {
          blocked.add(id);
          return { content: [{ type: "text", text: "blocked" }], isError: true };
        }
        args = overrides.rewrite ? overrides.rewrite(args) : args;
        adjusted.set(id, args);
        return t.execute(id, args, abort);
      } };
      wrapped.add(bound);
      return bound;
    }),
    ...overrides.options,
  });
  return { host, hooks, terminal, runtime };
}

test("validates before hooks and again after hook rewrites without coercion", async () => {
  let executions = 0;
  const { host, hooks } = fixture([tool("read", async () => { executions++; return { content: [] }; })]);
  await assert.rejects(host.executeTool(call("read", "bad", { path: 12 }), signal()), /Invalid arguments/);
  await assert.rejects(host.executeTool(call("read", "extra", { path: "a", extra: true }), signal()), /Invalid arguments/);
  assert.equal(executions, 0);
  assert.equal(hooks.length, 0);
  assert.deepEqual(host.getToolCounts(), { startedCount: 0, completedCount: 0, activeCount: 0 });
  const changed = fixture([tool()], { rewrite: () => ({ path: 42 }) });
  assert.equal((await changed.host.executeTool(call(), signal())).isError, true);
  assert.deepEqual(changed.host.getToolCounts(), { startedCount: 0, completedCount: 0, activeCount: 0 });
  assert.equal(changed.terminal[0].executionStarted, false);
});

test("keeps adjusted hook arguments and reports actual dispatch to the host", async () => {
  let received;
  const { host, hooks, terminal } = fixture([tool("read", async (_id, args) => {
    received = args;
    return { content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] };
  })], { rewrite: () => ({ path: "rewritten" }) });
  assert.deepEqual(await host.executeTool(call(), signal()), { text: "one\ntwo", isError: false });
  assert.deepEqual(received, { path: "rewritten" });
  assert.deepEqual(hooks[0].startArgs, received);
  assert.equal(hooks.length, 1);
  assert.equal(terminal[0].executionStarted, true);
  assert.deepEqual(host.getToolCounts(), { startedCount: 1, completedCount: 1, activeCount: 0 });
  assert.deepEqual(host.getReplayState(), { hadPotentialSideEffects: false, replaySafe: true });
});

test("policy-blocked mutations never count as started or side effects", async () => {
  const { host, terminal, hooks } = fixture([tool("write")], { block: true });
  assert.equal((await host.executeTool(call("write"), signal())).isError, true);
  assert.deepEqual(host.getToolCounts(), { startedCount: 0, completedCount: 0, activeCount: 0 });
  assert.deepEqual(host.getReplayState(), { hadPotentialSideEffects: false, replaySafe: true });
  assert.equal(terminal[0].executionStarted, false);
  assert.equal(hooks.length, 1);
});

test("mutations remain potentially side-effecting when execution throws", async () => {
  const { host, hooks } = fixture([tool("write", async () => { throw new Error("partial write"); })]);
  assert.deepEqual(await host.executeTool(call("write"), signal()), { text: "partial write", isError: true });
  assert.deepEqual(host.getToolCounts(), { startedCount: 1, completedCount: 1, activeCount: 0 });
  assert.deepEqual(host.getReplayState(), { hadPotentialSideEffects: true, replaySafe: false });
  assert.equal(hooks[0].error, "partial write");
});

test("valid calls are single-use even concurrently; unknown and disabled tools fail closed", async () => {
  const { host } = fixture();
  const first = host.executeTool(call(), signal());
  await assert.rejects(host.executeTool(call(), signal()), /duplicate/);
  await first;
  await assert.rejects(host.executeTool(call("message", "unknown"), signal()), /unavailable/);
  const restricted = fixture(undefined, { options: { toolExecutionAllow: [] } }).host;
  assert.equal(restricted.tools.length, 1);
  await assert.rejects(restricted.executeTool(call(), signal()), /denied/);
  assert.equal(restricted.getToolCounts().startedCount, 0);
});

test("tracks concurrent dispatch and does not announce replay safety during a pending read", async () => {
  const finishes = [];
  const { host } = fixture([tool("read", () => new Promise((resolve) => finishes.push(resolve)))]);
  const work = [host.executeTool(call("read", "a"), signal()), host.executeTool(call("read", "b"), signal())];
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(host.getToolCounts(), { startedCount: 2, completedCount: 0, activeCount: 2 });
  assert.equal(host.getReplayState().replaySafe, false);
  for (const finish of finishes) finish({ content: [] });
  await Promise.all(work);
  assert.deepEqual(host.getToolCounts(), { startedCount: 2, completedCount: 2, activeCount: 0 });
});

test("per-call cancellation reaches host tools and leaves conservative replay state", async () => {
  let received;
  const abort = new AbortController();
  const { host } = fixture([tool("read", async (_id, _args, sig) => {
    received = sig;
    await new Promise((_resolve, reject) => sig.addEventListener("abort", () => reject(sig.reason), { once: true }));
  })]);
  const work = host.executeTool(call(), abort.signal);
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort(new Error("call cancelled"));
  await assert.rejects(work, /call cancelled/);
  assert.equal(received.aborted, true);
  assert.deepEqual(host.getToolCounts(), { startedCount: 1, completedCount: 1, activeCount: 0 });
  assert.equal(host.getReplayState().replaySafe, false);
});

test("pre-aborted calls do not dispatch; disposal drains actual execution and runs every cleanup once", async () => {
  let finish;
  let toolSignal;
  let cleaned = 0;
  const { host } = fixture([tool("read", async (_id, _args, sig) => {
    toolSignal = sig;
    return new Promise((resolve) => { finish = resolve; });
  })], { options: { cleanups: [async () => { cleaned++; }, async () => { cleaned++; }] } });
  const abort = new AbortController();
  abort.abort(new Error("early"));
  await assert.rejects(host.executeTool(call(), abort.signal), /early/);
  const work = host.executeTool(call(), signal());
  const rejected = assert.rejects(work, /disposed/);
  await new Promise((resolve) => setImmediate(resolve));
  const disposal = host.dispose();
  assert.equal(host.dispose(), disposal);
  assert.equal(toolSignal.aborted, true);
  assert.equal(host.getToolCounts().activeCount, 1);
  assert.equal(cleaned, 0);
  finish({ content: [] });
  await rejected;
  await disposal;
  assert.equal(cleaned, 2);
  assert.equal(host.getToolCounts().activeCount, 0);
  await assert.rejects(host.executeTool(call("read", "after"), signal()), /disposed/);
});

test("after-tool hook failures cannot hide completed side effects or corrupt counts", async () => {
  const state = fixture([tool("write")]);
  state.runtime.runAgentHarnessAfterToolCallHook = async () => { throw new Error("hook broke"); };
  await assert.rejects(state.host.executeTool(call("write"), signal()), /hook broke/);
  assert.deepEqual(state.host.getToolCounts(), { startedCount: 1, completedCount: 1, activeCount: 0 });
  assert.equal(state.host.getReplayState().replaySafe, false);
});

test("rejects non-core tools, duplicate names, plugin shadows, invalid schemas and unbound surfaces", () => {
  assert.throws(() => fixture([tool("message")]), /Unsupported/);
  assert.throws(() => fixture([tool(), tool()]), /Duplicate/);
  assert.throws(() => fixture([{ ...tool(), plugin: { pluginId: "shadow" } }]), /Unsupported/);
  assert.throws(() => fixture([{ ...tool(), channel: { channelId: "shadow" } }]), /Unsupported/);
  assert.throws(() => fixture([{ ...tool(), parameters: { type: "string" } }]), /schema/);
  assert.throws(() => fixture(undefined, { options: { bindToolSurface: (tools) => tools } }), /policy-wrapped/);
});

test("local exec target is enforced after hooks, not just in the model schema", async () => {
  let executed = false;
  const exec = { ...tool("exec", async () => { executed = true; return { content: [] }; }),
    parameters: { type: "object", properties: { command: { type: "string" }, host: { type: "string" } }, required: ["command"] } };
  const { host } = fixture([exec], { rewrite: (args) => ({ ...args, host: "node" }) });
  const result = await host.executeTool(call("exec", "cmd", { command: "echo test" }), signal());
  assert.match(result.text, /local gateway/);
  assert.equal(result.isError, true);
  assert.equal(executed, false);
  assert.equal(host.getToolCounts().startedCount, 0);
});

test("carries inherited replay state even without tools", () => {
  const { host } = fixture([], { options: { initialReplayState: { hadPotentialSideEffects: true, replayInvalid: true } } });
  assert.deepEqual(host.getReplayState(), { hadPotentialSideEffects: true, replaySafe: false });
});

test("text result projection rejects media instead of silently discarding it", () => {
  assert.deepEqual(projectNativeToolResult({ content: [{ type: "text", text: "x" }] }, false), { text: "x", isError: false });
  assert.equal(projectNativeToolResult({ content: [{ type: "image", data: "secret" }] }, false).isError, true);
  assert.equal(projectNativeToolResult({}, false).isError, true);
  assert.equal(projectNativeToolResult({ content: [] }, true).isError, true);
});

test("host prompt injects workspace bootstrap, skill prompt and extra instructions once", () => {
  const prompt = renderNativeSystemPrompt({
    workspaceDir: "workspace", cwd: "task", bootstrapWorkspaceDir: "canonical",
    contextFiles: [{ path: "AGENTS.md", content: "Run existing tests." }], toolNames: ["read", "exec"],
    credentialSafety: "Never expose credentials.", replyGuidance: "Return text.",
    skillsPrompt: "Available: coding.", extraSystemPrompt: "Keep output brief.",
  });
  for (const text of ["Workspace: workspace", "Working directory: task", "instruction root: canonical",
    "AGENTS.md", "Run existing tests.", "Available: coding.", "Keep output brief.", "no native filesystem",
    "policy-controlled host exec", "Never expose credentials."]) assert.ok(prompt.includes(text), text);
  assert.equal(prompt.split("Keep output brief.").length, 2);
});

test("unsupported capabilities fail closed before constructing tools", () => {
  const base = { hostCapabilities: { bindToolSurface() {} } };
  assert.doesNotThrow(() => assertNativeHostSupported(base));
  assert.doesNotThrow(() => assertNativeHostSupported({ ...base, taskSuggestionDeliveryMode: "gateway" }));
  assert.doesNotThrow(() => assertNativeHostSupported({ ...base, skillLibraryAuthoring: {
    invoke() { throw new Error("Optional authoring must not be invoked"); },
  } }));
  for (const fields of [
    { clientTools: [{}] }, { images: [{}] }, { media: [{}] }, { sandbox: { enabled: true } },
    { execOverrides: { host: "node" } }, { toolOverrides: { mcpServers: [] } }, { permissionMode: "full" },
    { sourceReplyDeliveryMode: "message_tool_only" }, { forceMessageTool: true }, { enableHeartbeatTool: true },
    { runtimePluginToolGrant: {} }, { modelRun: true }, { codeModeOverride: true },
    { taskSuggestionDeliveryMode: "message_tool" },
    { skillWorkshopProposalOnly: true }, { skillWorkshopAutonomousCapture: true },
    { skillWorkshopUpdateProposals: {} }, { skillWorkshopCollectionReconcile: true },
    { skillWorkshopProposalRevision: {} },
    { config: { agents: { defaults: { sandbox: { mode: "all" } } } } },
    { config: { tools: { exec: { host: "node" } } } },
  ]) assert.throws(() => assertNativeHostSupported({ ...base, ...fields }), /does not support/);
});

test("canonical session roots work while canonical per-agent remote placement fails closed", () => {
  const base = { hostCapabilities: { bindToolSurface() {} }, agentId: "main",
    workspaceDir: process.cwd(), sessionRoot: process.cwd() };
  assert.doesNotThrow(() => assertNativeHostSupported(base));
  assert.doesNotThrow(() => assertNativeHostSupported({ ...base, cwd: join(process.cwd(), "src") }));
  assert.throws(() => assertNativeHostSupported({ ...base, cwd: join(process.cwd(), "..") }), /outside/);
  assert.throws(() => assertNativeHostSupported({ ...base, sessionRoot: join(process.cwd(), "other") }), /noncanonical/);
  for (const policy of [{ sandbox: { mode: "all" } }, { tools: { exec: { host: "node" } } }]) {
    assert.throws(() => assertNativeHostSupported({
      ...base, config: { agents: { entries: { main: policy } } },
    }), /does not support/);
  }
});

test("prepareNativeHost composes public SDK seams without granting tools during prompt hooks", async (t) => {
  // Mock only the public imports: no SDK dependencies, filesystem writes, or native commands.
  const wrapped = new WeakSet();
  let construction;
  let bootstrapOptions;
  let hookOptions;
  let hookRestriction;
  let failBootstrap = false;
  let cleaned = 0;
  const runtime = {
    ...fixture([]).runtime,
    isToolWrappedWithBeforeToolCallHook: (tool) => wrapped.has(tool),
    resolveSessionAgentIds: ({ sessionKey, fallbackAgentId }) =>
      ({ sessionAgentId: sessionKey?.split(":")[1] ?? fallbackAgentId ?? "main" }),
    resolveAgentDir: () => "agent-home",
    buildEmbeddedForegroundPromptContext: (run, agentDir) =>
      ({ ...run, agentDir, sandboxSessionKey: run.sandboxSessionKey ?? run.sessionKey }),
    resolveEmbeddedAttemptToolConstructionPlan: ({ disableTools, toolsAllow }) => ({
      constructTools: !disableTools && toolsAllow?.length !== 0,
      includeCoreTools: true, runtimeToolAllowlist: toolsAllow,
      codingToolConstructionPlan: { includeBaseCodingTools: true, includeShellTools: true,
        includeOpenClawTools: true, includePluginTools: true, includeChannelTools: true },
    }),
    buildEmbeddedAttemptToolRunContext: (p) => ({ trigger: p.trigger }),
    supportsModelTools: () => true,
    resolveModelAuthMode: () => "api-key",
    applyEmbeddedAttemptToolsAllow: (tools, allow) => allow === undefined
      ? tools : tools.filter((tool) => allow.includes("*") || allow.includes(tool.name)),
    resolveBootstrapContextForRun: async (options) => {
      bootstrapOptions = options;
      if (failBootstrap) throw new Error("bootstrap failed");
      return { contextFiles: [{ path: "AGENTS.md", content: "Bootstrap rules." }] };
    },
    buildCredentialSafetyPrompt: () => "Credential rules.",
    buildHarnessVisibleReplyGuidance: ({ messageToolAvailable }) => {
      assert.equal(messageToolAvailable, false);
      return "Text replies.";
    },
    resolveAgentHarnessBeforePromptBuildResult: async (options) => {
      hookOptions = options;
      const developerInstructions = options.developerInstructions.build({ toolsAllow: hookRestriction });
      if (hookRestriction?.length === 0) assert.deepEqual(options.toolAuthority.activeToolNames(), []);
      return {
        prompt: `prefix ${options.prompt} suffix`,
        developerInstructions: `system prefix\n${developerInstructions}\nsystem suffix`,
        toolsAllow: hookRestriction,
      };
    },
    createOpenClawCodingTools: (options) => {
      construction = options;
      options.registerRunCleanup(async () => { cleaned++; });
      return [tool("read"), tool("write")];
    },
  };
  const key = Symbol.for("dsh.native-host.test-sdk");
  globalThis[key] = runtime;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "openclaw/plugin-sdk/agent-harness-runtime" || specifier === "openclaw/plugin-sdk/agent-harness") {
        return { url: `native-host-test:${specifier}`, shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.startsWith("native-host-test:")) return {
        format: "module", shortCircuit: true,
        source: Object.keys(runtime).map((name) =>
          `export const ${name} = (...args) => globalThis[Symbol.for("dsh.native-host.test-sdk")].${name}(...args);`).join("\n"),
      };
      return next(url, context);
    },
  });
  t.after(() => { hooks.deregister(); delete globalThis[key]; });
  const base = {
    sessionKey: "agent:main:main", sessionId: "session", runId: "run", workspaceDir: "work",
    bootstrapWorkspaceDir: "canonical", cwd: "task", prompt: "user", provider: "deepseek", modelId: "model",
    model: { api: "openai-completions", contextWindow: 128000 }, toolsAllow: ["read"],
    config: { tools: { deny: ["write"] } }, senderId: "sender", senderIsOwner: false,
    conversationToolPolicy: { deny: ["exec"] }, groupId: "group", memberRoleIds: ["role"],
    toolExecutionAllow: ["read"], initialReplayState: { replayInvalid: false, hadPotentialSideEffects: false },
    skillsSnapshot: { prompt: "Visible skill instructions." }, extraSystemPrompt: "Extra rules.",
    skillLibraryAuthoring: { invoke() { throw new Error("Authoring capability must stay unused"); } },
    finalizePromptForResolvedTools: ({ prompt, messageToolAvailable }) => {
      assert.equal(messageToolAvailable, false);
      return `finalized ${prompt}`;
    },
    hostCapabilities: {
      assertActive() {},
      createToolSurface() { throw new Error("binding before the dispatch guard is not supported"); },
      bindToolSurface(surface) {
        return surface.map((tool) => {
          const bound = { ...tool };
          wrapped.add(bound);
          return bound;
        });
      },
    },
  };
  hookRestriction = ["read", "write"];
  const host = await prepareNativeHost(base, signal(), () => {});
  assert.deepEqual(host.tools.map((tool) => tool.name), ["read"]);
  assert.deepEqual(construction.config, base.config);
  assert.equal(construction.senderIsOwner, false);
  assert.deepEqual(construction.conversationToolPolicy, base.conversationToolPolicy);
  assert.equal(construction.policyAgentId, "main");
  assert.equal(construction.cwd, "task");
  assert.equal(construction.exec.allowBackground, false);
  assert.equal(construction.wrapBeforeToolCallHook, false);
  assert.equal(construction.disableMessageTool, true);
  assert.equal(construction.allowGatewaySubagentBinding, false);
  assert.equal(construction.toolConstructionPlan.includeChannelTools, false);
  assert.equal(construction.toolConstructionPlan.includePluginTools, false);
  assert.equal(construction.toolConstructionPlan.includeOpenClawTools, false);
  assert.equal(construction.skillLibraryAuthoring, undefined);
  assert.equal(JSON.stringify(host).includes("skillLibraryAuthoring"), false);
  assert.equal(bootstrapOptions.workspaceDir, "canonical");
  assert.equal(hookOptions.ctx.senderId, "sender");
  assert.match(host.systemPrompt, /Bootstrap rules/);
  assert.match(host.systemPrompt, /Visible skill instructions/);
  assert.match(host.systemPrompt, /Extra rules/);
  assert.match(host.systemPrompt, /system prefix/);
  assert.equal(host.prompt, "prefix finalized user suffix");
  assert.equal((await host.executeTool(call(), signal())).text, "ok");
  await host.dispose();
  assert.equal(construction.abortSignal.aborted, true);
  assert.equal(cleaned, 1);

  hookRestriction = [];
  const noTools = await prepareNativeHost(base, signal(), () => {});
  assert.deepEqual(noTools.tools, []);
  assert.match(noTools.systemPrompt, /host tools: \(none\)/);
  await noTools.dispose();

  hookRestriction = ["read", "write"];
  const denied = await prepareNativeHost({
    ...base, pluginHarnessToolPolicySafeDeniedTools: ["read"],
  }, signal(), () => {});
  assert.deepEqual(denied.tools, []);
  await denied.dispose();

  for (const policy of [{ sandbox: { mode: "all" } }, { tools: { exec: { host: "node" } } }]) {
    await assert.rejects(prepareNativeHost({
      ...base, config: { agents: { list: [{ id: "main", ...policy }] } },
    }, signal(), () => {}), /does not support/);
  }
  await assert.rejects(prepareNativeHost({
    ...base, sandboxSessionKey: "agent:restricted:main",
    config: { agents: { list: [{ id: "restricted", tools: { exec: { host: "node" } } }] } },
  }, signal(), () => {}), /does not support/);

  failBootstrap = true;
  const before = cleaned;
  await assert.rejects(prepareNativeHost(base, signal(), () => {}), /bootstrap failed/);
  assert.equal(cleaned, before + 1);
});
