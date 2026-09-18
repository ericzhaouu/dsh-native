#!/usr/bin/env node
import { mkdir, open, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertAbsoluteAdapter,
  budgetFields,
  ensureAbsoluteRunRoot,
  ensureSafeRunRoot,
  hardenPrivatePath,
  importAdapter,
  loadJson,
  loadManifest,
  makeRunId,
  redact,
  usageExceeds,
  validateUsageShape,
  zeroUsage,
} from "./lib/acceptance-contract.mjs";
import { buildReport, evaluateRun } from "./lib/acceptance-evaluator.mjs";

function usage() {
  return "Usage: node scripts\\run-acceptance.mjs --manifest <file> --run-root <absolute-dir> [--dry-run] [--execute --adapter <absolute-module>] [--live --scope <private-scope.json> --trusted-capable-adapter]";
}

function parseArgs(argv) {
  const args = { dryRun: true, execute: false, live: false, trustedCapableAdapter: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--manifest") args.manifest = argv[++index];
    else if (arg === "--run-root") args.runRoot = argv[++index];
    else if (arg === "--adapter") args.adapter = argv[++index];
    else if (arg === "--scope") args.scope = argv[++index];
    else if (arg === "--execute") { args.execute = true; args.dryRun = false; }
    else if (arg === "--dry-run") { args.dryRun = true; args.execute = false; }
    else if (arg === "--live") args.live = true;
    else if (arg === "--trusted-capable-adapter") args.trustedCapableAdapter = true;
    else if (arg === "--allow-overwrite") throw new TypeError("--allow-overwrite was removed; acceptance logs are append-only per run id");
    else if (arg === "--help" || arg === "-h") { console.log(usage()); process.exit(0); }
    else throw new TypeError(`Unknown argument ${arg}\n${usage()}`);
  }
  if (!args.manifest) throw new TypeError(`--manifest is required\n${usage()}`);
  args.runRoot = ensureAbsoluteRunRoot(args.runRoot);
  if (args.execute) args.adapter = assertAbsoluteAdapter(args.adapter);
  return args;
}

async function appendTrace(handle, event) {
  const safe = redact({ time: new Date().toISOString(), ...event });
  if (safe.evidence?.outputText) safe.evidence.outputText = `[omitted ${safe.evidence.outputText.length} chars]`;
  await handle.write(`${JSON.stringify(safe)}\n`);
}

function summarizeEvidence(evidence) {
  if (!evidence) return evidence;
  const clone = structuredClone(evidence);
  if (clone.outputText) clone.outputText = `[omitted ${clone.outputText.length} chars]`;
  return clone;
}

function adapterCase(testCase) {
  const { expected, assertions, oracle, fixtures, mode, ...task } = testCase;
  return structuredClone(task);
}

function stageOf(manifest, testCase) { return testCase.stage ?? manifest.stage ?? "offline"; }

function blockEvidence(reason, extra = {}) {
  return { executionStatus: "infrastructure_blocked", businessResult: "failed", outputText: "", policyFacts: { blockedReason: reason, ...(extra.policyFacts ?? {}) }, prerequisites: extra.prerequisites, sideEffects: [], usage: extra.usage, liveUnknown: extra.liveUnknown, unknownEffects: extra.unknownEffects };
}

function finiteUsageCaps(caps) {
  return budgetFields.every((field) => Number.isSafeInteger(caps?.[field]) && caps[field] >= 0);
}

function addUsage(a, b) {
  const out = { ...a };
  for (const field of budgetFields) out[field] = (out[field] ?? 0) + (b[field] ?? 0);
  if (b.priced === true || a.priced === true) {
    out.priced = true;
    out.currencyMicros = (a.currencyMicros ?? 0) + (b.currencyMicros ?? 0);
  } else out.priced = false;
  return out;
}

function remaining(caps, used) {
  const out = {};
  for (const field of budgetFields) out[field] = (caps?.[field] ?? Number.MAX_SAFE_INTEGER) - (used[field] ?? 0);
  if (Number.isFinite(caps?.currencyMicros)) out.currencyMicros = caps.currencyMicros - (used.currencyMicros ?? 0);
  return out;
}

function makeBudgetTracker(testCase, globalCaps, globalUsed) {
  const caseCaps = testCase.limits?.usage ?? {};
  const observed = { ...zeroUsage(), priced: false };
  return {
    observed,
    admit() {
      if (!finiteUsageCaps(caseCaps)) return `case ${testCase.id} is missing required finite usage budget fields`;
      if (globalCaps.priced === true && (caseCaps.priced !== true || !Number.isSafeInteger(caseCaps.currencyMicros))) {
        return `case ${testCase.id} needs a priced allocation under the private currency budget`;
      }
      const rem = remaining(globalCaps, globalUsed);
      for (const field of budgetFields) if (caseCaps[field] > rem[field]) return `case ${testCase.id} budget cap ${field} exceeds remaining suite budget`;
      if (caseCaps.priced === true && Number.isFinite(caseCaps.currencyMicros) && caseCaps.currencyMicros > (rem.currencyMicros ?? Number.MAX_SAFE_INTEGER)) return `case ${testCase.id} priced cost cap exceeds remaining suite budget`;
      return undefined;
    },
    reportUsage(delta) {
      const errors = validateUsageShape(delta, { requirePricing: false });
      if (errors.length) throw new Error(errors.join("; "));
      const next = addUsage(observed, delta);
      const capErrors = usageExceeds({ ...next, priced: next.priced ?? false }, caseCaps);
      const suiteErrors = usageExceeds({ ...addUsage(globalUsed, next), priced: next.priced ?? false }, globalCaps);
      if (capErrors.length || suiteErrors.length) throw new Error([...capErrors, ...suiteErrors].join("; "));
      Object.assign(observed, next);
    },
    reconcile(finalUsage) {
      const errors = validateUsageShape(finalUsage);
      for (const field of budgetFields) if ((finalUsage?.[field] ?? 0) < observed[field]) errors.push(`usage.${field} final usage lower than streamed usage`);
      if ((finalUsage?.currencyMicros ?? 0) < (observed.currencyMicros ?? 0)) errors.push("usage.currencyMicros final usage lower than streamed usage");
      errors.push(...usageExceeds(finalUsage ?? {}, caseCaps));
      errors.push(...usageExceeds(finalUsage ?? {}, globalCaps));
      errors.push(...usageExceeds(addUsage(globalUsed, finalUsage ?? zeroUsage()), globalCaps));
      return errors;
    },
  };
}

function validateScope(scope, manifest) {
  const errors = [];
  if (!scope || typeof scope !== "object") return { errors: ["live scope is required"], scope: undefined };
  if (scope.authorization !== "private") errors.push("live scope authorization must be private");
  if (scope.readOnly !== true) errors.push("live scope must be readOnly:true");
  if (scope.trustedCapableAdapter !== true) errors.push("live scope must declare trustedCapableAdapter:true");
  if (!Array.isArray(scope.permittedAgentProfiles) || scope.permittedAgentProfiles.length === 0) errors.push("live scope must list permittedAgentProfiles");
  if (!scope.prerequisites || typeof scope.prerequisites !== "object") errors.push("live scope must contain prerequisite facts");
  if (!finiteUsageCaps(scope.budgets)) errors.push("live scope must contain hard finite budgets for all usage dimensions");
  if (scope.budgets?.priced === true && (!Number.isSafeInteger(scope.budgets.currencyMicros) || scope.budgets.currencyMicros < 0)) errors.push("priced live scope requires non-negative currencyMicros");
  if (scope.budgets?.priced !== true && scope.budgets?.priced !== false) errors.push("live scope budgets must explicitly declare priced");
  return { errors, scope };
}

function preflightCase(testCase, manifest, args, scope) {
  const stage = stageOf(manifest, testCase);
  const prereqFacts = scope?.prerequisites ?? {};
  const prerequisiteEvidence = Object.fromEntries((testCase.prerequisites ?? []).map((name) => [name, prereqFacts[name] === true ? true : "missing"]));
  const missingPrereq = Object.entries(prerequisiteEvidence).filter(([, value]) => value !== true).map(([name]) => name);
  if (stage === "live") {
    if (!args.live) return blockEvidence("live case requires explicit --live flag", { prerequisites: prerequisiteEvidence, liveUnknown: true });
    if (!scope) return blockEvidence("live case requires private scope", { prerequisites: prerequisiteEvidence, liveUnknown: true });
    if (!args.trustedCapableAdapter || scope.trustedCapableAdapter !== true) return blockEvidence("no trusted live-capable production adapter authorized", { prerequisites: prerequisiteEvidence, liveUnknown: true });
    if (!scope.permittedAgentProfiles?.includes(testCase.agentProfile)) return blockEvidence("agent profile not permitted by live scope", { prerequisites: prerequisiteEvidence, liveUnknown: true });
  }
  if (missingPrereq.length) return blockEvidence(`missing prerequisites: ${missingPrereq.join(", ")}`, { prerequisites: prerequisiteEvidence });
  return undefined;
}

async function withTimeout(promise, timeoutMs, controller, caseId) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`case ${caseId} timed out after ${timeoutMs}ms`);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function executeCase(adapter, testCase, context, tracker) {
  const timeoutMs = testCase.limits?.timeoutMs ?? 30000;
  const controller = new AbortController();
  const started = Date.now();
  let uncertain = false;
  let error;
  let evidence;
  let budgetError;
  const execution = Promise.resolve().then(() => adapter.executeCase(Object.freeze(adapterCase(testCase)), {
    ...context, signal: controller.signal,
    reportUsage(delta) {
      try { tracker.reportUsage(delta); }
      catch (caught) {
        budgetError = caught;
        controller.abort(caught);
        throw caught;
      }
    },
  }));
  execution.catch(() => {});
  try {
    evidence = await withTimeout(execution, timeoutMs, controller, testCase.id);
  } catch (caught) {
    error = caught;
    uncertain = controller.signal.aborted;
    evidence = blockEvidence(caught.message, { liveUnknown: stageOf(context.manifestInfo, testCase) === "live", unknownEffects: uncertain });
  }
  let cleanupReceipt;
  let cleanupError;
  let cleanupTimer;
  try {
    cleanupReceipt = await Promise.race([
      adapter.cleanupCase(Object.freeze(adapterCase(testCase)), { ...context, evidence, signal: controller.signal }),
      new Promise((_, reject) => {
        cleanupTimer = setTimeout(() => reject(new Error("cleanup receipt timeout")),
          Math.min(1000, Math.max(100, timeoutMs)));
      }),
    ]);
  } catch (caught) { cleanupError = caught; }
  finally { clearTimeout(cleanupTimer); }
  const cleanup = cleanupError ? { error: cleanupError.message } : cleanupReceipt;
  if (!cleanup || typeof cleanup !== "object") evidence = { ...(evidence ?? {}), cleanup: { error: "missing cleanup receipt" } };
  else evidence = { ...(evidence ?? {}), cleanup, latencyMs: evidence?.latencyMs ?? Date.now() - started };
  if (error && stageOf(context.manifestInfo, testCase) !== "live" && !evidence.usage) evidence.usage = { ...zeroUsage(), priced: false };
  if (budgetError) {
    evidence = { ...evidence, executionStatus: "infrastructure_blocked", businessResult: "failed",
      unknownEffects: true, policyFacts: { ...evidence?.policyFacts, budgetError: budgetError.message } };
  }
  return { evidence, error: error ?? budgetError,
    uncertain: uncertain || !!budgetError || !!cleanupError || cleanup?.cleaned !== true };
}

export async function runAcceptance(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { manifest, manifestPath, manifestSha256 } = await loadManifest(args.manifest);
  const runId = makeRunId(manifest.suiteId);
  const runDir = resolve(args.runRoot, runId);
  await ensureSafeRunRoot(args.runRoot);
  await mkdir(args.runRoot, { recursive: true });
  await ensureSafeRunRoot(args.runRoot);
  await hardenPrivatePath(args.runRoot, true);
  await mkdir(runDir, { recursive: false });
  await hardenPrivatePath(runDir, true);
  const tracePath = join(runDir, "trace.jsonl");
  const reportPath = join(runDir, "report.json");
  const trace = await open(tracePath, "wx");
  await hardenPrivatePath(tracePath, false);
  const evidenceById = new Map();
  const cleanupReceipts = [];
  let stopReason;
  const manifestInfo = { suiteId: manifest.suiteId, stage: manifest.stage, manifestSha256 };
  try {
    await appendTrace(trace, { event: "run_started", runId, manifestPath: basename(manifestPath), manifestSha256, dryRun: args.dryRun, executionKind: args.dryRun ? "dry-run" : manifest.stage ?? "offline" });
    if (args.dryRun) {
      const planned = manifest.cases.map((testCase) => ({ id: testCase.id, agentProfile: testCase.agentProfile, stage: stageOf(manifest, testCase), outcome: "planned", mandatory: testCase.mandatory !== false }));
      const report = buildReport(manifest, [], { runId, dryRun: true, manifestSha256, executionKind: "dry-run" });
      report.plannedCases = planned;
      report.status = "planned";
      report.passed = false;
      await writeFile(reportPath, `${JSON.stringify(redact(report), null, 2)}\n`, { flag: "wx" });
      await hardenPrivatePath(reportPath, false);
      await appendTrace(trace, { event: "dry_run_completed", plannedCases: planned.length });
      return { code: 0, reportPath, tracePath, report };
    }

    let scope;
    if (args.scope) {
      const rawScope = await loadJson(args.scope);
      const scopeCheck = validateScope(rawScope, manifest);
      if (scopeCheck.errors.length) stopReason = scopeCheck.errors.join("; ");
      else scope = rawScope;
    }
    let adapter;
    const globalCaps = Object.fromEntries(budgetFields.map((field) => [field,
      Math.min(manifest.limits?.[field] ?? Number.MAX_SAFE_INTEGER,
        scope?.budgets?.[field] ?? Number.MAX_SAFE_INTEGER)]));
    const costCaps = [manifest.limits?.currencyMicros, scope?.budgets?.currencyMicros].filter(Number.isSafeInteger);
    if (costCaps.length) { globalCaps.priced = true; globalCaps.currencyMicros = Math.min(...costCaps); }
    let globalUsed = { ...zeroUsage(), priced: false };
    for (const testCase of manifest.cases) {
      if (stopReason) {
        evidenceById.set(testCase.id, blockEvidence(`not executed after stop: ${stopReason}`, { liveUnknown: stageOf(manifest, testCase) === "live", unknownEffects: true }));
        continue;
      }
      const preflight = preflightCase(testCase, manifest, args, scope);
      if (preflight) {
        evidenceById.set(testCase.id, preflight);
        await appendTrace(trace, { event: "case_preflight_blocked", caseId: testCase.id, reason: preflight.policyFacts.blockedReason });
        continue;
      }
      const tracker = makeBudgetTracker(testCase, globalCaps, globalUsed);
      const admissionError = tracker.admit();
      if (admissionError) {
        stopReason = admissionError;
        evidenceById.set(testCase.id, blockEvidence(admissionError));
        await appendTrace(trace, { event: "case_budget_blocked", caseId: testCase.id, reason: admissionError });
        continue;
      }
      if (!adapter) {
        try { adapter = await importAdapter(args.adapter); }
        catch (error) {
          stopReason = `adapter initialization failed: ${error.message}`;
          evidenceById.set(testCase.id, blockEvidence(stopReason));
          await appendTrace(trace, { event: "adapter_initialization_failed", caseId: testCase.id, reason: stopReason });
          continue;
        }
      }
      await appendTrace(trace, { event: "case_started", caseId: testCase.id, agentProfile: testCase.agentProfile });
      const result = await executeCase(adapter, testCase, { runId, runDir, manifestInfo, fixtureEvidence: testCase.fixtures?.evidence }, tracker);
      const reconcileErrors = result.evidence?.usage ? tracker.reconcile(result.evidence.usage) : (stageOf(manifest, testCase) === "live" ? ["missing live usage"] : []);
      if (reconcileErrors.length) {
        result.evidence = { ...result.evidence, executionStatus: "infrastructure_blocked", businessResult: "failed", policyFacts: { ...(result.evidence.policyFacts ?? {}), budgetError: reconcileErrors.join("; ") }, unknownEffects: true };
        stopReason = reconcileErrors.join("; ");
      } else if (result.evidence?.usage) {
        globalUsed = addUsage(globalUsed, result.evidence.usage);
      }
      if (result.uncertain) stopReason ??= result.error?.message ?? result.evidence?.cleanup?.error ?? "uncertain execution or cleanup state";
      evidenceById.set(testCase.id, result.evidence);
      cleanupReceipts.push({ caseId: testCase.id, receipt: result.evidence.cleanup });
      await appendTrace(trace, { event: "case_evidence", caseId: testCase.id, evidence: summarizeEvidence(result.evidence) });
    }
    const report = evaluateRun(manifest, evidenceById, { runId, dryRun: false, manifestSha256, executionKind: manifest.stage ?? "offline" });
    report.cleanupReceipts = cleanupReceipts;
    report.limitations = ["trusted JavaScript adapters can ignore AbortSignal; non-cooperative adapters are marked unknown and stop the campaign, but CPU-bound isolation requires a separate process adapter."];
    if (stopReason) report.stopReason = stopReason;
    await writeFile(reportPath, `${JSON.stringify(redact(report), null, 2)}\n`, { flag: "wx" });
    await hardenPrivatePath(reportPath, false);
    await appendTrace(trace, { event: "run_completed", passed: report.passed, stopReason });
    return { code: report.passed ? 0 : 1, reportPath, tracePath, report };
  } finally { await trace.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runAcceptance().then(({ code, reportPath }) => { console.log(JSON.stringify({ reportPath, code })); process.exitCode = code; }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
