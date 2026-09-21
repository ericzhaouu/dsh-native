import assert from "node:assert/strict";
import { spawnSync, execSync } from "node:child_process";
import { lookup } from "node:dns";
import { lstatSync } from "node:fs";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPatchedHostFixture } from "./patched-host.mjs";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const bridgeKey = Symbol.for("dsh.feishu.isolated.sdk");
const channelPluginId = "dsh-feishu-isolated-sdk";

export async function prepareIsolatedHost(root, { scope, providerId, transportPort, modelBaseUrl, taskPreparation = false }) {
  assert.equal(typeof taskPreparation, "boolean");
  const fixture = await createPatchedHostFixture(root);
  const channelPlugin = join(root, "transport-channel");
  await mkdir(join(channelPlugin, "node_modules"), { recursive: true });
  await symlink(fixture.host, join(channelPlugin, "node_modules", "openclaw"), "junction");
  await cp(join(fixtureDir, "feishu-isolated-sdk-channel.mjs"), join(channelPlugin, "channel.mjs"));
  await writeFile(join(channelPlugin, "package.json"), JSON.stringify({
    name: channelPluginId, version: "0.0.0", type: "module", openclaw: { extensions: ["./index.mjs"] },
  }));
  const channelSchema = { type: "object", additionalProperties: false, properties: { enabled: { type: "boolean" } } };
  const schema = { type: "object", additionalProperties: false,
    required: ["scope", "port"], properties: { scope: { type: "object" }, port: { type: "integer" } } };
  await writeFile(join(channelPlugin, "openclaw.plugin.json"), JSON.stringify({
    id: channelPluginId, activation: { onStartup: true }, channels: [scope.channel],
    channelConfigs: { [scope.channel]: { schema: channelSchema } }, configSchema: schema,
  }));
  await writeFile(join(channelPlugin, "index.mjs"), `
import { definePluginEntry, buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { register } from "./channel.mjs";
export default definePluginEntry({
  id: ${JSON.stringify(channelPluginId)}, name: "Isolated SDK transport",
  configSchema: buildJsonPluginConfigSchema(${JSON.stringify(schema)}), register,
});
`);
  // Decorate the copied native plugin, never its installed source or the SDK dispatcher.
  await writeFile(join(fixture.plugin, "observed-entry.mjs"), `
import original from "./dist/index.js";
const errorDetails = (error) => error && ({ ...error, message: error.message, stack: error.stack,
  originalError: error.originalError && { message: error.originalError.message, stack: error.originalError.stack } });
export default { ...original, register(api) {
  return original.register({ ...api, registerAgentHarness(harness) {
    const bridge = globalThis[Symbol.for("dsh.feishu.isolated.sdk")];
    const runAttempt = harness.runAttempt.bind(harness);
    harness.runAttempt = async params => {
      bridge.activeNative++;
      await bridge.checkpoint({ kind: "native-start", nativeRunId: params.runId });
      try {
        const result = await runAttempt(params);
        bridge.record({ kind: "native-end", nativeRunId: params.runId, terminal: result.terminal.kind,
          error: errorDetails(result.terminal.error), receiptState: result.terminal.error?.receiptState,
          outputDelivered: result.sourceReplyDelivered === true });
        return result;
      } catch (error) {
        bridge.record({ kind: "native-error", nativeRunId: params.runId, error: error.message });
        throw error;
      } finally { bridge.activeNative--; }
    };
    return api.registerAgentHarness(harness);
  } });
} };
`);
  const nativePackagePath = join(fixture.plugin, "package.json");
  const nativePackage = JSON.parse(await readFile(nativePackagePath, "utf8"));
  nativePackage.openclaw.extensions = ["./observed-entry.mjs"];
  await writeFile(nativePackagePath, JSON.stringify(nativePackage));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all(["workspace", "agent", "home", "state", "native-state"].map(
    (name) => mkdir(join(root, name), { recursive: true }),
  ));
  const model = "gpt-6-astra";
  const config = {
    discovery: { mdns: { mode: "off" } },
    update: { checkOnStart: false, auto: { enabled: false } },
    browser: { enabled: false },
    diagnostics: { enabled: false },
    messages: { groupChat: { visibleReplies: "message_tool" } },
    channels: { [scope.channel]: { enabled: true } },
    agents: { defaults: { model: { primary: `github-copilot/${model}` }, sandbox: { mode: "off" } },
      entries: { [scope.agentId]: { workspace, agentDir, runtime: { type: "embedded", harness: "dsh-native" } } } },
    models: { mode: "replace", providers: { "github-copilot": {
      baseUrl: modelBaseUrl, api: "openai-responses", apiKey: "isolated-not-a-real-key",
      headers: { "Copilot-Integration-Id": "copilot-developer-cli" },
      models: [{ id: model, name: "Isolated loopback responder", reasoning: true, input: ["text"],
        contextWindow: 1_000_000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsReasoningEffort: true, supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] } }],
    } } },
    tools: { profile: "coding", fs: { workspaceOnly: true }, exec: { host: "gateway" } },
    plugins: {
      enabled: true, allow: ["dsh-native", channelPluginId], slots: { memory: "none" },
      load: { paths: [fixture.plugin, channelPlugin] },
      entries: {
        "github-copilot": { enabled: false },
        [channelPluginId]: { enabled: true, config: { scope, port: transportPort } },
        "dsh-native": { enabled: true, config: {
          stateDir: join(root, "native-state"), startupTimeoutMs: 120000, shutdownTimeoutMs: 5000,
          allowedCopilotBaseUrls: [modelBaseUrl], toolAllowlist: [], maxConcurrentRuns: 1,
          ...(taskPreparation ? { taskPreparation: {
            agentIds: [scope.agentId], executionTools: [], skillAllowlist: [],
            maxClarificationTurns: 1, maxToolCalls: 1,
          } } : {}),
        } },
      },
    },
    logging: { level: "debug", consoleLevel: "error", file: join(root, "sdk.log") },
  };
  await writeFile(join(root, "openclaw.json"), JSON.stringify(config));
  await writeFile(join(root, "boot.json"), JSON.stringify({ host: fixture.host, workspace, providerId }));
}

async function runWorker(root) {
  assert.ok(process.send, "Direct SDK host requires a private IPC parent");
  const boot = JSON.parse(await readFile(join(root, "boot.json"), "utf8"));
  const config = JSON.parse(await readFile(join(root, "openclaw.json"), "utf8"));
  const checkpoints = new Map();
  let checkpointSequence = 0;
  const bridge = {
    providerId: boot.providerId, activeNative: 0, current: undefined,
    record(event) {
      process.send({ kind: "journal", event: {
        callbackId: bridge.current?.callbackId, ingressId: bridge.ingressId, ...event,
      } });
    },
    checkpoint(event) {
      const journalId = ++checkpointSequence;
      return new Promise((resolve, reject) => {
        checkpoints.set(journalId, { resolve, reject });
        process.send({ kind: "journal", journalId, event: {
          callbackId: bridge.current?.callbackId, ingressId: bridge.ingressId, ...event,
        } }, (error) => {
          if (error) { checkpoints.delete(journalId); reject(error); }
        });
      });
    },
  };
  globalThis[bridgeKey] = bridge;
  const fromHost = (name) => import(pathToFileURL(join(boot.host, "dist", name)).href);
  assert.throws(() => spawnSync("must-not-execute"), /forbids child_process.spawnSync/u);
  assert.throws(() => execSync("must-not-execute"), /forbids child_process.execSync/u);
  assert.throws(() => createConnection({ host: "192.0.2.1", port: 80 }), /forbids socket/u);
  assert.throws(() => createConnection({ host: "localhost", port: 80 }), /forbids socket/u);
  assert.throws(() => lookup("must-not-resolve.invalid", () => {}), /numeric loopback/u);
  assert.throws(() => lstatSync("/tmp/openclaw"), /shared temporary paths/u);
  const { n: resolveSdkTemp } = await fromHost("tmp-openclaw-dir-DnyL0lW9.js");
  const sdkTemp = resolveSdkTemp();
  const { i: resolveCoordinator } = await fromHost("state-database-coordinator-opgcBiXJ.js");
  const sqliteCoordinator = resolveCoordinator({ databasePath: join(root, "state", "openclaw.sqlite"),
    runtimeDirectory: "/tmp", uid: process.getuid() });
  const environment = Object.fromEntries(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH", "DSH_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
    "TEMP", "TMP", "TMPDIR", "APPDATA", "LOCALAPPDATA"].map((key) => [key, process.env[key]]));
  for (const path of [sdkTemp, sqliteCoordinator, ...Object.values(environment)]) {
    assert.ok(path && resolve(path).startsWith(`${resolve(root)}${sep}`), "SDK paths must remain private");
  }
  bridge.record({ kind: "isolation-verified", node: process.version, platform: process.platform, sdkTemp, sqliteCoordinator, environment,
    execDenied: true, dnsDenied: true, nonnumericDenied: true, externalSocketsDenied: true, sharedTempDenied: true });
  const { t: version } = await fromHost("version-v1kuAkGj.js");
  assert.equal(version, "2026.9.2", "Reinspect direct boot imports before changing SDK version");
  const { E: setRuntimeConfigSnapshot } = await fromHost("runtime-snapshot-BaQikjTR.js");
  const { o: loadOpenClawPlugins } = await fromHost("loader-DPiOPJjR.js");
  setRuntimeConfigSnapshot(config, config);
  loadOpenClawPlugins({ config, activationSourceConfig: config, workspaceDir: boot.workspace,
    onlyPluginIds: ["dsh-native", channelPluginId], activate: true, throwOnLoadError: true });
  const { n: getHarness, r: listHarnesses } = await fromHost("registry-D1_C7waJ.js");
  assert.equal(getHarness("dsh-native")?.ownerPluginId, "dsh-native");
  assert.ok(bridge.channel, "Genuine plugin registration did not expose inbound.run");
  await bridge.channel.connect();

  let busy = false;
  let stopping;
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      const errors = [];
      bridge.channel.close();
      let timer;
      const statuses = listHarnesses().map(({ harness }) => ({ id: harness.id, status: "pending", harness }));
      let disposalExpired = false;
      try {
        // The SDK fan-out logs and swallows disposal errors; inspect our owned harnesses directly.
        await Promise.race([Promise.all(statuses.map(async (entry) => {
          try { await entry.harness.dispose?.(); entry.status = "fulfilled"; }
          catch (error) {
            entry.status = "rejected"; entry.error = error.stack ?? error.message;
            if (!disposalExpired) errors.push(error);
          }
        })), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Private harness disposal timed out")), 10000);
        })]);
      } catch (error) { errors.push(error); }
      finally {
        disposalExpired = true;
        clearTimeout(timer);
        bridge.record({ kind: "harnesses-disposed", statuses: statuses.map(({ id, status, error }) => ({ id, status, error })) });
      }
      const children = [...(globalThis[Symbol.for("dsh.isolated.children")] ?? [])];
      const results = await Promise.allSettled(children.map((child) => new Promise((resolve, reject) => {
        let forced = false;
        const timeout = setTimeout(() => {
          forced = true;
          child.kill("SIGKILL");
        }, 4000);
        const deadline = setTimeout(() => reject(new Error("Private native child termination was not confirmed")), 9000);
        child.once("close", (code, signal) => {
          clearTimeout(timeout); clearTimeout(deadline);
          bridge.record({ kind: "native-child-closed", pid: child.pid, code, signal, forced });
          if (forced) reject(new Error("Private native child required forced termination"));
          else resolve();
        });
        child.kill();
      })));
      for (const result of results) if (result.status === "rejected") errors.push(result.reason);
      const remaining = globalThis[Symbol.for("dsh.isolated.children")].size;
      bridge.record({ kind: "native-children-settled", remaining });
      if (remaining !== 0) errors.push(new Error("Private native children remain after disposal"));
      if (errors.length) throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
    })();
    return stopping;
  }
  process.once("disconnect", () => {
    for (const checkpoint of checkpoints.values()) checkpoint.reject(new Error("Private parent disconnected"));
    checkpoints.clear();
    void stop().then(() => process.exit(0), (error) => {
      console.error(error); process.exit(1);
    });
  });
  process.on("message", async (message) => {
    if (message.kind === "journal-ack") {
      checkpoints.get(message.journalId)?.resolve();
      checkpoints.delete(message.journalId);
      return;
    }
    const respond = (result, error) => process.send?.({ kind: "response", id: message.id, result, error });
    try {
      if (message.method === "close") {
        await stop();
        respond({ closed: true });
        process.disconnect();
        return;
      }
      if (message.method === "snapshot") {
        respond({ busy, activeNative: bridge.activeNative, ...bridge.channel.snapshot() });
        return;
      }
      assert.equal(message.method, "execute");
      assert.ok(!busy && !stopping, "Private SDK host accepts one execution at a time");
      busy = true;
      const raw = Object.freeze(message.raw);
      bridge.current = { ...raw, callbackId: message.callbackId };
      try {
        await bridge.channel.dispatch(raw);
        if (message.type === "duplicate-replay") await bridge.channel.dispatch(raw);
        else {
          assert.equal(message.type, "reconnect-ack");
          await bridge.channel.reconnect();
        }
        bridge.record({ kind: "execution-settled" });
        respond(bridge.channel.snapshot());
      } finally {
        busy = false;
        bridge.current = undefined;
      }
    } catch (error) {
      respond(undefined, { message: error.message, stack: error.stack });
    }
  });
  process.send({ kind: "ready" });
}

if (process.argv[2] === "--worker") {
  runWorker(process.argv[3]).catch((error) => {
    process.send?.({ kind: "fatal", message: error.stack ?? error.message });
    process.exitCode = 1;
    process.disconnect?.();
  });
}
