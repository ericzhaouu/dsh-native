import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, statSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";

const counters = ["modelRequests", "inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "toolCalls", "userTurns"];
const reservations = ["modelRequests", "inputTokens", "outputTokens", "toolCalls"];
const names = {
  claim: "executor-dispatch.json", process: "executor-process.json",
  started: "executor-started.json", exit: "executor-exit.json",
  fence: "executor-fence.json", log: "executor-child.log",
};
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.length > 0;
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const mismatchCodes = ["GATEWAY_FINAL_CANONICAL_MISMATCH", "GATEWAY_PROJECTED_CANONICAL_MISMATCH"];
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

class ProofError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
function requireProof(condition, reason) {
  if (!condition) throw new ProofError(reason);
}
function unknown(reason, details = {}) {
  return { status: "unknown", accountingComplete: false, quiescent: false,
    outcome: null, reportPath: null, reportSha256: null, ledgerSha256: null, accounting: {},
    ...details, reason };
}
function absolute(value) {
  return text(value) && isAbsolute(value);
}
function childOf(root, child) {
  const rel = relative(root, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function contextSnapshot(value) {
  requireProof(object(value) && text(value.caseId) && text(value.dispatchId) &&
    digest(value.manifestSha256), "invalid-context");
  const result = { caseId: value.caseId, dispatchId: value.dispatchId, manifestSha256: value.manifestSha256 };
  for (const key of ["directory", "manifestPath", "oraclePath", "scopePath", "runRoot"]) {
    requireProof(absolute(value[key]), "invalid-context");
    result[key] = resolve(value[key]);
  }
  requireProof(childOf(result.directory, result.runRoot), "unsafe-run-root");
  return Object.freeze(result);
}
async function realEntry(path, directory = false) {
  const info = await lstat(path);
  requireProof(!info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile()),
    "unsafe-proof-path");
  requireProof(canonical(await realpath(path)) === canonical(path), "unsafe-proof-path");
  if (!directory) requireProof(info.nlink === 1 && info.size <= 32 * 1024 * 1024, "unsafe-proof-file");
  return info;
}
async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    // Windows does not consistently permit opening/fsyncing directories. File fsync is mandatory.
    if (process.platform !== "win32" ||
        !["EPERM", "EACCES", "EISDIR", "EINVAL", "ENOTSUP"].includes(error.code)) throw error;
  } finally { await handle?.close(); }
}
async function writeReceipt(path, value) {
  await realEntry(dirname(path), true);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(dirname(path));
}
async function readBytes(path) {
  const before = await realEntry(path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    requireProof(opened.ino === before.ino && opened.dev === before.dev, "proof-changed");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    requireProof(after.size === before.size && after.mtimeMs === before.mtimeMs &&
      bytes.length === before.size, "proof-changed");
    const current = await realEntry(path);
    requireProof(current.ino === before.ino && current.dev === before.dev &&
      current.size === before.size && current.mtimeMs === before.mtimeMs, "proof-changed");
    return bytes;
  } finally { await handle.close(); }
}
function parseJson(source) {
  const value = JSON.parse(source);
  const stack = [];
  // JSON.parse silently chooses the last duplicate member. Such proofs are ambiguous.
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "{") stack.push(new Set());
    else if (char === "[") stack.push(null);
    else if (char === "}" || char === "]") stack.pop();
    else if (char === '"') {
      const start = index++;
      while (source[index] !== '"') {
        if (source[index] === "\\") index++;
        index++;
      }
      let next = index + 1;
      while (/\s/.test(source[next] ?? "") && next < source.length) next++;
      if (source[next] === ":") {
        const key = JSON.parse(source.slice(start, index + 1));
        requireProof(!stack.at(-1).has(key), "ambiguous-json");
        stack.at(-1).add(key);
      }
    }
  }
  return value;
}
function json(bytes, requireNewline = true) {
  requireProof(!requireNewline || bytes.at(-1) === 10, "truncated-proof");
  return parseJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function jsonLines(bytes) {
  requireProof(bytes.length > 0 && bytes.at(-1) === 10, "truncated-proof");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n").slice(0, -1).map((line) => {
    const value = parseJson(line);
    requireProof(object(value) && text(value.event), "invalid-proof-event");
    return value;
  });
}
function identityValid(value, pid = value?.pid) {
  return object(value) && Number.isSafeInteger(value.pid) && value.pid > 0 &&
    value.pid === pid && text(value.startId);
}
function bound(ms, operation, fallback) {
  let timer;
  const work = Promise.resolve().then(operation);
  return Promise.race([work, new Promise((done) => { timer = setTimeout(() => done(fallback), ms); })])
    .finally(() => clearTimeout(timer));
}
function noExposure(value) {
  requireProof(object(value), "accounting-incomplete");
  for (const key of ["reserved", "outstandingReservations", "unresolvedExposure"]) {
    if (!Object.hasOwn(value, key)) continue;
    const exposure = value[key];
    requireProof(object(exposure) && reservations.every((field) => exposure[field] === 0) &&
      Object.values(exposure).every((amount) => amount === 0), "pending-exposure");
  }
  requireProof(value.unknownEffects !== true && value.liveUnknown !== true &&
    value.aborted !== true && value.pending !== true && !value.error, "pending-exposure");
}
function usage(value) {
  requireProof(object(value) && counters.every((field) => integer(value[field])) &&
    typeof value.priced === "boolean" && (value.priced ? integer(value.currencyMicros) :
      value.currencyMicros === undefined), "accounting-incomplete");
  return value;
}
function sameUsage(a, b) {
  usage(a); usage(b);
  requireProof(counters.every((field) => a[field] === b[field]) && a.priced === b.priced &&
    a.currencyMicros === b.currencyMicros, "accounting-mismatch");
}
function attestation(value, observed) {
  noExposure(value);
  requireProof(value.status === "verified" && value.quiescent === true &&
    value.hardLimitsVerified === true && Number.isSafeInteger(value.contextWindow) &&
    value.contextWindow > 0, "quiescence-unproven");
  const caps = value.operationalBudget;
  requireProof(object(caps) && ["maxModelRequests", "maxInputTokens", "maxOutputTokens", "maxToolCalls", "maxDurationMs"]
    .every((key) => Number.isSafeInteger(caps[key]) && caps[key] > 0) &&
    value.contextWindow <= caps.maxInputTokens, "attestation-incomplete");
  if (observed) requireProof(observed.modelRequests <= caps.maxModelRequests &&
    observed.outputTokens <= caps.maxOutputTokens && observed.toolCalls <= caps.maxToolCalls &&
    observed.inputTokens + observed.cacheReadTokens + observed.cacheWriteTokens <= caps.maxInputTokens,
  "attestation-usage-mismatch");
}
function accountingSection(section, caseId) {
  requireProof(object(section) && ["complete", "not_started"].includes(section.status) &&
    Array.isArray(section.cases), "accounting-incomplete");
  noExposure(section);
  usage(section.completeUsage); usage(section.observedLowerBound);
  requireProof(object(section.cost), "accounting-incomplete");
  if (section.status === "not_started") {
    requireProof(section.cases.length === 0 && section.totals === null &&
      section.cost.status === "not_started" && section.cost.currencyMicros === null &&
      section.cost.observedLowerBoundCurrencyMicros === 0 &&
      [section.completeUsage, section.observedLowerBound].every((value) =>
        counters.every((field) => value[field] === 0) && value.priced === false), "accounting-mismatch");
    return null;
  }
  requireProof(section.cases.length === 1, "accounting-mismatch");
  const entry = section.cases[0];
  requireProof(entry.caseId === caseId && entry.status === "complete" &&
    entry.executionSettled === true && entry.aborted === false, "accounting-incomplete");
  noExposure(entry);
  sameUsage(section.totals, section.completeUsage);
  sameUsage(section.totals, section.observedLowerBound);
  sameUsage(section.totals, entry.observedLowerBound);
  // Unpriced usage has unknown monetary cost, not unknown provider exposure.
  requireProof(section.cost.status === (section.totals.priced ? "complete" : "unknown") &&
    section.cost.currencyMicros === (section.totals.priced ? section.totals.currencyMicros : null) &&
    section.cost.observedLowerBoundCurrencyMicros === (section.totals.currencyMicros ?? 0), "accounting-mismatch");
  requireProof(entry.hardLimits?.status === "adapter-attested", "attestation-incomplete");
  attestation(entry.hardLimits.attestation, entry.observedLowerBound);
  return entry;
}
function cleaned(receipt) {
  noExposure(receipt);
  requireProof(receipt.cleaned === true && receipt.quiescent === true, "cleanup-unproven");
}

function mismatchDiagnosis(value) {
  requireProof(exactKeys(value, ["code", "actual", "canonical", "firstDiffUtf8Byte"]) &&
    mismatchCodes.includes(value.code), "ledger-judgment-invalid");
  for (const identity of [value.actual, value.canonical]) {
    requireProof(exactKeys(identity, ["sha256", "utf8Bytes", "whitespace"]) &&
      digest(identity.sha256) && integer(identity.utf8Bytes) &&
      exactKeys(identity.whitespace, ["leadingUtf8Bytes", "trailingUtf8Bytes", "lf", "cr", "tabs", "spaces"]) &&
      Object.values(identity.whitespace).every((count) => integer(count) && count <= identity.utf8Bytes) &&
      ["lf", "cr", "tabs", "spaces"].reduce((sum, key) => sum + identity.whitespace[key], 0) <= identity.utf8Bytes,
    "ledger-judgment-invalid");
  }
  requireProof(value.actual.sha256 !== value.canonical.sha256 && integer(value.firstDiffUtf8Byte) &&
    value.firstDiffUtf8Byte <= Math.min(value.actual.utf8Bytes, value.canonical.utf8Bytes) &&
    (value.actual.utf8Bytes !== value.canonical.utf8Bytes || value.firstDiffUtf8Byte < value.actual.utf8Bytes),
  "ledger-judgment-invalid");
}
function failedOutcome(report) {
  requireProof(report.passed === false && report.cases[0].outcome === "failed", "failure-outcome-mismatch");
}
function mismatchEvidence(evidence, report) {
  mismatchDiagnosis(evidence.diagnosis);
  requireProof(evidence.executionStatus === "failed" && evidence.businessResult === "failed" &&
    exactKeys(evidence.error, ["code", "message"]) && evidence.error.code === evidence.diagnosis.code &&
    text(evidence.error.message) && Array.isArray(evidence.sideEffects) && evidence.sideEffects.length === 0 &&
    (evidence.corpusGrading === undefined || evidence.corpusGrading?.status === "failed"),
  "ledger-judgment-mismatch");
  failedOutcome(report);
  noExposure({ ...evidence, error: undefined });
}

// Replay native journals locally: importing an adapter would load runner dependencies.
function settledNativeProof(config, journal, receipt, { zeroTools = false } = {}) {
  const reason = zeroTools ? "review-native" : "ledger-native";
  requireProof(config?.version === 1 && journal?.version === 1 &&
    ["runId", "sessionKey", "agentId"].every((key) =>
      text(config[key]) && config[key] === receipt[key] && journal[key] === receipt[key]) &&
    hash(JSON.stringify(config)) === receipt.configSha256 && journal.configSha256 === receipt.configSha256 &&
    isDeepStrictEqual(config.operationalBudget, receipt.operationalBudget) &&
    config.contextWindow === receipt.contextWindow, `${reason}-identity-mismatch`);
  const caps = config.operationalBudget;
  requireProof(exactKeys(caps, ["maxModelRequests", "maxInputTokens", "maxOutputTokens", "maxToolCalls", "maxDurationMs"]) &&
    Object.values(caps).every((value) => integer(value) && value > 0) &&
    integer(config.contextWindow) && config.contextWindow > 0 && config.contextWindow <= caps.maxInputTokens &&
    integer(config.maxTokens) && config.maxTokens > 0 && config.maxTokens <= config.contextWindow &&
    config.maxTokens <= caps.maxOutputTokens, `${reason}-proof-incomplete`);
  const entries = journal.entries;
  requireProof(Array.isArray(entries) && entries.length > 1 && entries.length <= 100000 &&
    entries[0]?.type === "admitted" && integer(entries[0].at), `${reason}-proof-incomplete`);
  const start = entries[0].at;
  const observed = { ...Object.fromEntries(counters.map((key) => [key, 0])), priced: false };
  const pending = new Map();
  const ids = new Set();
  const activeTools = new Set();
  const toolIds = new Set();
  let lastAt = start, inputReserved = 0, outputReserved = 0, settled = false;
  const inputUsed = () => observed.inputTokens + observed.cacheReadTokens + observed.cacheWriteTokens;
  for (const [seq, entry] of entries.entries()) {
    requireProof(object(entry) && entry.seq === seq && integer(entry.at) && entry.at >= lastAt &&
      entry.at <= Date.now() && !settled, `${reason}-proof-incomplete`);
    noExposure(entry);
    lastAt = entry.at;
    if (seq === 0) continue;
    switch (entry.type) {
      case "request_reserved":
        requireProof(entry.at - start < caps.maxDurationMs && text(entry.requestId) && !ids.has(entry.requestId) &&
          ["main", "preparation", "compaction", "maintenance", "review", "retry"].includes(entry.purpose) &&
          entry.inputTokens === config.contextWindow && integer(entry.outputTokens) && entry.outputTokens > 0 &&
          entry.outputTokens <= Math.min(config.maxTokens, caps.maxOutputTokens - observed.outputTokens - outputReserved) &&
          integer(inputUsed() + inputReserved + entry.inputTokens) &&
          inputUsed() + inputReserved + entry.inputTokens <= caps.maxInputTokens &&
          observed.modelRequests < caps.maxModelRequests, `${reason}-budget-mismatch`);
        ids.add(entry.requestId);
        pending.set(entry.requestId, entry);
        observed.modelRequests++;
        inputReserved += entry.inputTokens;
        outputReserved += entry.outputTokens;
        break;
      case "request_settled": {
        const reservation = pending.get(entry.requestId);
        const raw = entry.usage;
        requireProof(reservation && object(raw) &&
          ["input", "output", "cacheRead", "cacheWrite"].every((key) => integer(raw[key])) &&
          integer(raw.input + raw.cacheRead + raw.cacheWrite) &&
          raw.input + raw.cacheRead + raw.cacheWrite <= reservation.inputTokens &&
          raw.output <= reservation.outputTokens, `${reason}-accounting-mismatch`);
        for (const [field, key] of Object.entries({
          inputTokens: "input", outputTokens: "output", cacheReadTokens: "cacheRead", cacheWriteTokens: "cacheWrite",
        })) observed[field] += raw[key];
        inputReserved -= reservation.inputTokens;
        outputReserved -= reservation.outputTokens;
        pending.delete(entry.requestId);
        break;
      }
      case "tool_started":
        requireProof(!zeroTools, `${reason}-unsettled`);
        requireProof(entry.at - start < caps.maxDurationMs && text(entry.callId) && !toolIds.has(entry.callId) &&
          observed.toolCalls < caps.maxToolCalls, `${reason}-budget-mismatch`);
        toolIds.add(entry.callId);
        activeTools.add(entry.callId);
        observed.toolCalls++;
        break;
      case "tool_settled":
        requireProof(!zeroTools && activeTools.delete(entry.callId), `${reason}-unsettled`);
        break;
      case "settled":
        requireProof(entry.providerSettled === true && entry.toolsSettled === true &&
          pending.size === 0 && activeTools.size === 0, `${reason}-unsettled`);
        settled = true;
        break;
      default:
        throw new ProofError(`${reason}-unsettled`);
    }
  }
  requireProof(settled && (!zeroTools || observed.modelRequests > 0), `${reason}-unsettled`);
  attestation({ ...receipt, status: "verified" }, observed);
  return { status: "settled", runId: config.runId, sessionKey: config.sessionKey, agentId: config.agentId,
    operationalBudget: caps, contextWindow: config.contextWindow, configSha256: receipt.configSha256,
    ledgerSha256: hash(JSON.stringify(journal)), entryCount: entries.length,
    usage: observed, observedLowerBound: observed,
    reserved: { inputTokens: inputReserved, outputTokens: outputReserved, modelRequests: 0, toolCalls: 0 },
    usageStatus: "complete", quiescent: true, hardLimitsVerified: true };
}
async function checkReviewerProof(completion, review, caseId, read, absent) {
  const receipt = completion.receipt;
  const directory = receipt.runtimeBudgetDirectory;
  requireProof(typeof completion.text === "string" && absolute(receipt.reviewerProofPath) &&
    canonical(receipt.reviewerProofPath) === canonical(join(directory, "reviewer-proof.json")),
  "review-proof-incomplete");
  await realEntry(directory, true);
  const ownershipDirectory = basename(dirname(directory)) === "budgets" ? dirname(dirname(directory)) : directory;
  for (const path of new Set([directory, ownershipDirectory])) {
    await realEntry(path, true);
    for (const name of ["owner.lock", "source-reply.lock"]) await absent(join(path, name));
  }
  const durable = json(await read(receipt.reviewerProofPath));
  requireProof(durable.version === 1 && durable.caseId === caseId &&
    durable.evidenceSha256 === completion.evidenceSha256 && durable.completionStatus === "complete" &&
    exactKeys(durable.output, ["sha256", "utf8Bytes"]) && digest(durable.output.sha256) &&
    integer(durable.output.utf8Bytes) && isDeepStrictEqual(durable.receipt, receipt) &&
    isDeepStrictEqual(durable.budgetAttestation, review.hardLimits.attestation), "review-proof-mismatch");
  noExposure(durable); cleaned(durable.cleanup);
  sameUsage(durable.usage, completion.usage);
  // The runner redacts completion.text. Only the durable output identity commits to the original bytes.
  const runtimeConfig = json(await read(join(directory, "operational-budget-config.json")), false);
  const journal = json(await read(join(directory, "operational-budget-ledger.json")), false);
  const nativeProof = settledNativeProof(runtimeConfig, journal, receipt, { zeroTools: true });
  requireProof(isDeepStrictEqual(durable.nativeProof, nativeProof), "review-native-proof-mismatch");
  sameUsage(nativeProof.usage, completion.usage);
  const bindingBytes = await read(join(directory, "binding.json"));
  const binding = json(bindingBytes, false);
  requireProof(binding?.status === "ready" && binding.lastRunId === receipt.runId && text(binding.sessionId) &&
    Array.isArray(binding.consumedRunIds) && binding.consumedRunIds.every(text) &&
    binding.consumedRunIds.at(-1) === receipt.runId &&
    binding.consumedRunIds.filter((id) => id === receipt.runId).length === 1 &&
    ["budgetFailure", "failureDiagnostic", "pendingCompact"].every((key) => !Object.hasOwn(binding, key)) &&
    isDeepStrictEqual(durable.binding, { status: "ready", lastRunId: receipt.runId,
      sessionId: binding.sessionId, sha256: hash(bindingBytes) }), "review-binding-mismatch");
  noExposure(binding);
}

async function checkMismatchNativeProof(locator, proof, read, absent) {
  requireProof(exactKeys(locator, ["directory", "bindingSha256", "nativeSessionId"]) &&
    absolute(locator.directory) && digest(locator.bindingSha256) && text(locator.nativeSessionId),
  "ledger-native-locator-invalid");
  const directory = resolve(locator.directory);
  for (let path = locator.directory; ; path = dirname(path)) {
    await realEntry(path, true);
    if (dirname(path) === path) break;
  }
  const parentName = basename(dirname(directory));
  const ownershipDirectory = (process.platform === "win32" ? parentName.toLowerCase() : parentName) === "budgets" ?
    dirname(dirname(directory)) : directory;
  for (const path of new Set([directory, ownershipDirectory])) {
    for (const name of ["owner.lock", "source-reply.lock"]) await absent(join(path, name));
  }
  const bindingBytes = await read(join(directory, "binding.json"));
  const binding = json(bindingBytes, false);
  requireProof(hash(bindingBytes) === locator.bindingSha256 && binding?.sessionId === locator.nativeSessionId &&
    binding.status === "ready" && binding.lastRunId === proof.runId &&
    Array.isArray(binding.consumedRunIds) && binding.consumedRunIds.every(text) &&
    binding.consumedRunIds.at(-1) === proof.runId &&
    binding.consumedRunIds.filter((id) => id === proof.runId).length === 1 &&
    ["budgetFailure", "failureDiagnostic", "pendingCompact"].every((key) => !Object.hasOwn(binding, key)),
  "ledger-native-binding-mismatch");
  noExposure(binding);
  const configBytes = await read(join(directory, "operational-budget-config.json"));
  const journalBytes = await read(join(directory, "operational-budget-ledger.json"));
  requireProof(configBytes.length <= 8 * 1024 * 1024 && journalBytes.length <= 8 * 1024 * 1024,
    "unsafe-proof-file");
  const nativeProof = settledNativeProof(json(configBytes, false), json(journalBytes, false), proof);
  requireProof(isDeepStrictEqual(nativeProof, proof), "ledger-native-proof-mismatch");
}

async function checkGatewayLedger(events, evidence, dut, caseId, report, read, absent) {
  const budgets = new Map();
  const sends = new Map();
  const settlements = new Map();
  const duplicates = new Map();
  const resets = new Map();
  const judgments = new Map();
  let sessionKey;
  let agentId;
  let sessionReceipt = false;
  const session = (value) => {
    requireProof(text(value), "ledger-identity-mismatch");
    sessionKey ??= value;
    requireProof(sessionKey === value, "ledger-identity-mismatch");
  };
  for (const row of events) {
    requireProof(row.caseId === undefined || row.caseId === caseId, "ledger-identity-mismatch");
    requireProof(judgments.size === 0 && (!Object.hasOwn(row, "judgment") || row.event === "turn_settled"),
      "ledger-judgment-invalid");
    requireProof(!Object.hasOwn(row, "nativeSettlement") ||
      (row.event === "turn_settled" && Object.hasOwn(row, "judgment")), "ledger-native-locator-invalid");
    switch (row.event) {
      case "read_only_agent_policy_verified":
      case "read_only_session_planned":
        requireProof(!sessionReceipt && sends.size === 0 && text(row.agentId), "ledger-duplicate");
        session(row.sessionKey); agentId = row.agentId; sessionReceipt = true;
        break;
      case "configured_budget_checked":
      case "runtime_budget_admitted":
        requireProof(text(row.runId) && !budgets.has(row.runId) && !sends.has(row.runId) &&
          sessionReceipt && row.agentId === agentId, "ledger-identity-mismatch");
        if (row.chatSessionKey !== undefined) session(row.chatSessionKey);
        if (row.event === "runtime_budget_admitted") {
          requireProof(row.proof?.status === "admitted" && row.proof.runId === row.runId &&
            row.proof.agentId === agentId && text(row.proof.sessionKey) &&
            row.proof.usageStatus === "complete" && row.proof.quiescent === false &&
            digest(row.proof.configSha256), "ledger-proof-incomplete");
          noExposure(row.proof);
          usage(row.proof.usage);
          requireProof(counters.every((field) => row.proof.usage[field] === 0), "ledger-proof-incomplete");
        }
        budgets.set(row.runId, row);
        break;
      case "send_planned":
        session(row.sessionKey);
        requireProof(row.caseId === caseId && text(row.runId) && budgets.has(row.runId) &&
          !sends.has(row.runId) && row.turn === sends.size + 1 && digest(row.promptSha256) &&
          settlements.size === sends.size, "ledger-duplicate");
        sends.set(row.runId, row);
        break;
      case "duplicate_request_planned":
        session(row.sessionKey);
        requireProof(sends.has(row.runId) && !settlements.has(row.runId) && !duplicates.has(row.runId) &&
          sends.get(row.runId).turn === row.appliesToTurn, "ledger-pending");
        duplicates.set(row.runId, row);
        break;
      case "turn_settled": {
        session(row.sessionKey);
        requireProof(sends.has(row.runId) && !settlements.has(row.runId), "ledger-duplicate");
        const proof = row.budgetProof;
        requireProof(object(proof) && proof.runId === row.runId && proof.agentId === agentId &&
          text(proof.sessionKey) && proof.status === "settled" && proof.usageStatus === "complete" &&
          proof.quiescent === true && proof.hardLimitsVerified === true &&
          digest(proof.configSha256) && digest(proof.ledgerSha256) &&
          Number.isSafeInteger(proof.entryCount) && proof.entryCount > 1 &&
          object(proof.reserved), "ledger-proof-incomplete");
        noExposure(proof); usage(proof.usage);
        attestation({ ...proof, status: "verified" }, proof.usage);
        sameUsage(proof.usage, proof.observedLowerBound);
        const budget = budgets.get(row.runId);
        requireProof(isDeepStrictEqual(budget.proof?.operationalBudget ?? budget.operationalBudget, proof.operationalBudget) &&
          Object.keys(proof.operationalBudget).every((key) => proof.operationalBudget[key] <= budget.operationalBudget?.[key]) &&
          (budget.sessionKey === undefined || budget.sessionKey === proof.sessionKey) &&
          (budget.proof === undefined || (budget.proof.configSha256 === proof.configSha256 &&
            budget.proof.sessionKey === proof.sessionKey)),
        "ledger-identity-mismatch");
        settlements.set(row.runId, proof);
        if (Object.hasOwn(row, "judgment")) {
          requireProof(exactKeys(row.judgment, ["status", "diagnosis"]) && row.judgment.status === "failed",
            "ledger-judgment-invalid");
          mismatchDiagnosis(row.judgment.diagnosis);
          await checkMismatchNativeProof(row.nativeSettlement, proof, read, absent);
          judgments.set(row.runId, row);
        }
        break;
      }
      case "reset_planned":
        session(row.sessionKey);
        requireProof(Number.isSafeInteger(row.afterTurn) && row.afterTurn > 0 &&
          row.afterTurn === sends.size && sends.size === settlements.size &&
          budgets.size === sends.size && !resets.has(row.afterTurn), "ledger-pending");
        resets.set(row.afterTurn, row);
        break;
      default:
        // Abort acknowledgements, failures and unknown future dispatch/cleanup events cannot settle work.
        throw new ProofError("ledger-pending");
    }
  }
  requireProof(sends.size > 0 && budgets.size === sends.size && settlements.size === sends.size,
    "ledger-pending");
  requireProof(Array.isArray(evidence.turns) && evidence.turns.length === sends.size &&
    isDeepStrictEqual(dut.hardLimits.attestation.proofs, [...settlements.values()]), "ledger-report-mismatch");
  if (judgments.size) {
    mismatchEvidence(evidence, report);
    requireProof(isDeepStrictEqual([...judgments.values()][0].judgment.diagnosis, evidence.diagnosis),
      "ledger-judgment-mismatch");
  } else requireProof(evidence.diagnosis === undefined && !mismatchCodes.includes(evidence.error?.code),
    "ledger-judgment-mismatch");
  const totals = Object.fromEntries(counters.map((field) => [field, 0]));
  totals.priced = false;
  for (const [index, turn] of evidence.turns.entries()) {
    const send = [...sends.values()][index];
    const proof = settlements.get(send.runId);
    noExposure(turn);
    requireProof(turn.runId === send.runId && turn.sessionId === proof.sessionKey &&
      turn.delivery?.receiptId === send.runId && turn.delivery?.recipient === sessionKey &&
      turn.delivery?.delivered === true, "ledger-report-mismatch");
    if (judgments.size) {
      requireProof(judgments.has(send.runId) ?
        index === evidence.turns.length - 1 && turn.executionStatus === "failed" && turn.businessResult === "failed" &&
          turn.nativeSessionId === judgments.get(send.runId).nativeSettlement.nativeSessionId &&
          (typeof turn.outputText === "string" || integer(turn.outputCharacters)) :
        ["completed", "correctly_blocked"].includes(turn.executionStatus), "ledger-judgment-mismatch");
    }
    sameUsage(turn.usage, { ...proof.usage, userTurns: 1 });
    requireProof(turn.usage.priced === false, "ledger-proof-incomplete");
    for (const field of counters) totals[field] += turn.usage[field];
  }
  sameUsage(totals, dut.observedLowerBound);
  const controls = evidence.controlReceipts;
  requireProof(Array.isArray(controls) && controls.length === duplicates.size + resets.size,
    "ledger-pending");
  const used = new Set();
  const receiptIds = new Set();
  for (const control of controls) {
    requireProof(control.transportControlled === true && control.selfAsserted === false &&
      text(control.receiptId), "ledger-pending");
    let key;
    if (control.type === "new_context") {
      const reset = resets.get(control.appliesAfterTurn);
      requireProof(reset && control.sessionKey === sessionKey &&
        control.appliesAfterTurn < sends.size, "ledger-pending");
      key = `reset:${control.appliesAfterTurn}`;
    } else if (control.type === "duplicate_inbound_delivery") {
      const duplicate = duplicates.get(control.receiptId);
      requireProof(duplicate && duplicate.appliesToTurn === control.appliesToTurn &&
        duplicate.replaySourceTurn === control.replaySourceTurn &&
        control.dispatchedMessageSha256 === sends.get(control.receiptId).promptSha256, "ledger-pending");
      key = `duplicate:${control.receiptId}`;
    } else throw new ProofError("ledger-pending");
    requireProof(!used.has(key) && !receiptIds.has(control.receiptId), "ledger-duplicate");
    used.add(key); receiptIds.add(control.receiptId);
  }
}

async function auditProofs(config, context, inspectProcess) {
  const details = {};
  try {
    await realEntry(context.directory, true);
    const snapshots = new Map();
    const absences = new Set();
    const read = async (path) => {
      const bytes = await readBytes(path);
      requireProof(!snapshots.has(path) || snapshots.get(path) === hash(bytes), "proof-changed");
      snapshots.set(path, hash(bytes));
      return bytes;
    };
    const absent = async (path) => {
      requireProof(!(await exists(path)), "quiescence-unproven");
      absences.add(path);
    };
    const receipt = async (name) => json(await read(join(context.directory, names[name])));
    const claim = await receipt("claim");
    requireProof(claim.version === 1 && text(claim.attemptId) &&
      isDeepStrictEqual(claim.context, context), "dispatch-receipt-mismatch");
    requireProof(!(await exists(join(context.directory, names.fence))), "executor-fenced");
    absences.add(join(context.directory, names.fence));
    const worker = await receipt("process");
    requireProof(worker.version === 1 && worker.attemptId === claim.attemptId &&
      identityValid(worker.identity), "process-identity-missing");
    const state = await bound(config.runnerTimeoutMs, () => inspectProcess(worker.identity), "unknown");
    // inspectProcess must compare the start ID, not just PID existence. PID reuse means original gone.
    requireProof(state === "gone", state === "alive" ? "process-alive" : "process-state-unknown");
    const started = await receipt("started");
    requireProof(started.version === 1 && started.attemptId === claim.attemptId &&
      isDeepStrictEqual(started.identity, worker.identity), "start-receipt-mismatch");
    const exit = await receipt("exit");
    requireProof(exit.version === 1 && exit.attemptId === claim.attemptId && exit.pid === worker.identity.pid &&
      exit.spawnError === false && exit.signal === null && [0, 1].includes(exit.code),
    "child-exit-unproven");
    const manifest = json(await read(context.manifestPath), false);
    requireProof(snapshots.get(context.manifestPath) === context.manifestSha256 &&
      Array.isArray(manifest.cases) && manifest.cases.length === 1 &&
      manifest.cases[0].id === context.caseId, "manifest-mismatch");
    await realEntry(context.runRoot, true);
    const children = await readdir(context.runRoot);
    requireProof(children.length === 1, "ambiguous-run-directory");
    const runDir = join(context.runRoot, children[0]);
    await realEntry(runDir, true);
    requireProof(!(await exists(join(runDir, "gateway-admission.lock"))), "ledger-pending");
    absences.add(join(runDir, "gateway-admission.lock"));
    details.reportPath = join(runDir, "report.json");
    const report = json(await read(details.reportPath));
    details.reportSha256 = snapshots.get(details.reportPath);
    requireProof(report.runId === basename(runDir) && report.manifestSha256 === context.manifestSha256 &&
      report.suiteId === manifest.suiteId && Array.isArray(report.cases) && report.cases.length === 1 &&
      report.cases[0].id === context.caseId, "report-identity-mismatch");
    requireProof(report.dryRun === false && !["dry-run", "planned"].includes(report.executionKind) &&
      report.executionKind === (manifest.stage ?? "offline") && typeof report.passed === "boolean" &&
      ["passed", "failed", "blocked", "insufficient"].includes(report.cases[0].outcome) &&
      !Object.hasOwn(report, "plannedCases"), "report-not-executed");
    details.outcome = report.cases[0].outcome;
    requireProof(exit.code === (report.passed ? 0 : 1), "child-exit-mismatch");
    requireProof(report.runMetadataVersion === 1 && object(report.budgetAccounting) &&
      Array.isArray(report.connectionCleanupErrors) && report.connectionCleanupErrors.length === 0 &&
      !report.stopReason, "report-incomplete");
    details.accounting = report.budgetAccounting;
    const dut = accountingSection(report.budgetAccounting.dut, context.caseId);
    const review = accountingSection(report.budgetAccounting.review, context.caseId);
    requireProof(!Object.hasOwn(report, "independentReviewUsage") ||
      isDeepStrictEqual(report.independentReviewUsage, report.budgetAccounting.review.totals),
    "accounting-mismatch");
    const trace = jsonLines(await read(join(runDir, "trace.jsonl")));
    const events = (name) => trace.filter((row) => row.event === name);
    const allowed = new Set(["run_started", "run_completed", "case_started", "case_evidence",
      "independent_review_started", "independent_review", "case_preflight_blocked", "case_budget_blocked"]);
    requireProof(trace.every((row) => allowed.has(row.event) &&
      (row.caseId === undefined || row.caseId === context.caseId)) &&
      trace[0].event === "run_started" && trace.at(-1).event === "run_completed" &&
      events("run_started").length === 1 && events("run_completed").length === 1 &&
      trace[0].runId === report.runId && trace[0].manifestSha256 === context.manifestSha256 &&
      trace[0].dryRun === false && trace[0].executionKind === report.executionKind &&
      trace.at(-1).passed === report.passed && !trace.at(-1).stopReason,
    "trace-incomplete");
    for (const [name, count] of [["case_started", dut ? 1 : 0], ["case_evidence", dut ? 1 : 0],
      ["independent_review_started", review ? 1 : 0], ["independent_review", review ? 1 : 0]]) {
      requireProof(events(name).length === count &&
        events(name).every((row) => row.caseId === context.caseId), "trace-accounting-mismatch");
    }
    requireProof(Array.isArray(report.cleanupReceipts) && report.cleanupReceipts.length === (dut ? 1 : 0),
      "cleanup-unproven");
    let evidence;
    if (dut) {
      requireProof(events("case_preflight_blocked").length + events("case_budget_blocked").length === 0,
        "trace-accounting-mismatch");
      const cleanup = report.cleanupReceipts[0];
      requireProof(cleanup.caseId === context.caseId, "cleanup-unproven"); cleaned(cleanup.receipt);
      evidence = events("case_evidence")[0].evidence;
      if (evidence?.diagnosis !== undefined || mismatchCodes.includes(evidence?.error?.code)) {
        mismatchEvidence(evidence, report);
      } else noExposure(evidence);
      cleaned(evidence.cleanup);
      requireProof(isDeepStrictEqual(evidence.cleanup, cleanup.receipt) &&
        isDeepStrictEqual(evidence.budgetAttestation, dut.hardLimits.attestation), "trace-accounting-mismatch");
      sameUsage(evidence.usage, dut.observedLowerBound);
      requireProof(trace.indexOf(events("case_started")[0]) < trace.indexOf(events("case_evidence")[0]),
        "trace-incomplete");
    } else {
      requireProof(!review && events("case_preflight_blocked").length + events("case_budget_blocked").length === 1 &&
        ["blocked", "failed"].includes(details.outcome), "trace-accounting-mismatch");
    }
    const reviewPath = join(runDir, `review-${hash(context.caseId)}.private.json`);
    if (review) {
      requireProof(dut && trace.indexOf(events("case_started")[0]) <
        trace.indexOf(events("independent_review_started")[0]) &&
        trace.indexOf(events("independent_review_started")[0]) <
        trace.indexOf(events("independent_review")[0]) &&
        trace.indexOf(events("independent_review")[0]) < trace.indexOf(events("case_evidence")[0]),
      "trace-incomplete");
      const completion = json(await read(reviewPath));
      requireProof(completion.caseId === context.caseId && digest(completion.evidenceSha256) &&
        completion.receipt?.usageStatus === "complete" && completion.receipt.budgetStatus === "verified" &&
        completion.receipt.quiescent === true && completion.receipt.hardLimitsVerified === true &&
        ["runId", "sessionKey", "agentId"].every((key) => text(completion.receipt[key])) &&
        digest(completion.receipt.configSha256) && absolute(completion.receipt.runtimeBudgetDirectory) &&
        completion.receipt.contextWindow === review.hardLimits.attestation.contextWindow &&
        isDeepStrictEqual(completion.receipt.operationalBudget, review.hardLimits.attestation.operationalBudget),
      "review-proof-incomplete");
      noExposure(completion.receipt);
      sameUsage(completion.usage, review.observedLowerBound);
      sameUsage(events("independent_review")[0].usage, review.observedLowerBound);
      const grading = events("independent_review")[0].grading;
      requireProof(object(grading) && ["passed", "failed", "blocked"].includes(grading.status) &&
        isDeepStrictEqual(grading, evidence.corpusGrading), "review-grading-mismatch");
      if (grading.checks?.some((check) => check.name === "reviewerOutputParsed" && check.status === "failed")) {
        requireProof(grading.status === "failed", "review-grading-mismatch");
      }
      if (grading.status === "failed") failedOutcome(report);
      await checkReviewerProof(completion, review, context.caseId, read, absent);
    } else requireProof(!(await exists(reviewPath)), "trace-accounting-mismatch");
    const ledgerPath = join(runDir, "gateway-acceptance-ledger.jsonl");
    if ((config.live && dut) || await exists(ledgerPath) ||
        evidence?.policyFacts?.adapter === "real-Gateway-not-Feishu" || evidence?.diagnosis !== undefined) {
      const bytes = await read(ledgerPath);
      details.ledgerSha256 = snapshots.get(ledgerPath);
      requireProof(dut !== null, "ledger-accounting-mismatch");
      await checkGatewayLedger(jsonLines(bytes), evidence, dut, context.caseId, report, read, absent);
    }
    requireProof(isDeepStrictEqual(await readdir(context.runRoot), children), "proof-changed");
    for (const [path, sha] of snapshots) requireProof(hash(await readBytes(path)) === sha, "proof-changed");
    for (const path of absences) requireProof(!(await exists(path)), "proof-changed");
    return { ...unknown("complete-proof", details), status: "settled", accountingComplete: true, quiescent: true };
  } catch (error) {
    return unknown(error.reason ?? (error.code === "ENOENT" ? "missing-proof" : "invalid-proof"), details);
  }
}

/**
 * Identity hooks are offline and fail closed by default. startId is a nonempty OS creation-identity
 * string; inspectProcess returns "gone" only for that original identity (including confirmed PID reuse).
 * The caller supplies an existing private directory and a dedicated, initially empty runRoot beneath it.
 */
export function createAcceptanceExecutor(config, { processIdentity = async () => null,
  inspectProcess = async () => "unknown" } = {}) {
  if (!object(config) || typeof config.live !== "boolean" || !object(config.env) ||
      !Number.isSafeInteger(config.runnerTimeoutMs) || config.runnerTimeoutMs <= 0 ||
      config.runnerTimeoutMs > 2147483647 ||
      typeof processIdentity !== "function" || typeof inspectProcess !== "function") {
    throw new TypeError("Explicit env, live, identity hooks and positive runnerTimeoutMs <= 2147483647 are required");
  }
  const settings = { live: config.live, runnerTimeoutMs: config.runnerTimeoutMs,
    env: Object.create(null) };
  for (const key of ["runner", "node", "sourceRoot", "adapter", "reviewer"]) {
    if (!absolute(config[key])) throw new TypeError(`${key} must be absolute`);
    const info = statSync(config[key]);
    if (!(key === "sourceRoot" ? info.isDirectory() : info.isFile())) throw new TypeError(`Invalid ${key}`);
    settings[key] = resolve(config[key]);
  }
  for (const [key, value] of Object.entries(config.env)) {
    if (!key || /[=\0]/.test(key) || typeof value !== "string" || value.includes("\0")) {
      throw new TypeError("env must contain only explicit string environment entries");
    }
    settings.env[key] = value;
  }
  Object.freeze(settings.env); Object.freeze(settings);
  const audit = async (value) => {
    try { return await auditProofs(settings, contextSnapshot(value), inspectProcess); }
    catch (error) { return unknown(error.reason ?? "invalid-context"); }
  };
  const execute = async (value, { onStarted } = {}) => {
    let context;
    let log;
    let child;
    let spawned = false;
    try {
      context = contextSnapshot(value);
      await realEntry(context.directory, true);
      const manifestBytes = await readBytes(context.manifestPath);
      const manifest = json(manifestBytes, false);
      requireProof(hash(manifestBytes) === context.manifestSha256 && manifest.cases?.length === 1 &&
        manifest.cases[0].id === context.caseId, "manifest-mismatch");
      await realEntry(context.oraclePath); await realEntry(context.scopePath);
      const attemptId = randomUUID();
      // The exclusive, fsynced claim is the no-retry fence, including crashes before PID capture.
      await writeReceipt(join(context.directory, names.claim), { version: 1, attemptId, context });
      for (const name of ["process", "started", "exit", "fence", "log"]) {
        requireProof(!(await exists(join(context.directory, names[name]))), "dispatch-already-exists");
      }
      if (!(await exists(context.runRoot))) {
        await mkdir(context.runRoot, { mode: 0o700 });
        await syncDirectory(dirname(context.runRoot));
      }
      await realEntry(context.runRoot, true);
      requireProof((await readdir(context.runRoot)).length === 0, "run-root-not-empty");
      log = await open(join(context.directory, names.log), "wx", 0o600);
      await log.sync(); await syncDirectory(context.directory);
      const argv = [settings.runner, "--manifest", context.manifestPath, "--run-root", context.runRoot,
        "--execute", "--adapter", settings.adapter, "--scope", context.scopePath,
        "--oracles", context.oraclePath, "--reviewer", settings.reviewer,
        ...(settings.live ? ["--live", "--trusted-capable-adapter"] : [])];
      const deadline = performance.now() + settings.runnerTimeoutMs;
      child = spawn(settings.node, argv, { cwd: settings.sourceRoot, env: settings.env,
        detached: true, shell: false, windowsHide: true, stdio: ["ignore", log.fd, log.fd] });
      spawned = true;
      let spawnError = false;
      let childExited = false;
      const exited = new Promise((done) => {
        child.on("error", () => { spawnError = true; });
        child.once("exit", () => { childExited = true; });
        child.once("close", (code, signal) => done({ code, signal, spawnError, pid: child.pid ?? null }));
      }).then(async (exit) => {
        let logSynced = false;
        try {
          await log.sync();
          logSynced = true;
        } catch { /* The exit receipt remains useful even when the diagnostic log cannot be synced. */ }
        finally {
          await log.close().catch(() => {});
          log = undefined;
        }
        try {
          await writeReceipt(join(context.directory, names.exit), { version: 1, attemptId, ...exit });
          return logSynced ? exit : null;
        } catch { return null; }
      });
      const work = async () => {
        try {
          const identity = await processIdentity(child.pid);
          requireProof(identityValid(identity, child.pid), "process-identity-missing");
          requireProof(!childExited, "process-identity-unproven");
          requireProof(performance.now() < deadline, "runner-timeout");
          const pinned = Object.freeze({ pid: identity.pid, startId: identity.startId });
          await writeReceipt(join(context.directory, names.process), { version: 1, attemptId, identity: pinned });
          requireProof(typeof onStarted === "function", "start-callback-missing");
          requireProof(performance.now() < deadline, "runner-timeout");
          await onStarted(pinned);
          requireProof(performance.now() < deadline, "runner-timeout");
          await writeReceipt(join(context.directory, names.started), { version: 1, attemptId, identity: pinned });
        } catch (error) {
          const reason = error.reason ?? "start-identity-or-callback-failed";
          try { await writeReceipt(join(context.directory, names.fence), { version: 1, attemptId, reason }); }
          catch { /* Missing identity/start proof already prevents settlement. */ }
          return unknown(reason);
        }
        const exit = await exited;
        if (!exit) return unknown("exit-receipt-failed");
        if (exit.spawnError) return unknown("spawn-failed");
        if (![0, 1].includes(exit.code) || exit.signal !== null) return unknown("child-exit-unproven");
        return audit(context);
      };
      return await bound(settings.runnerTimeoutMs, work, unknown("runner-timeout"));
    } catch (error) {
      return unknown(error.reason ?? (error.code === "EEXIST" ? "dispatch-already-exists" :
        spawned ? "execution-unknown" : "spawn-or-preparation-failed"));
    } finally {
      child?.unref();
      // A timeout never kills the child or asserts remote quiescence. Its exit listener may still fsync a receipt.
      if (!spawned && log) await log.close().catch(() => {});
    }
  };
  return { execute, audit };
}
