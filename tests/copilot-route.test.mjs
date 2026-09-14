import assert from "node:assert/strict";
import test from "node:test";
import { nativeSupports, resolveNativeRoute } from "../dist/native/route.js";
import { parseDshConfig } from "../dist/config.js";
import { copilotHeaders } from "../dist/copilot-policy.js";

const config = parseDshConfig({});
const headers = {
  "Accept-Encoding": "identity", "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "User-Agent": "GitHubCopilotChat/0.35.0", "Openai-Organization": "github-copilot",
  "Copilot-Integration-Id": "copilot-developer-cli",
};
function attempt(overrides = {}) {
  return {
    provider: "github-copilot", modelId: "gpt-6-astra", resolvedApiKey: "fixture-host-token",
    thinkLevel: "xhigh",
    model: {
      provider: "github-copilot", api: "openai-responses", id: "gpt-6-astra", name: "Account Astra",
      baseUrl: "https://api.individual.githubcopilot.com", input: ["text"], reasoning: true,
      contextWindow: 1000000, maxTokens: 128000,
      compat: { supportsReasoningEffort: true, supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
    },
    ...overrides,
  };
}
function support(overrides = {}) {
  return {
    requestedRuntime: "dsh-native", provider: "github-copilot", modelId: "gpt-6-astra",
    modelProvider: {
      api: "openai-responses", baseUrl: "https://api.individual.githubcopilot.com",
      requestTransportOverrides: "present", request: { headers },
      preparedAuth: { source: "profile", mode: "token", requirement: "subscription" },
    },
    ...overrides,
  };
}
const resolve = (p = attempt(), cfg = config, request = { headers }) => resolveNativeRoute(p, cfg, () => request);

test("Copilot is explicit-only and uses GPT Responses rather than the DeepSeek protocol", () => {
  assert.equal(nativeSupports(support()).supported, true);
  for (const change of [
    { requestedRuntime: "auto" },
    { modelId: "auto" }, { modelId: "claude-sonnet-5" },
    { modelProvider: { ...support().modelProvider, api: "openai-completions" } },
    { modelProvider: { ...support().modelProvider, runtimePolicy: { compatibleIds: ["copilot"] } } },
    { modelProvider: { ...support().modelProvider, preparedAuth: { source: "harness" } } },
  ]) assert.equal(nativeSupports(support(change)).supported, false);
});

test("preserves host account, model metadata and supported per-model effort", () => {
  const result = resolve();
  assert.equal(result.provider, "github-copilot");
  assert.equal(result.modelId, "gpt-6-astra");
  assert.equal(result.modelName, "Account Astra");
  assert.equal(result.apiKey, "fixture-host-token");
  assert.equal(result.baseUrl, "https://api.individual.githubcopilot.com");
  assert.equal(result.contextWindow, 1000000);
  assert.equal(result.maxTokens, 128000);
  assert.equal(result.reasoningEffort, "xhigh");
  assert.equal(result.reasoningEfforts.minimal, "low");
  assert.deepEqual(result.headers, headers);
  const sol = attempt();
  sol.model = { ...sol.model, id: "gpt-5.6-sol", contextWindow: 200000, maxTokens: 32000 };
  const solResult = resolve(sol);
  assert.equal(solResult.modelId, "gpt-5.6-sol");
  assert.equal(solResult.contextWindow, 200000);
});

test("off and declared capability limits do not silently clamp to a different model", () => {
  assert.equal(resolve(attempt({ thinkLevel: "off" })).reasoningEffort, "off");
  const p = attempt();
  p.model.compat.supportedReasoningEfforts = ["low", "high"];
  assert.throws(() => resolve(p), /does not support/);
  assert.throws(() => resolve(attempt({ thinkLevel: "adaptive" })), /unsupported/);
  assert.throws(() => resolve(attempt({ thinkLevel: "ultra" })), /unsupported/);
  assert.throws(() => resolve(attempt({ resolvedApiKey: '{"githubToken":"unprepared"}' })), /raw host/);
  const nonReasoning = attempt({ thinkLevel: "off" });
  nonReasoning.model.reasoning = false;
  nonReasoning.model.compat = { codeMode: "preferred" };
  const resolved = resolve(nonReasoning);
  assert.equal(resolved.reasoningEffort, undefined);
  assert.equal(resolved.reasoningEfforts, false);
});

test("exact endpoints are provider-scoped and custom loopback requires an explicit grant", () => {
  const p = attempt();
  p.model.baseUrl = "http://127.0.0.1:12345";
  assert.throws(() => resolve(p), /allowedCopilotBaseUrls/);
  assert.equal(resolve(p, parseDshConfig({ allowedCopilotBaseUrls: [p.model.baseUrl] })).baseUrl, p.model.baseUrl);
  p.model.baseUrl = "https://api.individual.githubcopilot.com.attacker.example";
  assert.throws(() => resolve(p), /allowedCopilotBaseUrls/);
  p.model.baseUrl = "http://api.individual.githubcopilot.com";
  assert.throws(() => resolve(p), /HTTPS/);
});

test("only nonsecret prepared identity headers can cross into a profile", () => {
  const p = attempt();
  p.model.headers = { "copilot-integration-id": "vscode-chat" };
  assert.equal(resolve(p).headers["Copilot-Integration-Id"], "copilot-developer-cli");
  for (const bad of [
    { Authorization: "Bearer credential" }, { Cookie: "session=credential" },
    { "X-Initiator": "user" }, { "Copilot-Vision-Request": "true" },
    { "User-Agent": "line\r\ninjection" }, { "User-Agent": "Bearer credential" },
    { "User-Agent": "a", "user-agent": "b" },
  ]) assert.throws(() => resolve(attempt(), config, { headers: bad }), /header|Credential/);
  assert.deepEqual(copilotHeaders({ "editor-version": "vscode/1" }), { "Editor-Version": "vscode/1" });
  assert.throws(() => resolve(attempt({ config: { models: { providers: {
    "github-copilot": { headers: { "User-Agent": "custom-client" } },
  } } } })), /custom User-Agent/);
});

test("incompatible auth routes and transport behavior fail before model execution", () => {
  for (const request of [
    { proxy: "https://proxy.example" }, { tls: {} }, { auth: { mode: "none" } },
    { privateNetwork: true },
  ]) assert.throws(() => resolve(attempt(), config, request), /transport/);
  assert.throws(() => resolve(attempt({ runtimePlan: { auth: { selectedAuthMode: "aws-sdk" } } })), /host token/);
  assert.throws(() => resolve(attempt({ streamParams: { temperature: 0.5 } })), /stream parameter/);
  assert.throws(() => resolve(attempt({ runtimePlan: { auth: { modelRoute: {
    provider: "openai", modelId: "gpt-6-astra", api: "openai-responses",
    baseUrl: "https://api.individual.githubcopilot.com",
  } } } })), /differs/);
});
