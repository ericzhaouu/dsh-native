import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { executionStatuses, validateUsageShape, zeroUsage } from "./acceptance-contract.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const textOf = (message) => typeof message?.content === "string" ? message.content :
  (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
const usageKeys = Object.keys(zeroUsage());
const preparationModes = ["chat", "clarify", "draft", "execute"];
const sumUsage = (a, b) => Object.fromEntries([
  ...usageKeys.map((key) => [key, a[key] + b[key]]), ["priced", false],
]);

function exactBodyError(actual, canonical, code, message) {
  if (actual === canonical) return undefined;
  const bytes = [Buffer.from(actual, "utf8"), Buffer.from(canonical, "utf8")];
  let firstDiffUtf8Byte = 0;
  while (firstDiffUtf8Byte < Math.min(...bytes.map((value) => value.length)) &&
      bytes[0][firstDiffUtf8Byte] === bytes[1][firstDiffUtf8Byte]) firstDiffUtf8Byte++;
  const identity = (text) => ({
    sha256: hash(text), utf8Bytes: Buffer.byteLength(text, "utf8"),
    whitespace: {
      leadingUtf8Bytes: Buffer.byteLength(text.match(/^\s*/u)[0], "utf8"),
      trailingUtf8Bytes: Buffer.byteLength(text.match(/\s*$/u)[0], "utf8"),
      lf: (text.match(/\n/g) ?? []).length, cr: (text.match(/\r/g) ?? []).length,
      tabs: (text.match(/\t/g) ?? []).length, spaces: (text.match(/ /g) ?? []).length,
    },
  });
  return Object.assign(new Error(message), { code,
    diagnosis: { code, actual: identity(actual), canonical: identity(canonical), firstDiffUtf8Byte } });
}

function safeFailure(error) {
  if (["GATEWAY_FINAL_CANONICAL_MISMATCH", "GATEWAY_PROJECTED_CANONICAL_MISMATCH"].includes(error?.code) &&
      error.diagnosis?.code === error.code) return error;
  const message = error?.code === "ERR_ASSERTION" ? error.message.split("\n")[0] :
    error instanceof SyntaxError ? "Invalid JSON in native evidence" : error?.message ?? "Gateway execution failed";
  const safe = new Error(message);
  if (error?.code) safe.code = error.code;
  for (const key of ["budgetAccounting", "observedTurn", "preDispatchBudgetBlock", "remoteUnsettled"]) {
    if (error?.[key] !== undefined) safe[key] = error[key];
  }
  return safe;
}

function failureTurnSummary(turn) {
  const { prompt, outputText, tools, ...summary } = turn;
  return { ...summary,
    ...(typeof outputText === "string" ? {
      outputSha256: hash(outputText), outputUtf8Bytes: Buffer.byteLength(outputText, "utf8"),
    } : {}),
    ...(tools ? { tools: tools.map(({ callId, name, isError }) => ({ callId, name, isError })) } : {}),
  };
}

function observedExecutionStatus(mode, ...observations) {
  const statuses = observations.filter((value) => value && Object.hasOwn(value, "executionStatus"))
    .map((value) => value.executionStatus);
  const unknown = statuses.findIndex((status) => !executionStatuses.includes(status));
  if (unknown >= 0) return statuses[unknown];
  const unsafe = statuses.findIndex((status) => !["completed", "correctly_blocked"].includes(status));
  if (unsafe >= 0) return statuses[unsafe];
  const abnormal = observations.find((value) => value?.stopReason !== undefined && !["stop", "length"].includes(value.stopReason));
  if (abnormal) return ["error", "aborted"].includes(abnormal.stopReason) ? "failed" : "unknown";
  if (statuses.length) return statuses[0];
  if (!preparationModes.includes(mode)) return "unknown";
  return mode === "clarify" ? "correctly_blocked" : "completed";
}

const operationalFields = ["maxModelRequests", "maxInputTokens", "maxOutputTokens", "maxToolCalls", "maxDurationMs"];
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const nonNegative = (value) => Number.isSafeInteger(value) && value >= 0;
export const monotonicNowMs = () => Math.floor(performance.now());

// Capture legacy wall deadlines once at entry; only the monotonic deadline is authoritative thereafter.
export function captureBudgetDeadline(context = {}, startedAtMs = monotonicNowMs()) {
  const wallNow = Date.now();
  const deadlineAtMs = resolveDeadlineAtMs(wallNow, context.timeoutMs, context.deadlineAtMs);
  let inherited = context.deadlineMonotonicMs;
  if (inherited === undefined && context.deadlineAtMs !== undefined) {
    inherited = resolveDeadlineAtMs(startedAtMs, Math.max(1, context.deadlineAtMs - wallNow));
    if (context.deadlineAtMs <= wallNow) inherited = startedAtMs;
  }
  const deadlineMonotonicMs = resolveDeadlineAtMs(startedAtMs, context.timeoutMs, inherited);
  return Object.freeze({ deadlineAtMs, deadlineMonotonicMs });
}

export function remainingDeadlineMs(deadline) {
  const captured = typeof deadline === "number" ? captureBudgetDeadline({ deadlineAtMs: deadline }) : deadline;
  if (captured?.deadlineMonotonicMs === undefined) return undefined;
  assert.ok(nonNegative(captured.deadlineMonotonicMs), "Invalid monotonic deadline");
  return captured.deadlineMonotonicMs - monotonicNowMs();
}

export function resolveDeadlineAtMs(startedAtMs, timeoutMs, inheritedDeadlineAtMs) {
  assert.ok(nonNegative(startedAtMs), "Invalid deadline start time");
  if (inheritedDeadlineAtMs !== undefined) {
    assert.ok(nonNegative(inheritedDeadlineAtMs), "deadlineAtMs must be a non-negative safe integer");
  }
  if (timeoutMs === undefined) return inheritedDeadlineAtMs;
  assert.ok(positive(timeoutMs), "timeoutMs must be a positive safe integer");
  return Math.min(startedAtMs + Math.min(timeoutMs, Number.MAX_SAFE_INTEGER - startedAtMs),
    inheritedDeadlineAtMs ?? Number.MAX_SAFE_INTEGER);
}

export function assertBudgetFitsDeadline(budget, deadline) {
  const remaining = remainingDeadlineMs(deadline) - 25;
  assert.ok(positive(budget.maxDurationMs) && budget.maxDurationMs <= remaining,
    `Configured maxDurationMs (${budget.maxDurationMs}) exceeds remaining duration (${remaining}ms including dispatch margin); ` +
    "operator must install smaller configured limits strictly below the case/review deadline with setup headroom. " +
    "Input caps must still cover the full prepared contextWindow");
}

function checkedSum(...values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  assert.ok(nonNegative(total), "Budget accounting exceeds safe integer range");
  return total;
}

export function validateOperationalBudget(value, label = "operationalBudget") {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !operationalFields.includes(key)) ||
      operationalFields.some((key) => !Object.hasOwn(value, key) || !positive(value[key]))) {
    throw new TypeError(`${label} requires all five positive safe integer limits and no extra fields`);
  }
  return Object.fromEntries(operationalFields.map((key) => [key, value[key]]));
}

export function narrowOperationalBudget(root, caps = {}, timeoutMs, { zeroTools = false } = {}) {
  const budget = validateOperationalBudget(root);
  assertUnpricedAllocation(caps);
  for (const [field, key] of Object.entries({
    modelRequests: "maxModelRequests", inputTokens: "maxInputTokens",
    outputTokens: "maxOutputTokens", toolCalls: "maxToolCalls",
  })) {
    if (caps[field] === undefined || (zeroTools && field === "toolCalls")) continue;
    assert.ok(nonNegative(caps[field]), `Invalid budget.${field}`);
    budget[key] = Math.min(budget[key], caps[field]);
  }
  if (timeoutMs !== undefined) {
    assert.ok(positive(timeoutMs), "timeoutMs must be a positive safe integer");
    budget.maxDurationMs = Math.min(budget.maxDurationMs, timeoutMs);
  }
  return validateOperationalBudget(budget, "operationalBudget allocation (no exhausted limits)");
}

function assertUnpricedAllocation(caps) {
  assert.ok(caps.priced !== true && caps.currencyMicros === undefined,
    "Native runtime budgets cannot enforce priced/currency allocations; operator must supply unpriced token/request caps " +
    "or install runtime pricing enforcement before bounded admission");
}

export function assertNativeBudgetFitsAllocation(configured, caps = {}) {
  const budget = validateOperationalBudget(configured);
  assertUnpricedAllocation(caps);
  for (const field of ["inputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
    if (caps[field] === undefined) continue;
    assert.ok(nonNegative(caps[field]), `Invalid budget.${field}; operator must supply non-negative safe integer caps`);
    assert.ok(budget.maxInputTokens <= caps[field],
      `Configured maxInputTokens (${budget.maxInputTokens}) exceeds remaining ${field} budget (${caps[field]}); ` +
      "operator must install smaller configured limits within EACH input/cache allocation. " +
      "Input caps must still cover the full prepared contextWindow; the runtime cannot enforce an unknown cache split");
  }
  return budget;
}

export function resolveConfiguredOperationalBudget(hostConfig, agentId) {
  const plugin = hostConfig.plugins?.entries?.["dsh-native"]?.config;
  const byAgent = plugin?.operationalBudgetByAgent;
  if (byAgent !== undefined) {
    assert.ok(byAgent && typeof byAgent === "object" && !Array.isArray(byAgent) &&
      Object.keys(byAgent).length <= 64, "Invalid configured operationalBudgetByAgent");
    for (const [agent, budget] of Object.entries(byAgent)) {
      assert.match(agent, /^[a-z][a-z0-9_-]{0,63}$/, "Configured budgets require exact agent identifiers");
      validateOperationalBudget(budget, `operationalBudgetByAgent.${agent}`);
    }
  }
  const caps = [plugin?.operationalBudget, byAgent && Object.hasOwn(byAgent, agentId) ? byAgent[agentId] : undefined]
    .filter((cap) => cap !== undefined).map((cap) => validateOperationalBudget(cap));
  return caps.length ? Object.fromEntries(operationalFields.map((key) =>
    [key, Math.min(...caps.map((cap) => cap[key]))])) : undefined;
}

export function remainingNativeAllocation(caps = {}, used = zeroUsage()) {
  const remaining = { ...caps };
  for (const key of usageKeys) {
    if (caps[key] !== undefined) remaining[key] = caps[key] - (used[key] ?? 0);
  }
  if (caps.inputTokens !== undefined) {
    remaining.inputTokens = caps.inputTokens - checkedSum(used.inputTokens ?? 0,
      used.cacheReadTokens ?? 0, used.cacheWriteTokens ?? 0);
  }
  return remaining;
}

export function remainingOperationalBudget(root, used = zeroUsage()) {
  const budget = validateOperationalBudget(root);
  budget.maxModelRequests -= used.modelRequests ?? 0;
  budget.maxInputTokens -= checkedSum(used.inputTokens ?? 0, used.cacheReadTokens ?? 0, used.cacheWriteTokens ?? 0);
  budget.maxOutputTokens -= used.outputTokens ?? 0;
  budget.maxToolCalls -= used.toolCalls ?? 0;
  return validateOperationalBudget(budget, "remaining operationalBudget (no exhausted limits)");
}

// Offline admission only: no Gateway, auth, model preparation or runtime attestation.
export function preflightConfiguredOperationalBudget({ hostConfig, agentId, caseBudget, attemptBudget,
  budget = {}, used = zeroUsage(), contextWindow, timeoutMs, zeroTools = false }) {
  assert.deepEqual(validateUsageShape(used, { requirePricing: false }), [], "Invalid preflight usage");
  const configured = resolveConfiguredOperationalBudget(hostConfig, agentId);
  assert.ok(configured, "Runtime budget proof unsupported without configured plugin operationalBudget limits for the exact agent");
  const caps = remainingNativeAllocation(budget, used);
  const remaining = narrowOperationalBudget(caseBudget !== undefined ? remainingOperationalBudget(caseBudget, used) : configured,
    caps, timeoutMs, { zeroTools });
  assertConfiguredBudgetFits(configured, remaining);
  if (attemptBudget !== undefined) assertConfiguredBudgetFits(configured, attemptBudget);
  assertNativeBudgetFitsAllocation(configured, caps);
  assert.ok(positive(contextWindow) && contextWindow <= configured.maxInputTokens,
    "Configured maxInputTokens must cover the full prepared contextWindow, not guessed prompt tokens");
  if (timeoutMs !== undefined || caseBudget !== undefined) {
    assert.ok(configured.maxDurationMs <= remaining.maxDurationMs - 25,
      "Configured maxDurationMs requires dispatch margin and setup headroom below the case/review timeoutMs");
  }
  return Object.freeze(configured);
}

export function assertConfiguredBudgetFits(configured, remaining) {
  assert.ok(configured, "Runtime budget proof unsupported without configured plugin operationalBudget limits for the exact agent");
  const cap = validateOperationalBudget(configured);
  const allocation = validateOperationalBudget(remaining);
  for (const key of operationalFields) {
    assert.ok(cap[key] <= allocation[key],
      `Configured ${key} (${cap[key]}) exceeds remaining budget (${allocation[key]}); ` +
      "operator must install smaller configured limits no greater than all remaining case/campaign budgets. " +
      "Input caps must still cover the full prepared contextWindow, not guessed prompt tokens");
  }
  return cap;
}

// This is an observation contract, not an enforcement shim. The runtime must persist
// reservations before EVERY network attempt (including retries/maintenance), and only
// release them on measured settlement. Configured admission alone is not attestation.
export function validateRuntimeBudgetProof(proof, expected = {}) {
  const config = proof?.runtimeConfig;
  const journal = proof?.ledger;
  assert.equal(config?.version, 1, "Missing versioned runtime budget config");
  assert.equal(journal?.version, 1, "Missing versioned runtime budget ledger");
  for (const key of ["runId", "sessionKey", "agentId"]) {
    assert.ok(typeof config[key] === "string" && config[key].length > 0, `Missing runtime ${key}`);
    assert.equal(journal[key], config[key], `Budget ledger ${key} identity mismatch`);
    if (expected[key] !== undefined) assert.equal(config[key], expected[key], `Runtime ${key} identity mismatch`);
  }
  const budget = validateOperationalBudget(config.operationalBudget);
  if (expected.operationalBudget) {
    const root = validateOperationalBudget(expected.operationalBudget);
    for (const key of operationalFields) assert.ok(budget[key] <= root[key], `Runtime widened ${key}`);
  }
  const configSha256 = hash(JSON.stringify(config));
  assert.equal(journal.configSha256, configSha256, "Runtime config/ledger fingerprint mismatch");
  if (expected.configSha256) assert.equal(configSha256, expected.configSha256, "Runtime configuration changed after admission");
  assert.ok(positive(config.contextWindow) && config.contextWindow <= budget.maxInputTokens,
    "Input budget cannot reserve a full contextWindow");
  assert.ok(positive(config.maxTokens) && config.maxTokens <= config.contextWindow &&
    config.maxTokens <= budget.maxOutputTokens, "Runtime maxTokens exceeds output/context budget");
  const entries = journal.entries;
  assert.ok(Array.isArray(entries) && entries.length > 0 && entries.length <= 100000, "Invalid runtime budget ledger entries");
  assert.equal(entries[0].type, "admitted", "Budget ledger lacks admission");
  const start = entries[0].at;
  assert.ok(nonNegative(start), "Invalid budget admission time");
  const pending = new Map();
  const requestIds = new Set();
  const activeTools = new Set();
  const toolIds = new Set();
  const usage = { ...zeroUsage(), priced: false };
  let inputUsed = 0, inputReserved = 0, outputReserved = 0;
  let lastAt = start, terminal;
  const accounting = () => ({ usageStatus: "unknown", observedLowerBound: { ...usage },
    reserved: { inputTokens: inputReserved, outputTokens: outputReserved,
      modelRequests: pending.size, toolCalls: activeTools.size } });
  try {
  for (const [seq, entry] of entries.entries()) {
    assert.equal(entry.seq, seq, "Budget ledger sequence is discontinuous");
    assert.ok(nonNegative(entry.at) && entry.at >= lastAt,
      "Invalid runtime ledger time");
    lastAt = entry.at;
    assert.ok(!terminal, "Budget ledger continued after its terminal fence/settlement");
    if (seq === 0) continue;
    switch (entry.type) {
      case "request_reserved": {
        assert.ok(entry.at - start < budget.maxDurationMs, "Provider request admitted after duration deadline");
        assert.ok(typeof entry.requestId === "string" && entry.requestId && !requestIds.has(entry.requestId),
          "Provider attempts require unique request reservations");
        assert.ok(["main", "preparation", "compaction", "maintenance", "review", "retry"].includes(entry.purpose),
          "Unknown provider request purpose");
        assert.equal(entry.inputTokens, config.contextWindow, "Each provider attempt must reserve contextWindow input");
        const availableOutput = budget.maxOutputTokens - usage.outputTokens - outputReserved;
        assert.ok(positive(entry.outputTokens) && entry.outputTokens <= Math.min(config.maxTokens, availableOutput),
          "Provider output was not clipped to remaining output budget");
        assert.ok(checkedSum(inputUsed, inputReserved, entry.inputTokens) <= budget.maxInputTokens,
          "Insufficient input budget for contextWindow reservation");
        assert.ok(usage.modelRequests < budget.maxModelRequests, "Provider request budget exhausted");
        requestIds.add(entry.requestId);
        pending.set(entry.requestId, entry);
        usage.modelRequests++;
        inputReserved = checkedSum(inputReserved, entry.inputTokens);
        outputReserved = checkedSum(outputReserved, entry.outputTokens);
        break;
      }
      case "request_settled": {
        const reservation = pending.get(entry.requestId);
        assert.ok(reservation, "Provider settlement lacks an outstanding reservation");
        const raw = entry.usage;
        assert.ok(raw && ["input", "output", "cacheRead", "cacheWrite"].every((key) => nonNegative(raw[key])),
          "Provider usage missing or invalid; unknown usage cannot be zero");
        const input = checkedSum(raw.input, raw.cacheRead, raw.cacheWrite);
        assert.ok(input <= reservation.inputTokens && raw.output <= reservation.outputTokens,
          "Provider usage exceeds its reservation");
        inputUsed = checkedSum(inputUsed, input);
        for (const [field, key] of Object.entries({
          inputTokens: "input", outputTokens: "output", cacheReadTokens: "cacheRead", cacheWriteTokens: "cacheWrite",
        })) usage[field] = checkedSum(usage[field], raw[key]);
        inputReserved -= reservation.inputTokens;
        outputReserved -= reservation.outputTokens;
        pending.delete(entry.requestId);
        break;
      }
      case "tool_started":
        assert.ok(entry.at - start < budget.maxDurationMs, "Tool admitted after duration deadline");
        assert.ok(typeof entry.callId === "string" && entry.callId && !toolIds.has(entry.callId),
          "Tool calls require unique durable admissions");
        assert.ok(usage.toolCalls < budget.maxToolCalls, "Tool budget exhausted");
        toolIds.add(entry.callId);
        activeTools.add(entry.callId);
        usage.toolCalls++;
        break;
      case "tool_settled":
        assert.ok(activeTools.delete(entry.callId), "Tool settlement lacks an outstanding admission");
        break;
      case "settled":
        // Deadlines fence admission/cancel work; only drained provider/tool receipts
        // establish settlement, which may occur after the deadline.
        assert.equal(entry.providerSettled, true, "Provider settlement unproven");
        assert.equal(entry.toolsSettled, true, "Tool settlement unproven");
        assert.equal(pending.size + activeTools.size, 0, "Outstanding requests/tools prevent quiescence");
        terminal = "settled";
        break;
      case "fenced":
        terminal = "fenced";
        break;
      default:
        throw new Error(`Unknown runtime budget ledger event: ${entry.type}`);
    }
  }
  } catch (error) {
    error.budgetAccounting = accounting();
    throw error;
  }
  const status = terminal ?? (entries.length === 1 ? "admitted" : "active");
  const complete = status === "settled" || status === "admitted";
  const quiescent = status === "settled";
  try {
    if (expected.settled === false) {
      assert.equal(status, "admitted", "Expected fresh runtime admission before any work");
      const admissionAge = Date.now() - start;
      assert.ok(admissionAge >= 0, "Runtime budget admission clock identity changed");
      assert.ok(admissionAge < budget.maxDurationMs, "Runtime budget admission deadline already expired");
    }
    if (expected.settled === true) {
      assert.equal(status, "settled", "Runtime requests are unsettled or fenced");
    }
  } catch (error) {
    error.budgetAccounting = accounting();
    throw error;
  }
  return { status, runId: config.runId, sessionKey: config.sessionKey, agentId: config.agentId,
    operationalBudget: budget, contextWindow: config.contextWindow, configSha256,
    ledgerSha256: hash(JSON.stringify(journal)), entryCount: entries.length,
    usage: complete ? usage : undefined, observedLowerBound: usage,
    reserved: { inputTokens: inputReserved, outputTokens: outputReserved,
      modelRequests: pending.size, toolCalls: activeTools.size },
    usageStatus: complete ? "complete" : "unknown", quiescent,
    hardLimitsVerified: quiescent };
}

export async function readRuntimeBudgetProof(directory, expected) {
  assert.ok(typeof directory === "string" && isAbsolute(directory), "Runtime budget proof directory must be absolute");
  const info = await lstat(directory);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), "Runtime budget directory cannot be a symlink");
  const canonical = await realpath(directory);
  assert.equal(process.platform === "win32" ? canonical.toLowerCase() : canonical,
    process.platform === "win32" ? resolve(directory).toLowerCase() : resolve(directory),
    "Runtime budget directory cannot traverse a symlink");
  const read = async (name) => {
    const path = join(directory, name);
    const stat = await lstat(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8 * 1024 * 1024,
      "Runtime budget evidence must be a bounded regular file");
    return readFile(path, "utf8");
  };
  const bytes = await read("operational-budget-config.json");
  const journal = await read("operational-budget-ledger.json");
  assert.equal(await read("operational-budget-config.json"), bytes, "Runtime config changed during proof read");
  const proof = validateRuntimeBudgetProof({ runtimeConfig: JSON.parse(bytes), ledger: JSON.parse(journal) }, expected);
  if (expected?.settled === true) {
    const ownershipDirectory = basename(dirname(directory)) === "budgets" ? dirname(dirname(directory)) : directory;
    for (const path of new Set([directory, ownershipDirectory])) {
      for (const name of ["owner.lock", "source-reply.lock"]) {
        await lstat(join(path, name)).then(() => {
          const error = new Error(`Runtime settlement retains ${name}; quiescence unproven`);
          error.budgetAccounting = { usageStatus: "unknown", observedLowerBound: proof.observedLowerBound, reserved: proof.reserved };
          throw error;
        }, (error) => { if (error.code !== "ENOENT") throw error; });
      }
    }
  }
  return proof;
}

function validateConfig(value) {
  for (const key of ["hostRoot", "configPath", "stateDir", "nativeStateDir"]) {
    if (typeof value?.[key] !== "string" || !isAbsolute(value[key])) throw new Error(`${key} must be an absolute path`);
  }
  const url = new URL(value.gatewayUrl);
  if (!["ws:", "wss:"].includes(url.protocol) || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("gatewayUrl must be an explicit credential-free loopback WebSocket endpoint");
  }
  if (!/^acceptance-[a-z0-9-]+$/.test(value.ownedSessionPrefix)) throw new Error("Invalid acceptance-owned session prefix");
  if (!Array.isArray(value.allowedAgentIds) || !value.allowedAgentIds.length ||
      !value.agentMap || typeof value.agentMap !== "object") throw new Error("Explicit agent mappings are required");
  for (const [logical, physical] of Object.entries(value.agentMap)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(logical) || !/^[a-z][a-z0-9_-]*$/.test(physical) ||
        !value.allowedAgentIds.includes(physical)) throw new Error("Mapped agent is not allowed");
  }
  if (value.isolation !== undefined && value.isolation !== "agent-policy-read-only") throw new Error("Unsupported evaluation isolation");
  return { ...value, gatewayUrl: url.href.replace(/\/$/, ""),
    ...Object.fromEntries(["operationalBudget", "caseBudget", "attemptBudget"]
      .filter((key) => value[key] !== undefined).map((key) => [key, validateOperationalBudget(value[key], key)])) };
}

async function waitFor(predicate, signal, timeoutMs, label) {
  const deadline = resolveDeadlineAtMs(monotonicNowMs(), timeoutMs);
  for (;;) {
    signal?.throwIfAborted();
    const value = await predicate();
    signal?.throwIfAborted();
    if (value) return value;
    if (monotonicNowMs() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

async function resolveActiveResetBoundary(...args) {
  const runtime = await import("../../dist/native/reset-boundary.js");
  return runtime.resolveActiveResetBoundary(...args);
}

async function ledger(context, value) {
  await mkdir(context.runDir, { recursive: true, mode: 0o700 });
  const file = await open(join(context.runDir, "gateway-acceptance-ledger.jsonl"), "a", 0o600);
  try {
    await file.write(`${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`);
    await file.sync();
  } finally { await file.close(); }
}

async function readNativeRows(directory) {
  const files = [];
  async function visit(path, depth = 0) {
    if (depth > 8) throw new Error("Unexpected native transcript directory depth");
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        if (entry.name === "session.jsonl") throw new Error("Native transcript cannot be a symlink");
        continue;
      }
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child, depth + 1);
      else if (entry.name === "session.jsonl") files.push(child);
    }
  }
  await visit(join(directory, "home"));
  assert.equal(files.length, 1, "Expected one native transcript for the exact owned epoch");
  const text = await readFile(files[0], "utf8");
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error("Native evidence exceeds bounded case size");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function nativeTurnEvidence(rows, assistant, budgetProof) {
  const start = rows.findLastIndex((row) => row.type === "turn/start");
  if (start < 0) throw new Error("No native turn/start evidence");
  const current = rows.slice(start);
  const turn = current[0].data.turn;
  if (!current.some((row) => row.type === "turn/end" && row.data.turn === turn)) throw new Error("Native turn has not ended");
  const results = new Map();
  for (const row of current.filter((row) => row.type === "tool/result" && row.data.turn === turn)) {
    for (const block of row.data.message.content) {
      if (block.type === "tool-result") results.set(block.toolCallId, block);
    }
  }
  const calls = current.filter((row) => row.type === "tool/call" && row.data.turn === turn).map(({ data }) => {
    const result = results.get(data.callId);
    if (!result || typeof result.isError !== "boolean") throw new Error("Native tool call lacks its correlated terminal result");
    return { callId: data.callId, name: data.name,
      arguments: typeof data.arguments === "string" ? JSON.parse(data.arguments) : data.arguments,
      result: result.content, isError: result.isError };
  });
  const route = current.findLast((row) => row.type === "request/header" && row.data.header?.config)?.data.header.config;
  assert.equal(route?.provider, "github-copilot", "Native provider must be github-copilot");
  assert.equal(route?.model, "gpt-6-astra", "Native model must be gpt-6-astra");
  const raw = assistant.usage;
  const usage = budgetProof ? { ...budgetProof.usage, userTurns: 1 } : {
    modelRequests: current.filter((row) => row.type === "step/start").length,
    inputTokens: raw?.input, outputTokens: raw?.output,
    cacheReadTokens: raw?.cacheRead, cacheWriteTokens: raw?.cacheWrite,
    toolCalls: calls.length, userTurns: 1, priced: false,
  };
  const errors = validateUsageShape(usage);
  if (errors.length || usage.modelRequests < 1) throw new Error(`Incomplete actual usage: ${errors.join("; ")}`);
  if (budgetProof) {
    assert.equal(budgetProof.hardLimitsVerified, true, "Native operational budget is unproven");
    // The runtime ledger counts host dispatches, not DSH's internal preparation control.
    const hostCalls = calls.filter((call) => call.name !== "dsh_prepare_task");
    assert.ok(usage.toolCalls >= hostCalls.length, "Runtime ledger omitted native tool admissions");
    assert.ok(usage.modelRequests >= current.filter((row) => row.type === "step/start").length,
      "Runtime ledger omitted native model steps");
  }
  return { calls, usage, provider: route.provider, model: route.model,
    usageBasis: budgetProof ? "runtime-provider-attempt-ledger" : "legacy-native-steps-not-network-attempts" };
}

function sideEffects(tools) {
  const effects = [];
  let unknown = false;
  for (const tool of tools) {
    if (["write", "edit", "apply_patch"].includes(tool.name)) effects.push({ kind: "write", tool: tool.name, callId: tool.callId });
    else if (!["dsh_prepare_task", "read", "grep", "glob", "find", "ls", "web_search", "web_fetch"].includes(tool.name)) {
      effects.push({ kind: "unclassified", tool: tool.name, callId: tool.callId });
      unknown = true;
    }
  }
  return { effects, unknown };
}

function normalizeTurnInput(turn) {
  if (typeof turn === "string") return { prompt: turn };
  if (turn && typeof turn === "object" && !Array.isArray(turn)) {
    return {
      prompt: turn.prompt,
      ...(typeof turn.submissionId === "string" && turn.submissionId ? { submissionId: turn.submissionId } : {}),
    };
  }
  return { prompt: turn };
}

function turnInputsForCase(testCase) {
  return Array.isArray(testCase.turns) ? testCase.turns.map(normalizeTurnInput) : [normalizeTurnInput(testCase.prompt)];
}

function validateGatewayControls(testCase, prompts) {
  const duplicateByTurn = new Map();
  const resetAfter = new Set();
  const controls = testCase.adapterControls ?? [];
  const fail = (reason) => ({ ok: false, reason });
  for (const control of controls) {
    if (!["new_context", "duplicate_inbound_delivery"].includes(control.type)) {
      return fail("Unsupported Gateway control; no input sent");
    }
    if (control.visibleToModel !== false) return fail("Gateway controls must be hidden from the model");
    if (control.type === "new_context") {
      if (control.replaySourceTurn !== undefined || control.controlVersion !== undefined) {
        return fail("Versioned replay fields apply only to duplicate_inbound_delivery");
      }
      if (!positive(control.appliesAfterTurn) || control.appliesAfterTurn >= prompts.length) {
        return fail("new_context must apply after an existing non-final turn");
      }
      if (resetAfter.has(control.appliesAfterTurn)) return fail("new_context may only be declared once per turn");
      resetAfter.add(control.appliesAfterTurn);
      continue;
    }
    if (!positive(control.appliesToTurn) || control.appliesToTurn > prompts.length) {
      return fail("duplicate_inbound_delivery appliesToTurn is outside compiled turns");
    }
    if (duplicateByTurn.has(control.appliesToTurn)) {
      return fail("duplicate_inbound_delivery may only be declared once per turn");
    }
    if (control.replaySourceTurn !== undefined || control.controlVersion !== undefined) {
      if (control.controlVersion !== 1) return fail("replaySourceTurn requires duplicate_inbound_delivery controlVersion 1");
    }
    if (control.replaySourceTurn !== undefined) {
      if (!positive(control.replaySourceTurn) || control.replaySourceTurn >= control.appliesToTurn ||
          control.replaySourceTurn > prompts.length) {
        return fail("replaySourceTurn must name an earlier compiled turn captured by this case");
      }
    }
    duplicateByTurn.set(control.appliesToTurn, control);
  }
  return { ok: true, duplicateByTurn, resetAfter };
}

async function realConnection(config, events) {
  const configBytes = await readFile(config.configPath, "utf8");
  const configFingerprint = hash(configBytes);
  const hostConfig = JSON.parse(configBytes);
  const hostConfigSnapshot = JSON.stringify(hostConfig);
  const [{ t: GatewayClient }, { t: version, s: buildId }, { n: loadDeviceIdentityIfPresent }, store] = await Promise.all([
    import(pathToFileURL(join(config.hostRoot, "dist/client-I-RoP1Al.js")).href),
    import(pathToFileURL(join(config.hostRoot, "dist/version-v1kuAkGj.js")).href),
    import(pathToFileURL(join(config.hostRoot, "dist/device-identity-J83pn_rP.js")).href),
    import(pathToFileURL(join(config.hostRoot, "dist/plugin-sdk/session-store-runtime.js")).href),
  ]);
  assert.equal(version, "2026.9.2", "The real adapter is pinned to the inspected SDK");
  const env = { ...process.env, OPENCLAW_STATE_DIR: config.stateDir, OPENCLAW_CONFIG_PATH: config.configPath };
  let resolveReady, rejectReady;
  let connectionError;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const client = new GatewayClient({
    url: config.gatewayUrl, origin: config.gatewayUrl.replace(/^ws/, "http"),
    token: hostConfig.gateway.auth.token, deviceIdentity: loadDeviceIdentityIfPresent(),
    deviceAuthScope: config.gatewayUrl, sharedStateMode: "read-only", env,
    clientName: "openclaw-control-ui", clientDisplayName: "DSH acceptance adapter",
    clientVersion: version, clientBuildId: buildId(), mode: "ui", scopes: ["operator.admin"],
    caps: ["task-suggestions"], instanceId: randomUUID(), minProtocol: 4, maxProtocol: 4,
    onHelloOk: resolveReady,
    onEvent: (frame) => {
      const key = frame.payload?.sessionKey;
      if (typeof key === "string" && config.allowedAgentIds.some((id) =>
        key.startsWith(`agent:${id}:${config.ownedSessionPrefix}-`))) events.push(frame);
    },
    onConnectError: (error) => { connectionError = error; rejectReady(error); },
    onGap: () => { connectionError = new Error("Gateway event stream lost frames"); },
    onClose: () => { connectionError = new Error("Gateway connection closed"); rejectReady(connectionError); },
  });
  client.start();
  let timer;
  try {
    await Promise.race([ready, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Gateway connection deadline exceeded")), 30000);
    })]);
  } catch (error) {
    await client.stopAndWait({ timeoutMs: 10000 });
    throw error;
  } finally { clearTimeout(timer); }
  return {
    client, hostConfig,
    assertHealthy() {
      if (connectionError) throw connectionError;
      assert.equal(hash(readFileSync(config.configPath, "utf8")), configFingerprint,
        "Host evaluation policy changed during the campaign");
      assert.equal(JSON.stringify(hostConfig), hostConfigSnapshot, "Pinned host configuration changed during the campaign");
    },
    readTranscript: (scope) => store.loadTranscriptEventsSync({ ...scope, env }),
  };
}

export async function createGatewayAcceptanceAdapter(options = {}) {
  const inputPath = options.env?.DSH_ACCEPTANCE_GATEWAY_CONFIG ?? process.env.DSH_ACCEPTANCE_GATEWAY_CONFIG;
  if (!options.config && (!inputPath || !isAbsolute(inputPath))) throw new Error("Explicit private adapter config path is required");
  const config = validateConfig(options.config ?? JSON.parse(await readFile(inputPath, "utf8")));
  const events = options.events ?? [];
  let connection;
  let busy = false;
  let fenced = false;
  const states = new Map();
  const gateway = async () => connection ??= await (options.connectionFactory
    ? options.connectionFactory(config, events) : realConnection(config, events));
  const request = async (method, params, signal, timeoutMs = 30000, onDispatch) => {
    signal?.throwIfAborted();
    const owner = await gateway();
    signal?.throwIfAborted();
    owner.assertHealthy();
    onDispatch?.();
    return owner.client.request(method, params, { timeoutMs });
  };
  const framesFor = (sessionKey, runId) => events.filter((frame) =>
    frame.payload?.sessionKey === sessionKey && frame.payload?.runId === runId);
  const assertFrames = (sessionKey, runId) => {
    const frames = framesFor(sessionKey, runId);
    const bad = frames.find((frame) => frame.event === "chat" && ["error", "aborted"].includes(frame.payload.state) ||
      frame.event === "agent" && frame.payload.stream === "lifecycle" &&
      ["error", "aborted", "fallback", "fallback_cleared"].includes(frame.payload.data?.phase));
    if (bad) {
      const detail = bad.payload.errorMessage ?? bad.payload.data?.error;
      const error = new Error(`Owned Gateway turn failed (${bad.payload.state ?? bad.payload.data.phase})`);
      error.remoteUnsettled = /abort|timed?\s*out|timeout|fenc/i.test(typeof detail === "string" ? detail : "");
      const failureStatus = ["fallback", "fallback_cleared"].includes(bad.payload.data?.phase) ? "infrastructure_blocked" : "failed";
      const finals = frames.filter((frame) => frame.event === "chat" && frame.payload.state === "final");
      error.observedTurn = { outputText: textOf(finals.at(-1)?.payload.message ?? bad.payload.message),
        executionStatus: observedExecutionStatus(undefined, bad.payload, bad.payload.message,
          { executionStatus: failureStatus }), terminalEvent: {
          event: bad.event, payload: { state: bad.payload.state,
            ...(bad.payload.data ? { data: { phase: bad.payload.data.phase } } : {}) },
        },
        delivery: { delivered: finals.length > 0, terminalOutputs: finals.length, receiptId: runId, recipient: sessionKey } };
      throw error;
    }
    return frames;
  };

  async function inspect(sessionKey, agentId, runId, signal) {
    const owner = await gateway();
    const history = await request("chat.history", { sessionKey, agentId, limit: 50 }, signal);
    if (!history.sessionId || history.inFlightRun) return undefined;
    const raw = await owner.readTranscript({ sessionKey, agentId, sessionId: history.sessionId });
    const boundary = await resolveActiveResetBoundary(raw, history.sessionId);
    const stateId = boundary.kind === "clear" ? boundary.stateId : history.sessionId;
    const key = `${boundary.kind === "clear" ? boundary.assistantKeyPrefix : "dsh-native:"}${runId}:assistant`;
    const canonical = raw.findLast((row) => row.type === "message" && row.message?.idempotencyKey === key)?.message;
    const projected = history.messages?.find((message) =>
      (message.idempotencyKey ?? message.__openclaw?.idempotencyKey) === key);
    if (!canonical || !projected) return undefined;
    const directory = join(config.nativeStateDir, hash(stateId));
    let binding, bindingBytes;
    try {
      const path = join(directory, "binding.json");
      const info = await lstat(path);
      assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024,
        "Native binding must be a bounded regular file");
      bindingBytes = await readFile(path, "utf8");
      binding = JSON.parse(bindingBytes);
    }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    if (binding.status === "blocked") throw new Error("Native binding is blocked");
    if (binding.status !== "ready" || binding.lastRunId !== runId) return undefined;
    assert.ok(["budgetFailure", "failureDiagnostic", "pendingCompact"].every((field) => !Object.hasOwn(binding, field)),
      "Native binding is fenced or unsettled");
    return { history, raw, boundary, canonical, projected, binding, bindingSha256: hash(bindingBytes), directory, key };
  }

  async function reset(state, context, afterTurn) {
    const before = await request("chat.history", { sessionKey: state.sessionKey, agentId: state.agentId, limit: 1 }, context.signal);
    const owner = await gateway();
    const raw = await owner.readTranscript({ sessionKey: state.sessionKey, agentId: state.agentId, sessionId: before.sessionId });
    const prior = await resolveActiveResetBoundary(raw, before.sessionId);
    await ledger(context, { event: "reset_planned", sessionKey: state.sessionKey, afterTurn });
    const response = await request("sessions.reset", { key: state.sessionKey, agentId: state.agentId, reason: "new" }, context.signal, 120000);
    assert.equal(response.ok, true);
    assert.equal(response.key, state.sessionKey);
    state.hostSessionId = response.entry.sessionId;
    const next = await owner.readTranscript({ sessionKey: state.sessionKey, agentId: state.agentId, sessionId: response.entry.sessionId });
    const boundary = await resolveActiveResetBoundary(next, response.entry.sessionId);
    if (before.sessionId === response.entry.sessionId) {
      assert.deepEqual(next.slice(0, raw.length), raw, "Reset removed canonical history");
      assert.equal(boundary.kind, "clear");
      assert.notEqual(boundary.resetId, prior.resetId);
    }
    return { type: "new_context", appliesAfterTurn: afterTurn, receiptId: boundary.resetId ?? response.entry.sessionId,
      transportControlled: true, selfAsserted: false, sessionKey: state.sessionKey };
  }

  async function turn(testCase, context, state, turnInput, index, duplicateControl, capturedMessage) {
    const { prompt, submissionId } = normalizeTurnInput(turnInput);
    const duplicate = duplicateControl !== undefined;
    const runId = randomUUID();
    state.runtimeBudgetDirectory = undefined;
    state.budgetExpected = undefined;
    state.reservedBudget = undefined;
    state.settlement = undefined;
    state.bodyError = undefined;
    state.executionKnown = false;
    state.preparationKnown = false;
    state.observation = { agentProfile: testCase.agentProfile, prompt, runId,
      executionStatus: "unknown", ...(submissionId ? { submissionId } : {}) };
    const owner = await gateway();
    owner.assertHealthy();
    let admission;
    let expected;
    let directory;
    if (state.operationalBudget) {
      const inputAllocations = [testCase.limits.usage, context.budget].filter(Boolean)
        .map((caps) => remainingNativeAllocation(caps, state.usage));
      let operationalBudget;
      try {
        operationalBudget = remainingOperationalBudget(state.operationalBudget, state.usage);
        for (const caps of inputAllocations) operationalBudget = narrowOperationalBudget(operationalBudget, caps);
        operationalBudget = narrowOperationalBudget(operationalBudget, {}, remainingDeadlineMs(state.deadline));
        if (state.attemptBudget) operationalBudget = Object.fromEntries(operationalFields.map((key) =>
          [key, Math.min(operationalBudget[key], state.attemptBudget[key])]));
        operationalBudget = Object.freeze(operationalBudget);
        if (!state.prepareBudget) {
          operationalBudget = Object.freeze(assertConfiguredBudgetFits(
            resolveConfiguredOperationalBudget(owner.hostConfig, state.agentId), operationalBudget));
          for (const caps of inputAllocations) assertNativeBudgetFitsAllocation(operationalBudget, caps);
          assertBudgetFitsDeadline(operationalBudget, state.deadline);
        }
      } catch (error) {
        error.preDispatchBudgetBlock = true;
        if (!/operator/.test(error.message)) error.message += "; operator must install smaller configured limits " +
          "within remaining case/campaign budgets, allowing the full prepared contextWindow";
        throw error;
      }
      expected = { runId, agentId: state.agentId, operationalBudget,
        ...(state.hostSessionId ? { sessionKey: state.hostSessionId } : {}) };
      state.reservedBudget = state.prepareBudget ?
        resolveConfiguredOperationalBudget(owner.hostConfig, state.agentId) : operationalBudget;
      state.budgetExpected = expected;
      if (state.prepareBudget) {
        state.activeRunId = runId;
        directory = await owner.prepareOperationalBudget(Object.freeze({
          ...expected, chatSessionKey: state.sessionKey, signal: context.signal,
        }));
        assert.ok(typeof directory === "string" && isAbsolute(directory), "Runtime budget directory must be absolute");
        const rel = relative(config.nativeStateDir, directory);
        assert.ok(rel && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
          !isAbsolute(rel), "Budget proof must be owned by the configured native state root");
        admission = await readRuntimeBudgetProof(directory, { ...expected, settled: false });
        expected.configSha256 = admission.configSha256;
        state.runtimeBudgetDirectory = directory;
        state.reservedBudget = admission.operationalBudget;
        state.budgetExpected = expected;
        for (const caps of inputAllocations) assertNativeBudgetFitsAllocation(admission.operationalBudget, caps);
        await ledger(context, { event: "runtime_budget_admitted", ...expected, proof: admission });
      } else {
        await ledger(context, { event: "configured_budget_checked", ...expected,
          chatSessionKey: state.sessionKey, hardLimitsVerified: false, budgetStatus: "unproven",
          admissionMode: "operator-configured-caps" });
      }
    }
    const message = capturedMessage ??
      (context.resources?.modelVisibleContext ? `${prompt}\n\n${context.resources.modelVisibleContext}` : prompt);
    const args = { sessionKey: state.sessionKey, agentId: state.agentId, message, thinking: "medium",
      timeoutMs: Math.min(testCase.limits.timeoutMs, 240000),
      ...(config.isolation ? {} : { expectedPermissionMode: "read-only" }), idempotencyKey: runId };
    await ledger(context, { event: "send_planned", caseId: testCase.id, runId, turn: index + 1,
      sessionKey: state.sessionKey, promptSha256: hash(message) });
    const checkDispatch = (nativeAttempt = true) => {
      try {
        if (expected) {
          const attempt = admission?.operationalBudget ?? expected.operationalBudget;
          assertBudgetFitsDeadline(attempt, state.deadline);
          if (nativeAttempt) context.beforeDispatch?.(attempt);
        }
        assert.ok(remainingDeadlineMs(state.deadline) > 0, "Case deadline expired before dispatch");
      } catch (error) {
        error.preDispatchBudgetBlock = true;
        throw error;
      }
    };
    const accepted = await request("chat.send", args, context.signal, 30000, () => {
      checkDispatch();
      state.activeRunId = runId;
    });
    assert.equal(accepted.runId, runId, "Host substituted the run identity");
    const final = await waitFor(() => {
      connection.assertHealthy();
      const finals = assertFrames(state.sessionKey, runId).filter((frame) => frame.event === "chat" && frame.payload.state === "final");
      assert.ok(finals.length <= 1, "Duplicate live terminal frame");
      return finals[0];
    }, context.signal, testCase.limits.timeoutMs, "actual chat.final frame");
    Object.assign(state.observation, { outputText: textOf(final.payload.message),
      executionStatus: observedExecutionStatus(undefined, final.payload, final.payload.message),
      delivery: { delivered: true, terminalOutputs: 1, receiptId: runId, recipient: state.sessionKey } });
    const settled = await waitFor(() => inspect(state.sessionKey, state.agentId, runId, context.signal),
      context.signal, 30000, "native/canonical settlement");
    const mode = settled.binding.taskPreparation?.state?.mode;
    Object.assign(state.observation, {
      mode, executionStatus: observedExecutionStatus(mode, settled.canonical, final.payload, final.payload.message),
    });
    state.executionKnown = executionStatuses.includes(state.observation.executionStatus);
    state.preparationKnown = preparationModes.includes(mode);
    // Body judgment cannot discard independently verified provider settlement.
    const bodyError = exactBodyError(textOf(final.payload.message), textOf(settled.canonical),
      "GATEWAY_FINAL_CANONICAL_MISMATCH", "Live final differs from committed canonical text") ??
      exactBodyError(textOf(settled.projected), textOf(settled.canonical),
        "GATEWAY_PROJECTED_CANONICAL_MISMATCH", "Canonical and projected assistant differ");
    state.bodyError = bodyError;
    let budgetProof;
    if (expected) {
      directory ??= settled.directory;
      assert.ok(!expected.sessionKey || expected.sessionKey === settled.history.sessionId,
        "Runtime settlement changed the owned session");
      expected = { ...expected, sessionKey: settled.history.sessionId };
      state.runtimeBudgetDirectory = directory;
      state.budgetExpected = expected;
      budgetProof = await readRuntimeBudgetProof(directory, { ...expected, settled: true });
      if (!state.prepareBudget) {
        assert.deepEqual(budgetProof.operationalBudget, expected.operationalBudget,
          "Runtime budget differs from the pinned configured limits");
      }
      state.budgetExpected = { ...expected, configSha256: budgetProof.configSha256 };
    }
    if (budgetProof) {
      assert.equal(await realpath(directory), await realpath(settled.directory),
        "Budget proof does not belong to the settled native epoch");
    }
    const rows = await (options.readNativeRows ?? readNativeRows)(settled.directory);
    const native = nativeTurnEvidence(rows, settled.canonical, budgetProof);
    const business = native.calls.filter((call) => call.name !== "dsh_prepare_task");
    const policy = connection.hostConfig.plugins.entries["dsh-native"].config.taskPreparation;
    const advertised = policy?.skillAllowlistByAgent?.[state.agentId] ?? policy?.skillAllowlist ?? [];
    const loaded = advertised.filter((name) => business.some((call) =>
      call.name === "read" && !call.isError && typeof call.arguments?.path === "string" &&
      call.arguments.path.replace(/\\/g, "/").endsWith(`/${name}/SKILL.md`)));
    Object.assign(state.observation, {
      tools: native.calls, skill: { advertised, selected: loaded, loaded }, usage: native.usage,
      provider: native.provider, model: native.model, sessionId: settled.history.sessionId,
      nativeSessionId: settled.binding.sessionId, usageBasis: native.usageBasis,
      dispatchedMessageSha256: hash(message),
    });
    state.settlement = { settled, budgetProof };
    assert.ok(state.executionKnown, "Missing or unknown native execution status");
    assert.ok(state.preparationKnown, "Missing actual native preparation mode");
    if (bodyError) throw bodyError;
    state.reportedRunIds.add(runId);
    context.reportUsage(native.usage);
    state.capturedInputs.set(index + 1, { prompt, message, runId });
    if (duplicate) {
      await ledger(context, { event: "duplicate_request_planned", runId, sessionKey: state.sessionKey,
        appliesToTurn: index + 1, ...(duplicateControl.replaySourceTurn !== undefined ?
          { replaySourceTurn: duplicateControl.replaySourceTurn } : {}) });
      const beforeHash = hash(JSON.stringify(rows));
      // Replaying the same admitted run does not authorize a second native attempt.
      const reply = await request("chat.send", args, context.signal, 30000, () => checkDispatch(false));
      assert.equal(reply.runId, runId);
      await new Promise((done) => setTimeout(done, 1000));
      const after = await inspect(state.sessionKey, state.agentId, runId, context.signal);
      assert.ok(after, "Duplicate request restarted or replaced the turn");
      assert.equal(hash(JSON.stringify(await (options.readNativeRows ?? readNativeRows)(after.directory))), beforeHash,
        "Duplicate request replayed native work");
      if (budgetProof) {
        const afterProof = await readRuntimeBudgetProof(directory, { ...expected, settled: true });
        assert.equal(afterProof.ledgerSha256, budgetProof.ledgerSha256, "Duplicate request changed provider budget ledger");
      }
    }
    assert.equal(assertFrames(state.sessionKey, runId).filter((frame) => frame.event === "chat" && frame.payload.state === "final").length, 1);
    state.activeRunId = undefined;
    await ledger(context, { event: "turn_settled", runId, sessionKey: state.sessionKey,
      ...(budgetProof ? { budgetProof } : { hardLimitsVerified: false, budgetStatus: "legacy-unattested" }) });
    if (budgetProof) state.proofs.push(budgetProof);
    return {
      agentProfile: testCase.agentProfile, prompt, outputText: textOf(settled.canonical), mode,
      executionStatus: state.observation.executionStatus,
      tools: native.calls, skill: { advertised, selected: loaded, loaded }, usage: native.usage,
      delivery: { delivered: true, terminalOutputs: 1, receiptId: runId, recipient: state.sessionKey },
      provider: native.provider, model: native.model, sessionId: settled.history.sessionId,
      nativeSessionId: settled.binding.sessionId, runId,
      usageBasis: native.usageBasis,
      ...(duplicateControl?.replaySourceTurn !== undefined ? { replaySourceTurn: duplicateControl.replaySourceTurn } : {}),
      dispatchedMessageSha256: hash(message),
      ...(submissionId ? { submissionId } : {}),
    };
  }

  return {
    async executeCase(testCase, context) {
      const startedAt = monotonicNowMs();
      let deadline = captureBudgetDeadline({ ...context,
        timeoutMs: Math.min(testCase.limits.timeoutMs, context.timeoutMs ?? Number.MAX_SAFE_INTEGER) }, startedAt);
      if (busy || fenced) throw new Error("Gateway adapter has active or uncertain work; further admission is fenced");
      busy = true;
      let campaignLock;
      let state;
      let timer;
      const controller = new AbortController();
      context = { ...context, signal: context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal };
      const armDeadline = () => {
        clearTimeout(timer);
        Object.assign(context, deadline);
        // Local cancellation is not proof of remote abort or settlement.
        timer = setTimeout(() => controller.abort(new Error("Operational budget duration expired; settlement unproven")),
          Math.max(0, Math.min(remainingDeadlineMs(deadline), 2147483647)));
      };
      try {
      const agentId = config.agentMap[testCase.agentProfile];
      const block = (reason) => {
        states.set(testCase.id, { settled: true, noWork: true });
        return { executionStatus: "infrastructure_blocked", businessResult: "failed", outputText: "",
          policyFacts: { blockedReason: reason }, sideEffects: [], usage: { ...zeroUsage(), priced: false },
          budgetAttestation: { status: "unproven", hardLimitsVerified: false, quiescent: true },
          delivery: { delivered: false, terminalOutputs: 0 }, turns: [] };
      };
      if (!agentId || !config.allowedAgentIds.includes(agentId)) return block("Agent profile not authorized");
      if (testCase.category === "delivery") return block("Actual Feishu controls require the channel adapter, not Gateway proxying");
      const prompts = turnInputsForCase(testCase);
      const controlPlan = validateGatewayControls(testCase, prompts);
      if (!controlPlan.ok) return block(controlPlan.reason);
      for (const key of ["caseBudget", "attemptBudget", "operationalBudget"]) {
        if (context[key] !== undefined) validateOperationalBudget(context[key], key);
      }
      const roots = [config.caseBudget ?? config.operationalBudget, context.caseBudget ?? context.operationalBudget]
        .filter((value) => value !== undefined)
        .map((value) => validateOperationalBudget(value));
      const attempts = [config.attemptBudget ?? (config.caseBudget ? config.operationalBudget : undefined),
        context.attemptBudget ?? (context.caseBudget ? context.operationalBudget : undefined)]
        .filter((value) => value !== undefined)
        .map((value) => validateOperationalBudget(value, "attemptBudget"));
      for (const root of roots) deadline = captureBudgetDeadline({ ...deadline, timeoutMs: root.maxDurationMs }, startedAt);
      armDeadline();
      if (remainingDeadlineMs(deadline) <= 0) return block("Case deadline expired before Gateway setup; no input sent");
      const owner = await gateway();
      owner.assertHealthy();
      const runtimeRoot = resolveConfiguredOperationalBudget(owner.hostConfig, agentId);
      const prepareBudget = typeof owner.prepareOperationalBudget === "function";
      if (runtimeRoot !== undefined && !roots.length) roots.push(runtimeRoot);
      if (runtimeRoot !== undefined) attempts.push(runtimeRoot);
      const attemptBudget = attempts.length ? Object.freeze(Object.fromEntries(operationalFields
        .map((key) => [key, Math.min(...attempts.map((value) => value[key]))]))) : undefined;
      let operationalBudget;
      if (roots.length) {
        if (runtimeRoot === undefined) return block("Runtime budget proof unsupported without configured plugin " +
          "operationalBudget limits for the exact agent; operator must install limits within remaining case/campaign budgets");
        const root = Object.fromEntries(operationalFields.map((key) => [key, Math.min(...roots.map((value) => value[key]))]));
        try {
          operationalBudget = narrowOperationalBudget(root, testCase.limits.usage, testCase.limits.timeoutMs);
          operationalBudget = narrowOperationalBudget(operationalBudget, context.budget, context.timeoutMs);
          if (!prepareBudget) {
            assertConfiguredBudgetFits(runtimeRoot, operationalBudget);
            assertConfiguredBudgetFits(runtimeRoot, attemptBudget);
            assertNativeBudgetFitsAllocation(runtimeRoot, testCase.limits.usage);
            assertNativeBudgetFitsAllocation(runtimeRoot, context.budget);
          }
        } catch (error) { return block(error.message); }
        deadline = captureBudgetDeadline({ ...deadline, timeoutMs: operationalBudget.maxDurationMs }, startedAt);
        armDeadline();
      }
      if (remainingDeadlineMs(deadline) <= 0) return block("Case deadline expired during Gateway setup; no input sent");
      const token = hash(`${context.runId}:${testCase.id}`).slice(0, 24);
      await mkdir(context.runDir, { recursive: true, mode: 0o700 });
      campaignLock = await open(join(context.runDir, "gateway-admission.lock"), "wx", 0o600);
      await campaignLock.write(JSON.stringify({ runId: context.runId, caseId: testCase.id, status: "admitted" }));
      await campaignLock.sync();
      const marker = await open(join(context.runDir, `gateway-case-${token}.json`), "wx", 0o600);
      try {
        await marker.write(JSON.stringify({ caseId: testCase.id, runId: context.runId }));
        await marker.sync();
      } finally { await marker.close(); }
      state = { sessionKey: `agent:${agentId}:${config.ownedSessionPrefix}-${token}`, agentId, settled: false,
        operationalBudget, attemptBudget, prepareBudget, deadline, proofs: [], usage: { ...zeroUsage(), priced: false },
        capturedInputs: new Map(), reportedRunIds: new Set() };
      states.set(testCase.id, state);
      const turns = [];
      const controlReceipts = [];
      let usage = { ...zeroUsage(), priced: false };
      try {
        if (config.isolation === "agent-policy-read-only") {
          const owner = await gateway();
          const agent = owner.hostConfig.agents.entries[agentId];
          assert.ok(agentId.startsWith("dsh-acceptance-"), "Agent-policy isolation requires a dedicated test Agent");
          assert.ok(Array.isArray(agent?.tools?.allow) && agent.tools.allow.length > 0 &&
            agent.tools.allow.every((name) => ["read", "grep", "glob", "find", "ls"].includes(name)),
          "Dedicated test Agent must have an explicit read-only tool allowlist");
          assert.equal(agent.tools.fs?.workspaceOnly ?? owner.hostConfig.tools?.fs?.workspaceOnly, true,
            "Dedicated Agent filesystem tools must be workspace-only");
          await ledger(context, { event: "read_only_agent_policy_verified", sessionKey: state.sessionKey, agentId });
        } else {
          await ledger(context, { event: "read_only_session_planned", sessionKey: state.sessionKey, agentId });
          const created = await request("sessions.create", {
            key: state.sessionKey, agentId, permissionMode: "read-only", idempotencyKey: `create-${token}`,
          }, context.signal);
          assert.equal(created.ok, true);
          assert.equal(created.key, state.sessionKey);
          assert.equal(created.entry?.permissionMode, "read-only", "Host must confirm read-only scope before any model input");
          state.hostSessionId = created.entry.sessionId;
        }
        for (const [index, prompt] of prompts.entries()) {
          assert.equal(typeof prompt.prompt, "string", "Compiled turns must be original prompt strings");
          if (index && controlPlan.resetAfter.has(index)) {
            controlReceipts.push(await reset(state, context, index));
          }
          const duplicate = controlPlan.duplicateByTurn.get(index + 1);
          const sourceTurn = duplicate?.replaySourceTurn !== undefined
            ? state.capturedInputs.get(duplicate.replaySourceTurn) : undefined;
          if (duplicate?.replaySourceTurn !== undefined && !sourceTurn) {
            throw new Error("replaySourceTurn source turn was not captured and settled");
          }
          const turnInput = sourceTurn ? { prompt: sourceTurn.prompt,
            ...(prompt.submissionId ? { submissionId: prompt.submissionId } : {}) } : prompt;
          const result = await turn(testCase, context, state, turnInput, index, duplicate, sourceTurn?.message);
          turns.push(result);
          usage = sumUsage(usage, result.usage);
          state.usage = usage;
          if (duplicate) controlReceipts.push({ type: "duplicate_inbound_delivery", appliesToTurn: index + 1,
            receiptId: result.runId, transportControlled: true, selfAsserted: false, surface: "Gateway-RPC",
            dispatchedPromptSha256: hash(result.prompt),
            dispatchedMessageSha256: result.dispatchedMessageSha256,
            ...(duplicate.controlVersion !== undefined ? { controlVersion: duplicate.controlVersion } : {}),
            ...(sourceTurn ? { replaySourceTurn: duplicate.replaySourceTurn, sourceReceiptId: sourceTurn.runId,
              sourcePromptSha256: hash(sourceTurn.prompt), targetManifestPromptSha256: hash(prompt.prompt),
              sourceMessageSha256: hash(sourceTurn.message),
              replayCrossesReset: [...controlPlan.resetAfter].some((after) =>
                after >= duplicate.replaySourceTurn && after < index + 1),
              modelContext: "target turn sees only the replayed captured input bytes plus host-visible context for its current reset epoch" } : {}) });
          if (!["completed", "correctly_blocked"].includes(result.executionStatus)) break;
        }
        const effects = sideEffects(turns.flatMap((item) => item.tools));
        state.settled = !effects.unknown && effects.effects.length === 0;
        fenced = !state.settled;
        context.signal.throwIfAborted();
        return {
          executionStatus: turns.at(-1).executionStatus,
          businessResult: ["completed", "correctly_blocked"].includes(turns.at(-1).executionStatus) ? "partial" : "failed",
          outputText: turns.at(-1).outputText,
          turns, usage, sideEffects: effects.effects, unknownEffects: effects.unknown || undefined, controlReceipts,
          delivery: { delivered: true, terminalOutputs: turns.length, recipient: state.sessionKey },
          policyFacts: { mode: turns.at(-1).mode, adapter: "real-Gateway-not-Feishu" }, latencyMs: monotonicNowMs() - startedAt,
          budgetAttestation: operationalBudget ? { status: "verified", hardLimitsVerified: true,
            quiescent: true, operationalBudget, contextWindow: Math.max(...state.proofs.map((proof) => proof.contextWindow)),
            proofs: state.proofs } : { status: "legacy-unattested", hardLimitsVerified: false, quiescent: false },
        };
      } catch (caught) {
        let error = safeFailure(state.bodyError ?? caught);
        state.bodyError = undefined;
        let recoveryRejected = false;
        // Only a body judgment over a captured, complete native turn is recoverable here.
        // Re-read the exact epoch/config/binding before releasing admission; cancellation
        // or callback/control failures must never reuse an earlier settlement snapshot.
        if (caught === error && error.diagnosis && state.settlement?.budgetProof &&
            state.executionKnown && state.preparationKnown &&
            !context.signal.aborted && remainingDeadlineMs(state.deadline) > 0 &&
            !state.reportedRunIds.has(state.activeRunId)) {
          try {
            const checkFrames = () => {
              const finals = assertFrames(state.sessionKey, state.activeRunId)
                .filter((frame) => frame.event === "chat" && frame.payload.state === "final");
              assert.ok(finals.length === 1 && textOf(finals[0].payload.message) === state.observation.outputText,
                "Failure recovery requires the same single live final");
            };
            checkFrames();
            const { settled: prior, budgetProof: pinned } = state.settlement;
            const current = await inspect(state.sessionKey, state.agentId, state.activeRunId, context.signal);
            assert.ok(current && current.binding.sessionId === prior.binding.sessionId &&
              current.bindingSha256 === prior.bindingSha256 &&
              Array.isArray(current.binding.consumedRunIds) &&
              current.binding.consumedRunIds.at(-1) === state.activeRunId &&
              current.binding.consumedRunIds.filter((id) => id === state.activeRunId).length === 1,
            "Failure accounting requires an unfenced binding for the exact consumed run");
            assert.equal(await realpath(current.directory), await realpath(prior.directory),
              "Failure accounting changed native epoch");
            const proof = await readRuntimeBudgetProof(state.runtimeBudgetDirectory,
              { ...state.budgetExpected, configSha256: pinned.configSha256, settled: true });
            assert.equal(proof.ledgerSha256, pinned.ledgerSha256, "Failure accounting changed runtime ledger");
            const failedTurn = { ...state.observation, executionStatus: "failed", businessResult: "failed" };
            const failedTurns = [...turns, failedTurn];
            const effects = sideEffects(failedTurns.flatMap((item) => item.tools));
            assert.ok(!effects.unknown && effects.effects.length === 0, "Failure accounting has uncertain effects");
            context.signal.throwIfAborted();
            state.reportedRunIds.add(state.activeRunId);
            context.reportUsage(failedTurn.usage);
            const after = await inspect(state.sessionKey, state.agentId, state.activeRunId, context.signal);
            assert.ok(after && after.bindingSha256 === current.bindingSha256 &&
              after.directory === current.directory, "Failure binding changed during accounting");
            const afterProof = await readRuntimeBudgetProof(state.runtimeBudgetDirectory,
              { ...state.budgetExpected, configSha256: pinned.configSha256, settled: true });
            assert.equal(afterProof.ledgerSha256, pinned.ledgerSha256, "Failure proof changed during accounting");
            context.signal.throwIfAborted();
            checkFrames();
            const total = sumUsage(usage, failedTurn.usage);
            const proofs = [...state.proofs, proof];
            const diagnosis = error.diagnosis;
            await ledger(context, { event: "turn_settled", runId: state.activeRunId,
              sessionKey: state.sessionKey, budgetProof: proof,
              nativeSettlement: { directory: state.runtimeBudgetDirectory,
                bindingSha256: after.bindingSha256, nativeSessionId: after.binding.sessionId },
              judgment: { status: "failed", diagnosis } });
            context.signal.throwIfAborted();
            checkFrames();
            const result = {
              executionStatus: "failed", businessResult: "failed", outputText: failedTurn.outputText,
              error: { code: error.code, message: error.message }, diagnosis,
              turns: failedTurns, usage: total, sideEffects: [], controlReceipts,
              delivery: { delivered: true, terminalOutputs: failedTurns.length, recipient: state.sessionKey },
              policyFacts: { mode: failedTurn.mode, adapter: "real-Gateway-not-Feishu" },
              budgetAttestation: { status: "verified", hardLimitsVerified: true, quiescent: true,
                operationalBudget, contextWindow: Math.max(...proofs.map((value) => value.contextWindow)), proofs },
              latencyMs: monotonicNowMs() - startedAt,
            };
            state.proofs = proofs;
            state.usage = total;
            state.activeRunId = undefined;
            state.settled = true;
            fenced = false;
            return result;
          } catch {
            // Retain the first body failure, but never promote unsuccessful recovery to settlement.
            recoveryRejected = true;
          }
        }
        const effects = sideEffects(turns.flatMap((item) => item.tools));
        if (error.preDispatchBudgetBlock && !state.activeRunId && !effects.unknown && !effects.effects.length) {
          state.settled = true;
          state.noWork = turns.length === 0;
          await ledger(context, { event: "configured_budget_blocked", reason: error.message,
            caseId: testCase.id, usage, hardLimitsVerified: false });
          return { executionStatus: "infrastructure_blocked", businessResult: "failed", outputText: "",
            policyFacts: { blockedReason: error.message }, sideEffects: [], usage, turns, controlReceipts,
            budgetAttestation: { status: "unproven", hardLimitsVerified: false, quiescent: true },
            delivery: { delivered: false, terminalOutputs: turns.length, recipient: state.sessionKey } };
        }
        fenced = true;
        state.settled = false;
        if (state.activeRunId && !state.runtimeBudgetDirectory && state.budgetExpected) {
          try {
            const owner = await gateway();
            const history = await request("chat.history", { sessionKey: state.sessionKey, agentId: state.agentId, limit: 1 },
              undefined, 1000);
            assert.equal(history.sessionId, state.hostSessionId, "Failure accounting cannot substitute the owned session");
            const raw = await owner.readTranscript({ sessionKey: state.sessionKey, agentId: state.agentId, sessionId: history.sessionId });
            const boundary = await resolveActiveResetBoundary(raw, history.sessionId);
            state.runtimeBudgetDirectory = join(config.nativeStateDir, hash(boundary.kind === "clear" ? boundary.stateId : history.sessionId));
          } catch { /* A failed lookup cannot establish settlement or release reservations. */ }
        }
        let drained = false;
        if (!error.budgetAccounting && state.activeRunId && state.runtimeBudgetDirectory) {
          try {
            const proof = await readRuntimeBudgetProof(state.runtimeBudgetDirectory, { ...state.budgetExpected, settled: true });
            error.budgetAccounting = { usageStatus: "unknown", observedLowerBound: proof.observedLowerBound, reserved: proof.reserved };
            if (!state.prepareBudget) assert.deepEqual(proof.operationalBudget, state.budgetExpected.operationalBudget,
              "Runtime budget differs from the pinned configured limits");
            const terminal = error.observedTurn?.terminalEvent?.payload;
            const snapshot = await inspect(state.sessionKey, state.agentId, state.activeRunId);
            const binding = snapshot?.binding;
            const executionStatus = observedExecutionStatus(undefined, snapshot?.canonical,
              { ...state.observation, ...error.observedTurn });
            // Provider settlement cannot establish execution or preparation semantics.
            drained = executionStatuses.includes(executionStatus) &&
              preparationModes.includes(binding?.taskPreparation?.state?.mode) && !recoveryRejected && snapshot &&
              await realpath(snapshot.directory) === await realpath(state.runtimeBudgetDirectory) &&
              binding.status === "ready" && binding.lastRunId === state.activeRunId &&
              Array.isArray(binding.consumedRunIds) && binding.consumedRunIds.at(-1) === state.activeRunId &&
              binding.consumedRunIds.filter((id) => id === state.activeRunId).length === 1 &&
              ["budgetFailure", "failureDiagnostic", "pendingCompact"].every((key) => !Object.hasOwn(binding, key)) &&
              proof.quiescent && proof.hardLimitsVerified && !context.signal.aborted && !error.remoteUnsettled &&
              !/abort|timed?\s*out|timeout|fenc/i.test(`${error.name} ${error.code ?? ""} ${error.message}`) &&
              terminal?.state !== "aborted" && !["abort", "aborted", "timeout", "fenced"].includes(terminal?.data?.phase);
          } catch (proofError) {
            if (proofError.budgetAccounting) error.budgetAccounting ??= proofError.budgetAccounting;
          }
        }
        if (state.activeRunId) error.budgetAccounting ??= {
          usageStatus: "unknown", observedLowerBound: { ...zeroUsage(), priced: false },
          ...(state.reservedBudget ? { reserved: { modelRequests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0 } } : {}),
        };
        if (state.activeRunId && state.reservedBudget) error.budgetAccounting.unresolvedExposure = {
          modelRequests: drained ? 0 : state.reservedBudget.maxModelRequests,
          inputTokens: drained ? 0 : state.reservedBudget.maxInputTokens,
          outputTokens: drained ? 0 : state.reservedBudget.maxOutputTokens,
          toolCalls: drained ? 0 : state.reservedBudget.maxToolCalls,
        };
        if (error.budgetAccounting) {
          error.budgetAccounting.observedLowerBound = sumUsage(state.usage,
            error.budgetAccounting.observedLowerBound ?? zeroUsage());
        }
        const failedTurn = state.activeRunId ? failureTurnSummary({ ...state.observation, ...error.observedTurn }) : undefined;
        if (error.observedTurn) error.observedTurn = failureTurnSummary(error.observedTurn);
        error.evidence = {
          executionStatus: failedTurn?.executionStatus ?? "unknown", businessResult: "failed",
          turns: [...turns.map(failureTurnSummary), ...(failedTurn ? [failedTurn] : [])], sideEffects: effects.effects,
          unknownEffects: true, controlReceipts, budgetAccounting: error.budgetAccounting,
          budgetAttestation: { status: "unproven", hardLimitsVerified: false, quiescent: false },
        };
        await ledger(context, { event: "case_failed", caseId: testCase.id, reason: error.message,
          ...(error.diagnosis ? { diagnosis: error.diagnosis } : {}),
          activeRunId: state.activeRunId, sessionKey: state.sessionKey, budgetAccounting: error.budgetAccounting,
          evidence: error.evidence }).catch(() => {});
        throw error;
      }
      } finally {
        clearTimeout(timer);
        busy = false;
        if (campaignLock) {
          await campaignLock.close();
          if (!state || state.settled) await rm(join(context.runDir, "gateway-admission.lock"));
        }
      }
    },
    async cleanupCase(testCase, context) {
      const state = states.get(testCase.id);
      if (!state) return { cleaned: false, error: "No execution/skip receipt for this case" };
      if (state.activeRunId) {
        try {
          await request("chat.abort", { sessionKey: state.sessionKey, runId: state.activeRunId }, undefined, 10000);
          await ledger(context, { event: "abort_requested", sessionKey: state.sessionKey, runId: state.activeRunId });
        } catch (error) {
          return { cleaned: false, quiescent: false, error: `Owned abort unconfirmed: ${error.message}` };
        }
        return { cleaned: false, quiescent: false, receipt: "Abort requested; uncertain turn prevents further work" };
      }
      return state.settled ? { cleaned: true,
        quiescent: state.noWork === true || (state.proofs?.length > 0 && state.proofs.every((proof) => proof.quiescent)),
        receipt: "Owned native turn settled; read-only evidence retained" }
        : { cleaned: false, quiescent: false, error: "Uncertain effects or failed execution require review" };
    },
    async close() {
      if (connection) await connection.client.stopAndWait({ timeoutMs: 10000 });
    },
  };
}

export function createAdapter() {
  return createGatewayAcceptanceAdapter();
}
