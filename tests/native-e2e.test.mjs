import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { startModelServer } from "./fixtures/model-server.mjs";
import { startResponsesServer } from "./fixtures/responses-server.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginRoot = process.env.DSH_NATIVE_PACKAGED_ROOT ?? packageRoot;
const useCopilot = process.env.DSH_NATIVE_E2E_PROVIDER === "github-copilot";
const provider = useCopilot ? "github-copilot" : "deepseek";
const modelId = useCopilot ? "gpt-6-astra" : "deepseek-v4-pro";
const modelRef = `${provider}/${modelId}`;
const restrictedPolicy = process.env.DSH_NATIVE_E2E_RESTRICTED_POLICY === "1";
const sessionDenies = ["sessions_list", "sessions_history", "sessions_send", "session_status"];

test("actual OpenClaw selects native DSH, reads a file, resumes and disables independently", { timeout: 600000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-dsh-e2e-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const state = join(root, "state");
  const agentDir = join(root, "agent");
  await Promise.all([workspace, home, state, agentDir].map((path) => mkdir(path)));
  await writeFile(join(workspace, "fixture.txt"), "NATIVE-HOST-READ\n");
  const model = useCopilot ? await startResponsesServer(async ({ body, reasoning, tool, text, finish }) => {
    if (body.input.some((item) => item.type === "function_call_output")) text("DSH-NATIVE-E2E-OK");
    else { reasoning(); tool("read", { path: "fixture.txt" }, "e2e_read"); }
    finish();
  }) : await startModelServer(async ({ body, send, finish }) => {
    if (body.messages.some((message) => message.role === "tool")) {
      send({ role: "assistant", content: "DSH-NATIVE-E2E-OK" });
      finish();
    } else {
      send({ role: "assistant", tool_calls: [{
        index: 0, id: "e2e_read", type: "function",
        function: { name: "read", arguments: JSON.stringify({ path: "fixture.txt" }) },
      }] });
      finish("tool_calls");
    }
  });
  const configPath = join(root, "openclaw.json");
  await writeFile(configPath, JSON.stringify({
    agents: {
      defaults: {
        model: { primary: modelRef },
        sandbox: { mode: "off" },
      },
      entries: {
        experiment: {
          workspace, agentDir,
          models: { [modelRef]: { agentRuntime: { id: "dsh-native" } } },
          ...(restrictedPolicy ? { tools: { deny: sessionDenies, alsoAllow: ["workboard"] } } : {}),
        },
      },
    },
    models: {
      mode: "replace",
      providers: {
        [provider]: {
          baseUrl: model.baseUrl, api: useCopilot ? "openai-responses" : "openai-completions", apiKey: "e2e-not-a-real-key",
          ...(useCopilot ? { headers: { "Copilot-Integration-Id": "copilot-developer-cli" } } : {}),
          models: [{
            id: modelId, name: "Local DSH fixture", reasoning: useCopilot, input: ["text"],
            contextWindow: 1000000, maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            ...(useCopilot ? { compat: {
              supportsReasoningEffort: true,
              supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
            } } : {}),
          }],
        },
      },
    },
    tools: { profile: "coding", fs: { workspaceOnly: true }, exec: { host: "gateway" } },
    plugins: {
      slots: { memory: "none" },
      enabled: true, allow: ["dsh-native"], load: { paths: [pluginRoot] },
      entries: {
        ...(useCopilot ? { "github-copilot": { enabled: false } } : {}),
        "dsh-native": {
          enabled: true,
          config: { stateDir: join(root, "dsh-state"),
            startupTimeoutMs: 120000,
            ...(useCopilot ? { allowedCopilotBaseUrls: [model.baseUrl] } : { allowedBaseUrls: [model.baseUrl] }) },
        },
      },
    },
    logging: { level: "debug", consoleLevel: "debug", file: join(root, "openclaw.log") },
    diagnostics: { enabled: false },
  }));
  const cli = async (args) => {
    const child = spawn(process.execPath, [
      "--import", pathToFileURL(join(packageRoot, "tests", "fixtures", "loopback-only.mjs")).href,
      join(packageRoot, "node_modules", "openclaw", "openclaw.mjs"), ...args,
    ], { cwd: root, env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        ["systemroot", "windir", "comspec", "pathext", "path", "temp", "tmp", "tmpdir", "lang"].includes(key.toLowerCase()))),
      OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_LOG_LEVEL: "debug",
      HOME: home, USERPROFILE: home, DO_NOT_TRACK: "1", FORCE_COLOR: "0",
      NODE_DISABLE_COMPILE_CACHE: "1",
    }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 240000);
    try {
      const status = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      const log = await readFile(join(root, "openclaw.log"), "utf8").catch((error) => {
        if (error.code === "ENOENT") return "(no OpenClaw log)";
        throw error;
      });
      assert.equal(status, 0, `${stdout}\n${stderr}\n${log.slice(-12000)}`);
      return stdout;
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  };
  const turn = (message) => cli([
    "agent", "--local", "--agent", "experiment", "--session-key", "agent:experiment:native-e2e",
    "--model", modelRef, "--thinking", useCopilot ? "xhigh" : "off", "--timeout", "60",
    "--message", message, "--json",
  ]);
  try {
    const first = await turn("Read fixture.txt using the read tool, then reply DSH-NATIVE-E2E-OK.");
    assert.ok(first.includes("DSH-NATIVE-E2E-OK"), first);
    assert.ok(model.requests.length >= 2);
    const last = model.requests.at(-1).body;
    assert.ok(useCopilot
      ? last.input.some((item) => item.type === "function_call_output" && JSON.stringify(item.output).includes("NATIVE-HOST-READ"))
      : last.messages.some((message) => message.role === "tool" && String(message.content).includes("NATIVE-HOST-READ")));
    const names = last.tools.map((tool) => useCopilot ? tool.name : tool.function.name);
    assert.ok(names.includes("read"));
    assert.ok(names.every((name) => ["read", "write", "edit", "apply_patch", "exec", "process",
      "grep", "glob", "find", "ls"].includes(name)));
    const requestsBeforeResume = model.requests.length;
    const second = await turn("Continue the same conversation and remember the file you just read.");
    assert.ok(second.includes("DSH-NATIVE-E2E-OK"), second);
    assert.equal(model.requests.length, requestsBeforeResume + 1);
    const continued = model.requests.at(-1).body;
    assert.ok(useCopilot
      ? continued.input.some((item) => item.type === "function_call_output" && JSON.stringify(item.output).includes("NATIVE-HOST-READ"))
      : continued.messages.some((message) => message.role === "tool" && String(message.content).includes("NATIVE-HOST-READ")));
    if (useCopilot) {
      assert.equal(continued.model, "gpt-6-astra");
      assert.equal(continued.reasoning.effort, "xhigh");
      assert.equal(JSON.stringify(continued.input).includes("encrypted_sensitive"), false);
      assert.equal(model.requests[0].headers["copilot-integration-id"], "copilot-developer-cli");
    }
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.agents.defaults.models?.[modelRef]?.agentRuntime, undefined);
    saved.agents.entries.experiment.models[modelRef].agentRuntime.id = "openclaw";
    await writeFile(configPath, JSON.stringify(saved));
    await cli(["plugins", "disable", "dsh-native"]);
    const disabled = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(disabled.plugins.entries["dsh-native"].enabled, false);
    assert.ok(disabled.models.providers[provider]);
    assert.equal(await readFile(join(workspace, "fixture.txt"), "utf8"), "NATIVE-HOST-READ\n");
  } finally {
    await model.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
