import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import test from "node:test";
import { createAcceptanceExecutor } from "../scripts/lib/acceptance-campaign-executor.mjs";

const root = process.env.DSH_CAMPAIGN_TEST_ROOT;
const skip = !root && "Filesystem tests require explicit DSH_CAMPAIGN_TEST_ROOT";
const digest = (value) => createHash("sha256").update(value).digest("hex");

async function syncDirectory(path) {
  let handle;
  try { handle = await open(path, "r"); await handle.sync(); }
  catch (error) {
    if (process.platform !== "win32" ||
        !["EPERM", "EACCES", "EISDIR", "EINVAL", "ENOTSUP"].includes(error.code)) throw error;
  } finally { await handle?.close(); }
}
async function write(path, value) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(value); await handle.sync(); }
  finally { await handle.close(); }
}

// This tiny child emits the existing runner's on-disk schema; it never imports adapters or uses a network.
async function mockRunner() {
  const { createHash } = await import("node:crypto");
  const { mkdir, open, readFile, symlink } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  const args = process.argv.slice(2);
  const arg = (key) => args[args.indexOf(key) + 1];
  const mode = process.env.MOCK_MODE;
  const root = arg("--run-root");
  const manifestBytes = await readFile(arg("--manifest"));
  const manifest = JSON.parse(manifestBytes);
  const caseId = manifest.cases[0].id;
  const runId = "offline-run";
  async function syncDir(path) {
    let handle;
    try { handle = await open(path, "r"); await handle.sync(); }
    catch (error) {
      if (process.platform !== "win32" ||
          !["EPERM", "EACCES", "EISDIR", "EINVAL", "ENOTSUP"].includes(error.code)) throw error;
    } finally { await handle?.close(); }
  }
  async function save(path, bytes) {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
  }
  async function saveJson(path, value) { await save(path, `${JSON.stringify(value)}\n`); }
  await saveJson(join(root, "..", "mock-invocation.json"), { argv: args, cwd: process.cwd(),
    explicit: process.env.EXPLICIT_VALUE ?? null, ambientAuth: process.env.DSH_EXECUTOR_AMBIENT_AUTH ?? null,
    ambientNodeOptions: process.env.NODE_OPTIONS ?? null });
  if (mode === "timeout") await new Promise((done) => setTimeout(done, 650));
  if (mode === "crash") { process.exitCode = 2; return; }
  const directory = join(root, runId);
  await mkdir(directory, { mode: 0o700 });
  const fields = ["modelRequests", "inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "toolCalls", "userTurns"];
  const zero = () => ({ ...Object.fromEntries(fields.map((key) => [key, 0])), priced: false });
  const budget = { maxModelRequests: 3, maxInputTokens: 100, maxOutputTokens: 100,
    maxToolCalls: 3, maxDurationMs: 500 };
  const measured = { ...zero(), modelRequests: 1, inputTokens: 20, outputTokens: 5,
    toolCalls: mode === "mismatch-tools" ? 2 : 0, userTurns: 1 };
  const proof = { runId: "turn-1", sessionKey: "native-session-1", agentId: "test-agent",
    status: "settled", usageStatus: "complete", quiescent: true, hardLimitsVerified: true,
    operationalBudget: budget, contextWindow: 50, configSha256: sha("config"), ledgerSha256: sha("runtime"),
    entryCount: 4, usage: { ...measured, userTurns: 0 }, observedLowerBound: { ...measured, userTurns: 0 },
    reserved: { modelRequests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0 } };
  const attestation = { status: "verified", hardLimitsVerified: true, quiescent: true,
    operationalBudget: budget, contextWindow: 50, proofs: [proof] };
  const section = () => ({ status: "complete", totals: measured, completeUsage: measured,
    observedLowerBound: measured, cost: { status: "unknown", currencyMicros: null, observedLowerBoundCurrencyMicros: 0 },
    cases: [{ caseId, status: "complete", observedLowerBound: measured, executionSettled: true,
      aborted: false, hardLimits: { status: "adapter-attested", attestation } }] });
  const notStarted = () => ({ status: "not_started", totals: null, completeUsage: zero(),
    observedLowerBound: zero(), cost: { status: "not_started", currencyMicros: null, observedLowerBoundCurrencyMicros: 0 },
    cases: [] });
  const cleanup = { cleaned: true, quiescent: true };
  const mismatch = mode.startsWith("mismatch-");
  const parseFailed = mode.endsWith("review-parse-failed");
  const passed = mode !== "ordinary-fail" && mode !== "not-started" && !mismatch && !parseFailed;
  const report = { version: 2, suiteId: manifest.suiteId, runId, manifestSha256: sha(manifestBytes),
    executionKind: "live", dryRun: false, passed, cases: [{ id: caseId, outcome: passed ? "passed" : "failed" }],
    runMetadataVersion: 1, budgetAccounting: { dut: section(), review: notStarted() },
    connectionCleanupErrors: [], cleanupReceipts: [{ caseId, receipt: cleanup }] };
  const sessionKey = "agent:test-agent:acceptance-offline";
  const evidence = { usage: measured, cleanup, budgetAttestation: attestation,
    executionStatus: "completed", businessResult: "partial", sideEffects: [],
    policyFacts: { adapter: "real-Gateway-not-Feishu" }, controlReceipts: [],
    turns: [{ runId: "turn-1", sessionId: "native-session-1", usage: measured,
      executionStatus: "completed", businessResult: "partial", outputText: "actual output",
      delivery: { delivered: true, receiptId: "turn-1", recipient: sessionKey } }] };
  const ledger = [
    { event: "read_only_agent_policy_verified", agentId: "test-agent", sessionKey },
    { event: "configured_budget_checked", runId: "turn-1", agentId: "test-agent", operationalBudget: budget,
      chatSessionKey: sessionKey, hardLimitsVerified: false, budgetStatus: "unproven" },
    { event: "send_planned", runId: "turn-1", caseId, turn: 1, sessionKey, promptSha256: sha("prompt") },
    { event: "turn_settled", runId: "turn-1", sessionKey, budgetProof: proof },
  ];
  const trace = [
    { event: "run_started", runId, manifestSha256: report.manifestSha256, dryRun: false, executionKind: "live" },
    { event: "case_started", caseId },
    { event: "case_evidence", caseId, evidence },
    { event: "run_completed", passed },
  ];
  if (mode === "pending-send") ledger.pop();
  if (mode === "pending-reset") ledger.push({ event: "reset_planned", sessionKey, afterTurn: 1 });
  if (mode === "pending-duplicate") {
    ledger.pop();
    ledger.push({ event: "duplicate_request_planned", runId: "turn-1", sessionKey, appliesToTurn: 1 });
  }
  if (mode === "complete-duplicate") {
    ledger.splice(3, 0, { event: "duplicate_request_planned", runId: "turn-1", sessionKey, appliesToTurn: 1 });
    evidence.controlReceipts.push({ type: "duplicate_inbound_delivery", appliesToTurn: 1, receiptId: "turn-1",
      transportControlled: true, selfAsserted: false, dispatchedMessageSha256: sha("prompt") });
  }
  if (mode === "complete-reset" || mode === "mismatch-multi") {
    const second = { ...proof, runId: "turn-2", sessionKey: "native-session-2" };
    ledger.push({ event: "reset_planned", sessionKey, afterTurn: 1 },
      { ...ledger[1], runId: "turn-2", sessionKey: "native-session-2" },
      { ...ledger[2], runId: "turn-2", turn: 2 },
      { ...ledger[3], runId: "turn-2", budgetProof: second });
    evidence.turns.push({ ...evidence.turns[0], runId: "turn-2", sessionId: "native-session-2",
      delivery: { delivered: true, receiptId: "turn-2", recipient: sessionKey } });
    attestation.proofs.push(second);
    evidence.controlReceipts.push({ type: "new_context", appliesAfterTurn: 1, receiptId: "reset-1",
      transportControlled: true, selfAsserted: false, sessionKey });
    const total = { ...zero(), ...Object.fromEntries(fields.map((key) => [key, measured[key] * 2])) };
    const section = report.budgetAccounting.dut;
    section.totals = section.completeUsage = section.observedLowerBound = section.cases[0].observedLowerBound = total;
    evidence.usage = total;
  }
  if (mismatch) {
    const settledRow = ledger.at(-1);
    const proof = settledRow.budgetProof;
    const nativeDirectory = mode === "mismatch-budget-directory" ?
      join(directory, "native-dut", "budgets", proof.runId) : join(directory, "native-dut");
    await mkdir(nativeDirectory, { recursive: true, mode: 0o700 });
    const budgetIdentity = { runId: proof.runId, sessionKey: proof.sessionKey, agentId: proof.agentId };
    const runtimeConfig = { version: 1, ...budgetIdentity, operationalBudget: budget, contextWindow: 50, maxTokens: 25 };
    const entries = [
      { at: 100, type: "admitted" },
      { at: 101, type: "request_reserved", requestId: "request-1", purpose: "main", inputTokens: 50, outputTokens: 25 },
      { at: 102, type: "request_settled", requestId: "request-1", usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 } },
      ...(mode === "mismatch-tools" ? [
        { at: 103, type: "tool_started", callId: "tool-1" },
        { at: 104, type: "tool_started", callId: "tool-2" },
        { at: 700, type: "tool_settled", callId: "tool-2" },
        { at: 701, type: "tool_settled", callId: "tool-1" },
      ] : []),
      { at: 702, type: "settled", providerSettled: true, toolsSettled: true },
    ].map((entry, seq) => ({ seq, ...entry }));
    const journal = { version: 1, ...budgetIdentity, configSha256: sha(JSON.stringify(runtimeConfig)), entries };
    const binding = { status: "ready", lastRunId: proof.runId, sessionId: "dut-native-session-1",
      consumedRunIds: ["prior-run", proof.runId] };
    const bindingBytes = JSON.stringify(binding);
    Object.assign(proof, { configSha256: journal.configSha256, ledgerSha256: sha(JSON.stringify(journal)),
      entryCount: entries.length });
    settledRow.nativeSettlement = { directory: nativeDirectory, bindingSha256: sha(bindingBytes),
      nativeSessionId: binding.sessionId };
    evidence.turns.at(-1).nativeSessionId = binding.sessionId;
    await save(join(nativeDirectory, "operational-budget-config.json"), JSON.stringify(runtimeConfig));
    await save(join(nativeDirectory, "operational-budget-ledger.json"), JSON.stringify(journal));
    await save(join(nativeDirectory, "binding.json"), bindingBytes);
    await syncDir(nativeDirectory);
    const actual = mode === "mismatch-projected" ? "  actual output\r\n\t" : "actual output \n";
    const canonical = "actual output";
    const identity = (value) => ({
      sha256: sha(value), utf8Bytes: Buffer.byteLength(value),
      whitespace: { leadingUtf8Bytes: Buffer.byteLength(value.match(/^\s*/u)[0]),
        trailingUtf8Bytes: Buffer.byteLength(value.match(/\s*$/u)[0]),
        lf: (value.match(/\n/g) ?? []).length, cr: (value.match(/\r/g) ?? []).length,
        tabs: (value.match(/\t/g) ?? []).length, spaces: (value.match(/ /g) ?? []).length },
    });
    const code = mode === "mismatch-projected" ? "GATEWAY_PROJECTED_CANONICAL_MISMATCH" : "GATEWAY_FINAL_CANONICAL_MISMATCH";
    const diagnosis = { code, actual: identity(actual), canonical: identity(canonical),
      firstDiffUtf8Byte: mode === "mismatch-projected" ? 0 : Buffer.byteLength(canonical) };
    Object.assign(evidence, { executionStatus: "failed", businessResult: "failed", diagnosis,
      error: { code, message: "Output differs from canonical text" }, outputText: actual });
    Object.assign(evidence.turns.at(-1), { executionStatus: "failed", businessResult: "failed", outputText: actual });
    ledger.at(-1).judgment = { status: "failed", diagnosis };
    if (mode === "mismatch-trimmed") {
      evidence.outputText = `[omitted ${actual.length} chars]`;
      evidence.turns.at(-1).outputCharacters = actual.length;
      delete evidence.turns.at(-1).outputText;
    }
  }
  if (mode === "runtime-admitted" || mode === "pending-admission") {
    proof.operationalBudget = { ...budget, maxModelRequests: 2 };
    ledger[1] = { event: "runtime_budget_admitted", runId: "turn-1", agentId: "test-agent",
      operationalBudget: budget, proof: { ...proof, status: "admitted", quiescent: false,
        hardLimitsVerified: false, entryCount: 1, usage: zero(), observedLowerBound: zero() } };
    if (mode === "pending-admission") ledger.splice(2);
  }
  if (mode === "pending-cleanup") ledger.push({ event: "abort_requested", sessionKey, runId: "turn-1" });
  if (mode === "duplicate-id") ledger.splice(3, 0, ledger[2]);
  if (mode === "wrong-ledger-case") ledger[2].caseId = "another-case";
  if (mode === "wrong-ledger-session") ledger[3].sessionKey = "another-session";
  if (mode === "wrong-proof-session") proof.sessionKey = "another-native-session";
  if (mode === "unknown-event") ledger.push({ event: "cleanup_planned", sessionKey });
  if (mode === "wrong-case") report.cases[0].id = "another-case";
  if (mode === "wrong-hash") report.manifestSha256 = sha("wrong");
  if (mode === "wrong-run") report.runId = "another-run";
  if (mode === "dry-run") report.dryRun = true;
  if (mode === "planned") report.executionKind = "planned";
  if (mode === "unknown-accounting") report.budgetAccounting.dut.status = "unknown";
  if (mode === "missing-accounting") delete report.budgetAccounting;
  if (mode === "pending-exposure") report.budgetAccounting.dut.cases[0].unresolvedExposure =
    { modelRequests: 1, inputTokens: 0, outputTokens: 0, toolCalls: 0 };
  if (mode === "bad-cleanup") cleanup.quiescent = false;
  if (mode === "unattested") attestation.quiescent = false;
  if (mode === "connection-pending") report.connectionCleanupErrors = ["close timed out"];
  if (mode === "wrong-accounting-total") report.budgetAccounting.dut.totals = { ...measured, inputTokens: 0 };
  if (mode === "over-attested-usage") attestation.operationalBudget = { ...budget, maxModelRequests: 0 };
  if (mode === "review-hidden") trace.splice(2, 0, { event: "independent_review_started", caseId });
  if (["review-complete", "review-parse-failed", "review-budget-directory"].includes(mode) ||
      mode.startsWith("mismatch-review-")) {
    const nativeDirectory = mode === "review-budget-directory" ?
      join(directory, "native-review", "budgets", "review-run-1") : join(directory, "native-review");
    await mkdir(nativeDirectory, { recursive: true, mode: 0o700 });
    const reviewUsage = { ...measured, userTurns: 0, inputTokens: 12, cacheReadTokens: 5, cacheWriteTokens: 3 };
    const reviewAttestation = { status: "verified", quiescent: true, hardLimitsVerified: true,
      operationalBudget: budget, contextWindow: 50 };
    const runtimeConfig = { version: 1, runId: "review-run-1", sessionKey: "review-host-session-1", agentId: "reviewer",
      operationalBudget: budget, contextWindow: 50, maxTokens: 25 };
    const identity = { runId: runtimeConfig.runId, sessionKey: runtimeConfig.sessionKey, agentId: runtimeConfig.agentId };
    const journal = { version: 1, ...identity, configSha256: sha(JSON.stringify(runtimeConfig)),
      entries: [
        { seq: 0, at: 100, type: "admitted" },
        { seq: 1, at: 101, type: "request_reserved", requestId: "request-1", purpose: "review", inputTokens: 50, outputTokens: 25 },
        { seq: 2, at: 102, type: "request_settled", requestId: "request-1", usage: { input: 12, output: 5, cacheRead: 5, cacheWrite: 3 } },
        { seq: 3, at: 700, type: "settled", providerSettled: true, toolsSettled: true },
      ] };
    const nativeProof = { status: "settled", ...identity, operationalBudget: budget, contextWindow: 50,
      configSha256: journal.configSha256, ledgerSha256: sha(JSON.stringify(journal)), entryCount: journal.entries.length,
      usage: reviewUsage, observedLowerBound: reviewUsage,
      reserved: { inputTokens: 0, outputTokens: 0, modelRequests: 0, toolCalls: 0 },
      usageStatus: "complete", quiescent: true, hardLimitsVerified: true };
    const binding = { status: "ready", lastRunId: identity.runId, sessionId: "review-native-session-1",
      consumedRunIds: [identity.runId] };
    const bindingBytes = JSON.stringify(binding);
    const proofPath = join(nativeDirectory, "reviewer-proof.json");
    const receipt = { budgetStatus: "verified", usageStatus: "complete", quiescent: true, hardLimitsVerified: true,
      ...identity, configSha256: journal.configSha256, runtimeBudgetDirectory: nativeDirectory,
      contextWindow: 50, operationalBudget: budget, reviewerProofPath: proofPath };
    const text = parseFailed ? "not-json private@example.invalid" :
      '{"submissionId":"answer","businessResult":"passed"}\n';
    const grading = { status: parseFailed || mismatch ? "failed" : "passed",
      checks: [{ name: mismatch ? "executionBusinessResult" : "reviewerOutputParsed",
        status: parseFailed || mismatch ? "failed" : "passed" }] };
    evidence.corpusGrading = grading;
    report.budgetAccounting.review = { ...section(), totals: reviewUsage, completeUsage: reviewUsage,
      observedLowerBound: reviewUsage, cases: [{ ...section().cases[0], observedLowerBound: reviewUsage,
        hardLimits: { status: "adapter-attested", attestation: reviewAttestation } }] };
    report.independentReviewUsage = reviewUsage;
    trace.splice(2, 0, { event: "independent_review_started", caseId },
      { event: "independent_review", caseId, usage: reviewUsage, grading });
    await saveJson(join(directory, `review-${sha(caseId)}.private.json`), {
      caseId, evidenceSha256: sha("evidence"), text: text.replace("private@example.invalid", "[redacted-email]"),
      usage: reviewUsage, receipt,
    });
    await saveJson(proofPath, { version: 1, caseId, evidenceSha256: sha("evidence"), completionStatus: "complete",
      output: { sha256: sha(text), utf8Bytes: Buffer.byteLength(text) }, usage: reviewUsage, receipt,
      budgetAttestation: reviewAttestation, cleanup, nativeProof,
      binding: { status: "ready", lastRunId: binding.lastRunId, sessionId: binding.sessionId, sha256: sha(bindingBytes) } });
    await save(join(nativeDirectory, "operational-budget-config.json"), JSON.stringify(runtimeConfig));
    await save(join(nativeDirectory, "operational-budget-ledger.json"), JSON.stringify(journal));
    await save(join(nativeDirectory, "binding.json"), bindingBytes);
    await syncDir(nativeDirectory);
  }
  if (mode === "not-started") {
    report.budgetAccounting.dut = notStarted();
    report.cleanupReceipts = [];
    trace.splice(1, 2, { event: "case_preflight_blocked", caseId, reason: "no authorization" });
  }
  if (mode === "extra-run") await mkdir(join(root, "second-run"), { mode: 0o700 });
  if (mode === "admission-lock") await save(join(directory, "gateway-admission.lock"), "owned\n");
  if (mode !== "missing-ledger" && mode !== "not-started") {
    let bytes = ledger.map((row) => JSON.stringify(row)).join("\n") + "\n";
    if (mode === "truncated-ledger") bytes = bytes.slice(0, -1);
    if (mode === "ambiguous-ledger") bytes = bytes.replace('"event":"turn_settled"',
      '"event":"abort_requested","event":"turn_settled"');
    await save(join(directory, "gateway-acceptance-ledger.jsonl"), bytes);
  }
  if (mode !== "missing-report") {
    let bytes = JSON.stringify(report) + "\n";
    if (mode === "ambiguous-report") bytes = bytes.replace('"dryRun":false', '"dryRun":true,"dryRun":false');
    await save(join(directory, "report.json"), mode === "truncated-report" ? bytes.slice(0, -5) : bytes);
  }
  await save(join(directory, "trace.jsonl"), trace.map((row) => JSON.stringify(row)).join("\n") +
    (mode === "truncated-trace" ? "" : "\n"));
  if (mode === "mismatch-future-journal") {
    const path = join(ledger.at(-1).nativeSettlement.directory, "operational-budget-ledger.json");
    const journal = JSON.parse(await readFile(path, "utf8"));
    journal.entries.push({ seq: journal.entries.length, at: 703, type: "tool_started", callId: "future-tool" });
    const file = await open(path, "w");
    try { await file.writeFile(JSON.stringify(journal)); await file.sync(); }
    finally { await file.close(); }
  }
  if (mode === "mismatch-retained-lock") {
    await save(join(ledger.at(-1).nativeSettlement.directory, "owner.lock"), "owned\n");
  }
  if (mode === "run-symlink") {
    // A directory junction needs no Windows symlink privilege.
    const { rename } = await import("node:fs/promises");
    const destination = join(root, "..", "redirected-run");
    await rename(directory, destination);
    await symlink(destination, directory, process.platform === "win32" ? "junction" : "dir");
  } else await syncDir(directory);
  await syncDir(root);
  console.log("offline child finished");
  process.exitCode = mode === "abnormal-exit" ? 7 : passed ? 0 : 1;
}

async function fixture(t, mode = "complete", overrides = {}) {
  assert.ok(isAbsolute(root), "DSH_CAMPAIGN_TEST_ROOT must be absolute");
  const rootStat = await lstat(root);
  assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink());
  const directory = await mkdtemp(join(resolve(root), "acceptance-executor-"));
  const children = new Set();
  t.after(async () => {
    // Only known fixture PIDs are observed; no process killing or production inspection.
    for (const pid of children) {
      await waitFor(async () => {
        try { process.kill(pid, 0); return false; }
        catch (error) { if (error.code === "ESRCH") return true; throw error; }
      }, 10000);
    }
    await waitFor(async () => {
      try { await rm(directory, { recursive: true }); return true; }
      catch (error) { if (["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code)) return false; throw error; }
    }, 5000);
  });
  const runner = join(directory, "mock-runner.mjs");
  const adapter = join(directory, "adapter.mjs");
  const reviewer = join(directory, "reviewer.mjs");
  await write(runner, `await (${mockRunner.toString()})();\n`);
  await write(adapter, 'throw new Error("adapter must never be imported by executor");\n');
  await write(reviewer, 'throw new Error("reviewer must never be imported by executor");\n');
  const manifestBytes = JSON.stringify({ suiteId: "offline-executor", stage: "live", cases: [{ id: "case-alpha" }] }) + "\n";
  const context = { caseId: "case-alpha", dispatchId: "dispatch-1", directory,
    manifestPath: join(directory, "manifest.json"), oraclePath: join(directory, "oracles.json"),
    scopePath: join(directory, "scope.json"), runRoot: join(directory, "runs"), manifestSha256: digest(manifestBytes) };
  await write(context.manifestPath, manifestBytes);
  await write(context.oraclePath, "{}\n");
  await write(context.scopePath, "{}\n");
  await syncDirectory(directory);
  const config = { runner, node: process.execPath, sourceRoot: directory, adapter, reviewer, live: true,
    env: { MOCK_MODE: mode, EXPLICIT_VALUE: "only-explicit" }, runnerTimeoutMs: 10000, ...overrides };
  const identities = new Map();
  let starts = 0;
  const hooks = {
    async processIdentity(pid) {
      if (!Number.isSafeInteger(pid)) return null;
      children.add(pid);
      const identity = { pid, startId: `offline-fixture-${pid}` };
      identities.set(pid, identity.startId);
      return identity;
    },
    async inspectProcess(identity) {
      assert.equal(identities.get(identity.pid), identity.startId);
      try { process.kill(identity.pid, 0); return "alive"; }
      catch (error) { return error.code === "ESRCH" ? "gone" : "unknown"; }
    },
  };
  const executor = createAcceptanceExecutor(config, hooks);
  const onStarted = async (identity) => {
    assert.equal(identities.get(identity.pid), identity.startId);
    starts++;
  };
  return { context, config, hooks, executor, onStarted, children, starts: () => starts };
}
async function waitFor(predicate, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.fail("Timed out awaiting offline fixture");
}
async function waitForExit(f) {
  await waitFor(async () => {
    try { JSON.parse(await readFile(join(f.context.directory, "executor-exit.json"), "utf8")); return true; }
    catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return false; throw error; }
  }, 10000);
}

async function proofDocuments(f, review = false) {
  const directory = join(f.context.runRoot, "offline-run");
  const paths = { report: join(directory, "report.json"), trace: join(directory, "trace.jsonl"),
    ledger: join(directory, "gateway-acceptance-ledger.jsonl") };
  const documents = {};
  const load = async (key) => {
    const bytes = await readFile(paths[key], "utf8");
    documents[key] = key === "trace" || key === "ledger" ?
      bytes.trimEnd().split("\n").map((line) => JSON.parse(line)) : JSON.parse(bytes);
  };
  for (const key of Object.keys(paths)) await load(key);
  if (review) {
    paths.completion = join(directory, `review-${digest(f.context.caseId)}.private.json`);
    await load("completion");
    const receipt = documents.completion.receipt;
    Object.assign(paths, { durable: receipt.reviewerProofPath,
      config: join(receipt.runtimeBudgetDirectory, "operational-budget-config.json"),
      journal: join(receipt.runtimeBudgetDirectory, "operational-budget-ledger.json"),
      binding: join(receipt.runtimeBudgetDirectory, "binding.json") });
    for (const key of ["durable", "config", "journal", "binding"]) await load(key);
  }
  return { paths, ...documents };
}
async function replaceDocuments(documents) {
  for (const [key, path] of Object.entries(documents.paths)) {
    const bytes = key === "trace" || key === "ledger" ?
      documents[key].map((row) => JSON.stringify(row)).join("\n") + "\n" : JSON.stringify(documents[key]);
    const file = await open(path, "w");
    try { await file.writeFile(bytes + (["report", "completion", "durable"].includes(key) ? "\n" : "")); await file.sync(); }
    finally { await file.close(); }
  }
}
async function mismatchDocuments(f) {
  const documents = await proofDocuments(f);
  const directory = documents.ledger.at(-1).nativeSettlement.directory;
  for (const [key, name] of Object.entries({ config: "operational-budget-config.json",
    journal: "operational-budget-ledger.json", binding: "binding.json" })) {
    documents.paths[key] = join(directory, name);
    documents[key] = JSON.parse(await readFile(documents.paths[key], "utf8"));
  }
  return documents;
}
function pinMismatchProof(documents, patch = {}) {
  Object.assign(documents.ledger.at(-1).budgetProof, patch);
  for (const attestation of [documents.report.budgetAccounting.dut.cases[0].hardLimits.attestation,
    caseEvidence(documents).budgetAttestation]) {
    Object.assign(attestation.proofs.at(-1), patch);
  }
}
function pinMismatchJournal(documents) {
  pinMismatchProof(documents, { ledgerSha256: digest(JSON.stringify(documents.journal)),
    entryCount: documents.journal.entries.length });
}
function pinMismatchConfig(documents) {
  documents.journal.configSha256 = digest(JSON.stringify(documents.config));
  pinMismatchProof(documents, { configSha256: documents.journal.configSha256 });
  pinMismatchJournal(documents);
}
function pinMismatchBinding(documents) {
  documents.ledger.at(-1).nativeSettlement.bindingSha256 = digest(JSON.stringify(documents.binding));
}
function pinJournal(documents) {
  documents.durable.nativeProof.ledgerSha256 = digest(JSON.stringify(documents.journal));
  documents.durable.nativeProof.entryCount = documents.journal.entries.length;
}
function pinBinding(documents) {
  documents.durable.binding.sha256 = digest(JSON.stringify(documents.binding));
}
function caseEvidence(documents) {
  return documents.trace.find((row) => row.event === "case_evidence").evidence;
}

test("real detached child uses exact argv, cwd and explicit environment; audit is offline and immutable", { skip }, async (t) => {
  const key = "DSH_EXECUTOR_AMBIENT_AUTH";
  const old = process.env[key];
  process.env[key] = "DO-NOT-INHERIT";
  t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  const f = await fixture(t);
  f.config.env.EXPLICIT_VALUE = "mutated-after-construction";
  const result = await f.executor.execute(f.context, { onStarted: f.onStarted });
  assert.equal(result.status, "settled", JSON.stringify(result));
  assert.equal(result.accountingComplete, true);
  assert.equal(result.quiescent, true);
  assert.equal(result.outcome, "passed");
  assert.equal(f.starts(), 1);
  assert.equal(result.reportSha256, digest(await readFile(result.reportPath)));
  assert.equal(result.ledgerSha256, digest(await readFile(join(f.context.runRoot, "offline-run", "gateway-acceptance-ledger.jsonl"))));
  const invocation = JSON.parse(await readFile(join(f.context.directory, "mock-invocation.json")));
  assert.equal(invocation.cwd, f.config.sourceRoot);
  assert.equal(invocation.explicit, "only-explicit");
  assert.equal(invocation.ambientAuth, null);
  assert.equal(invocation.ambientNodeOptions, null);
  assert.deepEqual(invocation.argv, ["--manifest", f.context.manifestPath, "--run-root", f.context.runRoot,
    "--execute", "--adapter", f.config.adapter, "--scope", f.context.scopePath, "--oracles", f.context.oraclePath,
    "--reviewer", f.config.reviewer, "--live", "--trusted-capable-adapter"]);
  const saved = await readFile(join(f.context.directory, "executor-exit.json"));
  const before = await readdir(f.context.directory);
  assert.deepEqual(await f.executor.audit(f.context), result);
  assert.deepEqual(await readdir(f.context.directory), before);
  const duplicate = await f.executor.execute(f.context, { onStarted: f.onStarted });
  assert.equal(duplicate.status, "unknown");
  assert.equal(duplicate.reason, "dispatch-already-exists");
  assert.equal(f.starts(), 1);
  assert.deepEqual(await readFile(join(f.context.directory, "executor-exit.json")), saved);
  if (process.platform !== "win32") {
    for (const name of ["executor-child.log", "executor-process.json", "executor-exit.json"]) {
      assert.equal((await stat(join(f.context.directory, name))).mode & 0o777, 0o600);
    }
    assert.equal((await stat(f.context.runRoot)).mode & 0o777, 0o700);
  }
});

for (const mode of ["ordinary-fail", "complete-duplicate", "complete-reset", "runtime-admitted", "review-complete",
  "review-parse-failed", "review-budget-directory", "mismatch-final", "mismatch-projected", "mismatch-multi",
  "mismatch-trimmed", "mismatch-tools", "mismatch-budget-directory",
  "mismatch-review-complete", "mismatch-review-parse-failed", "not-started"]) {
  test(`${mode} retains proven accounting and permits settlement`, { skip }, async (t) => {
    const f = await fixture(t, mode);
    const result = await f.executor.execute(f.context, { onStarted: f.onStarted });
    assert.equal(result.status, "settled", JSON.stringify(result));
    assert.equal(result.accountingComplete, true);
    assert.equal(result.quiescent, true);
    if (mode === "ordinary-fail" || mode === "review-parse-failed" || mode.startsWith("mismatch-")) {
      assert.equal(result.outcome, "failed");
    }
    assert.deepEqual(await f.executor.audit(f.context), result);
    if (mode.startsWith("mismatch-")) {
      const p = await mismatchDocuments(f);
      const settledRow = p.ledger.at(-1);
      assert.equal(settledRow.nativeSettlement.bindingSha256, digest(await readFile(p.paths.binding)));
      assert.equal(settledRow.budgetProof.configSha256, digest(JSON.stringify(p.config)));
      assert.equal(settledRow.budgetProof.ledgerSha256, digest(JSON.stringify(p.journal)));
      assert.equal(caseEvidence(p).turns.at(-1).nativeSessionId, settledRow.nativeSettlement.nativeSessionId);
      if (mode === "mismatch-tools") assert.equal(result.accounting.dut.totals.toolCalls, 2);
    }
    if (mode === "review-parse-failed") {
      const completion = JSON.parse(await readFile(join(f.context.runRoot, "offline-run",
        `review-${digest(f.context.caseId)}.private.json`)));
      const durable = JSON.parse(await readFile(completion.receipt.reviewerProofPath));
      assert.notEqual(digest(completion.text), durable.output.sha256, "redacted text is not the original output");
      assert.equal(result.accounting.review.totals.modelRequests, 1);
      assert.equal(result.accounting.review.totals.userTurns, 0);
    }
  });
}
for (const mode of ["pending-send", "pending-reset", "pending-duplicate", "pending-cleanup",
  "duplicate-id", "wrong-ledger-case", "wrong-ledger-session", "wrong-proof-session", "unknown-event",
  "missing-ledger", "truncated-ledger", "wrong-case", "wrong-hash", "wrong-run", "dry-run", "planned",
  "unknown-accounting", "missing-accounting", "pending-exposure", "bad-cleanup", "unattested",
  "connection-pending", "wrong-accounting-total", "over-attested-usage", "review-hidden", "extra-run", "admission-lock",
  "pending-admission", "ambiguous-ledger", "ambiguous-report",
  "missing-report", "truncated-report", "truncated-trace", "run-symlink", "crash", "abnormal-exit",
  "mismatch-future-journal", "mismatch-retained-lock"]) {
  test(`${mode} fails closed without accounting recovery`, { skip }, async (t) => {
    const f = await fixture(t, mode);
    const result = await f.executor.execute(f.context, { onStarted: f.onStarted });
    assert.equal(result.status, "unknown", JSON.stringify(result));
    assert.equal(result.quiescent, false);
    assert.equal(result.accountingComplete, false);
    const audited = await f.executor.audit(f.context);
    assert.equal(audited.status, "unknown");
    await waitForExit(f);
    assert.equal(f.starts(), 1);
  });
}

const judgmentMutations = {
  "missing judgment": (p) => { delete p.ledger.at(-1).judgment; },
  "unknown judgment status": (p) => { p.ledger.at(-1).judgment.status = "passed"; },
  "null judgment": (p) => { p.ledger.at(-1).judgment = null; },
  "extra judgment metadata": (p) => { p.ledger.at(-1).judgment.pending = true; },
  "judgment on admission": (p) => { p.ledger[1].judgment = p.ledger.at(-1).judgment; },
  "unknown diagnosis": (p) => { p.ledger.at(-1).judgment.diagnosis.code = "GATEWAY_TIMEOUT"; },
  "extra diagnosis metadata": (p) => { p.ledger.at(-1).judgment.diagnosis.unknownEffects = true; },
  "invalid digest": (p) => { p.ledger.at(-1).judgment.diagnosis.actual.sha256 = "not-a-digest"; },
  "negative byte count": (p) => { p.ledger.at(-1).judgment.diagnosis.actual.utf8Bytes = -1; },
  "fractional whitespace": (p) => { p.ledger.at(-1).judgment.diagnosis.actual.whitespace.spaces = 1.5; },
  "impossible whitespace": (p) => { p.ledger.at(-1).judgment.diagnosis.actual.whitespace.lf = 100; },
  "missing whitespace": (p) => { delete p.ledger.at(-1).judgment.diagnosis.canonical.whitespace; },
  "identical hashes": (p) => { p.ledger.at(-1).judgment.diagnosis.actual.sha256 = p.ledger.at(-1).judgment.diagnosis.canonical.sha256; },
  "out of bounds difference": (p) => { p.ledger.at(-1).judgment.diagnosis.firstDiffUtf8Byte = 100; },
  "negative difference": (p) => { p.ledger.at(-1).judgment.diagnosis.firstDiffUtf8Byte = -1; },
  "evidence diagnosis substitution": (p) => { caseEvidence(p).diagnosis.firstDiffUtf8Byte = 0; },
  "evidence error substitution": (p) => { caseEvidence(p).error.code = "GATEWAY_TIMEOUT"; },
  "evidence passed": (p) => { caseEvidence(p).businessResult = "passed"; },
  "corpus grading passed": (p) => { caseEvidence(p).corpusGrading = { status: "passed" }; },
  "failed turn passed": (p) => { caseEvidence(p).turns.at(-1).executionStatus = "completed"; },
  "failed turn usage missing": (p) => { delete caseEvidence(p).turns.at(-1).usage; },
  "failed turn wrong run": (p) => { caseEvidence(p).turns.at(-1).runId = "other"; },
  "failed turn wrong session": (p) => { caseEvidence(p).turns.at(-1).sessionId = "other"; },
  "failed turn not delivered": (p) => { caseEvidence(p).turns.at(-1).delivery.delivered = false; },
  "report case passed": (p) => { p.report.cases[0].outcome = "passed"; },
  "unknown effects": (p) => { caseEvidence(p).unknownEffects = true; },
  "side effects": (p) => { caseEvidence(p).sideEffects.push({ type: "write" }); },
  "pending exposure": (p) => { caseEvidence(p).unresolvedExposure = { modelRequests: 1 }; },
  "duplicate settlement": (p) => { p.ledger.push(p.ledger.at(-1)); },
  "pending duplicate": (p) => { p.ledger.splice(-1, 0, { event: "duplicate_request_planned",
    runId: "turn-1", sessionKey: p.ledger.at(-1).sessionKey, appliesToTurn: 1 }); },
  "unknown event": (p) => { p.ledger.push({ event: "future_dispatch" }); },
  "unsafe case_failed": (p) => { p.ledger.push({ event: "case_failed", usageStatus: "unknown" }); },
};
for (const [name, mutate] of Object.entries(judgmentMutations)) {
  test(`settled mismatch rejects ${name}`, { skip }, async (t) => {
    const f = await fixture(t, "mismatch-trimmed");
    assert.equal((await f.executor.execute(f.context, { onStarted: f.onStarted })).status, "settled");
    const documents = await proofDocuments(f);
    mutate(documents);
    await replaceDocuments(documents);
    const result = await f.executor.audit(f.context);
    assert.equal(result.status, "unknown", JSON.stringify(result));
    assert.equal(result.accountingComplete, false);
    assert.equal(result.quiescent, false);
    assert.equal(f.starts(), 1);
  });
}

const mismatchNativeMutations = {
  "missing locator": (p) => { delete p.ledger.at(-1).nativeSettlement; },
  "null locator": (p) => { p.ledger.at(-1).nativeSettlement = null; },
  "extra locator key": (p) => { p.ledger.at(-1).nativeSettlement.quiescent = true; },
  "relative directory": (p) => { p.ledger.at(-1).nativeSettlement.directory = "native-dut"; },
  "missing directory": (p) => { delete p.ledger.at(-1).nativeSettlement.directory; },
  "invalid binding digest": (p) => { p.ledger.at(-1).nativeSettlement.bindingSha256 = "invalid"; },
  "missing native session": (p) => { delete p.ledger.at(-1).nativeSettlement.nativeSessionId; },
  "empty native session": (p) => { p.ledger.at(-1).nativeSettlement.nativeSessionId = ""; },
  "locator on admission": (p) => { p.ledger[1].nativeSettlement = p.ledger.at(-1).nativeSettlement; },
  "missing evidence native session": (p) => { delete caseEvidence(p).turns.at(-1).nativeSessionId; },
  "wrong evidence native session": (p) => { caseEvidence(p).turns.at(-1).nativeSessionId = "other"; },
  "wrong binding digest": (p) => { p.ledger.at(-1).nativeSettlement.bindingSha256 = digest("other binding"); },
  "cross-native-session binding": (p) => { p.binding.sessionId = "other"; pinMismatchBinding(p); },
  "cross-run binding": (p) => { p.binding.lastRunId = "other"; pinMismatchBinding(p); },
  "changed binding bytes": (p) => { p.binding.extra = true; },
  "unfinished binding": (p) => { p.binding.status = "running"; pinMismatchBinding(p); },
  "budget failure": (p) => { p.binding.budgetFailure = null; pinMismatchBinding(p); },
  "failure diagnostic": (p) => { p.binding.failureDiagnostic = false; pinMismatchBinding(p); },
  "pending compaction": (p) => { p.binding.pendingCompact = null; pinMismatchBinding(p); },
  "binding pending exposure": (p) => { p.binding.pending = true; pinMismatchBinding(p); },
  "missing consumed runs": (p) => { delete p.binding.consumedRunIds; pinMismatchBinding(p); },
  "empty consumed runs": (p) => { p.binding.consumedRunIds = []; pinMismatchBinding(p); },
  "invalid consumed runs": (p) => { p.binding.consumedRunIds.unshift(null); pinMismatchBinding(p); },
  "duplicate consumed run": (p) => { p.binding.consumedRunIds.push(p.binding.lastRunId); pinMismatchBinding(p); },
  "newer consumed run": (p) => { p.binding.consumedRunIds.push("newer"); pinMismatchBinding(p); },
  "unversioned config": (p) => { p.config.version = 2; pinMismatchConfig(p); },
  "cross-run config": (p) => { p.config.runId = "other"; pinMismatchConfig(p); },
  "cross-session config": (p) => { p.config.sessionKey = "other"; pinMismatchConfig(p); },
  "cross-agent config": (p) => { p.config.agentId = "other"; pinMismatchConfig(p); },
  "changed config": (p) => { p.config.maxTokens = 26; },
  "different native caps": (p) => { p.config.operationalBudget.maxToolCalls++; pinMismatchConfig(p); },
  "different context window": (p) => { p.config.contextWindow--; pinMismatchConfig(p); },
  "zero max tokens": (p) => { p.config.maxTokens = 0; pinMismatchConfig(p); },
  "fractional max tokens": (p) => { p.config.maxTokens = 25.5; pinMismatchConfig(p); },
  "max tokens above context": (p) => { p.config.maxTokens = 51; pinMismatchConfig(p); },
  "extra proof field": (p) => { pinMismatchProof(p, { extra: true }); },
  "wrong proof entry count": (p) => { pinMismatchProof(p, { entryCount: 100 }); },
  "wrong proof ledger hash": (p) => { pinMismatchProof(p, { ledgerSha256: digest("other ledger") }); },
  "unversioned journal": (p) => { p.journal.version = 2; pinMismatchJournal(p); },
  "cross-run journal": (p) => { p.journal.runId = "other"; pinMismatchJournal(p); },
  "cross-session journal": (p) => { p.journal.sessionKey = "other"; pinMismatchJournal(p); },
  "cross-agent journal": (p) => { p.journal.agentId = "other"; pinMismatchJournal(p); },
  "wrong journal config hash": (p) => { p.journal.configSha256 = digest("other config"); pinMismatchJournal(p); },
  "missing admission": (p) => { p.journal.entries[0].type = "settled"; pinMismatchJournal(p); },
  "missing sequence": (p) => { p.journal.entries[1].seq = 10; pinMismatchJournal(p); },
  "negative journal time": (p) => { p.journal.entries[0].at = -1; pinMismatchJournal(p); },
  "decreasing journal time": (p) => { p.journal.entries[2].at = 100; pinMismatchJournal(p); },
  "future journal time": (p) => { p.journal.entries.at(-1).at = Date.now() + 3600000; pinMismatchJournal(p); },
  "unfinished journal": (p) => { p.journal.entries.pop(); pinMismatchJournal(p); },
  "fenced journal": (p) => { p.journal.entries.at(-1).type = "fenced"; pinMismatchJournal(p); },
  "unknown journal event": (p) => { p.journal.entries[1].type = "future_dispatch"; pinMismatchJournal(p); },
  "unproven provider settlement": (p) => { p.journal.entries.at(-1).providerSettled = false; pinMismatchJournal(p); },
  "unproven tool settlement": (p) => { p.journal.entries.at(-1).toolsSettled = false; pinMismatchJournal(p); },
  "continued terminal": (p) => { p.journal.entries.push({ ...p.journal.entries.at(-1), seq: 4 }); pinMismatchJournal(p); },
  "pending provider": (p) => {
    p.journal.entries.splice(2, 1); p.journal.entries[2].seq = 2; pinMismatchJournal(p);
  },
  "missing provider reservation": (p) => { p.journal.entries[2].requestId = "other"; pinMismatchJournal(p); },
  "duplicate provider request": (p) => {
    p.journal.entries.splice(3, 0, { ...p.journal.entries[1], seq: 3, at: 103 });
    p.journal.entries[4].seq = 4; pinMismatchJournal(p);
  },
  "unknown usage": (p) => { delete p.journal.entries[2].usage.cacheWrite; pinMismatchJournal(p); },
  "negative usage": (p) => { p.journal.entries[2].usage.input = -1; pinMismatchJournal(p); },
  "fractional usage": (p) => { p.journal.entries[2].usage.input = 0.5; pinMismatchJournal(p); },
  "native accounting drift": (p) => { p.journal.entries[2].usage.input--; pinMismatchJournal(p); },
  "unsafe input sum": (p) => {
    p.journal.entries[2].usage.input = Number.MAX_SAFE_INTEGER;
    p.journal.entries[2].usage.cacheRead = 1; pinMismatchJournal(p);
  },
  "aggregate input above reservation": (p) => { p.journal.entries[2].usage.cacheRead = 31; pinMismatchJournal(p); },
  "output above reservation": (p) => { p.journal.entries[2].usage.output = 26; pinMismatchJournal(p); },
  "nominal input reservation": (p) => { p.journal.entries[1].inputTokens = 20; pinMismatchJournal(p); },
  "unclipped output reservation": (p) => { p.journal.entries[1].outputTokens = 26; pinMismatchJournal(p); },
  "late provider admission": (p) => {
    p.journal.entries[1].at = 600; p.journal.entries[2].at = 601; pinMismatchJournal(p);
  },
  "unknown request purpose": (p) => { p.journal.entries[1].purpose = "unknown"; pinMismatchJournal(p); },
};
for (const [name, mutate] of Object.entries(mismatchNativeMutations)) {
  test(`recovered mismatch requires native proof: ${name}`, { skip }, async (t) => {
    const f = await fixture(t, "mismatch-final");
    assert.equal((await f.executor.execute(f.context, { onStarted: f.onStarted })).status, "settled");
    const p = await mismatchDocuments(f);
    mutate(p);
    await replaceDocuments(p);
    const result = await createAcceptanceExecutor(f.config, f.hooks).audit(f.context);
    assert.equal(result.status, "unknown", JSON.stringify(result));
    assert.equal(result.accountingComplete, false);
    assert.equal(result.quiescent, false);
    assert.equal(f.starts(), 1);
  });
}

const mismatchToolMutations = {
  "pending tool": (p) => { p.journal.entries.splice(5, 1); },
  "unadmitted tool": (p) => { p.journal.entries[5].callId = "other"; },
  "duplicate tool admission": (p) => { p.journal.entries[4].callId = "tool-1"; },
  "duplicate tool settlement": (p) => { p.journal.entries[6].callId = "tool-2"; },
  "missing tool identity": (p) => { delete p.journal.entries[3].callId; },
  "late tool admission": (p) => { p.journal.entries[3].at = 600; p.journal.entries[4].at = 601; },
  "exhausted tool budget": (p) => {
    p.journal.entries.splice(5, 0, { at: 105, type: "tool_started", callId: "tool-3" },
      { at: 106, type: "tool_started", callId: "tool-4" },
      { at: 107, type: "tool_settled", callId: "tool-3" },
      { at: 108, type: "tool_settled", callId: "tool-4" });
  },
};
for (const [name, mutate] of Object.entries(mismatchToolMutations)) {
  test(`recovered mismatch rejects ${name}`, { skip }, async (t) => {
    const f = await fixture(t, "mismatch-tools");
    assert.equal((await f.executor.execute(f.context, { onStarted: f.onStarted })).status, "settled");
    const p = await mismatchDocuments(f);
    mutate(p);
    p.journal.entries.forEach((entry, seq) => { entry.seq = seq; });
    pinMismatchJournal(p);
    await replaceDocuments(p);
    const result = await f.executor.audit(f.context);
    assert.equal(result.status, "unknown", JSON.stringify(result));
    assert.match(result.reason, /^ledger-native-(budget-mismatch|unsettled)$/);
    assert.equal(result.accountingComplete, false);
    assert.equal(result.quiescent, false);
  });
}

for (const key of ["binding", "config", "journal"]) {
  for (const kind of ["missing", "directory", "hardlink", "ambiguous-json", "truncated-json", "oversized"]) {
    test(`recovered mismatch rejects ${kind} native ${key}`, { skip }, async (t) => {
      const f = await fixture(t, "mismatch-final");
      assert.equal((await f.executor.execute(f.context, { onStarted: f.onStarted })).status, "settled");
      const p = await mismatchDocuments(f);
      const path = p.paths[key];
      if (kind === "hardlink") await link(path, join(f.context.directory, `linked-${key}.json`));
      else {
        await rm(path);
        if (kind === "directory") await mkdir(path);
        else if (kind !== "missing") {
          const bytes = JSON.stringify(p[key]);
          const limit = key === "binding" ? 32 : 8;
          await write(path, kind === "ambiguous-json" ? `{"ambiguous":1,"ambiguous":2,${bytes.slice(1)}` :
            kind === "oversized" ? bytes + " ".repeat(limit * 1024 * 1024) : bytes.slice(0, -1));
        }
      }
      const result = await f.executor.audit(f.context);
      assert.equal(result.status, "unknown", JSON.stringify(result));
      assert.equal(result.accountingComplete, false);
      assert.equal(result.quiescent, false);
    });
  }
}
for (const kind of ["directory-junction", "ancestor-junction", "aliased-ancestor"]) {
  test(`recovered mismatch rejects native ${kind}`, { skip }, async (t) => {
    const f = await fixture(t, "mismatch-budget-directory");
    assert.equal((await f.executor.execute(f.context, { onStarted: f.onStarted })).status, "settled");
    const p = await mismatchDocuments(f);
    const directory = kind === "directory-junction" ? p.ledger.at(-1).nativeSettlement.directory :
      join(f.context.runRoot, "offline-run", "native-dut");
    const target = join(f.context.directory, "redirected-native");
    if (kind === "aliased-ancestor") {
      await symlink(directory, target, process.platform === "win32" ? "junction" : "dir");
      p.ledger.at(-1).nativeSettlement.directory = join(target, "budgets", "turn-1");
      await replaceDocuments(p);
    } else {
      await rename(directory, target);
      await symlink(target, directory, process.platform === "win32" ? "junction" : "dir");
    }
    const result = await f.executor.audit(f.context);
    assert.equal(result.reason, "unsafe-proof-path", JSON.stringify(result));
    assert.equal(result.accountingComplete, false);
    assert.equal(result.quiescent, false);
  });
}
for (const level of ["runtime", "ownership"]) {
  for (const name of ["owner.lock", "source-reply.lock"]) {
    test(`recovered mismatch rejects ${level} ${name} on resume audit`, { skip }, async (t) => {
      const f = await fixture(t, "mismatch-budget-directory");
      assert.equal((await f.executor.execute(f.context, { onStarted: f.onStarted })).status, "settled");
      const p = await mismatchDocuments(f);
      const directory = level === "runtime" ? p.ledger.at(-1).nativeSettlement.directory :
        join(f.context.runRoot, "offline-run", "native-dut");
      await write(join(directory, name), "owned\n");
      const result = await createAcceptanceExecutor(f.config, f.hooks).audit(f.context);
      assert.equal(result.reason, "quiescence-unproven");
      assert.equal(result.accountingComplete, false);
      assert.equal(result.quiescent, false);
      assert.equal((await f.executor.execute(f.context, { onStarted: f.onStarted })).reason, "dispatch-already-exists");
      assert.equal(f.starts(), 1);
    });
  }
}
for (const alias of ["trailing-dot", "parent-traversal", ...(process.platform === "win32" ? ["case-variant"] : [])]) {
  for (const name of ["owner.lock", "source-reply.lock"]) {
    test(`recovered mismatch checks ownership ${name} through ${alias} locator`, { skip }, async (t) => {
      const f = await fixture(t, "mismatch-budget-directory");
      assert.equal((await f.executor.execute(f.context, { onStarted: f.onStarted })).status, "settled");
      const p = await mismatchDocuments(f);
      const locator = p.ledger.at(-1).nativeSettlement;
      locator.directory = alias === "trailing-dot" ? `${locator.directory}${sep}.` :
        alias === "parent-traversal" ? `${locator.directory}${sep}..${sep}turn-1` :
        locator.directory.replace(`${sep}budgets${sep}`, `${sep}BUDGETS${sep}`);
      await replaceDocuments(p);
      assert.equal((await f.executor.audit(f.context)).status, "settled");
      await write(join(f.context.runRoot, "offline-run", "native-dut", name), "owned\n");
      const result = await createAcceptanceExecutor(f.config, f.hooks).audit(f.context);
      assert.equal(result.reason, "quiescence-unproven", JSON.stringify(result));
      assert.equal(result.accountingComplete, false);
      assert.equal(result.quiescent, false);
    });
  }
}

test("recovered mismatch hashes actual binding bytes and replays immutable native snapshots on resume", { skip }, async (t) => {
  const f = await fixture(t, "mismatch-tools");
  assert.equal((await f.executor.execute(f.context, { onStarted: f.onStarted })).status, "settled");
  const p = await mismatchDocuments(f);
  const bindingBytes = JSON.stringify(p.binding, null, 2) + "\n";
  p.ledger.at(-1).nativeSettlement.bindingSha256 = digest(bindingBytes);
  await replaceDocuments(p);
  await rm(p.paths.binding);
  await write(p.paths.binding, bindingBytes);
  const before = await Promise.all(Object.values(p.paths).map((path) => readFile(path)));
  const executor = createAcceptanceExecutor(f.config, f.hooks);
  const result = await executor.audit(f.context);
  assert.equal(result.status, "settled", JSON.stringify(result));
  assert.deepEqual(await executor.audit(f.context), result);
  assert.deepEqual(await Promise.all(Object.values(p.paths).map((path) => readFile(path))), before);
  // A newer native journal must invalidate the captured proof, not mutate its snapshot.
  const journalBytes = JSON.stringify({ ...p.journal, entries: [...p.journal.entries,
    { seq: p.journal.entries.length, at: 703, type: "request_reserved", requestId: "future",
      purpose: "main", inputTokens: 50, outputTokens: 25 }] });
  await rm(p.paths.journal);
  await write(p.paths.journal, journalBytes);
  const rejected = await executor.audit(f.context);
  assert.equal(rejected.status, "unknown", JSON.stringify(rejected));
  assert.equal(rejected.accountingComplete, false);
  assert.equal(rejected.quiescent, false);
  assert.equal(await readFile(p.paths.journal, "utf8"), journalBytes);
  assert.deepEqual(await readFile(p.paths.ledger), before[2]);
  assert.equal((await executor.execute(f.context, { onStarted: f.onStarted })).reason, "dispatch-already-exists");
  assert.equal(f.starts(), 1);
});

const reviewMutations = {
  "unfinished completion": (p) => { p.durable.completionStatus = "unfinished"; },
  "unversioned proof": (p) => { p.durable.version = 2; },
  "cross-case proof": (p) => { p.durable.caseId = "other-case"; },
  "cross-evidence proof": (p) => { p.durable.evidenceSha256 = digest("other evidence"); },
  "invalid output hash": (p) => { p.durable.output.sha256 = "invalid"; },
  "invalid output bytes": (p) => { p.durable.output.utf8Bytes = -1; },
  "missing output receipt": (p) => { delete p.durable.output; },
  "missing completion text": (p) => { delete p.completion.text; },
  "cross-run receipt": (p) => { p.durable.receipt.runId = "other-run"; },
  "cross-session receipt": (p) => { p.durable.receipt.sessionKey = "other-session"; },
  "cross-agent receipt": (p) => { p.durable.receipt.agentId = "other-agent"; },
  "cross-config receipt": (p) => { p.durable.receipt.configSha256 = digest("other config"); },
  "cross-run native config": (p) => { p.config.runId = "other-run"; },
  "cross-session native config": (p) => { p.config.sessionKey = "other-session"; },
  "cross-agent native config": (p) => { p.config.agentId = "other-agent"; },
  "cross-session ledger": (p) => { p.journal.sessionKey = "other-session"; pinJournal(p); },
  "changed native config": (p) => { p.config.maxTokens = 26; },
  "mismatched native proof": (p) => { p.durable.nativeProof.ledgerSha256 = digest("other journal"); },
  "incomplete native proof": (p) => { p.durable.nativeProof.quiescent = false; },
  "unproven cleanup": (p) => { p.durable.cleanup.quiescent = false; },
  "unproven attestation": (p) => { p.durable.budgetAttestation.hardLimitsVerified = false; },
  "underreported usage": (p) => { p.durable.usage.inputTokens--; },
  "native accounting drift": (p) => { p.journal.entries[2].usage.cacheRead++; pinJournal(p); },
  "unknown native usage": (p) => { delete p.journal.entries[2].usage.cacheWrite; pinJournal(p); },
  "negative native usage": (p) => { p.journal.entries[2].usage.input = -1; pinJournal(p); },
  "aggregate input over reservation": (p) => { p.journal.entries[2].usage.cacheRead = 45; pinJournal(p); },
  "output over reservation": (p) => { p.journal.entries[2].usage.output = 26; pinJournal(p); },
  "nominal input reservation": (p) => { p.journal.entries[1].inputTokens = 20; pinJournal(p); },
  "unclipped output reservation": (p) => { p.journal.entries[1].outputTokens = 26; pinJournal(p); },
  "late admission": (p) => { p.journal.entries[1].at = 601; p.journal.entries[2].at = 602; pinJournal(p); },
  "unknown request purpose": (p) => { p.journal.entries[1].purpose = "unknown"; pinJournal(p); },
  "missing reservation": (p) => { p.journal.entries[2].requestId = "unreserved"; pinJournal(p); },
  "pending request": (p) => { p.journal.entries.splice(2, 1); p.journal.entries[2].seq = 2; pinJournal(p); },
  "unfinished journal": (p) => { p.journal.entries.pop(); pinJournal(p); },
  "fenced journal": (p) => { p.journal.entries.at(-1).type = "fenced"; pinJournal(p); },
  "unknown journal event": (p) => { p.journal.entries[1].type = "unknown"; pinJournal(p); },
  "tool admission": (p) => { p.journal.entries[1].type = "tool_started"; p.journal.entries[1].callId = "tool-1"; pinJournal(p); },
  "duplicate terminal": (p) => { p.journal.entries.push({ ...p.journal.entries.at(-1), seq: 4 }); pinJournal(p); },
  "duplicate request": (p) => { p.journal.entries.splice(3, 0, { ...p.journal.entries[1], seq: 3, at: 103 });
    p.journal.entries[4].seq = 4; pinJournal(p); },
  "cross-run binding": (p) => { p.binding.lastRunId = "other"; pinBinding(p); },
  "cross-native-session binding": (p) => { p.binding.sessionId = "other"; pinBinding(p); },
  "changed binding bytes": (p) => { p.binding.extra = true; },
  "unfinished binding": (p) => { p.binding.status = "running"; pinBinding(p); },
  "fenced binding": (p) => { p.binding.budgetFailure = {}; pinBinding(p); },
  "failure diagnostic binding": (p) => { p.binding.failureDiagnostic = null; pinBinding(p); },
  "pending compaction": (p) => { p.binding.pendingCompact = false; pinBinding(p); },
  "missing consumed run": (p) => { p.binding.consumedRunIds = []; pinBinding(p); },
  "duplicate consumed run": (p) => { p.binding.consumedRunIds.push(p.binding.lastRunId); pinBinding(p); },
  "newer consumed run": (p) => { p.binding.consumedRunIds.push("newer"); pinBinding(p); },
  "passed report for parse failure": (p) => { p.report.cases[0].outcome = "passed"; },
  "passed evidence for parse failure": (p) => { caseEvidence(p).corpusGrading.status = "passed"; },
  "passed grading with failed parse check": (p) => {
    caseEvidence(p).corpusGrading.status = "passed";
    p.trace.find((row) => row.event === "independent_review").grading.status = "passed";
  },
};
for (const [name, mutate] of Object.entries(reviewMutations)) {
  test(`durable parse-failed review rejects ${name}`, { skip }, async (t) => {
    const f = await fixture(t, "review-parse-failed");
    assert.equal((await f.executor.execute(f.context, { onStarted: f.onStarted })).status, "settled");
    const documents = await proofDocuments(f, true);
    mutate(documents);
    await replaceDocuments(documents);
    const result = await f.executor.audit(f.context);
    assert.equal(result.status, "unknown", JSON.stringify(result));
    assert.equal(result.accountingComplete, false);
    assert.equal(result.quiescent, false);
    assert.equal(f.starts(), 1);
  });
}

test("durable reviewer still rejects fully settled, exactly accounted native tools", { skip }, async (t) => {
  const f = await fixture(t, "review-complete");
  assert.equal((await f.executor.execute(f.context, { onStarted: f.onStarted })).status, "settled");
  const p = await proofDocuments(f, true);
  p.journal.entries.splice(3, 0, { seq: 3, at: 103, type: "tool_started", callId: "review-tool" },
    { seq: 4, at: 104, type: "tool_settled", callId: "review-tool" });
  p.journal.entries.at(-1).seq = 5;
  for (const usage of [p.durable.nativeProof.usage, p.durable.nativeProof.observedLowerBound,
    p.durable.usage, p.completion.usage, p.report.budgetAccounting.review.totals,
    p.report.budgetAccounting.review.completeUsage, p.report.budgetAccounting.review.observedLowerBound,
    p.report.budgetAccounting.review.cases[0].observedLowerBound, p.report.independentReviewUsage,
    p.trace.find((row) => row.event === "independent_review").usage]) usage.toolCalls = 1;
  pinJournal(p);
  await replaceDocuments(p);
  const result = await f.executor.audit(f.context);
  assert.equal(result.reason, "review-native-unsettled", JSON.stringify(result));
  assert.equal(result.accountingComplete, false);
  assert.equal(result.quiescent, false);
});

for (const mode of ["review-complete", "review-parse-failed"]) {
  for (const key of ["completion", "durable", "config", "journal", "binding"]) {
    test(`${mode} requires durable ${key} file`, { skip }, async (t) => {
      const f = await fixture(t, mode);
      assert.equal((await f.executor.execute(f.context, { onStarted: f.onStarted })).status, "settled");
      const documents = await proofDocuments(f, true);
      await rm(documents.paths[key]);
      const result = await f.executor.audit(f.context);
      assert.equal(result.reason, "missing-proof");
      assert.equal(result.accountingComplete, false);
    });
  }
}
for (const mode of ["review-parse-failed", "review-budget-directory"]) {
  for (const name of ["owner.lock", "source-reply.lock"]) {
    test(`${mode} rejects retained ${name}`, { skip }, async (t) => {
      const f = await fixture(t, mode);
      assert.equal((await f.executor.execute(f.context, { onStarted: f.onStarted })).status, "settled");
      const documents = await proofDocuments(f, true);
      const directory = join(f.context.runRoot, "offline-run", "native-review");
      await write(join(directory, name), "owned\n");
      const result = await f.executor.audit(f.context);
      assert.equal(result.reason, "quiescence-unproven");
      assert.equal(result.accountingComplete, false);
      assert.equal(result.quiescent, false);
      assert.ok(documents.durable.nativeProof.quiescent, "a stale receipt alone cannot establish quiescence");
    });
  }
}
for (const kind of ["junction", "hardlink", "wrong-path", "ambiguous-json", "truncated-proof"]) {
  test(`durable reviewer rejects ${kind} proof path or bytes`, { skip }, async (t) => {
    const f = await fixture(t, "review-parse-failed");
    assert.equal((await f.executor.execute(f.context, { onStarted: f.onStarted })).status, "settled");
    const p = await proofDocuments(f, true);
    if (kind === "junction") {
      const directory = p.completion.receipt.runtimeBudgetDirectory;
      const target = join(f.context.directory, "redirected-review");
      await rename(directory, target);
      await symlink(target, directory, process.platform === "win32" ? "junction" : "dir");
    } else if (kind === "hardlink") {
      await link(p.paths.durable, join(f.context.directory, "hardlinked-review.json"));
    } else if (kind === "wrong-path") {
      const path = join(f.context.directory, "different-reviewer-proof.json");
      await write(path, await readFile(p.paths.durable));
      p.completion.receipt.reviewerProofPath = path;
      await replaceDocuments(p);
    } else {
      const bytes = await readFile(p.paths.durable, "utf8");
      await rm(p.paths.durable);
      await write(p.paths.durable, kind === "ambiguous-json" ?
        bytes.replace('"completionStatus":"complete"', '"completionStatus":"unfinished","completionStatus":"complete"') :
        bytes.trimEnd());
    }
    const result = await f.executor.audit(f.context);
    assert.equal(result.status, "unknown", JSON.stringify(result));
    assert.equal(result.accountingComplete, false);
  });
}

test("durable reviewer audit is read-only and detects subsequent native proof changes", { skip }, async (t) => {
  const f = await fixture(t, "review-complete");
  const result = await f.executor.execute(f.context, { onStarted: f.onStarted });
  assert.equal(result.status, "settled");
  const p = await proofDocuments(f, true);
  const before = await Promise.all(Object.values(p.paths).map((path) => readFile(path)));
  assert.deepEqual(await f.executor.audit(f.context), result);
  assert.deepEqual(await Promise.all(Object.values(p.paths).map((path) => readFile(path))), before);
  p.journal.entries.at(-1).type = "fenced";
  pinJournal(p);
  await replaceDocuments(p);
  assert.equal((await f.executor.audit(f.context)).reason, "review-native-unsettled");
  assert.equal((await f.executor.execute(f.context, { onStarted: f.onStarted })).reason, "dispatch-already-exists");
  assert.equal(f.starts(), 1);
});

test("timeout neither kills nor redispatches child; later actual proof can be audited", { skip }, async (t) => {
  const f = await fixture(t, "timeout", { runnerTimeoutMs: 400 });
  const start = Date.now();
  const result = await f.executor.execute(f.context, { onStarted: f.onStarted });
  assert.equal(result.reason, "runner-timeout");
  assert.equal(result.quiescent, false);
  assert.ok(Date.now() - start < 4000);
  assert.equal(f.starts(), 1);
  assert.equal((await f.executor.audit(f.context)).status, "unknown");
  assert.equal((await f.executor.execute(f.context, { onStarted: f.onStarted })).reason, "dispatch-already-exists");
  await waitForExit(f);
  assert.equal((await f.executor.audit(f.context)).status, "settled");
});

for (const kind of ["null", "throw", "callback", "missing-callback", "hanging-identity", "hanging-callback"]) {
  test(`${kind} startup is fenced even if child later finishes`, { skip }, async (t) => {
    const f = await fixture(t, "complete", { runnerTimeoutMs: kind.startsWith("hanging") ? 200 : 10000 });
    const hooks = { ...f.hooks };
    if (["null", "throw", "hanging-identity"].includes(kind)) {
      hooks.processIdentity = async (pid) => {
        await f.hooks.processIdentity(pid);
        if (kind === "throw") throw new Error("identity unavailable");
        if (kind === "hanging-identity") return new Promise(() => {});
        return null;
      };
    }
    const executor = createAcceptanceExecutor(f.config, hooks);
    const callback = kind === "callback" ? async () => { throw new Error("journal failed"); } :
      kind === "hanging-callback" ? () => new Promise(() => {}) : f.onStarted;
    const result = await executor.execute(f.context, kind === "missing-callback" ? {} : { onStarted: callback });
    assert.equal(result.status, "unknown");
    assert.equal(result.quiescent, false);
    await waitForExit(f);
    assert.equal((await executor.audit(f.context)).status, "unknown");
    assert.equal((await executor.execute(f.context, { onStarted: f.onStarted })).reason, "dispatch-already-exists");
  });
}

test("audit always inspects original start identity; PID reuse is not remote settlement proof", { skip }, async (t) => {
  const f = await fixture(t, "pending-send");
  await f.executor.execute(f.context, { onStarted: f.onStarted });
  const receipt = JSON.parse(await readFile(join(f.context.directory, "executor-process.json")));
  let calls = 0;
  for (const state of ["alive", "unknown", "gone"]) {
    const audit = createAcceptanceExecutor(f.config, { inspectProcess: async (identity) => {
      assert.deepEqual(identity, receipt.identity); calls++;
      if (state !== "gone") return state;
      const reusedPid = { pid: identity.pid, startId: "different-process-creation" };
      return reusedPid.startId === identity.startId ? "alive" : "gone";
    } }).audit;
    const result = await audit(f.context);
    assert.equal(result.status, "unknown");
    if (state === "alive") assert.equal(result.reason, "process-alive");
    if (state === "unknown") assert.equal(result.reason, "process-state-unknown");
    if (state === "gone") assert.equal(result.reason, "ledger-pending");
  }
  assert.equal(calls, 3);
});

test("even complete proofs reject an alive original identity or absent exit proof", { skip }, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.executor.execute(f.context, { onStarted: f.onStarted })).status, "settled");
  const executor = createAcceptanceExecutor(f.config, { inspectProcess: async () => "alive" });
  assert.equal((await executor.audit(f.context)).reason, "process-alive");
  const reusedPid = createAcceptanceExecutor(f.config, { inspectProcess: async (identity) =>
    identity.startId === "different-process-creation" ? "alive" : "gone" });
  assert.equal((await reusedPid.audit(f.context)).status, "settled");
  await rm(join(f.context.directory, "executor-exit.json"));
  assert.equal((await f.executor.audit(f.context)).status, "unknown");
});

test("identity first observed after child exit cannot accidentally identify a reused PID", { skip }, async (t) => {
  const f = await fixture(t);
  const executor = createAcceptanceExecutor(f.config, {
    ...f.hooks,
    processIdentity: async (pid) => {
      await f.hooks.processIdentity(pid);
      await waitForExit(f);
      return { pid, startId: "possibly-reused-pid" };
    },
  });
  const result = await executor.execute(f.context, { onStarted: f.onStarted });
  assert.equal(result.reason, "process-identity-unproven");
  assert.equal((await executor.audit(f.context)).status, "unknown");
  assert.equal(f.starts(), 0);
});

test("asynchronous spawn error is handled and permanently prevents another dispatch", { skip }, async (t) => {
  const f = await fixture(t);
  const fakeNode = join(f.context.directory, "vanishing-node.exe");
  await write(fakeNode, "not an executable\n");
  const executor = createAcceptanceExecutor({ ...f.config, node: fakeNode }, f.hooks);
  await rm(fakeNode);
  const result = await executor.execute(f.context, { onStarted: f.onStarted });
  assert.equal(result.status, "unknown");
  await waitForExit(f);
  const exit = JSON.parse(await readFile(join(f.context.directory, "executor-exit.json")));
  assert.equal(exit.spawnError, true);
  assert.equal((await executor.execute(f.context, { onStarted: f.onStarted })).reason, "dispatch-already-exists");
});

test("simultaneous execute attempts spawn at most one child", { skip }, async (t) => {
  const f = await fixture(t);
  const other = createAcceptanceExecutor(f.config, f.hooks);
  const results = await Promise.all([f.executor.execute(f.context, { onStarted: f.onStarted }),
    other.execute(f.context, { onStarted: f.onStarted })]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["settled", "unknown"]);
  assert.equal(f.starts(), 1);
});

test("missing explicit env and invalid timeouts are rejected without filesystem writes", () => {
  for (const config of [{}, { live: false, env: {}, runnerTimeoutMs: 0 },
    { live: false, env: {}, runnerTimeoutMs: Infinity }, { live: false, env: {}, runnerTimeoutMs: -1 }]) {
    assert.throws(() => createAcceptanceExecutor(config), TypeError);
  }
});
