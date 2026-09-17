import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { get } from "node:http";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { t as GatewayClient } from "../../node_modules/openclaw/dist/client-I-RoP1Al.js";
import { s as resolveRuntimeServiceBuildId, t as OPENCLAW_VERSION } from "../../node_modules/openclaw/dist/version-v1kuAkGj.js";
import { startResponsesServer } from "./responses-server.mjs";
import { createPatchedHostFixture, createPluginFixture } from "./patched-host.mjs";
import { createHostSearchFixture, HOST_SEARCH_PLUGIN_ID, HOST_SEARCH_PROVIDER_ID } from "./host-search-plugin.mjs";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const TOKEN = "dashboard-gateway-fixture-token";
const AGENT_ID = "dashboard-fixture";
const MODEL_ID = "gpt-6-astra";
const MODEL_REF = `github-copilot/${MODEL_ID}`;
const CORE_TOOLS = ["read", "write", "edit", "apply_patch", "exec", "process", "grep", "glob", "find", "ls"];

export function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join("");
  return typeof message?.text === "string" ? message.text : "";
}

async function createNetworkGuard(root) {
  const path = join(root, "dashboard-loopback-only.mjs");
  // Cover sockets as well as fetch, including the native Node child whose env drops NODE_OPTIONS.
  await writeFile(path, `
import net from "node:net";
import dgram from "node:dgram";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const options = typeof values[0] === "object" ? { ...values[0] }
    : { port: values[0], host: typeof values[1] === "string" ? values[1] : "127.0.0.1" };
  if (typeof values[0] === "string" && !Number.isFinite(Number(values[0]))) return connect.apply(this, args);
  if (!options.path) {
    const host = options.host ?? "127.0.0.1";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"].includes(host)) {
      throw new Error("Offline integration forbids external socket: " + host);
    }
    if (host === "localhost") options.host = "127.0.0.1";
  }
  return connect.call(this, options, values.find((value) => typeof value === "function"));
};
for (const method of ["connect", "send"]) dgram.Socket.prototype[method] = function () {
  throw new Error("Offline integration forbids datagram traffic");
};
const spawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  if (command === process.execPath && Array.isArray(args)) {
    return spawn.call(this, command, ["--import", import.meta.url, ...args], options);
  }
  return spawn.apply(this, arguments);
};
syncBuiltinESMExports();
`);
  return path;
}

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

async function waitForPort(port, assertHealthy, timeoutMs = 180000) {
  await waitFor(() => {
    assertHealthy();
    return new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      const finish = (value) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(1000, () => finish(false));
    });
  }, timeoutMs, 250);
}

async function waitForReadiness(port, assertHealthy) {
  await waitFor(() => {
    assertHealthy();
    return new Promise((resolve, reject) => {
      const request = get(`http://127.0.0.1:${port}/readyz`, { timeout: 1500 }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          resolve(false);
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 8192) request.destroy(new Error("Oversized Gateway readiness response"));
        });
        response.once("error", reject);
        response.once("end", () => {
          try { resolve(JSON.parse(body).ready === true); }
          catch (error) { reject(error); }
        });
      });
      request.once("timeout", () => { resolve(false); request.destroy(); });
      request.once("error", (error) => {
        if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(error.code)) resolve(false);
        else reject(error);
      });
    });
  }, 180000, 250);
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

export async function startDashboardGateway(responder, {
  agentPinned = true, redactTranscriptIdentity = false, taskPreparation,
  hostTools, searchFixture = false, agentToolPolicy, agentId = AGENT_ID,
} = {}) {
  assert.equal(OPENCLAW_VERSION, "2026.9.2", "Dashboard fixture must use the inspected genuine SDK");
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
  let fixtureFailure;
  let stopping = false;
  let readyReject;
  let closed = Promise.resolve();
  const failFixture = (error) => {
    if (stopping) return;
    fixtureFailure ??= error;
    readyReject?.(fixtureFailure);
  };
  const eventsForRun = (sessionKey, runId) => events.filter((frame) =>
    frame.payload?.sessionKey === sessionKey && frame.payload?.runId === runId);
  const assertHealthy = () => {
    if (fixtureFailure) throw fixtureFailure;
  };
  const assertTurnHealthy = (sessionKey, runId) => {
    assertHealthy();
    const failed = eventsForRun(sessionKey, runId).find((frame) =>
      (frame.event === "chat" && ["error", "aborted"].includes(frame.payload.state)) ||
      (frame.event === "agent" && frame.payload.stream === "lifecycle" &&
        (["error", "aborted"].includes(frame.payload.data?.phase) || frame.payload.data?.aborted === true)));
    if (failed) throw new Error(`Dashboard turn failed: ${JSON.stringify(failed.payload)}`);
  };
  const readDshBindings = async () => {
    const bindings = [];
    for (const directory of await readdir(dshState, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      const path = join(dshState, directory.name, "binding.json");
      try { bindings.push({ path, value: JSON.parse(await readFile(path, "utf8")) }); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return bindings;
  };
  const stopPartial = async () => {
    stopping = true;
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
    const originalHost = join(packageRoot, "node_modules", "openclaw");
    const fixture = agentPinned ? await createPatchedHostFixture(root)
      : { host: originalHost, plugin: await createPluginFixture(root, originalHost) };
    const search = searchFixture ? await createHostSearchFixture(root, fixture.host) : undefined;
    const networkGuard = await createNetworkGuard(root);
    await writeFile(join(workspace, "fixture.txt"), "DASHBOARD-HOST-READ\n");
    responses = await startResponsesServer(async (request) => {
      try { await responder(request); }
      catch (error) { failFixture(error); throw error; }
    });
    const port = await reserveLoopbackPort();
    const configPath = join(root, "openclaw.json");
    const logPath = join(root, "openclaw.log");
    await writeFile(configPath, JSON.stringify({
      gateway: { mode: "local", bind: "loopback", auth: { mode: "token" } },
      discovery: { mdns: { mode: "off" } },
      update: { checkOnStart: false, auto: { enabled: false } },
      browser: { enabled: false },
      agents: {
        defaults: {
          model: { primary: MODEL_REF },
          sandbox: { mode: "off" },
        },
        entries: {
          [agentId]: {
            workspace, agentDir,
            ...(agentToolPolicy === undefined ? {} : { tools: agentToolPolicy }),
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
      tools: { profile: "coding", fs: { workspaceOnly: true }, exec: { host: "gateway" },
        ...(search ? { web: { search: { enabled: true, provider: HOST_SEARCH_PROVIDER_ID } } } : {}),
      },
      plugins: {
        slots: { memory: "none" },
        enabled: true,
        allow: ["dsh-native", ...(search ? [HOST_SEARCH_PLUGIN_ID] : [])],
        load: { paths: [fixture.plugin, ...(search ? [search.plugin] : [])] },
        entries: {
          "github-copilot": { enabled: false },
          ...(search ? { [HOST_SEARCH_PLUGIN_ID]: { enabled: true, config: search.config } } : {}),
          "dsh-native": {
            enabled: true,
            config: {
              stateDir: dshState,
              startupTimeoutMs: 120000,
              allowedCopilotBaseUrls: [responses.baseUrl],
              ...(hostTools === undefined ? {} : { toolAllowlist: hostTools }),
              ...(taskPreparation === undefined ? {} : { taskPreparation }),
            },
          },
        },
      },
      logging: { level: "debug", consoleLevel: "debug", file: logPath,
        ...(redactTranscriptIdentity ? { redactPatterns: ["^github-copilot$", "^gpt-6-astra$"] } : {}) },
      diagnostics: { enabled: false },
    }));
    child = spawn(process.execPath, [
      "--import", pathToFileURL(join(packageRoot, "tests", "fixtures", "loopback-only.mjs")).href,
      "--import", pathToFileURL(networkGuard).href,
      join(fixture.host, "openclaw.mjs"),
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
        APPDATA: join(home, "AppData", "Roaming"),
        LOCALAPPDATA: join(home, "AppData", "Local"),
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        TEMP: root,
        TMP: root,
        TMPDIR: root,
        DO_NOT_TRACK: "1",
        FORCE_COLOR: "0",
        NODE_DISABLE_COMPILE_CACHE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    closed = new Promise((resolve) => {
      child.once("error", (error) => { failFixture(error); resolve(); });
      child.once("close", (code, signal) => {
        failFixture(new Error(`Dashboard gateway exited: code=${code}, signal=${signal}`));
        resolve();
      });
    });
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    try {
      await waitForPort(port, assertHealthy);
      await waitForReadiness(port, assertHealthy);
    } catch (error) {
      const log = await readFile(logPath, "utf8").catch(() => "(no OpenClaw log)");
      throw new Error(`Gateway failed to open its port.\n${stdout}\n${stderr}\n${log.slice(-12000)}`, { cause: error });
    }
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyRaw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
    let readyResolve;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
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
    onConnectError(error) { failFixture(error); },
    onClose(code, reason) { failFixture(new Error(`Dashboard client closed: ${code} ${reason}`)); },
    onGap(info) { failFixture(new Error(`Dashboard client lost event frames: ${JSON.stringify(info)}`)); },
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
      agentDir,
      configPath,
      logPath,
      dshState,
      port,
      token: TOKEN,
      modelRef: MODEL_REF,
      agentId,
      searchFixture: search,
      responses,
      chat,
      events,
      eventsForRun,
      assertTurnHealthy,
      stdout: () => stdout,
      stderr: () => stderr,
      async waitForFinal(sessionKey, runId, timeoutMs = 120000) {
        assert.ok(sessionKey && runId, "waitForFinal requires an exact sessionKey and runId");
        try {
          return await waitFor(() => {
            assertTurnHealthy(sessionKey, runId);
            return eventsForRun(sessionKey, runId).find((frame) =>
              frame.event === "chat" && frame.payload.state === "final");
          }, timeoutMs);
        }
        catch (error) {
          const log = await readFile(logPath, "utf8").catch(() => "(no OpenClaw log)");
          throw new Error(`Waiting for Dashboard final ${sessionKey}/${runId}: ${error.message}\n` +
            `${JSON.stringify(eventsForRun(sessionKey, runId))}\n${stdout.slice(-6000)}\n${stderr.slice(-6000)}\n${log.slice(-12000)}`,
          { cause: error });
        }
      },
      async waitForDurableSettle(sessionKey, runId, timeoutMs = 120000) {
        assert.ok(sessionKey && runId, "waitForDurableSettle requires an exact sessionKey and runId");
        let stableSince;
        let previousSnapshot;
        return waitFor(async () => {
          assertTurnHealthy(sessionKey, runId);
          const bindings = await readDshBindings();
          const binding = bindings.find((entry) => entry.value.lastRunId === runId);
          if (binding?.value.status === "blocked") throw new Error(`Native binding blocked for ${runId}`);
          const history = await chat.request("chat.history",
            { sessionKey, agentId, limit: 20 }, { timeoutMs: 15000 });
          assertTurnHealthy(sessionKey, runId);
          const assistant = history.messages?.find((message) => message.role === "assistant" &&
            (message.idempotencyKey ?? message.__openclaw?.idempotencyKey) === `dsh-native:${runId}:assistant`);
          if (binding?.value.status !== "ready" || !assistant || history.inFlightRun) {
            stableSince = undefined;
            return false;
          }
          // Streaming/final can precede both the native commit and host reply-dispatch cleanup.
          const snapshot = JSON.stringify([
            binding.value, history.messages, history.sessionInfo?.modelProvider, history.sessionInfo?.model,
            history.sessionInfo?.activeModelProvider, history.sessionInfo?.activeModel,
            eventsForRun(sessionKey, runId).length,
          ]);
          if (snapshot !== previousSnapshot || stableSince === undefined) {
            previousSnapshot = snapshot;
            stableSince = Date.now();
          }
          return Date.now() - stableSince >= 500 ? { binding, bindings, history, assistant } : false;
        }, timeoutMs);
      },
      readDshBindings,
      close: stopPartial,
      async assertHealthyLogs() {
        const log = await readFile(logPath, "utf8");
        assert.match(log, /dsh-native/i);
        assert.doesNotMatch(`${stdout}\n${stderr}\n${log}`, /Offline integration forbids/);
        return log;
      },
      coreTools: CORE_TOOLS,
      agentPinned,
      redactTranscriptIdentity,
    };
  } catch (error) {
    await stopPartial();
    throw error;
  }
}
