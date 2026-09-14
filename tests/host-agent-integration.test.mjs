import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createPatchedHostFixture, projectRoot } from "./fixtures/patched-host.mjs";
import { startResponsesServer } from "./fixtures/responses-server.mjs";

test("real patched host fixes runtime per Agent while inheriting models and refusing unsupported fallback", { timeout: 900000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dsh-agent-host-e2e-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ["systemroot", "windir", "comspec", "pathext", "path", "temp", "tmp", "tmpdir", "lang"].includes(key.toLowerCase())));
  const run = async (args, expected = 0) => {
    const child = spawn(process.execPath, args, { cwd: root, env: {
      ...env, OPENCLAW_HOME: join(root, "home"), OPENCLAW_STATE_DIR: join(root, "state"),
      OPENCLAW_CONFIG_PATH: join(root, "openclaw.json"), HOME: join(root, "home"), USERPROFILE: join(root, "home"),
      NODE_DISABLE_COMPILE_CACHE: "1", FORCE_COLOR: "0", OPENCLAW_LOG_LEVEL: "debug",
    }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 240000);
    try {
      const code = await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
      assert.equal(code, expected, output.slice(-18000));
      return output;
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  };
  let model;
  try {
    const { host, plugin } = await createPatchedHostFixture(root);
    await Promise.all(["home", "state", "workspace", "main-workspace", "agent"].map((dir) => mkdir(join(root, dir))));
    model = await startResponsesServer(async ({ body, text, finish, response }) => {
      if (body.model === "gpt-unavailable") {
        response.end('event: error\ndata: {"type":"error","code":"model_not_found","message":"Fixture missing model"}\n\n');
        return;
      }
      text(`MODEL:${body.model}`);
      finish();
    });
    const models = ["gpt-6-astra", "gpt-5.6-sol", "gpt-unavailable"].map((id) => ({
      id, name: id, api: "openai-responses", reasoning: false, input: ["text"],
      contextWindow: 1000000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));
    const config = {
      agents: {
        ownership: "explicit",
        defaults: { model: { primary: "github-copilot/gpt-6-astra" }, sandbox: { mode: "off" } },
        entries: {
          main: { workspace: join(root, "main-workspace") },
          "dsh-experiment": {
            workspace: join(root, "workspace"), agentDir: join(root, "agent"),
            runtime: { type: "embedded", harness: "dsh-native" },
          },
        },
      },
      models: { mode: "replace", providers: {
        "github-copilot": { api: "openai-responses", baseUrl: model.baseUrl, apiKey: "fixture-token", models },
        "microsoft-foundry": { api: "openai-responses", baseUrl: model.baseUrl, apiKey: "fixture-foundry-token", models },
      } },
      tools: { profile: "coding", exec: { host: "gateway" } },
      plugins: { allow: ["dsh-native"], slots: { memory: "none" }, load: { paths: [plugin] }, entries: {
        "github-copilot": { enabled: false }, "microsoft-foundry": { enabled: false },
        "dsh-native": { enabled: true, config: { stateDir: join(root, "dsh"), allowedCopilotBaseUrls: [model.baseUrl], startupTimeoutMs: 120000 } },
      } },
      logging: { level: "debug", consoleLevel: "debug", file: join(root, "host.log") },
      diagnostics: { enabled: false },
    };
    const save = () => writeFile(join(root, "openclaw.json"), JSON.stringify(config));
    await save();
    const cliPrefix = ["--import", pathToFileURL(join(projectRoot, "tests", "fixtures", "loopback-only.mjs")).href,
      join(host, "openclaw.mjs")];
    await t.test("real registry refuses runtime-owner conflicts and declared host fallback", async () => {
      const output = await run([join(projectRoot, "tests", "fixtures", "host-policy-probe.mjs"), host]);
      assert.match(output, /HOST_AGENT_PIN_POLICY_OK/);
    });
    const turn = (agent, suffix, expected = 0) => run([...cliPrefix, "agent", "--local", "--agent", agent,
      "--session-key", `agent:${agent}:pin-${suffix}`, "--thinking", "off", "--timeout", "90",
      "--message", "Reply with your selected model identifier. Do not use tools.", "--json"], expected);
    await t.test("Agent inherits the default model without any model-level runtime entry", async () => {
      const out = await turn("dsh-experiment", "one");
      assert.match(out, /MODEL:gpt-6-astra/);
      assert.match(out, /"agentHarnessId":\s*"dsh-native"/);
      assert.equal(config.agents.entries["dsh-experiment"].model, undefined);
      assert.equal(config.agents.entries["dsh-experiment"].models, undefined);
    });
    await t.test("changing the inherited default model retains the Agent harness", async () => {
      config.agents.defaults.model.primary = "github-copilot/gpt-5.6-sol";
      await save();
      const out = await turn("dsh-experiment", "two");
      assert.match(out, /MODEL:gpt-5.6-sol/);
      assert.match(out, /"agentHarnessId":\s*"dsh-native"/);
    });
    await t.test("an unpinned Agent remains on the built-in runtime", async () => {
      const out = await turn("main", "native");
      assert.match(out, /"agentHarnessId":\s*"openclaw"/);
    });
    await t.test("a stale model-specific runtime entry cannot override the Agent pin", async () => {
      config.agents.entries["dsh-experiment"].models = {
        "github-copilot/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
      };
      await save();
      const out = await turn("dsh-experiment", "model-pin-conflict");
      assert.match(out, /"agentHarnessId":\s*"dsh-native"/);
      delete config.agents.entries["dsh-experiment"].models;
    });
    await t.test("unsupported provider is refused without calling it or another harness", async () => {
      config.agents.defaults.model.primary = "microsoft-foundry/gpt-5.6-sol";
      config.agents.defaults.model.fallbacks = ["github-copilot/gpt-5.6-sol"];
      await save();
      const count = model.requests.length;
      const out = await turn("dsh-experiment", "unsupported", 1);
      assert.match(out, /Agent-pinned harness|cannot run/);
      assert.equal(model.requests.length, count);
    });
    await t.test("remove Agent pin to restore normal runtime selection", async () => {
      config.agents.defaults.model.primary = "github-copilot/gpt-5.6-sol";
      config.agents.defaults.model.fallbacks = [];
      config.agents.entries["dsh-experiment"].runtime = { type: "embedded" };
      await save();
      const out = await turn("dsh-experiment", "disabled");
      assert.match(out, /"agentHarnessId":\s*"openclaw"/);
    });
  } finally {
    await model?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});
