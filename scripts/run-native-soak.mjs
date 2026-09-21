#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDshConfig } from "../dist/config.js";
import { createDshRuntime } from "../dist/runtime.js";
import { startModelServer } from "../tests/fixtures/model-server.mjs";

const DEFAULT_TURNS = 200;
const MAX_TURNS = 200;
const RESET_CADENCE_PER_AGENT = 10;
const DEFAULT_MAX_CONCURRENT_RUNS = 8;
const STABILITY_WAVE_CONCURRENCY = 2;
const AGENTS = ["synthetic-agent-a", "synthetic-agent-b"];
const SENTINEL_KEY = "offline-native-soak-loopback-key";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultArtifactsDir = join(repoRoot, "artifacts", "externalprivate");

function usage() {
  return "Usage: node scripts\\run-native-soak.mjs [--execute] [--stability] [--gc-diagnostics] [--turns <1-200>] [--max-concurrent-runs <1-8>] [--keep-artifacts] [--artifacts-dir <repo\\artifacts\\externalprivate\\...>]";
}

function parseBoundedTurns(value) {
  if (!/^\d+$/.test(String(value))) throw new TypeError("--turns must be an integer between 1 and 200");
  const turns = Number(value);
  if (!Number.isSafeInteger(turns) || turns < 1 || turns > MAX_TURNS) {
    throw new TypeError("--turns must be an integer between 1 and 200");
  }
  return turns;
}

function parseMaxConcurrentRuns(value) {
  if (!/^\d+$/.test(String(value))) throw new TypeError("--max-concurrent-runs must be an integer between 1 and 8");
  const runs = Number(value);
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > DEFAULT_MAX_CONCURRENT_RUNS) {
    throw new TypeError("--max-concurrent-runs must be an integer between 1 and 8");
  }
  return runs;
}

function assertPrivateArtifactsDir(value) {
  const resolved = resolve(value ?? defaultArtifactsDir);
  const base = resolve(defaultArtifactsDir);
  const rel = relative(base, resolved);
  if (rel === ".." || rel.startsWith(`..\\`) || rel.startsWith("../") || isAbsolute(rel)) {
    throw new TypeError("--artifacts-dir must be inside artifacts\\externalprivate");
  }
  return resolved;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    execute: false,
    dryRun: true,
    turns: DEFAULT_TURNS,
    stability: false,
    maxConcurrentRuns: DEFAULT_MAX_CONCURRENT_RUNS,
    gcDiagnostics: false,
    keepArtifacts: false,
    artifactsDir: defaultArtifactsDir,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--execute") {
      args.execute = true;
      args.dryRun = false;
    } else if (arg === "--dry-run") {
      args.execute = false;
      args.dryRun = true;
    } else if (arg === "--turns") {
      if (argv[index + 1] === undefined) throw new TypeError(`--turns requires a value\n${usage()}`);
      args.turns = parseBoundedTurns(argv[++index]);
    } else if (arg === "--stability") {
      args.stability = true;
    } else if (arg === "--gc-diagnostics") {
      args.gcDiagnostics = true;
    } else if (arg === "--max-concurrent-runs") {
      if (argv[index + 1] === undefined) throw new TypeError(`--max-concurrent-runs requires a value\n${usage()}`);
      args.maxConcurrentRuns = parseMaxConcurrentRuns(argv[++index]);
    } else if (arg === "--keep-artifacts") {
      args.keepArtifacts = true;
    } else if (arg === "--artifacts-dir") {
      if (argv[index + 1] === undefined) throw new TypeError(`--artifacts-dir requires a value\n${usage()}`);
      args.artifactsDir = assertPrivateArtifactsDir(argv[++index]);
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new TypeError(`Unknown argument ${arg}\n${usage()}`);
    }
  }
  args.artifactsDir = assertPrivateArtifactsDir(args.artifactsDir);
  return args;
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (value && typeof value === "object") return textOf(value.text ?? value.content ?? value.output ?? "");
  return "";
}

function messageText(message) {
  return textOf(message?.content ?? message?.output ?? "");
}

function allBodyText(body) {
  return (body.messages ?? []).map(messageText).join("\n");
}

function markerFor(agent, agentTurn, totalTurn, { stability = false } = {}) {
  const epoch = stability ? 0 : Math.floor(agentTurn / RESET_CADENCE_PER_AGENT);
  return {
    agent,
    agentTurn,
    totalTurn,
    epoch,
    marker: `SOAK_MARKER agent=${agent} epoch=${epoch} agentTurn=${agentTurn} totalTurn=${totalTurn}`,
  };
}

function markerRegex() {
  return /SOAK_MARKER agent=(synthetic-agent-[ab]) epoch=(\d+) agentTurn=(\d+) totalTurn=(\d+)/g;
}

function markersIn(text) {
  return [...text.matchAll(markerRegex())].map((match) => ({
    marker: match[0],
    agent: match[1],
    epoch: Number(match[2]),
    agentTurn: Number(match[3]),
    totalTurn: Number(match[4]),
  }));
}

function lastUserMarker(body) {
  let found;
  for (let index = 0; index < (body.messages ?? []).length; index++) {
    const message = body.messages[index];
    if (message?.role !== "user") continue;
    const markers = markersIn(messageText(message));
    if (markers.length > 0) found = { ...markers.at(-1), index };
  }
  assert.ok(found, "model request must include a current synthetic user marker");
  return found;
}

function hasToolOutputAfter(body, userIndex, marker) {
  return (body.messages ?? []).slice(userIndex + 1).some((message) =>
    message?.role === "tool" && messageText(message).includes(`tool-output:${marker}`));
}

function shaJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function bindingKey(nativeStateId) {
  return createHash("sha256").update(nativeStateId).digest("hex");
}

function percentile(sorted, p) {
  if (sorted.length === 0) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export function summarizeNumbers(values) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) return { count: 0 };
  const sum = finite.reduce((total, value) => total + value, 0);
  const summary = {
    count: finite.length,
    min: finite[0],
    avg: Math.round(sum / finite.length),
    max: finite.at(-1),
  };
  if (finite.length >= 20) {
    summary.p50 = percentile(finite, 50);
    summary.p95 = percentile(finite, 95);
  }
  return summary;
}

function readProcFile(path) {
  return readFile(path, "utf8").catch((error) => {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return undefined;
    throw error;
  });
}

function parseStatusNumberKiB(status, key) {
  const match = status?.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
  return match ? Number(match[1]) * 1024 : undefined;
}

function parseStatusNumber(status, key) {
  const match = status?.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
  return match ? Number(match[1]) : undefined;
}

function parseProcStat(stat) {
  if (!stat) return {};
  const close = stat.lastIndexOf(")");
  if (close < 0) return {};
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  return {
    state: fields[0],
    pgrp: Number(fields[2]),
    startTime: fields[19],
  };
}

async function directChildPids() {
  const tids = await readdir("/proc/self/task");
  const pids = new Set();
  await Promise.all(tids.map(async (tid) => {
    const text = await readProcFile(`/proc/self/task/${tid}/children`);
    for (const token of (text ?? "").trim().split(/\s+/)) {
      if (/^\d+$/.test(token)) pids.add(Number(token));
    }
  }));
  return [...pids];
}

async function inspectPid(pid) {
  let firstStartTime;
  for (let attempt = 0; attempt < 3; attempt++) {
    const [status, stat, fdEntries] = await Promise.all([
      readProcFile(`/proc/${pid}/status`),
      readProcFile(`/proc/${pid}/stat`),
      readdir(`/proc/${pid}/fd`).catch((error) => {
        if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) return undefined;
        throw error;
      }),
    ]);
    if (!status || !stat) return undefined;
    const identity = parseProcStat(stat);
    if (!identity.startTime || !/^\d+$/.test(identity.startTime)) throw new Error("Owned child process identity could not be measured");
    firstStartTime ??= identity.startTime;
    const afterStat = await readProcFile(`/proc/${pid}/stat`);
    if (!afterStat) return undefined;
    const after = parseProcStat(afterStat);
    if (!after.startTime || !/^\d+$/.test(after.startTime)) throw new Error("Owned child process identity could not be measured");
    if (identity.startTime !== firstStartTime || after.startTime !== firstStartTime) return undefined;
    const statusState = status.match(/^State:\s+([A-Z])/m)?.[1];
    if ([identity.state, after.state, statusState].some((state) => ["Z", "X"].includes(state))) return undefined;
    const rssBytes = parseStatusNumberKiB(status, "VmRSS");
    // A child can lose its mm/procfs access between reads while exiting.
    // Retry boundedly, but retain null for genuinely unavailable live measurements.
    if ((!Number.isFinite(rssBytes) || fdEntries === undefined) && attempt < 2) {
      await new Promise((done) => setTimeout(done, 1));
      continue;
    }
    return {
      pid,
      ppid: parseStatusNumber(status, "PPid"),
      rssBytes: Number.isFinite(rssBytes) ? rssBytes : null,
      highWaterRssBytes: parseStatusNumberKiB(status, "VmHWM") ?? 0,
      fdCount: fdEntries?.length ?? null,
      ...after,
    };
  }
}

function makeTrend(values) {
  if (values.length === 0) return { samples: 0 };
  const first = values.slice(0, Math.min(10, values.length));
  const tail = values.slice(Math.max(0, values.length - Math.min(10, values.length)));
  const baselineAvg = summarizeNumbers(first).avg;
  const tailAvg = summarizeNumbers(tail).avg;
  return {
    samples: values.length,
    baselineAvg,
    tailAvg,
    deltaBytes: tailAvg - baselineAvg,
  };
}

export function createLinuxResourceSampler({ intervalMs = 75 } = {}) {
  if (process.platform !== "linux") {
    return {
      measured: false,
      unsupportedReason: `unsupported platform ${process.platform}`,
      start() {},
      async stop() { return this.summary(); },
      summary() { return { measured: false, unsupportedReason: this.unsupportedReason }; },
      async liveOwnedPids() { return []; },
    };
  }
  const samples = [];
  const seen = new Map();
  let timer;
  let running = false;
  let inFlight = Promise.resolve();
  let samplingError;
  let totalSamples = 0;

  async function sample() {
    const parentRssBytes = process.memoryUsage().rss;
    const children = (await Promise.all((await directChildPids()).map(inspectPid))).filter(Boolean)
      .filter((child) => child.ppid === process.pid);
    for (const child of children) seen.set(child.pid, child.startTime);
    const childRssBytes = children.every((child) => child.rssBytes !== null)
      ? children.reduce((sum, child) => sum + child.rssBytes, 0) : null;
    const childFdCount = children.every((child) => child.fdCount !== null)
      ? children.reduce((sum, child) => sum + child.fdCount, 0) : null;
    const childHighWaterRssBytes = Math.max(0, ...children.map((child) => child.highWaterRssBytes));
    totalSamples++;
    samples.push({
      at: Date.now(),
      parentRssBytes,
      activeChildren: children.length,
      childRssBytes,
      childFdCount,
      childHighWaterRssBytes,
      childPids: children.map((child) => child.pid),
    });
    if (samples.length > 10000) samples.shift();
  }
  async function sampleSafely() {
    try { await sample(); }
    catch (error) { samplingError = error; running = false; }
  }

  function schedule() {
    timer = setTimeout(async () => {
      try { inFlight = sampleSafely(); await inFlight; }
      finally { if (running) schedule(); }
    }, intervalMs);
    timer.unref?.();
  }

  return {
    measured: true,
    start() {
      if (running) return;
      running = true;
      inFlight = sampleSafely();
      schedule();
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      await inFlight;
      return this.summary();
    },
    summary() {
      if (samplingError) throw new Error("Linux resource sampling failed", { cause: samplingError });
      return {
        measured: samples.length > 0,
        sampleCount: samples.length,
        totalSamples, samplesTruncated: totalSamples > samples.length,
        parentRssBytes: summarizeNumbers(samples.map((sample) => sample.parentRssBytes)),
        parentRssTrend: makeTrend(samples.map((sample) => sample.parentRssBytes)),
        childRssMeasured: samples.some((sample) => sample.activeChildren > 0 && sample.childRssBytes !== null),
        unavailableRssSamples: samples.filter((sample) => sample.childRssBytes === null).length,
        childRssBytes: summarizeNumbers(samples.map((sample) => sample.childRssBytes)),
        childHighWaterRssBytes: summarizeNumbers(samples.map((sample) => sample.childHighWaterRssBytes)),
        activeChildren: summarizeNumbers(samples.map((sample) => sample.activeChildren)),
        childFdCount: summarizeNumbers(samples.map((sample) => sample.childFdCount)),
        unavailableFdSamples: samples.filter((sample) => sample.childFdCount === null).length,
        maxActiveChildren: Math.max(0, ...samples.map((sample) => sample.activeChildren)),
        maxChildRssBytes: Math.max(0, ...samples.map((sample) => sample.childRssBytes)),
      };
    },
    snapshot() {
      return this.summary();
    },
    async liveOwnedPids() {
      const alive = [];
      for (const [pid, startTime] of seen) {
        const current = await inspectPid(pid);
        if (current?.startTime === startTime) alive.push(pid);
      }
      return alive;
    },
  };
}

function createEventSink(limit = 200) {
  const recent = [];
  const counts = new Map();
  let total = 0;
  return {
    push(event) {
      total++;
      counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
      recent.push(event);
      if (recent.length > limit) recent.shift();
    },
    summary() {
      return { total, byType: Object.fromEntries(counts), recent };
    },
    count(type) { return counts.get(type) ?? 0; },
  };
}

async function collectRuntimeState(root, runIds = new Set()) {
  const bindings = [];
  const locks = [];
  async function scan(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (entry.name === "binding.json") bindings.push({ path, value: JSON.parse(await readFile(path, "utf8")) });
      else if (entry.name === "owner.lock") {
        const text = await readFile(path, "utf8");
        const lock = JSON.parse(text);
        assert.equal(typeof lock.pid, "number", `Unexpected owner.lock pid shape at ${path}`);
        assert.equal(typeof lock.runId, "string", `Unexpected owner.lock runId shape at ${path}`);
        assert.equal(runIds.has(lock.runId), true, `Unexpected owner.lock runId at ${path}`);
        locks.push({ path, value: lock });
      }
    }
  }
  await scan(root);
  return { bindings, locks };
}

function makeInput({ root, model, turn, runId, nativeStateId, events, signal, executeTool }) {
  return {
    sessionId: `approved1.0plan:${turn.agent}`,
    nativeStateId,
    runId,
    workspaceDir: root,
    systemPrompt: "Offline native runtime state soak. Use only read_fixture. Do not write files.",
    prompt: `${turn.marker}\nCall read_fixture once, then answer with the returned probe.`,
    modelId: "deepseek-v4-pro",
    apiKey: SENTINEL_KEY,
    baseUrl: model.baseUrl,
    contextWindow: 1000000,
    maxTokens: 1000,
    thinking: "disabled",
    tools: [{
      name: "read_fixture",
      description: "Return a synthetic offline probe for the current soak marker.",
      parameters: {
        type: "object",
        properties: { marker: { type: "string" } },
        required: ["marker"],
        additionalProperties: false,
      },
    }],
    signal,
    assertActive() {},
    onEvent(event) { events.push({ runId, type: event.type, status: event.status }); },
    executeTool,
  };
}

async function runExecutedSoak(args) {
  if (args.gcDiagnostics && typeof globalThis.gc !== "function") {
    throw new Error("--gc-diagnostics requires node --expose-gc; no work was started");
  }
  const runLabel = `soak-${randomUUID()}`;
  const root = join(args.artifactsDir, runLabel);
  const metadata = {
    suite: "approved1.0plan-offline-native-runtime-state-soak",
    label: args.stability ? "offline native runtime stability soak" : "offline native runtime state soak",
    loopbackOnly: true,
    turns: args.turns,
    maxTurns: MAX_TURNS,
    resetCadencePerAgent: args.stability ? null : RESET_CADENCE_PER_AGENT,
    stability: args.stability,
    gcDiagnostics: args.gcDiagnostics,
    maxConcurrentRuns: args.maxConcurrentRuns,
    waveConcurrency: args.stability ? Math.min(STABILITY_WAVE_CONCURRENCY, args.maxConcurrentRuns) : 1,
    turnTimeoutMs: 60000,
    agents: AGENTS,
  };
  const privateJsonSha256 = shaJson(metadata);
  await mkdir(root, { recursive: true });
  const eventSink = createEventSink();
  let modelRequestCount = 0;
  const model = await startModelServer(async ({ body, send, finish }) => {
    modelRequestCount++;
    const current = lastUserMarker(body);
    const bodyText = allBodyText(body);
    for (const seen of markersIn(bodyText)) {
      assert.equal(seen.agent, current.agent, "other agent marker leaked into model request");
      assert.equal(seen.epoch, current.epoch, "pre-reset marker leaked into model request");
    }
    const turnRecord = turnRecords.get(current.marker);
    assert.ok(turnRecord, `unregistered turn marker ${current.marker}`);
    if (!hasToolOutputAfter(body, current.index, current.marker)) {
      assert.equal(turnRecord.callbacks, 0, "model attempted more than one tool phase");
      send({ role: "assistant", tool_calls: [{
        index: 0,
        id: `call-${createHash("sha256").update(current.marker).digest("hex").slice(0, 16)}`,
        type: "function",
        function: { name: "read_fixture", arguments: JSON.stringify({ marker: current.marker }) },
      }] });
      finish("tool_calls");
      return;
    }
    turnRecord.finals++;
    assert.equal(turnRecord.finals, 1, "model emitted more than one final response for a turn");
      send({ role: "assistant", content: `final:${current.marker}:tool-output:${current.marker}` });
      finish();
    });
  const runtime = createDshRuntime(parseDshConfig({
    stateDir: root,
    allowedBaseUrls: [model.baseUrl],
    startupTimeoutMs: 30000,
    shutdownTimeoutMs: 10000,
    streamIdleTimeoutMs: 3000,
    maxConcurrentRuns: args.maxConcurrentRuns,
  }));
  const runIds = new Set();
  const turnRecords = new Map();
  const nativeSessionByEpoch = new Map();
  const latencies = [];
  const waveSummaries = [];
  const sampler = createLinuxResourceSampler();
  let runtimeDisposed = false;
  let modelClosed = false;
  let maxActiveRuns = 0;
  let activeRuns = 0;
  let primaryFailure;
  let cleanup = { completed: false, scopedRoot: root, removedOwnedState: false };

  async function runTurn(turn) {
    const runId = `native-soak-${turn.agent}-${turn.totalTurn}-${randomUUID()}`;
    runIds.add(runId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`native soak turn ${turn.totalTurn} timed out`)), 60000);
    const nativeStateId = `approved1.0plan:${turn.agent}:native-soak-epoch-${turn.epoch}`;
    const record = { ...turn, callbacks: 0, finals: 0 };
    turnRecords.set(turn.marker, record);
    const started = Date.now();
    activeRuns++;
    maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
    let result;
    try {
      result = await runtime.run(makeInput({
        root,
        model,
        turn,
        runId,
        nativeStateId,
        events: eventSink,
        signal: controller.signal,
        executeTool: async (call) => {
          record.callbacks++;
          assert.equal(call.name, "read_fixture");
          assert.deepEqual(call.arguments, { marker: turn.marker });
          assert.equal(record.callbacks, 1, "host callback must dispatch once per attempt");
          return { text: `tool-output:${turn.marker}`, isError: false };
        },
      }));
    } finally {
      activeRuns--;
      clearTimeout(timer);
    }
    const latencyMs = Date.now() - started;
    latencies.push(latencyMs);
    assert.equal(result.stopReason, "stop");
    assert.equal(result.text, `final:${turn.marker}:tool-output:${turn.marker}`);
    assert.equal(result.toolCalls, 1);
    assert.equal(record.callbacks, 1);
    assert.equal(record.finals, 1);
    assert.ok(result.usage.input >= 0 && result.usage.output >= 0);
    const bindingPath = join(root, bindingKey(nativeStateId), "binding.json");
    const binding = JSON.parse(await readFile(bindingPath, "utf8"));
    const epochKey = `${turn.agent}:${turn.epoch}`;
    if (nativeSessionByEpoch.has(epochKey)) {
      assert.equal(binding.sessionId, nativeSessionByEpoch.get(epochKey), "same epoch must resume the same native session");
    } else {
      nativeSessionByEpoch.set(epochKey, binding.sessionId);
    }
    assert.equal(binding.status, "ready");
    assert.equal(binding.lastRunId, runId);
    return { turn, latencyMs, runId, bindingSessionId: binding.sessionId };
  }

  async function writeWaveObservation(wave) {
    if (!args.keepArtifacts) return;
    const file = join(root, `wave-${String(wave.index).padStart(4, "0")}.json`);
    await writeFile(file, JSON.stringify(wave, null, 2), { mode: 0o600 });
  }

  try {
    sampler.start();
    const perAgentTurns = Object.fromEntries(AGENTS.map((agent) => [agent, 0]));
    let totalTurn = 0;
    let waveIndex = 0;
    const waveConcurrency = args.stability ? Math.min(STABILITY_WAVE_CONCURRENCY, args.maxConcurrentRuns) : 1;
    while (totalTurn < args.turns) {
      const turns = [];
      for (let slot = 0; slot < waveConcurrency && totalTurn < args.turns; slot++, totalTurn++) {
        const agent = AGENTS[totalTurn % AGENTS.length];
        const agentTurn = perAgentTurns[agent]++;
        turns.push(markerFor(agent, agentTurn, totalTurn, { stability: args.stability }));
      }
      const waveStarted = Date.now();
      const completed = await Promise.all(turns.map(runTurn));
      model.requests.length = 0;
      const beforeGc = process.memoryUsage();
      if (args.gcDiagnostics) globalThis.gc();
      const quiescentMemory = process.memoryUsage();
      const wave = {
        index: waveIndex++,
        turnCount: completed.length,
        totalTurnsCompleted: totalTurn,
        durationMs: Date.now() - waveStarted,
        markers: completed.map((item) => item.turn.marker),
        latencyMs: summarizeNumbers(completed.map((item) => item.latencyMs)),
        resources: sampler.snapshot(),
        quiescentParentRssBytes: quiescentMemory.rss,
        quiescentHeapUsedBytes: quiescentMemory.heapUsed,
        ...(args.gcDiagnostics ? { heapUsedBeforeDiagnosticGc: beforeGc.heapUsed } : {}),
      };
      waveSummaries.push(wave);
      await writeWaveObservation(wave);
    }
    await runtime.dispose();
    runtimeDisposed = true;
    const resourceSummary = await sampler.stop();
    const liveOwnedPids = await sampler.liveOwnedPids();
    const state = await collectRuntimeState(root, runIds);
    assert.equal(state.locks.length, 0, "owner locks must be absent after settlement");
    assert.equal(liveOwnedPids.length, 0, "owned child processes must be absent after runtime disposal");
    for (const binding of state.bindings) assert.equal(binding.value.status, "ready", `binding not ready: ${binding.path}`);
    cleanup.completed = true;
    const stabilityGates = args.stability ? {
      zeroOrphans: liveOwnedPids.length === 0,
      zeroLocks: state.locks.length === 0,
      sameEpoch2Bindings: nativeSessionByEpoch.size === AGENTS.length && state.bindings.length === AGENTS.length,
      observedMaxActiveChildrenAtLeast2: resourceSummary.measured === true && resourceSummary.maxActiveChildren >= 2,
    } : undefined;
    if (args.stability) {
      assert.equal(resourceSummary.childRssMeasured, true, "Stability certification requires actual Linux child RSS samples");
      assert.ok(Object.values(stabilityGates).every(Boolean), "Stability ownership/concurrency gates did not all pass");
    }
    return {
      code: 0,
      summary: {
        label: metadata.label,
        execute: true,
        stability: args.stability,
        dryRunPassed: false,
        realTurnCount: args.turns,
        modelRequestCount,
        toolCallbacks: [...turnRecords.values()].reduce((sum, turn) => sum + turn.callbacks, 0),
        finals: [...turnRecords.values()].reduce((sum, turn) => sum + turn.finals, 0),
        nativeBindingCount: state.bindings.length,
        ownerLockCountAfterSettlement: state.locks.length,
        orphanOwnedPidCountAfterDispose: liveOwnedPids.length,
        previousNativeBindingsRetainedDuringRun: nativeSessionByEpoch.size === state.bindings.length,
        sameEpochNativeBindingCount: args.stability ? nativeSessionByEpoch.size : undefined,
        wavesCompleted: waveSummaries.length,
        maxConcurrentRuns: args.maxConcurrentRuns,
        maxActiveRunsObserved: maxActiveRuns,
        stabilityGates,
        privateJsonSha256,
        resourceFacts: {
          driverRssBytes: process.memoryUsage().rss,
          childRssMeasured: resourceSummary.childRssMeasured === true,
          statusEvents: eventSink.count("status"),
          events: eventSink.summary(),
          latencyMs: summarizeNumbers(latencies),
          linuxSampler: resourceSummary,
          quiescentParentRssTrend: makeTrend(waveSummaries.slice(Math.min(5, Math.floor(waveSummaries.length / 4)))
            .map((wave) => wave.quiescentParentRssBytes)),
          quiescentHeapUsedTrend: makeTrend(waveSummaries.slice(Math.min(5, Math.floor(waveSummaries.length / 4)))
            .map((wave) => wave.quiescentHeapUsedBytes)),
          diagnosticGcEnabled: args.gcDiagnostics,
        },
        cleanup,
      },
    };
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const errors = [];
    try { await sampler.stop(); } catch (error) { errors.push(error); }
    if (!runtimeDisposed) {
      try { await runtime.dispose(); } catch (error) { errors.push(error); }
    }
    if (!modelClosed) {
      await model.close();
      modelClosed = true;
    }
    if (!args.keepArtifacts) {
      const [state, liveOwnedPids] = await Promise.all([
        collectRuntimeState(root, runIds), sampler.liveOwnedPids(),
      ]);
      const safeToRemove = errors.length === 0 && state.locks.length === 0 && liveOwnedPids.length === 0;
      if (safeToRemove) {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        cleanup.removedOwnedState = true;
      }
    }
    if (errors.length) throw new AggregateError([...(primaryFailure ? [primaryFailure] : []), ...errors],
      "Stability resource/cleanup confirmation failed; retained owned artifacts");
  }
}

function dryRunSummary(args) {
  return {
    code: 0,
    summary: {
      label: args.stability ? "offline native runtime stability soak" : "offline native runtime state soak",
      execute: false,
      dryRunPassed: false,
      plannedOnly: true,
      realTurnCount: 0,
      plannedTurnCount: args.turns,
      maxTurns: MAX_TURNS,
      stability: args.stability,
      maxConcurrentRuns: args.maxConcurrentRuns,
      resetCadencePerAgent: args.stability ? null : RESET_CADENCE_PER_AGENT,
      stabilityWaveConcurrency: args.stability ? Math.min(STABILITY_WAVE_CONCURRENCY, args.maxConcurrentRuns) : 1,
      agents: AGENTS,
      loopbackModelFixture: "tests\\fixtures\\model-server.mjs",
      wouldLaunchRuntimeOrModel: false,
    },
  };
}

export async function runNativeSoak(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { code: 0, summary: { usage: usage() } };
  if (!args.execute) return dryRunSummary(args);
  return runExecutedSoak(args);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runNativeSoak().then(({ code, summary }) => {
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = code;
  }).catch((error) => {
    const describe = (failure) => ({
      message: failure.message,
      ...(failure.cause ? { cause: describe(failure.cause) } : {}),
      ...(failure.errors ? { errors: failure.errors.map(describe) } : {}),
    });
    console.error(JSON.stringify(describe(error)));
    process.exitCode = 1;
  });
}
