import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBridgePatch } from "../dist/bridge/profile.js";
import { JsonRpcPeer } from "../dist/rpc.js";

const require = createRequire(import.meta.url);
const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const dshManifest = require.resolve("@deepseek-ai/dsh/package.json");

async function deadline(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("official sdk-minimal CLI readies and drains shutdown before natural exit", { timeout: 60000 }, async (t) => {
  const fixture = join(projectDir, `.worker-cli-${randomUUID()}`);
  const home = join(fixture, "home");
  const cwd = join(fixture, "workspace");
  const scratch = join(fixture, "scratch");
  const patchPath = join(fixture, "bridge.patch.json");
  let child;
  let peer;
  let didClose = false;
  const closed = Promise.withResolvers();
  t.after(async () => {
    try {
      if (child && !didClose) {
        child.kill();
        await deadline(closed.promise, 5000, "owned CLI cleanup");
      }
    } finally {
      peer?.close();
      child?.stdin.destroy();
      child?.stdout.destroy();
      child?.stderr.destroy();
      await rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
  await Promise.all([home, cwd, scratch].map((dir) => mkdir(dir, { recursive: true })));
  const installed = JSON.parse(await readFile(dshManifest, "utf8"));
  assert.equal(installed.version, "0.1.2-alpha.2");
  await writeFile(patchPath, JSON.stringify(createBridgePatch({
    bridgePath: join(projectDir, "dist", "bridge", "index.js"),
    baseUrl: "http://127.0.0.1:9",
    thinking: "enabled",
    contextWindow: 32768,
    streamIdleTimeoutMs: 1000,
  })));
  const env = {
    DSH_HOME: home,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    TEMP: scratch,
    TMP: scratch,
    TMPDIR: scratch,
    PATH: dirname(process.execPath),
    OPENCLAW_DSH_MODEL_KEY: "worker-cli-fake-key-not-a-credential",
    DSH_TELEMETRY_DISABLED: "1",
    NO_COLOR: "1",
  };
  for (const key of ["SystemRoot", "WINDIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  child = spawn(process.execPath, [
    join(dirname(dshManifest), "lib", "bin.js"),
    "--profile", "sdk-minimal", "--patch", patchPath,
  ], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  let overflow = false;
  let spawnError;
  let shutdownSeen = false;
  const transportFailed = Promise.withResolvers();
  const onTransportError = (error) => {
    spawnError ??= error;
    peer?.close(error);
    transportFailed.resolve(error);
  };
  child.on("error", onTransportError);
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on("error", onTransportError);
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    overflow ||= stdout.length + chunk.length > 1024 * 1024;
    stdout = (stdout + chunk).slice(0, 1024 * 1024);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    overflow ||= stderr.length + chunk.length > 1024 * 1024;
    stderr = (stderr + chunk).slice(0, 1024 * 1024);
  });
  child.on("close", (code, signal) => {
    didClose = true;
    closed.resolve({ code, signal, shutdownSeen });
  });
  const ready = Promise.withResolvers();
  const events = [];
  const requests = [];
  peer = new JsonRpcPeer(child.stdout, child.stdin, {
    onRequest(method, params) {
      requests.push({ method, params });
      throw new Error(`Unexpected CLI callback: ${method}`);
    },
    onNotification(method, event) {
      assert.equal(method, "event");
      events.push(event);
      assert.equal(event.type, "ready");
      ready.resolve(event);
    },
  });
  const prematureExit = closed.promise.then(({ code, signal }) => {
    throw spawnError ?? new Error(`CLI closed unexpectedly (code=${code}, signal=${signal})`);
  });
  const prematureEof = peer.closed.then(() => {
    throw new Error("CLI RPC closed before the expected response");
  });
  const transportFailure = transportFailed.promise.then((error) => { throw error; });
  void transportFailure.catch(() => {});
  try {
    const event = await deadline(Promise.race([
      ready.promise, prematureExit, prematureEof, transportFailure,
    ]), 30000, "CLI ready");
    assert.deepEqual(event, { type: "ready", version: 1, dshVersion: installed.version });
    const result = await deadline(Promise.race([
      peer.request("shutdown", {}), prematureExit, prematureEof, transportFailure,
    ]), 10000, "CLI shutdown response");
    assert.deepEqual(result, {});
    shutdownSeen = true;
    child.stdin.end();
    const exit = await deadline(closed.promise, 10000, "CLI natural exit");
    await peer.drain();
    assert.deepEqual(exit, { code: 0, signal: null, shutdownSeen: true });
    assert.equal(child.killed, false, "successful shutdown must not need a signal");
    assert.equal(spawnError, undefined);
    assert.equal(overflow, false, "CLI output must remain bounded");
    assert.equal(stderr, "", "CLI must not log startup or shutdown errors");
    assert.deepEqual(events, [event], "no second SDK stdio owner or autonomous events");
    assert.deepEqual(requests, [], "startup must not invoke host tools");
    assert.ok(stdout.endsWith("\n"), "the final JSON-RPC frame must drain completely");
    assert.deepEqual(stdout.slice(0, -1).split("\n").map((line) => JSON.parse(line)), [
      { jsonrpc: "2.0", method: "event", params: event },
      { jsonrpc: "2.0", id: 1, result: {} },
    ], "stdout must contain exactly the bridge ready event and shutdown response");
    t.diagnostic(`DSH ${installed.version}: ready v1, shutdown {}, two JSONL frames, natural exit 0`);
  } catch (error) {
    if (!didClose) await deadline(closed.promise, 250, "diagnostic output drain").catch(() => {});
    t.diagnostic(`CLI stdout: ${JSON.stringify(stdout)}`);
    t.diagnostic(`CLI stderr: ${JSON.stringify(stderr)}`);
    throw error;
  }
});
