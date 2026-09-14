import assert from "node:assert/strict";
import test from "node:test";
import { attachModelProviderRequestTransport, getModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import { nativeSupports, resolveNativeRoute } from "../dist/native/route.js";

/** @typedef {import("openclaw/plugin-sdk/agent-harness").AgentHarnessV2} AgentHarnessV2 */
/** @typedef {Parameters<AgentHarnessV2["runAttempt"]>[0]} Attempt */
/** @typedef {Parameters<AgentHarnessV2["supports"]>[0]} SupportContext */

const config = {
  stateDir: "route-fixture-state",
  startupTimeoutMs: 1000,
  shutdownTimeoutMs: 1000,
  streamIdleTimeoutMs: 1000,
  allowedBaseUrls: [],
};

/** @returns {SupportContext} */
function support(overrides = {}) {
  return {
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
    requestedRuntime: "dsh-native",
    modelProvider: {
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
    },
    ...overrides,
  };
}

// Only the SDK attempt fields read by this pure route validator are needed.
/** @returns {Pick<Attempt, "provider" | "modelId" | "model" | "resolvedApiKey" | "thinkLevel">} */
function attempt(overrides = {}) {
  return {
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
    resolvedApiKey: "fixture-host-api-key",
    thinkLevel: "high",
    model: {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      provider: "deepseek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
    },
    ...overrides,
  };
}

function resolve(p = attempt(), cfg = config) {
  return resolveNativeRoute(/** @type {Attempt} */ (p), cfg, getModelProviderRequestTransport);
}

test("support is explicit-only and does not require compatibleIds", () => {
  assert.equal(nativeSupports(support()).supported, true);
  for (const requestedRuntime of ["auto", "openclaw", "dsh", undefined]) {
    const result = nativeSupports(support({ requestedRuntime }));
    assert.equal(result.supported, false);
    assert.match(result.reason, /explicit/u);
  }
});

test("host-prepared disabled fastMode is accepted without dropping generation overrides", () => {
  const plan = (extraParams) => ({ transport: { extraParams } });
  const baseline = resolve();
  assert.deepEqual(resolve(attempt({ runtimePlan: plan({ fastMode: false }) })), baseline);
  for (const extraParams of [{ fastMode: true }, { temperature: 0 }, { maxTokens: 500 }, { topP: 1 }]) {
    assert.throws(() => resolve(attempt({ runtimePlan: plan(extraParams) })), /prepared generation/);
  }
});

test("support requires real provider identity, a concrete model and Chat Completions", () => {
  for (const overrides of [
    { provider: "openrouter" }, { provider: "openai" }, { provider: "deepseek-proxy" },
    { modelId: "auto" }, { modelId: "default" }, { modelId: "" }, { modelId: undefined },
    { modelProvider: undefined },
    { modelProvider: { ...support().modelProvider, api: "openai-responses" } },
    { providerOwnerStatus: "ambiguous" },
  ]) {
    assert.equal(nativeSupports(support(overrides)).supported, false);
  }
  assert.equal(nativeSupports(support({ providerOwnerStatus: "owned" })).supported, true);
});

test("support honors explicit runtime policy without demanding absent policy", () => {
  for (const compatibleIds of [[], ["openclaw"]]) {
    assert.equal(nativeSupports(support({
      modelProvider: { ...support().modelProvider, runtimePolicy: { compatibleIds } },
    })).supported, false);
  }
  assert.equal(nativeSupports(support({
    modelProvider: { ...support().modelProvider, runtimePolicy: { compatibleIds: ["dsh-native"] } },
  })).supported, true);
});

test("support rejects auth and transport behavior it cannot reproduce", () => {
  for (const overrides of [
    { requestTransportOverrides: "present" },
    { azureApiVersion: "2026-01-01" },
    { preparedAuth: { source: "harness" } },
    { preparedAuth: { source: "none" } },
    { preparedAuth: { source: "profile", mode: "oauth" } },
    { preparedAuth: { source: "direct", requirement: "subscription" } },
    { request: { auth: { mode: "header" } } },
    { request: { proxy: { mode: "env-proxy" } } },
    { request: { tls: { insecureSkipVerify: false } } },
    { request: { allowPrivateNetwork: false } },
  ]) {
    const result = nativeSupports(support({
      modelProvider: { ...support().modelProvider, ...overrides },
    }));
    assert.equal(result.supported, false);
    assert.ok(result.reason);
  }
  assert.equal(nativeSupports(support({
    modelProvider: {
      ...support().modelProvider,
      requestTransportOverrides: "none",
      preparedAuth: { source: "profile", mode: "api_key", requirement: "api-key" },
      request: { auth: { mode: "provider-default" } },
    },
  })).supported, true);
});

test("resolved credentials, provider-facing model and URL are preserved without mutation", () => {
  const p = attempt({ modelId: "operator-alias", resolvedApiKey: "  exact-host-key  " });
  p.model.baseUrl = "https://api.deepseek.com/v1/";
  Object.freeze(p.model);
  Object.freeze(p);
  assert.deepEqual(resolve(p), {
    modelId: "deepseek-v4-pro",
    apiKey: "  exact-host-key  ",
    baseUrl: "https://api.deepseek.com/v1/",
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    thinking: "enabled",
    reasoningEffort: "high",
  });
});

test("no environment, profile store or DSH login can substitute for a resolved key", () => {
  for (const resolvedApiKey of [undefined, "", "  ", "key\ninjection"]) {
    const p = attempt({ resolvedApiKey });
    Object.defineProperty(p, "authStorage", { get() { throw new Error("must not read credentials"); } });
    Object.defineProperty(p, "authProfileStore", { get() { throw new Error("must not read profiles"); } });
    assert.throws(() => resolve(p), /host-resolved API key/u);
  }
});

test("concrete attempt route is checked again independently of supports", () => {
  for (const overrides of [{ provider: "openrouter" }, { api: "openai-responses" }, { id: "auto" }]) {
    const p = attempt();
    Object.assign(p.model, overrides);
    assert.throws(() => resolve(p), /concrete DeepSeek/u);
  }
  assert.throws(() => resolve(attempt({ provider: "openai" })), /concrete DeepSeek/u);
});

test("stock DeepSeek compatibility metadata is accepted, conflicting overrides are rejected", () => {
  const p = attempt();
  p.model.compat = {
    thinkingFormat: "deepseek",
    maxTokensField: "max_tokens",
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsUsageInStreaming: true,
    requiresReasoningContentOnAssistantMessages: true,
    reasoningEffortMap: { low: "high", medium: "high", high: "high", xhigh: "max", max: "max" },
  };
  assert.equal(resolve(p).thinking, "enabled");
  for (const compat of [
    { thinkingFormat: "openrouter" }, { supportsUsageInStreaming: false },
    { maxTokensField: "max_completion_tokens" }, { supportsDeveloperRole: true },
    { requiresReasoningContentOnAssistantMessages: false },
    { reasoningEffortMap: { high: "low" } }, { openRouterRouting: { only: ["deepseek"] } },
    { cacheControlFormat: "anthropic" }, { unknownFutureFlag: true },
  ]) {
    p.model.compat = compat;
    assert.throws(() => resolve(p), /overrides/u);
  }
});

test("SDK-attached transport metadata is rejected using the real public helper", () => {
  for (const request of [
    { headers: { "x-custom": "fixture-secret" } },
    { auth: { mode: "authorization-bearer", token: "fixture-secret" } },
    { auth: { mode: "header", headerName: "x-key", value: "fixture-secret" } },
    { proxy: { mode: "env-proxy" } },
    { proxy: { mode: "explicit-proxy", url: "http://proxy.test" } },
    { tls: { ca: "fixture-secret" } }, { allowPrivateNetwork: true },
  ]) {
    const p = attempt();
    p.model = attachModelProviderRequestTransport(p.model, request);
    assert.throws(() => resolve(p), (error) => {
      assert.match(error.message, /overrides/u);
      assert.doesNotMatch(error.message, /fixture-secret/u);
      return true;
    });
  }
  const p = attempt();
  p.model = attachModelProviderRequestTransport(p.model, { headers: {}, auth: { mode: "provider-default" } });
  assert.equal(resolve(p).apiKey, p.resolvedApiKey);
});

test("DeepSeek HTTPS origin is trusted but custom URLs need an exact allowlist entry", () => {
  for (const baseUrl of ["https://api.deepseek.com", "https://api.deepseek.com/v1"]) {
    const p = attempt();
    p.model.baseUrl = baseUrl;
    assert.equal(resolve(p).baseUrl, baseUrl);
  }
  const p = attempt();
  for (const baseUrl of [
    "https://api.deepseek.com.evil.test/v1", "https://proxy.test/v1",
    "https://api.deepseek.com:8443/v1", "http://127.0.0.1:9876/v1",
  ]) {
    p.model.baseUrl = baseUrl;
    assert.throws(() => resolve(p), /not allowed/u);
    assert.equal(resolve(p, { ...config, allowedBaseUrls: [baseUrl] }).baseUrl, baseUrl);
  }
  p.model.baseUrl = "https://proxy.test/v1";
  for (const allowed of ["https://proxy.test", "https://proxy.test/v10", "https://proxy.test/v1/child"]) {
    assert.throws(() => resolve(p, { ...config, allowedBaseUrls: [allowed] }), /not allowed/u);
  }
  assert.equal(resolve(p, { ...config, allowedBaseUrls: ["https://proxy.test/v1/"] }).baseUrl, p.model.baseUrl);
});

test("unsafe URLs fail even when explicitly allowlisted, without echoing secrets", () => {
  for (const baseUrl of [
    "http://api.deepseek.com", "http://api.deepseek.com./v1",
    "https://user:fixture-secret@api.deepseek.com",
    "https://api.deepseek.com?key=fixture-secret", "https://api.deepseek.com#fragment",
    "https://api.deepseek.com\\@evil.test", " https://api.deepseek.com",
    "https://api.deepseek.com\n", "file:///fixture-secret", "not-a-url",
  ]) {
    const p = attempt();
    p.model.baseUrl = baseUrl;
    assert.equal(nativeSupports(support({
      modelProvider: { ...support().modelProvider, baseUrl },
    })).supported, false);
    assert.throws(() => resolve(p, { ...config, allowedBaseUrls: [baseUrl] }), (error) => {
      assert.doesNotMatch(error.message, /fixture-secret/u);
      return true;
    });
  }
});

test("stream token budget is preserved and context caps are honored rather than defaulted", () => {
  const p = attempt({ contextTokenBudget: 100_000, authoredContextTokenCap: 90_000,
    streamParams: { maxTokens: 1234 } });
  assert.equal(resolve(p).maxTokens, 1234);
  assert.equal(resolve(p).contextWindow, 90_000);
  for (const maxTokens of [0, -1, 1.5, NaN, Infinity, null, 100_001]) {
    assert.throws(() => resolve({ ...p, streamParams: { maxTokens } }), /maxTokens/u);
  }
  for (const contextWindow of [0, -1, NaN, Infinity, 2.5]) {
    p.model.contextWindow = contextWindow;
    assert.throws(() => resolve(p), /context window/u);
  }
});

test("thinking off is explicit; V4 levels preserve documented high/max wire semantics", () => {
  const off = resolve(attempt({ thinkLevel: "off" }));
  assert.equal(off.thinking, "disabled");
  assert.equal(Object.hasOwn(off, "reasoningEffort"), false);
  for (const thinkLevel of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
    const route = resolve(attempt({ thinkLevel }));
    assert.equal(route.thinking, "enabled");
    assert.equal(route.reasoningEffort, ["xhigh", "max"].includes(thinkLevel) ? "max" : "high");
  }
  for (const thinkLevel of ["adaptive", "ultra", undefined, "unknown"]) {
    assert.throws(() => resolve(attempt({ thinkLevel })), /thinking level/u);
  }
});

test("unsupported generation options, client tools, media and remote sandbox fail closed", () => {
  for (const key of ["temperature", "topP", "stop", "fastMode", "responseFormat",
    "frequencyPenalty", "presencePenalty", "seed", "unknownOption"]) {
    assert.throws(() => resolve(attempt({ streamParams: { [key]: 0 } })), /generation/u);
  }
  for (const overrides of [
    { fastMode: true }, { fastModeAuto: true },
    { clientTools: [{ type: "function", function: { name: "client" } }] },
    { images: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
    { media: [{ kind: "audio" }] }, { sandbox: { enabled: true } },
    { sandbox: { enabled: false, required: true } }, { execOverrides: { host: "node" } },
    { swarmOutputSchema: { type: "object" } },
  ]) assert.throws(() => resolve(attempt(overrides)), /unsupported|overrides/u);
  assert.equal(resolve(attempt({ fastMode: false, images: [], media: [], clientTools: [] })).thinking, "enabled");
});

test("model/provider/default/agent overrides cannot silently disappear", () => {
  for (const modelOverride of [{ headers: { "x-test": "value" } }, { authHeader: false },
    { params: { temperature: 0 } }, { thinkingLevelMap: { high: "low" } }]) {
    const p = attempt();
    Object.assign(p.model, modelOverride);
    assert.throws(() => resolve(p), /cannot|unsupported/u);
  }
  const ref = "deepseek/deepseek-v4-pro";
  for (const cfg of [
    { models: { providers: { deepseek: { models: [], headers: { "x-test": "value" } } } } },
    { models: { providers: { deepseek: { models: [], request: { tls: {} } } } } },
    { models: { providers: { deepseek: { models: [], params: { temperature: 0 } } } } },
    { models: { providers: { deepseek: { models: [], auth: "oauth" } } } },
    { models: { providers: { deepseek: { models: [{ id: "deepseek-v4-pro", params: { seed: 1 } }] } } } },
    { agents: { defaults: { params: { temperature: 0 } } } },
    { agents: { defaults: { models: { [ref]: { params: { thinking: { type: "disabled" } } } } } } },
    { agents: { defaults: { models: { [ref]: { streaming: false } } } } },
    { agents: { entries: { main: { models: { [ref]: { params: { topP: 0.5 } } } } } } },
    { agents: { list: [{ id: "main", params: { seed: 1 } }] } },
  ]) {
    assert.throws(() => resolve(attempt({ agentId: "main", config: cfg })));
    assert.throws(() => resolve(attempt({ agentId: "main", preparedModelRuntime: { config: cfg } })));
  }
});

test("prepared runtime auth, transport and generation restrictions are revalidated", () => {
  const p = attempt();
  const runtimePlan = {
    resolvedRef: { provider: "deepseek", modelId: p.model.id, transport: "sse" },
    auth: {
      providerForAuth: "deepseek",
      authProfileProviderForAuth: "deepseek",
      selectedAuthMode: "api_key",
      modelRoute: {
        provider: "deepseek",
        modelId: p.model.id,
        api: p.model.api,
        baseUrl: p.model.baseUrl,
        authRequirement: "api-key",
        requestTransportOverrides: "none",
      },
    },
    transport: { extraParams: {} },
  };
  assert.equal(resolve({ ...p, runtimePlan }).apiKey, p.resolvedApiKey);
  for (const overrides of [
    { transport: { extraParams: { responseFormat: { type: "json_object" } } } },
    { resolvedRef: { ...runtimePlan.resolvedRef, transport: "websocket" } },
    { auth: { ...runtimePlan.auth, selectedAuthMode: "oauth" } },
    { auth: { ...runtimePlan.auth, harnessAuthProvider: "dsh-native" } },
    { auth: { ...runtimePlan.auth, deferredRouteSupport: {
      requestTransportOverrides: "none", runtimePolicy: { compatibleIds: ["dsh-native"] },
    } } },
  ]) assert.throws(() => resolve({ ...p, runtimePlan: { ...runtimePlan, ...overrides } }));
  for (const override of [
    { provider: "openrouter" }, { modelId: "other-model" }, { api: "openai-responses" },
    { baseUrl: "https://other.test" }, { authRequirement: "subscription" },
    { requestTransportOverrides: "present" }, { runtimePolicy: { compatibleIds: ["openclaw"] } },
  ]) {
    assert.throws(() => resolve({ ...p, runtimePlan: {
      ...runtimePlan,
      auth: { ...runtimePlan.auth, modelRoute: { ...runtimePlan.auth.modelRoute, ...override } },
    } }));
  }
});
