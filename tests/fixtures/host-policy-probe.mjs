import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const root = process.argv[2];
const load = (name) => import(pathToFileURL(join(root, "dist", name)).href);
const { t: resolvePolicy } = await load("policy-D9i1QMuw.js");
const { t: available } = await load("availability-DrQ2OOVX.js");
const { l: fallbackRuntime, u: fallbackAuth } = await load("model-fallback-attempt-hBQW6kuE.js");
const { t: createRegistry } = await load("registry-empty-55wlVNzO.js");
const { O: setRegistry } = await load("runtime-BL4wZfTq.js");
const registry = createRegistry();
setRegistry(registry, "isolated-agent-pin-test");
const selection = await load("selection-CgLPGlZh.js");
const select = Object.values(selection).find((value) => typeof value === "function" && value.name === "selectAgentHarness");
if (!select) throw new Error("Missing genuine host selector.");

const config = {
  agents: {
    ownership: "explicit",
    defaults: {
      model: { primary: "github-copilot/gpt-6-astra" },
      models: { "github-copilot/gpt-6-astra": { agentRuntime: { id: "copilot" } } },
    },
    entries: { main: {}, "dsh-experiment": { runtime: { type: "embedded", harness: "dsh-native" } } },
  },
};
const base = { config, agentId: "dsh-experiment", provider: "github-copilot", modelId: "gpt-6-astra" };
assert.equal(resolvePolicy(base).runtime, "dsh-native");
assert.equal(resolvePolicy(base).runtimeSource, "agent");
assert.equal(resolvePolicy({ ...base, agentId: "main" }).runtime, "copilot");
assert.equal(resolvePolicy({ ...base, provider: "new-provider", modelId: "new-model" }).runtime, "dsh-native");

let support = { supported: true };
registry.agentHarnesses.push({ pluginId: "fixture", harness: {
  id: "dsh-native", label: "Fixture native runtime", supports() { return support; },
  async runAttempt() { throw new Error("Policy-only probe must never infer."); },
} });
assert.equal(available(base).policy.runtime, "dsh-native");
for (const overrides of [{ agentHarnessId: "openclaw" }, { agentHarnessRuntimeOverride: "copilot" }]) {
  assert.throws(() => available({ ...base, ...overrides }), /Agent is pinned/);
}
support = { supported: false, reason: "fixture unsupported model", fallbackRuntime: "openclaw" };
assert.equal(available(base).policy.runtime, "dsh-native");
assert.equal(available(base).support.supported, false);
assert.throws(() => select(base), /not substituted/);
assert.throws(() => select({ ...base, provider: "microsoft-foundry", modelId: "gpt-5.6-sol" }), /not substituted/);
assert.equal(fallbackRuntime({
  cfg: config, agentId: "dsh-experiment", provider: "microsoft-foundry", model: "gpt-5.6-sol",
}).runtime, "dsh-native");
assert.throws(() => fallbackRuntime({
  cfg: config, agentId: "dsh-experiment", provider: "microsoft-foundry", model: "gpt-5.6-sol",
  resolveAgentHarnessRuntimeOverride: () => "openclaw",
}), /conflicts with Agent-pinned/);
config.agents.entries["dsh-experiment"].runtime.harness = "claude-cli";
assert.throws(() => select({ ...base, provider: "anthropic", modelId: "claude-opus-4" }), /not registered/);
await assert.rejects(fallbackAuth({
  cfg: config, agentId: "dsh-experiment", provider: "anthropic", model: "claude-opus-4",
}), /not registered/);
console.log("HOST_AGENT_PIN_POLICY_OK");
