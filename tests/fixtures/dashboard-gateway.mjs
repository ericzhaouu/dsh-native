import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { t as GatewayClient } from "../../node_modules/openclaw/dist/client-I-RoP1Al.js";
import { s as resolveRuntimeServiceBuildId, t as OPENCLAW_VERSION } from "../../node_modules/openclaw/dist/version-v1kuAkGj.js";
import { startResponsesServer } from "./responses-server.mjs";
import { createPatchedHostFixture } from "./patched-host.mjs";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const pluginRoot = process.env.DSH_NATIVE_PACKAGED_ROOT ?? packageRoot;
const TOKEN = "dashboard-gateway-fixture-token";
const MODEL_ID = "gpt-6-astra";
const MODEL_REF = `github-copilot/${MODEL_ID}`;
const CORE_TOOLS = ["read", "write", "edit", "apply_patch", "exec", "process", "grep", "glob", "find", "ls"];

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForPort(port, timeoutMs = 180000) {
  await waitFor(() => new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  }), timeoutMs, 250);
}

function envSubset() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ["systemroot", "windir", "comspec", "pathext", "path", "temp", "tmp", "tmpdir", "lang"].includes(key.toLowerCase())));
}

async function waitFor(predicate, timeoutMs, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitForAssistantText(client, events, sessionKey, matcher, timeoutMs = 120000) {
  return waitFor(async () => {
    const failed = events.find((frame) => frame.event === "chat" &&
      frame.payload?.sessionKey === sessionKey && ["error", "aborted"].includes(frame.payload.state));
    if (failed) throw new Error(`Dashboard turn failed: ${JSON.stringify(failed.payload)}`);
    const history = await client.request("chat.history", { sessionKey, limit: 20 });
    const messages = Array.isArray(history?.messages) ? history.messages : [];
    const assistant = messages.findLast?.((message) =>
      message?.role === "assistant" && matcher.test(JSON.stringify(message.content ?? message.text ?? message))) ??
      [...messages].reverse().find((message) =>
        message?.role === "assistant" && matcher.test(JSON.stringify(message.content ?? message.text ?? message)));
    return assistant || false;
  }, timeoutMs);
}

export async function startDashboardGateway(responder, { agentPinned = false } = {}) {
  const root = join(packageRoot, "artifacts", `dashboard-gateway-${randomUUID()}`);
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const state = join(root, "state");
  const agentDir = join(root, "agent");
  const dshState = join(root, "dsh-state");
  let responses;
  let child;
  let chat;
  let stdout = "";
  let stderr = "";
  const events = [];
  let closed = Promise.resolve();
  const stopPartial = async () => {
    const results = await Promise.allSettled([chat?.stopAndWait?.({ timeoutMs: 5000 })]);
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    try { await withTimeout(closed, 15000, "Gateway shutdown timeout"); }
    catch (error) {
      if (!child || child.exitCode !== null || child.signalCode !== null) throw error;
      child.kill("SIGKILL");
      await withTimeout(closed, 5000, "Gateway termination was not confirmed");
    }
    if (responses) await responses.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, "Dashboard client cleanup failed");
  };
  try {
    await Promise.all([root, workspace, home, state, agentDir, dshState].map((path) => mkdir(path, { recursive: true })));
    const fixture = agentPinned ? await createPatchedHostFixture(root) : undefined;
    await writeFile(join(workspace, "fixture.txt"), "DASHBOARD-HOST-READ\n");
    responses = await startResponsesServer(responder);
    const port = await reserveLoopbackPort();
    const configPath = join(root, "openclaw.json");
    const logPath = join(root, "openclaw.log");
    await writeFile(configPath, JSON.stringify({
      gateway: { mode: "local", bind: "loopback", auth: { mode: "token" } },
      agents: {
        defaults: {
          model: { primary: MODEL_REF },
          sandbox: { mode: "off" },
        },
        entries: {
          experiment: {
            workspace, agentDir,
            ...(agentPinned ? { runtime: { type: "embedded", harness: "dsh-native" } }
              : { models: { [MODEL_REF]: { agentRuntime: { id: "dsh-native" } } } }),
          },
        },
      },
      models: {
        mode: "replace",
        providers: {
          "github-copilot": {
            baseUrl: responses.baseUrl,
            api: "openai-responses",
            apiKey: "dashboard-not-a-real-key",
            headers: { "Copilot-Integration-Id": "copilot-developer-cli" },
            models: [{
              id: MODEL_ID,
              name: "Dashboard Local Copilot",
              reasoning: true,
              input: ["text"],
              contextWindow: 1_000_000,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              compat: {
                supportsReasoningEffort: true,
                supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
              },
            }],
          },
        },
      },
      tools: { profile: "coding", fs: { workspaceOnly: true }, exec: { host: "gateway" } },
      plugins: {
        slots: { memory: "none" },
        enabled: true,
        allow: ["dsh-native"],
        load: { paths: [fixture?.plugin ?? pluginRoot] },
        entries: {
          "github-copilot": { enabled: false },
          "dsh-native": {
            enabled: true,
            config: {
              stateDir: dshState,
              startupTimeoutMs: 120000,
              allowedCopilotBaseUrls: [responses.baseUrl],
            },
          },
        },
      },
      logging: { level: "debug", consoleLevel: "debug", file: logPath },
      diagnostics: { enabled: false },
    }));
    child = spawn(process.execPath, [
      "--import", pathToFileURL(join(packageRoot, "tests", "fixtures", "loopback-only.mjs")).href,
      join(fixture?.host ?? join(packageRoot, "node_modules", "openclaw"), "openclaw.mjs"),
      "gateway", "run", "--allow-unconfigured",
      "--bind", "loopback", "--port", String(port), "--auth", "token", "--token", TOKEN,
    ], {
      cwd: root,
      env: {
        ...envSubset(),
        OPENCLAW_HOME: home,
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_LOG_LEVEL: "debug",
        HOME: home,
        USERPROFILE: home,
        DO_NOT_TRACK: "1",
        FORCE_COLOR: "0",
        NODE_DISABLE_COMPILE_CACHE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    try {
      await waitForPort(port);
    } catch (error) {
      const log = await readFile(logPath, "utf8").catch(() => "(no OpenClaw log)");
      throw new Error(`Gateway failed to open its port.\n${stdout}\n${stderr}\n${log.slice(-12000)}`, { cause: error });
    }
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyRaw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
    let readyResolve;
    const ready = new Promise((resolve) => { readyResolve = resolve; });
    chat = new GatewayClient({
    deviceIdentity: {
      deviceId: createHash("sha256").update(publicKeyRaw).digest("hex"),
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    },
    deviceAuthScope: `ws://127.0.0.1:${port}`,
    sharedStateMode: "read-only",
    env: { ...envSubset(), OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: join(root, "client-state"),
      HOME: home, USERPROFILE: home },
    url: `ws://127.0.0.1:${port}`,
    token: TOKEN,
    origin: `http://127.0.0.1:${port}`,
    clientName: "openclaw-control-ui",
    clientDisplayName: "dashboard-fixture",
    clientVersion: OPENCLAW_VERSION,
    clientBuildId: resolveRuntimeServiceBuildId(),
    mode: "ui",
    scopes: ["operator.admin"],
    caps: ["task-suggestions"],
    instanceId: randomUUID(),
    minProtocol: 4,
    maxProtocol: 4,
    onHelloOk() { readyResolve(); },
    onEvent(frame) { events.push(frame); },
    });
    try {
      chat.start();
      await withTimeout(ready, 180000, "Gateway ready timeout");
    } catch (error) {
      const log = await readFile(logPath, "utf8").catch(() => "(no OpenClaw log)");
      throw new Error(`Gateway did not become ready.\n${stdout}\n${stderr}\n${log.slice(-12000)}`, { cause: error });
    }
    return {
      root,
      workspace,
      configPath,
      logPath,
      dshState,
      port,
      token: TOKEN,
      modelRef: MODEL_REF,
      responses,
      chat,
      stdout: () => stdout,
      stderr: () => stderr,
      async waitForAssistant(sessionKey, text) {
        try { return await waitForAssistantText(chat, events, sessionKey, new RegExp(text)); }
        catch (error) {
          const log = await readFile(logPath, "utf8");
          throw new Error(`${error.message}\n${stdout.slice(-12000)}\n${stderr.slice(-12000)}\n${log.slice(-18000)}`, { cause: error });
        }
      },
      async readDshBindings() {
        const bindings = [];
        for (const directory of await readdir(dshState, { withFileTypes: true })) {
          if (!directory.isDirectory()) continue;
          const path = join(dshState, directory.name, "binding.json");
          try { bindings.push({ path, value: JSON.parse(await readFile(path, "utf8")) }); }
          catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        return bindings;
      },
      close: stopPartial,
      async assertHealthyLogs() {
        const log = await readFile(logPath, "utf8");
        assert.match(log, /dsh-native/i);
        return log;
      },
      coreTools: CORE_TOOLS,
      agentPinned,
    };
  } catch (error) {
    await stopPartial();
    throw error;
  }
}
