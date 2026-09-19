import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";

const stateKey = Symbol.for("dsh.native-source-reply-construction");
globalThis[stateKey] = {};

const sourceModules = new Map([
  "native/host", "native/source-reply", "native/tool-bridge", "native/preparation", "preparation",
].map((name) => [
  new URL(`../dist/${name}.js`, import.meta.url).href,
  new URL(`../src/${name}.ts`, import.meta.url),
]));

const runtimeExports = [
  "resolveSessionAgentIds", "resolveAgentDir", "buildEmbeddedForegroundPromptContext",
  "resolveEmbeddedAttemptToolConstructionPlan", "buildEmbeddedAttemptToolRunContext", "supportsModelTools",
  "resolveModelAuthMode", "applyEmbeddedAttemptToolsAllow", "getPluginToolMeta", "getChannelAgentToolMeta",
  "isAgentToolReplaySafe", "isToolWrappedWithBeforeToolCallHook", "isHostScopedAgentToolActive",
  "resolveBootstrapContextForRun", "buildCredentialSafetyPrompt", "buildHarnessVisibleReplyGuidance",
  "resolveAgentHarnessBeforePromptBuildResult", "consumeAdjustedParamsForToolCall",
  "consumePreExecutionBlockedToolCall", "runAgentHarnessAfterToolCallHook", "isToolResultError",
  "formatToolExecutionErrorMessage", "getBeforeToolCallFailureDisposition", "extractMessagingToolSend",
  "extractMessagingToolSendResult", "isDeliveredMessageToolOnlySourceReplyResult",
];

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "openclaw/plugin-sdk/agent-harness-runtime") {
      return { url: "dsh-construction-test:runtime", shortCircuit: true };
    }
    if (specifier === "openclaw/plugin-sdk/agent-harness") {
      return { url: "dsh-construction-test:harness", shortCircuit: true };
    }
    if (specifier === "openclaw/plugin-sdk/agent-scope-runtime") {
      return { url: "dsh-construction-test:scope", shortCircuit: true };
    }
    const url = context.parentURL && new URL(specifier, context.parentURL).href;
    return sourceModules.has(url) ? { url, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (url === "dsh-construction-test:runtime") {
      return { format: "module", shortCircuit: true, source: runtimeExports.map((name) =>
        `export const ${name} = (...args) => globalThis[Symbol.for("dsh.native-source-reply-construction")].runtime.${name}(...args);`).join("\n") };
    }
    if (url === "dsh-construction-test:harness") {
      return { format: "module", shortCircuit: true,
        source: "export const createOpenClawCodingTools = (...args) => globalThis[Symbol.for('dsh.native-source-reply-construction')].harness.createOpenClawCodingTools(...args);" };
    }
    if (url === "dsh-construction-test:scope") {
      return { format: "module", shortCircuit: true,
        source: "export const resolveAgentConfig = (...args) => globalThis[Symbol.for('dsh.native-source-reply-construction')].scope.resolveAgentConfig(...args);" };
    }
    if (sourceModules.has(url)) {
      return { format: "module", shortCircuit: true,
        source: ts.transpileModule(readFileSync(sourceModules.get(url), "utf8"),
          { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText };
    }
    return next(url, context);
  },
});

const { prepareNativeHost, createNativeToolHost } = await import("../dist/native/host.js");

test.after(() => {
  hooks.deregister();
  delete globalThis[stateKey];
});

const signal = () => new AbortController().signal;
const schema = { type: "object", properties: { path: { type: "string" } }, additionalProperties: false };
const messageSchema = {
  type: "object",
  properties: { action: { type: "string" }, message: { type: "string" }, final: { type: "boolean" } },
  required: ["action", "message", "final"],
  additionalProperties: false,
};
const tool = (name, fields = {}) => ({ name, label: name, description: name, parameters: schema,
  execute: async () => ({ content: [{ type: "text", text: "ok" }] }), ...fields });
const messageTool = (fields = {}) => tool("message", {
  parameters: messageSchema,
  execute: async (_id, args) => ({ content: [{ type: "text", text: "sent" }],
    details: { deliveredText: args.message, messageDelivery: { sourceReplyDelivered: true, status: "settled" } } }),
  ...fields,
});

function installSdkFixture(t, options = {}) {
  const calls = { plans: [], constructions: [], bootstrap: 0, beforePrompt: 0, bound: [] };
  const wrapped = new WeakSet();
  const pluginMeta = new WeakMap();
  const channelMeta = new WeakMap();
  const constructedTools = options.constructedTools ?? [tool("read"), messageTool()];
  for (const candidate of constructedTools) {
    if (candidate.plugin) pluginMeta.set(candidate, candidate.plugin);
    if (candidate.channel) channelMeta.set(candidate, candidate.channel);
  }
  const restrict = (tools, allow, metaProvider) => {
    if (allow === undefined) return tools;
    return tools.filter((candidate) => allow.includes("*") || allow.includes(candidate.name) ||
      metaProvider?.(candidate) && allow.includes(metaProvider(candidate).pluginId));
  };
  const runtime = {
    resolveSessionAgentIds: ({ fallbackAgentId }) => ({ sessionAgentId: fallbackAgentId ?? "main" }),
    resolveAgentDir: () => "agent-dir",
    buildEmbeddedForegroundPromptContext: (p) => ({ ...p, sandboxSessionKey: p.sessionKey }),
    resolveEmbeddedAttemptToolConstructionPlan: (plan) => {
      calls.plans.push(plan);
      return options.plan ?? {
        constructTools: plan.forceMessageTool || plan.toolsAllow?.length !== 0,
        includeCoreTools: true,
        runtimeToolAllowlist: plan.toolsAllow,
        codingToolConstructionPlan: {
          includeBaseCodingTools: true, includeShellTools: true, includeOpenClawTools: true,
          includePluginTools: true, includeChannelTools: true,
        },
      };
    },
    buildEmbeddedAttemptToolRunContext: () => ({}),
    supportsModelTools: () => true,
    resolveModelAuthMode: () => "api-key",
    applyEmbeddedAttemptToolsAllow: (tools, allow, opts) => restrict(tools, allow, opts?.toolMeta),
    getPluginToolMeta: (candidate) => pluginMeta.get(candidate),
    getChannelAgentToolMeta: (candidate) => channelMeta.get(candidate),
    isAgentToolReplaySafe: () => false,
    isToolWrappedWithBeforeToolCallHook: (candidate) => wrapped.has(candidate),
    isHostScopedAgentToolActive: () => false,
    resolveBootstrapContextForRun: async () => { calls.bootstrap++; return { contextFiles: [] }; },
    buildCredentialSafetyPrompt: () => "Credential safety.",
    buildHarnessVisibleReplyGuidance: () => "Reply in text.",
    resolveAgentHarnessBeforePromptBuildResult: async (params) => {
      calls.beforePrompt++;
      return { prompt: params.prompt, developerInstructions: params.developerInstructions.build({}), toolsAllow: options.finalToolsAllow };
    },
    consumeAdjustedParamsForToolCall: () => undefined,
    consumePreExecutionBlockedToolCall: () => false,
    runAgentHarnessAfterToolCallHook: async () => {},
    isToolResultError: (result) => result?.isError === true,
    formatToolExecutionErrorMessage: (error) => error.message,
    getBeforeToolCallFailureDisposition: () => undefined,
    extractMessagingToolSend: (_name, args) => ({ tool: "message", provider: "fixture", text: args.message, sourceReplyFinal: true }),
    extractMessagingToolSendResult: (pending, result) => ({ ...pending, text: result.details.deliveredText }),
    isDeliveredMessageToolOnlySourceReplyResult: (params) =>
      params.sourceReplyDeliveryMode === "message_tool_only" &&
      params.toolName === "message" &&
      params.result?.details?.messageDelivery?.sourceReplyDelivered === true &&
      params.result?.details?.messageDelivery?.status === "settled" &&
      !params.isError,
  };
  globalThis[stateKey] = {
    runtime,
    harness: { createOpenClawCodingTools: (params) => { calls.constructions.push(params); return constructedTools; } },
    scope: { resolveAgentConfig: () => undefined },
  };
  t.after(() => { globalThis[stateKey] = {}; });
  return { calls, wrapped };
}

function attempt(overrides = {}) {
  const wrapped = overrides.wrapped;
  return {
    sessionId: "session", sessionKey: "agent:main", runId: "run", workspaceDir: process.cwd(), cwd: process.cwd(),
    prompt: "reply to the current source", provider: "openai", modelId: "model",
    model: { id: "model", api: "openai-completions", contextWindow: 4096 },
    config: {}, timeoutMs: 1000, sourceReplyDeliveryMode: "message_tool_only",
    hostCapabilities: {
      assertActive() {},
      bindToolSurface: (surface) => surface.map((candidate) => {
        const bound = { ...candidate };
        wrapped?.add(bound);
        return bound;
      }),
    },
    ...overrides,
  };
}

async function prepare(t, attemptOverrides = {}, fixtureOptions = {}, hostToolAllowlist) {
  const sdk = installSdkFixture(t, fixtureOptions);
  const p = attempt({ ...attemptOverrides, wrapped: sdk.wrapped });
  const host = await prepareNativeHost(p, signal(), () => {}, [], undefined, hostToolAllowlist);
  return { host, sdk, p };
}

test("private current-source message is forced for construction but never advertised to the model", async (t) => {
  const { host, sdk } = await prepare(t, {}, {}, []);
  assert.equal(sdk.calls.plans[0].forceMessageTool, true);
  assert.deepEqual(sdk.calls.plans[0].toolsAllow, []);
  assert.deepEqual(host.tools, []);
  assert.match(host.systemPrompt, /Available policy-filtered host tools: \(none\)/);
  assert.doesNotMatch(host.systemPrompt, /Available policy-filtered host tools: message/);
  assert.equal(typeof host.deliverSourceReply, "function");
  const delivered = await host.deliverSourceReply("Final current-source reply", signal());
  assert.equal(delivered.sourceReplyDelivered, true);
});

test("explicit run-level tool denies are preserved for private source replies", async (t) => {
  await assert.rejects(
    prepare(t, { toolsAllow: ["read"] }, { constructedTools: [tool("read"), messageTool()] }, []),
    /private message tool current-source route/u,
  );
  await assert.rejects(
    prepare(t, { toolExecutionAllow: [] }, { constructedTools: [messageTool()] }, []),
    /private message tool execution is denied/u,
  );
});

test("private source reply accepts only the core message tool, not plugin or channel shadows", async (t) => {
  await assert.rejects(
    prepare(t, {}, { constructedTools: [messageTool({ plugin: { pluginId: "shadow-plugin" } })] }, []),
    /core message tool/u,
  );
  await assert.rejects(
    prepare(t, {}, { constructedTools: [messageTool({ channel: { channelId: "shadow-channel" } })] }, []),
    /core message tool/u,
  );
});

test("ambiguous duplicate message candidates are rejected before prompt construction", async (t) => {
  const fixture = installSdkFixture(t, { constructedTools: [messageTool(), messageTool()] });
  await assert.rejects(
    prepareNativeHost(attempt({ wrapped: fixture.wrapped }), signal(), () => {}, [], undefined, []),
    /Ambiguous private current-source message tool/u,
  );
  assert.equal(fixture.calls.bootstrap, 0);
  assert.equal(fixture.calls.beforePrompt, 0);
});

test("missing private route fails before prompt/model preparation in message mode", async (t) => {
  const fixture = installSdkFixture(t, { constructedTools: [tool("read")] });
  await assert.rejects(
    prepareNativeHost(attempt({ wrapped: fixture.wrapped }), signal(), () => {}, [], undefined, []),
    /requires an authorized private message tool current-source route/u,
  );
  assert.equal(fixture.calls.bootstrap, 0);
  assert.equal(fixture.calls.beforePrompt, 0);
});

test("silent and memory message-mode attempts do not force or require a private message tool", async (t) => {
  await t.test("silentExpected", async (t) => {
    const { host, sdk } = await prepare(t, { silentExpected: true }, { constructedTools: [tool("read")] }, []);
    assert.equal(sdk.calls.plans[0].forceMessageTool, false);
    assert.equal(host.deliverSourceReply, undefined);
  });
  await t.test("memory trigger", async (t) => {
    const { host, sdk } = await prepare(t, { trigger: "memory" }, { constructedTools: [tool("read")] }, []);
    assert.equal(sdk.calls.plans[0].forceMessageTool, false);
    assert.equal(host.deliverSourceReply, undefined);
  });
});

test("createNativeToolHost identity guard rejects a mutated private message source", () => {
  const privateMessage = messageTool();
  const pluginMeta = new WeakMap();
  const wrapped = new WeakSet();
  const runtime = {
    getPluginToolMeta: (candidate) => pluginMeta.get(candidate),
    getChannelAgentToolMeta: () => undefined,
    isAgentToolReplaySafe: () => false,
    isToolWrappedWithBeforeToolCallHook: (candidate) => wrapped.has(candidate),
    consumeAdjustedParamsForToolCall: () => undefined,
    consumePreExecutionBlockedToolCall: () => false,
    runAgentHarnessAfterToolCallHook: async () => {},
    isToolResultError: () => false,
    formatToolExecutionErrorMessage: (error) => error.message,
    getBeforeToolCallFailureDisposition: () => undefined,
    extractMessagingToolSend: () => undefined,
    extractMessagingToolSendResult: (pending) => pending,
    isDeliveredMessageToolOnlySourceReplyResult: () => true,
  };
  assert.throws(() => createNativeToolHost({
    tools: [],
    privateSourceReplyTool: privateMessage,
    privateSourceReplyAttempt: { sourceReplyDeliveryMode: "message_tool_only", config: {} },
    runtime,
    signal: signal(),
    assertActive() {},
    runId: "run",
    sessionId: "session",
    cwd: process.cwd(),
    bindToolSurface(surface) {
      pluginMeta.set(privateMessage, { pluginId: "late-shadow" });
      return surface.map((candidate) => { const bound = { ...candidate }; wrapped.add(bound); return bound; });
    },
  }), /source identity changed/u);
});
