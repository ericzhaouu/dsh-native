#!/usr/bin/env node
import { mkdir, open, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
import { loadAcceptanceResources } from "./lib/acceptance-resources.mjs";
import { evaluateCorpusEvidence, loadCorpusOracles } from "./lib/acceptance-oracles.mjs";

const operationalBudgetGuidance = [
  "Private scope.operationalBudget and scope.reviewOperationalBudget opt in to attestation; legacy/default executions remain unattested.",
  "BEFORE every dispatch, the trusted adapter/reviewer must verify configured plugin effective operational caps (the minimum of global operationalBudget and exact-agent operationalBudgetByAgent caps when both exist) fit every remaining case/campaign allocation, including duration. Operators must install suitably small configured caps; the runner does not configure the plugin.",
  "budget and operationalBudget allocations passed to adapters/reviewers are ceilings, not automatic native narrowing. Chat messages or prompt text cannot enforce these limits.",
  "Configured runtime maxDurationMs must be strictly below the case/review deadline with setup headroom and a dispatch margin. Resource, prompt, and auth preparation consume the original absolute deadline; waiting timeouts do not guarantee remote abort or quiescence.",
  "maxInputTokens and remaining uncached inputTokens must allow the prepared full contextWindow for a worst-case cache miss, not guessed nominal prompt tokens. Cache read/write allocations cannot fund this reservation.",
  "Bounded Gateway/reviewer native total-input caps must also fit EACH remaining cacheReadTokens/cacheWriteTokens allocation. Their native ledgers are unpriced: priced/currency allocations require separate runtime enforcement and are rejected before dispatch.",
  "Attestation requires actual runtime enforcement/settlement proof plus successful quiescent cleanup. Unknown post-dispatch accounting and fenced/locked runtimes remain unknown, never known zero or attested.",
  "Failure accounting keeps measured observedLowerBound, journal outstandingReservations, and conservative unresolvedExposure separate; incomplete journals cannot release unproven exposure.",
];

function usage() {
  return ["Usage: node scripts\\run-acceptance.mjs --manifest <file> --run-root <absolute-dir> [--dry-run] [--execute --adapter <absolute-module>] [--live --scope <private-scope.json> --trusted-capable-adapter] [--oracles <file> --reviewer <absolute-module>]",
    "", ...operationalBudgetGuidance].join("\n");
}

function parseArgs(argv) {
  const args = { dryRun: true, execute: false, live: false, trustedCapableAdapter: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--manifest") args.manifest = argv[++index];
    else if (arg === "--run-root") args.runRoot = argv[++index];
    else if (arg === "--adapter") args.adapter = argv[++index];
    else if (arg === "--scope") args.scope = argv[++index];
    else if (arg === "--oracles") args.oracles = argv[++index];
    else if (arg === "--reviewer") args.reviewer = argv[++index];
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
  if (args.reviewer) {
    args.reviewer = assertAbsoluteAdapter(args.reviewer);
    if (args.reviewer === args.adapter) throw new TypeError("Independent reviewer must not be the execution adapter");
  }
  return args;
}

async function appendTrace(handle, event) {
  const safe = redact({ time: new Date().toISOString(), ...event });
  if (safe.evidence?.outputText) safe.evidence.outputText = `[omitted ${safe.evidence.outputText.length} chars]`;
  await handle.write(`${JSON.stringify(safe)}\n`);
}

function summarizeEvidence(evidence, hardLimits) {
  if (!evidence) return evidence;
  const clone = structuredClone(evidence);
  clone.budgetAttestation = structuredClone(hardLimits?.attestation ?? { status: "unattested" });
  if (clone.outputText) clone.outputText = `[omitted ${clone.outputText.length} chars]`;
  if (clone.turns) clone.turns = clone.turns.map(({ outputText, tools, prompt, ...turn }) => ({
    ...turn, outputCharacters: outputText?.length ?? 0,
    tools: tools?.map(({ name, isError }) => ({ name, isError })),
  }));
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

const operationalFields = ["maxModelRequests", "maxInputTokens", "maxOutputTokens", "maxToolCalls", "maxDurationMs"];

function validateOperationalBudget(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !operationalFields.includes(key)) ||
      operationalFields.some((key) => !Object.hasOwn(value, key) || !Number.isSafeInteger(value[key]) || value[key] <= 0)) {
    throw new TypeError(`${label} requires all five positive safe integer limits and no extra fields`);
  }
  return Object.fromEntries(operationalFields.map((key) => [key, value[key]]));
}

function allocateOperationalBudget(root, caps, timeoutMs, { review = false } = {}) {
  // Allocate ceilings only; the adapter must check the configured native limits before dispatch.
  // Reserve for a worst-case cache miss; a provider attempt cannot assume a cache hit.
  const inputTokens = caps.inputTokens;
  if (!Number.isSafeInteger(inputTokens)) throw new Error("operationalBudget input allocation is not a safe integer");
  return validateOperationalBudget({
    maxModelRequests: Math.min(root.maxModelRequests, caps.modelRequests),
    maxInputTokens: Math.min(root.maxInputTokens, inputTokens),
    maxOutputTokens: Math.min(root.maxOutputTokens, caps.outputTokens),
    // The reviewer independently enforces zero tools; runtime roots require positive limits.
    maxToolCalls: review ? root.maxToolCalls : Math.min(root.maxToolCalls, caps.toolCalls),
    maxDurationMs: Math.min(root.maxDurationMs, timeoutMs),
  }, "operationalBudget allocation (zero/exhausted limits are forbidden)");
}

function checkBudgetAttestation(value, root, cleanup, usage) {
  if (cleanup?.cleaned === false || cleanup?.error) {
    throw new Error("adapter cleanup is incomplete; usage and hard limits are unproven");
  }
  if (!root) return { status: "unattested" };
  if (value?.status !== "verified" || value.hardLimitsVerified !== true || value.quiescent !== true ||
      cleanup?.cleaned !== true || cleanup?.quiescent !== true) {
    throw new Error("operationalBudget requires verified adapter budgetAttestation and cleanup.cleaned:true, cleanup.quiescent:true");
  }
  const limits = validateOperationalBudget(value.operationalBudget, "budgetAttestation.operationalBudget");
  if (operationalFields.some((key) => limits[key] > root[key])) {
    throw new Error("budgetAttestation exceeds the trusted operationalBudget allocation");
  }
  if (!Number.isSafeInteger(value.contextWindow) || value.contextWindow <= 0) {
    throw new Error("budgetAttestation requires a positive prepared full contextWindow verified by the adapter, not guessed nominal prompt tokens");
  }
  if (value.contextWindow > limits.maxInputTokens) {
    throw new Error("budgetAttestation.contextWindow exceeds attested maxInputTokens; the configured input cap and remaining allocation must allow the prepared full contextWindow");
  }
  // Runtime input usage still includes uncached input plus cache reads and writes.
  for (const [key, observed] of Object.entries({
    maxModelRequests: usage?.modelRequests, maxOutputTokens: usage?.outputTokens, maxToolCalls: usage?.toolCalls,
    maxInputTokens: usage?.inputTokens + usage?.cacheReadTokens + usage?.cacheWriteTokens,
  })) {
    if (Number.isFinite(observed) && observed > limits[key]) throw new Error(`usage exceeds budgetAttestation.${key}`);
  }
  return { status: "adapter-attested", attestation: structuredClone(value) };
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
  out.priced = caps?.priced === true;
  return out;
}

function minimumAllocation(caps, rem) {
  const allocation = Object.fromEntries(budgetFields.map((field) => [field, Math.min(caps[field], rem[field])]));
  allocation.priced = caps.priced === true || rem.priced === true;
  if (allocation.priced) allocation.currencyMicros = Math.min(caps.currencyMicros ?? Number.MAX_SAFE_INTEGER,
    rem.currencyMicros ?? Number.MAX_SAFE_INTEGER);
  return allocation;
}

function makeBudgetTracker(testCase, globalCaps, globalUsed, { allowNarrowing = false } = {}) {
  const caseCaps = testCase.limits?.usage ?? {};
  const observed = { ...zeroUsage(), priced: false };
  let failure;
  let usageClosed = false;
  let closed = false;
  let outstandingReservations;
  let unresolvedExposure;
  const latch = (error) => { failure ??= error; return failure; };
  return {
    observed,
    get outstandingReservations() { return outstandingReservations; },
    get unresolvedExposure() { return unresolvedExposure; },
    retainLowerBound(error) {
      const data = error?.budgetAccounting;
      if (!data) return;
      if (closed) {
        latch(new Error("error accounting after accounting closed"));
        return;
      }
      if (validateUsageShape(data.observedLowerBound).length) return;
      for (const field of budgetFields) observed[field] = Math.max(observed[field], data.observedLowerBound[field]);
      if (data.observedLowerBound.priced === true) {
        observed.priced = true;
        observed.currencyMicros = Math.max(observed.currencyMicros ?? 0, data.observedLowerBound.currencyMicros);
      }
      if (data.reserved && ["inputTokens", "outputTokens", "modelRequests", "toolCalls"]
        .every((field) => Number.isSafeInteger(data.reserved[field]) && data.reserved[field] >= 0)) {
        outstandingReservations = { ...data.reserved };
      }
      if (data.unresolvedExposure && ["inputTokens", "outputTokens", "modelRequests", "toolCalls"]
        .every((field) => Number.isSafeInteger(data.unresolvedExposure[field]) && data.unresolvedExposure[field] >= 0)) {
        unresolvedExposure = Object.fromEntries(["inputTokens", "outputTokens", "modelRequests", "toolCalls"]
          .map((field) => [field, Math.max(unresolvedExposure?.[field] ?? 0, data.unresolvedExposure[field])]));
      }
    },
    get failure() { return failure; },
    closeUsage() { usageClosed = true; },
    close() { usageClosed = true; closed = true; },
    latch,
    allocation: minimumAllocation(caseCaps, remaining(globalCaps, globalUsed)),
    admit() {
      if (!finiteUsageCaps(caseCaps)) return `case ${testCase.id} is missing required finite usage budget fields`;
      if (globalCaps.priced === true && (caseCaps.priced !== true || !Number.isSafeInteger(caseCaps.currencyMicros))) {
        return `case ${testCase.id} needs a priced allocation under the private currency budget`;
      }
      const rem = remaining(globalCaps, globalUsed);
      for (const field of budgetFields) {
        if ((!allowNarrowing && caseCaps[field] > rem[field]) || (caseCaps[field] > 0 && rem[field] <= 0)) {
          return `case ${testCase.id} budget cap ${field} exceeds remaining suite budget`;
        }
      }
      if (caseCaps.priced === true && Number.isFinite(caseCaps.currencyMicros) &&
          ((!allowNarrowing && caseCaps.currencyMicros > (rem.currencyMicros ?? Number.MAX_SAFE_INTEGER)) ||
            (caseCaps.currencyMicros > 0 && rem.currencyMicros <= 0))) {
        return `case ${testCase.id} priced cost cap exceeds remaining suite budget`;
      }
      return undefined;
    },
    reportUsage(delta) {
      if (usageClosed) throw latch(new Error("usage callback after accounting closed"));
      const errors = validateUsageShape(delta, { requirePricing: false });
      if (errors.length) throw latch(new Error(errors.join("; ")));
      const next = addUsage(observed, delta);
      if (validateUsageShape(next).length) {
        for (const field of [...budgetFields, "currencyMicros"]) {
          if (next[field] !== undefined) observed[field] = Math.min(next[field], Number.MAX_SAFE_INTEGER);
        }
        observed.priced = next.priced;
        throw latch(new Error("observed usage accumulation is not a safe integer"));
      }
      Object.assign(observed, next);
      const capErrors = usageExceeds({ ...next, priced: next.priced ?? false }, caseCaps);
      const suiteErrors = usageExceeds({ ...addUsage(globalUsed, next), priced: next.priced ?? false }, globalCaps);
      if (capErrors.length || suiteErrors.length) throw latch(new Error([...capErrors, ...suiteErrors].join("; ")));
      if (failure) throw failure;
    },
    reconcile(finalUsage) {
      const errors = validateUsageShape(finalUsage);
      for (const field of [...budgetFields, "currencyMicros"]) {
        const value = finalUsage?.[field];
        if (Number.isSafeInteger(value) && value >= 0 && (field !== "currencyMicros" || finalUsage.priced === true)) {
          if (value < (observed[field] ?? 0)) errors.push(`usage.${field} final usage lower than streamed usage`);
          observed[field] = Math.max(observed[field] ?? 0, value);
        } else if (field === "currencyMicros" && observed.priced === true) errors.push("usage.currencyMicros final usage missing");
      }
      if (finalUsage?.priced === true && Number.isSafeInteger(finalUsage.currencyMicros) && finalUsage.currencyMicros >= 0) observed.priced = true;
      errors.push(...usageExceeds(finalUsage ?? {}, caseCaps));
      errors.push(...usageExceeds(addUsage(globalUsed, observed), globalCaps));
      if (errors.length) latch(new Error(errors.join("; ")));
      if (failure) errors.push(failure.message);
      return errors;
    },
  };
}

function accountingSummary(records) {
  const complete = records.filter((entry) => entry.complete && !entry.tracker.failure);
  const sum = (entries) => {
    const total = entries.reduce((value, entry) => addUsage(value, entry.tracker.observed), { ...zeroUsage(), priced: false });
    for (const field of budgetFields) total[field] = Math.min(total[field], Number.MAX_SAFE_INTEGER);
    if (entries.some((entry) => entry.tracker.observed.priced !== true) || !Number.isSafeInteger(total.currencyMicros)) {
      total.priced = false;
      delete total.currencyMicros;
    }
    return total;
  };
  const status = !records.length ? "not_started" : complete.length === records.length ? "complete" : "unknown";
  const observedCost = records.reduce((value, entry) => value + (entry.tracker.observed.currencyMicros ?? 0), 0);
  const costKnown = status === "complete" && Number.isSafeInteger(observedCost) &&
    records.every((entry) => entry.tracker.observed.priced === true);
  const costLowerBound = Math.min(observedCost, Number.MAX_SAFE_INTEGER);
  return {
    status, totals: status === "complete" ? sum(complete) : null,
    completeUsage: sum(complete), observedLowerBound: sum(records),
    cost: { status: !records.length ? "not_started" : costKnown ? "complete" : "unknown",
      currencyMicros: costKnown ? costLowerBound : null, observedLowerBoundCurrencyMicros: costLowerBound },
    cases: records.map((entry) => ({
      caseId: entry.caseId, status: entry.complete && !entry.tracker.failure ? "complete" : "unknown",
      observedLowerBound: { ...entry.tracker.observed }, executionSettled: entry.settled,
      ...(entry.tracker.outstandingReservations ? { outstandingReservations: entry.tracker.outstandingReservations } : {}),
      ...(entry.tracker.unresolvedExposure ? { unresolvedExposure: entry.tracker.unresolvedExposure } : {}),
      aborted: entry.controller.signal.aborted,
      hardLimits: entry.complete && !entry.tracker.failure ? entry.hardLimits ?? { status: "unattested" } : { status: "unattested" },
      ...(entry.tracker.failure ? { error: entry.tracker.failure.message } : {}),
    })),
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
  if (!finiteUsageCaps(scope.budgets)) errors.push("live scope must contain finite budgets for all usage dimensions");
  if (scope.budgets?.priced === true && (!Number.isSafeInteger(scope.budgets.currencyMicros) || scope.budgets.currencyMicros < 0)) errors.push("priced live scope requires non-negative currencyMicros");
  if (scope.budgets?.priced !== true && scope.budgets?.priced !== false) errors.push("live scope budgets must explicitly declare priced");
  for (const field of ["operationalBudget", "reviewOperationalBudget"]) {
    if (!Object.hasOwn(scope, field)) continue;
    try { scope[field] = validateOperationalBudget(scope[field], `scope.${field}`); }
    catch (error) { errors.push(error.message); }
  }
  if (scope.reviewResources !== undefined) {
    for (const [name, profiles] of Object.entries(scope.reviewResources ?? {})) {
      if (name !== "private-feishu-canary-map" || !profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
        errors.push("unsupported private review resource");
        continue;
      }
      for (const [profile, resource] of Object.entries(profiles)) {
        const allowed = ["scope", "chatId", "botAppId", "botMemberId", "creatorMemberId"];
        if (!scope.permittedAgentProfiles?.includes(profile) || !resource || typeof resource !== "object" ||
            Object.keys(resource).some((key) => !allowed.includes(key)) ||
            resource.scope !== "dedicated-synthetic-feishu-chat" ||
            allowed.filter((key) => key !== "scope").some((key) =>
              typeof resource[key] !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(resource[key]))) {
          errors.push("invalid or excessive private review resource fields");
        }
      }
    }
  }
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

function deadlineAfter(startedAtMs, timeoutMs) {
  return startedAtMs + Math.min(timeoutMs, Number.MAX_SAFE_INTEGER - startedAtMs);
}

function checkDeadline(deadlineAtMs, timeoutMs, controller, caseId) {
  if (Date.now() >= deadlineAtMs) {
    controller.abort(new Error(`case ${caseId} timed out after ${timeoutMs}ms`));
  }
  controller.signal.throwIfAborted();
}

async function withTimeout(promise, timeoutMs, controller, caseId, deadlineAtMs) {
  let timer;
  try {
    checkDeadline(deadlineAtMs, timeoutMs, controller, caseId);
    const result = await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`case ${caseId} timed out after ${timeoutMs}ms`);
          controller.abort(error);
          reject(error);
        }, Math.min(deadlineAtMs - Date.now(), 2147483647));
      }),
    ]);
    if (Date.now() >= deadlineAtMs) checkDeadline(deadlineAtMs, timeoutMs, controller, caseId);
    return result;
  } finally { clearTimeout(timer); }
}

async function executeCase(prepare, testCase, context, tracker) {
  const started = Date.now();
  const timeoutMs = context.timeoutMs;
  const deadlineAtMs = deadlineAfter(started, timeoutMs);
  context = { ...context, deadlineAtMs };
  const controller = new AbortController();
  let adapter;
  let error;
  let evidence;
  let settled = false;
  const execution = Promise.resolve().then(async () => {
    try {
      checkDeadline(deadlineAtMs, timeoutMs, controller, testCase.id);
      const prepared = await prepare(controller, deadlineAtMs);
      adapter = prepared.adapter;
      context.resources = prepared.resources;
      checkDeadline(deadlineAtMs, timeoutMs, controller, testCase.id);
      return await adapter.executeCase(Object.freeze(adapterCase(testCase)), {
        ...context, signal: controller.signal,
        reportUsage(delta) {
          try { tracker.reportUsage(delta); }
          catch (caught) {
            controller.abort(caught);
            throw caught;
          }
        },
      });
    } catch (caught) {
      // Observe rejection before promise adoption/finally can let cleanup close accounting.
      tracker.retainLowerBound(caught);
      throw caught;
    } finally { settled = true; }
  });
  execution.catch(() => {});
  try {
    evidence = await withTimeout(execution, timeoutMs, controller, testCase.id, deadlineAtMs);
  } catch (caught) {
    error = caught;
    tracker.latch(caught);
    evidence = caught.evidence && typeof caught.evidence === "object" && !Array.isArray(caught.evidence)
      ? { ...caught.evidence, unknownEffects: true }
      : blockEvidence(caught.message, { liveUnknown: stageOf(context.manifestInfo, testCase) === "live", unknownEffects: true });
  } finally { tracker.closeUsage(); }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    error ??= tracker.latch(new Error("adapter returned no valid evidence"));
    evidence = blockEvidence(error.message, { unknownEffects: true });
  }
  if (evidence.executionStatus === "infrastructure_blocked") {
    tracker.latch(new Error(evidence.policyFacts?.blockedReason ?? "infrastructure-blocked execution has unknown usage"));
  }
  if (evidence.unknownEffects === true || evidence.liveUnknown === true) {
    tracker.latch(new Error("adapter reported unknown post-dispatch state; usage and hard limits are unproven"));
  }
  let cleanupReceipt;
  let cleanupError;
  let cleanupTimer;
  try {
    cleanupReceipt = await Promise.race([
      Promise.resolve().then(() => adapter ? adapter.cleanupCase(Object.freeze(adapterCase(testCase)), { ...context, evidence, signal: controller.signal }) :
        { cleaned: settled, quiescent: false, receipt: "Execution adapter was not admitted" }),
      new Promise((_, reject) => {
        cleanupTimer = setTimeout(() => reject(new Error("cleanup receipt timeout")),
          Math.min(1000, Math.max(100, timeoutMs)));
      }),
    ]);
  } catch (caught) { cleanupError = caught; }
  finally { clearTimeout(cleanupTimer); tracker.close(); }
  const cleanup = cleanupError ? { error: cleanupError.message } : cleanupReceipt;
  if (!cleanup || typeof cleanup !== "object") evidence = { ...(evidence ?? {}), cleanup: { error: "missing cleanup receipt" } };
  else evidence = { ...(evidence ?? {}), cleanup, latencyMs: evidence?.latencyMs ?? Date.now() - started };
  if (!settled || controller.signal.aborted) {
    error ??= tracker.latch(controller.signal.reason ?? new Error("execution promise is not settled"));
    evidence.cleanup = { ...evidence.cleanup, quiescent: false };
  }
  let hardLimits = { status: "unattested" };
  try { hardLimits = checkBudgetAttestation(evidence.budgetAttestation, context.operationalBudget, evidence.cleanup, evidence.usage); }
  catch (caught) { error ??= tracker.latch(caught); }
  if (tracker.failure) {
    evidence = { ...evidence,
      ...(context.manifestInfo.version === 2 ? {} : { executionStatus: "infrastructure_blocked", businessResult: "failed" }),
      unknownEffects: true, policyFacts: { ...evidence?.policyFacts, budgetError: tracker.failure.message } };
  }
  return { evidence, error: error ?? tracker.failure, settled, controller, hardLimits,
    uncertain: !settled || controller.signal.aborted || !!tracker.failure || !!cleanupError || cleanup?.cleaned !== true };
}

async function importReviewer(path) {
  const module = await import(pathToFileURL(path).href);
  const factory = module.createReviewer ?? module.default;
  if (typeof factory !== "function") throw new TypeError("Reviewer must export createReviewer()");
  const reviewer = await factory();
  if (typeof reviewer?.reviewCase !== "function") throw new TypeError("Reviewer must implement reviewCase()");
  return reviewer;
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
  let adapter;
  let reviewer;
  const closed = new Set();
  const closeClients = async () => {
    const failures = [];
    for (const instance of [reviewer, adapter]) {
      if (!instance?.close || closed.has(instance)) continue;
      closed.add(instance);
      try { await instance.close(); } catch (error) { failures.push(error); }
    }
    return failures;
  };
  const manifestInfo = { version: manifest.version, suiteId: manifest.suiteId, stage: manifest.stage, manifestSha256 };
  try {
    await appendTrace(trace, { event: "run_started", runId, manifestPath: basename(manifestPath), manifestSha256, dryRun: args.dryRun, executionKind: args.dryRun ? "dry-run" : manifest.stage ?? "offline", operationalBudgetGuidance });
    if (args.dryRun) {
      const planned = manifest.cases.map((testCase) => ({ id: testCase.id, agentProfile: testCase.agentProfile, stage: stageOf(manifest, testCase), outcome: "planned", mandatory: testCase.mandatory !== false }));
      const report = buildReport(manifest, [], { runId, dryRun: true, manifestSha256, executionKind: "dry-run" });
      report.plannedCases = planned;
      report.status = "planned";
      report.passed = false;
      report.limitations = [...operationalBudgetGuidance];
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
    let corpusOracles;
    if (manifest.corpusOracle) {
      try {
        corpusOracles = await loadCorpusOracles(args.oracles ?? join(dirname(manifestPath), "oracles.json"), manifest);
        if (!args.reviewer || scope?.trustedIndependentReviewer !== true) {
          throw new Error("Compiled corpus requires a separately authorized independent reviewer");
        }
        if (!finiteUsageCaps(scope.reviewBudgets) || validateUsageShape(scope.reviewBudgets).length) {
          throw new Error("Independent review requires finite, explicitly priced/unpriced reviewBudgets");
        }
      } catch (error) { stopReason ??= `oracle preflight failed: ${error.message}`; }
    } else if (args.oracles || args.reviewer) {
      stopReason ??= "Oracle review requires a manifest-bound corpusOracle sidecar";
    }
    const globalCaps = Object.fromEntries(budgetFields.map((field) => [field,
      Math.min(manifest.limits?.[field] ?? Number.MAX_SAFE_INTEGER,
        scope?.budgets?.[field] ?? Number.MAX_SAFE_INTEGER)]));
    const costCaps = [manifest.limits?.currencyMicros, scope?.budgets?.currencyMicros].filter(Number.isSafeInteger);
    if (costCaps.length) { globalCaps.priced = true; globalCaps.currencyMicros = Math.min(...costCaps); }
    let globalUsed = { ...zeroUsage(), priced: false };
    let reviewUsed = { ...zeroUsage(), priced: false };
    const dutAccounting = [];
    const reviewAccounting = [];
    for (const testCase of manifest.cases) {
      const lateFailure = [...dutAccounting, ...reviewAccounting].find((entry) => entry.tracker.failure);
      if (lateFailure) stopReason ??= lateFailure.tracker.failure.message;
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
      let resources;
      let resourceError;
      const tracker = makeBudgetTracker(testCase, globalCaps, globalUsed, { allowNarrowing: !!scope?.operationalBudget });
      let admissionError = tracker.admit();
      let operationalBudget;
      const timeoutMs = Math.min(testCase.limits.timeoutMs, scope?.operationalBudget?.maxDurationMs ?? Number.MAX_SAFE_INTEGER);
      if (!admissionError && scope?.operationalBudget) {
        try { operationalBudget = allocateOperationalBudget(scope.operationalBudget, tracker.allocation, timeoutMs); }
        catch (error) { admissionError = error.message; }
      }
      if (admissionError) {
        stopReason = admissionError;
        evidenceById.set(testCase.id, blockEvidence(admissionError));
        await appendTrace(trace, { event: "case_budget_blocked", caseId: testCase.id, reason: admissionError });
        continue;
      }
      const result = await executeCase(async (controller, deadlineAtMs) => {
        try {
          if (testCase.fixtures?.names?.length) resources = await loadAcceptanceResources(scope, {
            agentProfile: testCase.agentProfile, fixtureNames: testCase.fixtures.names, runId,
          });
        } catch (error) {
          resourceError = error;
          throw new Error(`resource binding failed: ${error.message}`, { cause: error });
        }
        checkDeadline(deadlineAtMs, timeoutMs, controller, testCase.id);
        if (!adapter) {
          try {
            const initialized = await importAdapter(args.adapter);
            if (controller.signal.aborted) {
              await initialized.close?.();
              controller.signal.throwIfAborted();
            }
            adapter = initialized;
          }
          catch (error) { throw new Error(`adapter initialization failed: ${error.message}`, { cause: error }); }
        }
        checkDeadline(deadlineAtMs, timeoutMs, controller, testCase.id);
        await appendTrace(trace, { event: "case_started", caseId: testCase.id, agentProfile: testCase.agentProfile,
          budgetAllocation: { semantics: "ceilings-only", usage: tracker.allocation, operationalBudget, timeoutMs },
          hardLimits: { status: "unattested" } });
        return { adapter, resources };
      }, testCase, {
        runId, runDir, manifestInfo, fixtureEvidence: testCase.fixtures?.evidence,
        budget: Object.freeze({ ...tracker.allocation }), timeoutMs,
        ...(operationalBudget ? { operationalBudget: Object.freeze(operationalBudget) } : {}),
      }, tracker);
      if (resourceError && !result.controller.signal.aborted) {
        evidenceById.set(testCase.id, blockEvidence(`resource binding failed: ${resourceError.message}`,
          { liveUnknown: stageOf(manifest, testCase) === "live", prerequisites: scope?.prerequisites }));
        await appendTrace(trace, { event: "case_resource_blocked", caseId: testCase.id, reason: resourceError.message });
        continue;
      }
      result.evidence.prerequisites = Object.fromEntries((testCase.prerequisites ?? [])
        .map((name) => [name, scope?.prerequisites?.[name] === true]));
      const reconcileErrors = tracker.reconcile(result.evidence.usage);
      const accounting = { caseId: testCase.id, tracker, complete: !reconcileErrors.length && !result.uncertain,
        settled: result.settled, controller: result.controller, hardLimits: result.hardLimits };
      dutAccounting.push(accounting);
      if (reconcileErrors.length) {
        result.evidence = { ...result.evidence,
          ...(manifest.version === 2 ? {} : { executionStatus: "infrastructure_blocked", businessResult: "failed" }),
          policyFacts: { ...(result.evidence.policyFacts ?? {}), budgetError: reconcileErrors.join("; ") }, unknownEffects: true };
        stopReason = reconcileErrors.join("; ");
      } else if (accounting.complete) {
        globalUsed = addUsage(globalUsed, result.evidence.usage);
      }
      if (result.uncertain) stopReason ??= result.error?.message ?? result.evidence?.cleanup?.error ?? "uncertain execution or cleanup state";
      if (corpusOracles && !result.uncertain && !reconcileErrors.length &&
          result.evidence.executionStatus !== "infrastructure_blocked") {
        const reviewStartedAtMs = Date.now();
        const reviewBudget = remaining(scope.reviewBudgets, reviewUsed);
        const reviewTracker = makeBudgetTracker({ id: `${testCase.id}:independent-review`,
          limits: { usage: { ...reviewBudget, toolCalls: 0 } } }, scope.reviewBudgets, reviewUsed);
        const controller = new AbortController();
        const reviewEntry = { caseId: testCase.id, tracker: reviewTracker, complete: false, settled: false, controller };
        reviewAccounting.push(reviewEntry);
        try {
          for (const field of ["modelRequests", "inputTokens", "outputTokens"]) {
            if (reviewBudget[field] < 1) throw new Error(`No independent review ${field} budget remains`);
          }
          if (reviewBudget.priced && reviewBudget.currencyMicros <= 0) {
            throw new Error("No independent review currency budget remains");
          }
          const reviewTimeoutMs = Math.min(120000, testCase.limits.timeoutMs,
            scope.reviewOperationalBudget?.maxDurationMs ?? Number.MAX_SAFE_INTEGER);
          const reviewDeadlineAtMs = deadlineAfter(reviewStartedAtMs, reviewTimeoutMs);
          const reviewOperationalBudget = scope.reviewOperationalBudget ?
            allocateOperationalBudget(scope.reviewOperationalBudget, reviewBudget, reviewTimeoutMs, { review: true }) : undefined;
          const reviewExecution = Promise.resolve().then(async () => {
            try {
              checkDeadline(reviewDeadlineAtMs, reviewTimeoutMs, controller, `${testCase.id}:independent-review`);
              if (!reviewer) {
                const initialized = await importReviewer(args.reviewer);
                if (controller.signal.aborted) {
                  await initialized.close?.();
                  controller.signal.throwIfAborted();
                }
                reviewer = initialized;
              }
              await appendTrace(trace, { event: "independent_review_started", caseId: testCase.id,
                budgetAllocation: { semantics: "ceilings-only", usage: reviewBudget,
                  operationalBudget: reviewOperationalBudget, timeoutMs: reviewTimeoutMs },
                hardLimits: { status: "unattested" } });
              checkDeadline(reviewDeadlineAtMs, reviewTimeoutMs, controller, `${testCase.id}:independent-review`);
              return await reviewer.reviewCase({
                testCase: structuredClone(testCase),
                oracleCase: structuredClone(corpusOracles.cases[testCase.id]),
                fixtureGroundTruth: Object.fromEntries((corpusOracles.cases[testCase.id].fixtureRefs ?? [])
                  .filter((name) => Object.hasOwn(corpusOracles.fixtures ?? {}, name))
                  .map((name) => [name, structuredClone(corpusOracles.fixtures[name])])),
                authorizationGroundTruth: {
                  prerequisites: structuredClone(result.evidence.prerequisites),
                  resources: Object.fromEntries((corpusOracles.cases[testCase.id].fixtureRefs ?? [])
                    .filter((name) => scope.reviewResources?.[name]?.[testCase.agentProfile])
                    .map((name) => [name, structuredClone(scope.reviewResources[name][testCase.agentProfile])])),
                },
                evidence: structuredClone(result.evidence),
                resources: structuredClone(resources),
              }, {
                runId, runDir, signal: controller.signal, timeoutMs: reviewTimeoutMs, deadlineAtMs: reviewDeadlineAtMs,
                budget: Object.freeze({ ...reviewBudget }),
                ...(reviewOperationalBudget ? { operationalBudget: Object.freeze(reviewOperationalBudget) } : {}),
                async recordReviewCompletion(receipt) {
                  if (reviewEntry.settled || controller.signal.aborted || reviewTracker.failure) {
                    const error = reviewTracker.latch(new Error("review completion callback after accounting closed"));
                    controller.abort(error);
                    throw error;
                  }
                  const filename = `review-${createHash("sha256").update(testCase.id).digest("hex")}.private.json`;
                  await writeFile(join(runDir, filename), `${JSON.stringify(redact(receipt), null, 2)}\n`,
                    { flag: "wx", mode: 0o600 });
                },
                reportUsage(delta) {
                  try { reviewTracker.reportUsage(delta); }
                  catch (error) { controller.abort(error); throw error; }
                },
              });
            } catch (error) {
              reviewTracker.retainLowerBound(error);
              throw error;
            } finally { reviewEntry.settled = true; }
          });
          reviewExecution.catch(() => {});
          let review;
          try { review = await withTimeout(reviewExecution, reviewTimeoutMs, controller, `${testCase.id}:independent-review`, reviewDeadlineAtMs); }
          finally { reviewTracker.closeUsage(); }
          const reviewErrors = reviewTracker.reconcile(review?.usage);
          if (reviewErrors.length) throw new Error(reviewErrors.join("; "));
          controller.signal.throwIfAborted();
          if (review?.unknownEffects === true || review?.liveUnknown === true) {
            throw new Error("reviewer reported unknown post-dispatch state; usage and hard limits are unproven");
          }
          reviewEntry.hardLimits = checkBudgetAttestation(review?.budgetAttestation, reviewOperationalBudget, review?.cleanup, review?.usage);
          reviewUsed = addUsage(reviewUsed, review.usage);
          reviewEntry.complete = true;
          const grading = evaluateCorpusEvidence({
            testCase, oracleCase: corpusOracles.cases[testCase.id],
            evidence: result.evidence, semanticReview: review,
          });
          result.evidence = manifest.version === 2 ? { ...result.evidence, corpusGrading: grading } : {
            ...result.evidence, corpusGrading: grading,
            policyFacts: { ...result.evidence.policyFacts, ...grading.policyFacts },
            businessResult: grading.status === "passed" ? testCase.expected.businessResult : "failed",
            ...(grading.status === "blocked" ? { executionStatus: "infrastructure_blocked" } : {}),
          };
          await appendTrace(trace, { event: "independent_review", caseId: testCase.id, grading, usage: review.usage });
        } catch (error) {
          reviewTracker.retainLowerBound(error);
          reviewTracker.latch(error);
          stopReason ??= `independent review failed: ${error.message}`;
          result.evidence = { ...result.evidence,
            ...(manifest.version === 2 ? { unknownEffects: true } : { executionStatus: "infrastructure_blocked", businessResult: "failed" }),
            policyFacts: { ...result.evidence.policyFacts, independentOracleEvaluated: false, blockedReason: stopReason } };
        } finally { reviewTracker.close(); }
      }
      evidenceById.set(testCase.id, result.evidence);
      cleanupReceipts.push({ caseId: testCase.id, receipt: result.evidence.cleanup });
      await appendTrace(trace, { event: "case_evidence", caseId: testCase.id,
        evidence: summarizeEvidence(result.evidence, accounting.complete && !tracker.failure ? result.hardLimits : undefined) });
    }
    const closeFailures = await closeClients();
    const lateFailure = [...dutAccounting, ...reviewAccounting].find((entry) => entry.tracker.failure);
    if (lateFailure) stopReason ??= lateFailure.tracker.failure.message;
    const budgetAccounting = { dut: accountingSummary(dutAccounting), review: accountingSummary(reviewAccounting) };
    const report = evaluateRun(manifest, evidenceById, {
      runId, dryRun: false, manifestSha256, executionKind: manifest.stage ?? "offline",
      runMetadata: {
        runMetadataVersion: 1, budgetAccounting,
        connectionCleanupErrors: closeFailures.map((error) => error.message),
        ...(corpusOracles ? { independentReviewUsage: budgetAccounting.review.totals } : {}),
      },
    });
    report.cleanupReceipts = cleanupReceipts;
    // V2 case snapshots (including usage) are replay-bound. Uncertain accounting
    // belongs in report.budgetAccounting, never in edits to the evaluated cases.
    for (const item of manifest.version === 2 ? [] : report.cases) {
      const entry = dutAccounting.find((record) => record.caseId === item.id);
      if (!entry || !entry.complete || entry.tracker.failure) {
        item.usage = { status: "failed", accounting: entry ? "unknown" : "not_started", pricing: "unknown",
          ...Object.fromEntries(budgetFields.map((field) => [field, null])),
          observedLowerBound: entry ? { ...entry.tracker.observed } : null };
        if (entry?.controller.signal.aborted) {
          const receipt = cleanupReceipts.find((record) => record.caseId === item.id)?.receipt;
          if (receipt) receipt.quiescent = false;
        }
      }
    }
    report.limitations = [
      "Runner usage caps are admission and post-hoc checks, not provider hard enforcement; settings alone do not prove hard limits.",
      "Operational budget attestations are supplied by trusted JavaScript adapters. The runner checks their contract, not runtime enforcement or arbitrary JavaScript booleans independently. Legacy executions are explicitly unattested.",
      ...operationalBudgetGuidance,
      "A timeout, AbortSignal, abort acknowledgement, or cleaned:true receipt does not prove quiescence; unresolved or aborted execution stops the campaign with unknown accounting. Closed usage callbacks are rejected and latched, not added to final totals.",
      "Trusted JavaScript adapters can ignore AbortSignal; non-cooperative adapters are marked unknown and stop the campaign, but CPU-bound isolation requires a separate process adapter.",
    ];
    if (stopReason) report.stopReason = stopReason;
    await writeFile(reportPath, `${JSON.stringify(redact(report), null, 2)}\n`, { flag: "wx" });
    await hardenPrivatePath(reportPath, false);
    await appendTrace(trace, { event: "run_completed", passed: report.passed, stopReason });
    return { code: report.passed ? 0 : 1, reportPath, tracePath, report };
  } finally {
    const failures = await closeClients();
    await trace.close();
    if (failures.length) throw new AggregateError(failures, "Acceptance connection cleanup failed");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runAcceptance().then(({ code, reportPath }) => { console.log(JSON.stringify({ reportPath, code })); process.exitCode = code; }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
