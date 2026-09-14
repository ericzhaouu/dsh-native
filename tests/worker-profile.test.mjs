import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { composeEntries, loadOverlayPatches, PROFILE_TEMPLATES } from "@deepseek-ai/dsh-app-boot";
import * as Spine from "@deepseek-ai/dsh-agent-spine-demo";
import * as DeepSeek from "@deepseek-ai/dsh-llm-deepseek";
import { createBridgePatch } from "../dist/bridge/profile.js";

const require = createRequire(import.meta.url);
const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const options = Object.freeze({
  bridgePath: join(projectDir, "dist", "bridge", "index.js"),
  baseUrl: "https://api.deepseek.com",
  thinking: "enabled",
  reasoningEffort: "high",
  maxTokens: 8192,
  contextWindow: 128000,
  streamIdleTimeoutMs: 60000,
});
const minimal = loadOverlayPatches(
  "worker-profile-test",
  require.resolve("@deepseek-ai/dsh-sdk-minimal/cordis.patch.yml"),
);
const base = loadOverlayPatches(
  "worker-profile-test",
  require.resolve("@deepseek-ai/dsh-base/cordis.patch.yml"),
);

function compose(patch = createBridgePatch(options)) {
  const warnings = [];
  const rows = composeEntries([minimal, patch], (message) => warnings.push(message));
  assert.deepEqual(warnings, [], "every targeted row must exist in sdk-minimal");
  return new Map(rows.map((row) => [row.id, row]));
}

test("uses the installed standalone sdk-minimal profile and real CLI composition", () => {
  assert.equal(require("@deepseek-ai/dsh/package.json").version, "0.1.2-alpha.2");
  assert.deepEqual(PROFILE_TEMPLATES["sdk-minimal"], {
    bundles: ["@deepseek-ai/dsh-sdk-minimal"],
    patchReload: "startup",
  });
  const before = structuredClone(minimal);
  const rows = compose();
  assert.deepEqual(minimal, before);
  assert.deepEqual(
    [...rows.values()].filter((row) => row.disabled !== true).map((row) => row.id),
    [
      "llm-deepseek",
      "session-projection",
      "agent-spine",
      "sessions",
      "openclaw-bridge",
    ],
  );
  for (const id of ["sessions", "session-projection"]) {
    assert.deepEqual(rows.get(id), composeEntries([minimal]).find((row) => row.id === id));
  }
});

test("disables actual native tool registrations, both stdio owners, and their executors", () => {
  const rows = compose();
  for (const [id, toolName] of [
    ["persistent-bash", "bash"],
    ["persistent-pwsh", "pwsh"],
    ["str-replace-editor", "str_replace_editor"],
  ]) {
    const row = rows.get(id);
    assert.equal(row.disabled, true);
    const source = readFileSync(require.resolve(row.name), "utf8");
    assert.match(source, /ctx\.tools\.register\(/u);
    assert.ok(source.includes(`name: "${toolName}"`), `${id} actually produces ${toolName}`);
  }
  for (const id of [
    "sdk-app-startup", "sdk-jsonrpc-server", "sandbox", "sandbox-policy",
    "subprocess", "pty", "terminal-bash", "terminal-pwsh", "fs-local",
    "deepseek-llm-api-extensions", "session-log-deepseek", "plugin-package-inventory-deepseek",
  ]) {
    assert.equal(rows.get(id).disabled, true, id);
  }
});

test("base-only non-obvious tool and autonomous producers are not part of minimal", () => {
  const baseRows = new Map(composeEntries([base]).map((row) => [row.id, row]));
  const rows = compose();
  for (const id of [
    "plan-mode", "goal-round-driver", "agent-instructions", "skill-filesystem",
    "tool-subagent-list-agents", "subagent-spawn-in-process", "subagent-fork-in-process",
    "workflow-worker-thread", "tool-ralph", "tool-web", "settings", "credentials",
    "llm-pi-ai", "session-telemetry-otel",
  ]) {
    assert.ok(baseRows.has(id), `${id} is a real base row`);
    assert.equal(rows.has(id), false, `${id} is not inherited by sdk-minimal`);
  }
  const planSource = readFileSync(require.resolve(baseRows.get("plan-mode").name), "utf8");
  assert.match(planSource, /ctx\.tools\.register\(/u);
  assert.match(planSource, /const EXIT_PLAN_MODE = "exit_plan_mode"/u);
  assert.match(planSource, /name: EXIT_PLAN_MODE/u);
  const goalSource = readFileSync(require.resolve(baseRows.get("goal-round-driver").name), "utf8");
  assert.match(goalSource, /agent\.followup\(/u);
});

test("replaces complete configs and inserts only the explicit bridge module", () => {
  const patch = createBridgePatch(options);
  assert.deepEqual(JSON.parse(JSON.stringify(patch)), patch);
  const rows = compose(patch);
  const spine = rows.get("agent-spine").config;
  assert.deepEqual(spine, {
    agents: [],
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
    persona: "",
    workspaceContext: false,
    skills: { enabled: false },
    goals: false,
    toolBash: false,
    toolJobs: false,
    tools: { mode: "native" },
  });
  assert.doesNotThrow(() => Spine.Config(spine));
  assert.equal(JSON.stringify(spine).includes("__jsExpr"), false);
  assert.deepEqual(patch.filter((entry) => entry.insert), [{
    insert: [{
      id: "openclaw-bridge",
      name: pathToFileURL(options.bridgePath).href,
      config: { contextWindow: options.contextWindow },
    }],
  }]);
  const specialPath = join(projectDir, "a space # percent % 中文", "dist", "bridge", "index.js");
  const bridge = compose(createBridgePatch({ ...options, bridgePath: specialPath })).get("openclaw-bridge");
  assert.equal(fileURLToPath(bridge.name), specialPath);
  assert.deepEqual(bridge.config, { contextWindow: options.contextWindow });
});

test("configures the built-in deepseek-official adapter with only an environment key reference", () => {
  const row = compose().get("llm-deepseek");
  assert.equal(row.name, "@deepseek-ai/dsh-llm-deepseek");
  assert.deepEqual(row.config, {
    apiKeyEnv: "OPENCLAW_DSH_MODEL_KEY",
    baseURL: options.baseUrl,
    thinking: options.thinking,
    reasoningEffort: options.reasoningEffort,
    maxTokens: options.maxTokens,
    defaultContextWindow: options.contextWindow,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
  });
  const resolved = DeepSeek.resolveAdapterOptions(DeepSeek.Config(row.config));
  assert.equal(resolved.apiKeyEnv, "OPENCLAW_DSH_MODEL_KEY");
  assert.equal(resolved.defaultContextWindow, options.contextWindow);
  assert.equal(resolved.maxTokens, options.maxTokens);
  assert.equal(resolved.streamIdleTimeoutMs, options.streamIdleTimeoutMs);
  assert.deepEqual(resolved.defaults, { thinking: "enabled", reasoningEffort: "high" });
  const accidentalSecret = "test-only-secret-must-not-be-persisted";
  assert.equal(JSON.stringify(createBridgePatch({ ...options, apiKey: accidentalSecret })).includes(accidentalSecret), false);
});

test("configures the generic Copilot adapter and disables the deepseek row", () => {
  const patch = createBridgePatch({
    ...options,
    provider: "github-copilot",
    modelId: "gpt-5",
    modelName: "GPT 5",
    headers: {
      "editor-version": "vscode/1.0.0",
      "user-agent": "OpenClaw-Test/1.0",
    },
    reasoningEfforts: {
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(patch)), patch);
  const rows = compose(patch);
  assert.equal(rows.get("llm-deepseek").disabled, true);
  const row = rows.get("llm-pi-ai");
  assert.equal(row.name, "@deepseek-ai/dsh-llm-pi-ai");
  assert.deepEqual(row.config, {
    providers: {
      "github-copilot": {
        apiKeyEnv: "OPENCLAW_DSH_MODEL_KEY",
        api: "openai-responses",
        baseURL: options.baseUrl,
        headers: {
          "Editor-Version": "vscode/1.0.0",
          "User-Agent": "OpenClaw-Test/1.0",
        },
        models: [{
          id: "gpt-5",
          name: "GPT 5",
          contextWindow: options.contextWindow,
          maxTokens: options.maxTokens,
          input: ["text"],
          reasoningEfforts: {
            off: null,
            minimal: "minimal",
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: "xhigh",
            max: "max",
          },
        }],
        streamIdleTimeoutMs: options.streamIdleTimeoutMs,
      },
    },
  });
});

test("omits optional fields instead of emitting undefined and accepts supported thinking settings", () => {
  for (const thinking of ["enabled", "disabled"]) {
    for (const reasoningEffort of thinking === "enabled" ? [undefined, "off", "low", "high", "max"] : [undefined, "off"]) {
      const patch = createBridgePatch({ ...options, thinking, reasoningEffort, maxTokens: undefined });
      assert.deepEqual(JSON.parse(JSON.stringify(patch)), patch);
      const config = compose(patch).get("llm-deepseek").config;
      assert.equal(Object.hasOwn(config, "maxTokens"), false);
      assert.equal(Object.hasOwn(config, "reasoningEffort"), reasoningEffort !== undefined);
      assert.doesNotThrow(() => DeepSeek.resolveAdapterOptions(DeepSeek.Config(config)));
    }
  }
});

test("rejects unsupported or non-JSON-safe configuration before the worker starts", () => {
  for (const change of [
    { bridgePath: join("dist", "bridge", "index.js") },
    { baseUrl: "file:///models" },
    { baseUrl: "https://secret@api.deepseek.com" },
    { baseUrl: "https://api.deepseek.com?key=secret" },
    { baseUrl: "https://api.deepseek.com#fragment" },
    { thinking: "maybe" },
    { reasoningEffort: "medium" },
    { provider: "github-copilot", modelId: "" },
    { provider: "github-copilot", modelId: "bad/model" },
    { provider: "github-copilot", reasoningEfforts: {} },
    { provider: "github-copilot", reasoningEfforts: { medium: null } },
    { provider: "github-copilot", headers: { authorization: "Bearer secret" } },
    { provider: "other" },
    { thinking: "disabled", reasoningEffort: "high" },
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].flatMap((value) => [
      { contextWindow: value }, { maxTokens: value },
    ]),
    ...[0, -1, NaN, Infinity, 2_147_483_648].map((streamIdleTimeoutMs) => ({ streamIdleTimeoutMs })),
  ]) {
    assert.throws(() => createBridgePatch({ ...options, ...change }));
  }
});

test("returns fresh overlays without retaining callers' mutable objects", () => {
  const first = createBridgePatch(options);
  const expected = structuredClone(first);
  first.find((row) => row.id === "agent-spine").config.agents.push({ id: "unwanted" });
  first.find((row) => row.insert).insert[0].config.contextWindow = 1;
  assert.deepEqual(createBridgePatch(options), expected);
});

test("actual spine keeps the factory but exposes no native tools or autonomous producers", async () => {
  const ctx = new Context();
  try {
    const fiber = ctx.plugin(Spine, compose().get("agent-spine").config);
    await fiber.await();
    let fibers;
    do {
      fibers = [...ctx.registry.values()].flatMap((runtime) => [...runtime.fibers]);
      await Promise.all(fibers.map((child) => child.await()));
    } while (fibers.some((child) => child.inertia));
    assert.ok(ctx.get("agentLoop"), "the concrete DSH loop remains available");
    assert.ok(ctx.get("llm"));
    assert.ok(ctx.get("sessions"));
    assert.ok(ctx.get("systemPrompt"));
    assert.deepEqual(ctx.tools.schemas(), []);
    assert.deepEqual(ctx.agents.list(), []);
    for (const service of ["skills", "goals", "subagents", "workflow", "fs", "subprocess", "terminal"]) {
      assert.equal(ctx.get(service), undefined, service);
    }
  } finally {
    await ctx.fiber.dispose();
  }
});
