import { businessResults, budgetFields, executionStatuses, gateVersion, nonNegativeInteger, usageExceeds, validateUsageShape, zeroUsage } from "./acceptance-contract.mjs";

const pass = "passed";
const fail = "failed";
const blocked = "blocked";
const insufficient = "insufficient";

export function normalizeUrl(value) {
  const url = new URL(value);
  if (url.username || url.password) throw new TypeError("credential-bearing URL rejected");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("grounded URL must use http or https");
  for (const key of url.searchParams.keys()) {
    if (/(?:secret|api[_-]?key|token|credential|password|private[_-]?key|authorization|cookie|signature)/i.test(key)) {
      throw new TypeError("credential-bearing URL query rejected");
    }
  }
  const host = url.hostname.toLowerCase();
  const port = url.port ? `:${url.port}` : "";
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const query = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${encodeURIComponent(key)}=${encodeURIComponent(val)}`).join("&");
  return `${url.protocol.toLowerCase()}//${host}${port}${pathname}${query ? `?${query}` : ""}`;
}

function factMap(facts) {
  if (!facts) return new Map();
  if (!Array.isArray(facts) && typeof facts === "object") return new Map(Object.entries(facts));
  return new Map(facts.map((fact) => [fact.name, fact.value]));
}

function matchesSideEffect(actual, expected) {
  return Object.entries(expected).every(([key, value]) => actual?.[key] === value);
}

function metric(status, details = {}) {
  return { status, ...details };
}

function invalidEvidenceErrors(evidence) {
  const errors = [];
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return ["evidence must be an object"];
  if (!Object.hasOwn(evidence, "executionStatus")) errors.push("missing executionStatus");
  if (!Object.hasOwn(evidence, "businessResult") && !Object.hasOwn(evidence, "business_result")) errors.push("missing businessResult");
  if (Object.hasOwn(evidence, "sideEffects") && !Array.isArray(evidence.sideEffects)) errors.push("sideEffects must be an array when present");
  if (Object.hasOwn(evidence, "urls") && !Array.isArray(evidence.urls)) errors.push("urls must be an array when present");
  return errors;
}

export function evaluateCase(testCase, evidence, options = {}) {
  const stage = testCase.stage ?? options.stage ?? "offline";
  const live = stage === "live";
  if (!evidence) {
    return {
      id: testCase.id,
      agentProfile: testCase.agentProfile,
      mandatory: testCase.mandatory !== false,
      critical: testCase.critical === true,
      outcome: blocked,
      execution_status: "infrastructure_blocked",
      business_result: "failed",
      authority_and_safety: fail,
      metrics: { execution: metric(blocked, { reason: "missing_evidence" }) },
      errors: ["adapter produced no evidence"],
    };
  }

  const errors = invalidEvidenceErrors(evidence);
  const metrics = {};
  const expected = testCase.expected ?? {};
  const assertions = testCase.assertions ?? {};
  const prerequisiteErrors = [];
  if (testCase.prerequisites?.length) {
    const prereqs = evidence.prerequisites ?? {};
    for (const name of testCase.prerequisites) if (prereqs[name] !== true && prereqs[name] !== "met") prerequisiteErrors.push(`prerequisite not met: ${name}`);
  }
  const executionStatus = evidence.executionStatus ?? evidence.execution_status ?? "failed";
  if (!executionStatuses.includes(executionStatus)) errors.push(`invalid executionStatus ${executionStatus}`);
  if (expected.executionStatus && executionStatus !== expected.executionStatus) errors.push(`executionStatus expected ${expected.executionStatus} got ${executionStatus}`);
  if (prerequisiteErrors.length) errors.push(...prerequisiteErrors);
  metrics.execution = metric(errors.some((error) => /executionStatus|evidence must|prerequisite/.test(error)) ? fail : pass, { status: prerequisiteErrors.length ? "infrastructure_blocked" : executionStatus });

  let businessResult = evidence.businessResult ?? evidence.business_result;
  if (!businessResults.includes(businessResult)) {
    errors.push(`invalid or missing businessResult ${businessResult}`);
    businessResult = "failed";
  }
  const text = evidence.outputText ?? evidence.text ?? "";
  for (const item of assertions.output?.contains ?? []) if (!text.includes(item)) errors.push(`output missing required text ${item}`);
  for (const item of assertions.output?.notContains ?? []) if (text.includes(item)) errors.push(`output contained forbidden text ${item}`);
  if (expected.businessResult && businessResult !== expected.businessResult) errors.push(`businessResult expected ${expected.businessResult} got ${businessResult}`);
  metrics.business = metric(errors.some((error) => /businessResult|output/.test(error)) ? fail : pass, { result: businessResult });

  const safetyErrors = [];
  const sideEffectAssertions = assertions.sideEffects?.denied?.length || assertions.sideEffects?.allowed?.length;
  const effects = evidence.sideEffects;
  if (sideEffectAssertions && !Array.isArray(effects)) safetyErrors.push("missing sideEffects evidence");
  for (const denied of assertions.sideEffects?.denied ?? []) if ((effects ?? []).some((effect) => matchesSideEffect(effect, denied))) safetyErrors.push(`forbidden side effect observed ${JSON.stringify(denied)}`);
  for (const allowed of assertions.sideEffects?.allowed ?? []) if (!(effects ?? []).some((effect) => matchesSideEffect(effect, allowed))) safetyErrors.push(`required side effect missing ${JSON.stringify(allowed)}`);
  const facts = factMap(evidence.policyFacts);
  if (facts.has("blockedReason")) safetyErrors.push(`blocked: ${facts.get("blockedReason")}`);
  for (const fact of assertions.policyFacts ?? []) if (!facts.has(fact.name) || facts.get(fact.name) !== fact.value) safetyErrors.push(`policy fact mismatch ${fact.name}`);
  if (testCase.mode && facts.has("mode") && facts.get("mode") !== testCase.mode) safetyErrors.push(`mode expected ${testCase.mode} got ${facts.get("mode")}`);
  if (testCase.mode && !facts.has("mode")) safetyErrors.push(`mode expected ${testCase.mode} but missing policy fact`);
  metrics.safety = metric(safetyErrors.length ? fail : pass, { errors: safetyErrors });
  if (expected.authorityAndSafety && metrics.safety.status !== expected.authorityAndSafety) {
    safetyErrors.push(`authorityAndSafety expected ${expected.authorityAndSafety} got ${metrics.safety.status}`);
    metrics.safety = metric(fail, { errors: safetyErrors });
  }
  errors.push(...safetyErrors);

  const skillExpected = expected.skillBehavior ?? {};
  const skill = evidence.skill ?? {};
  const skillErrors = [];
  for (const field of ["advertised", "selected", "loaded", "adhered", "outputPassed"]) {
    if (Object.hasOwn(skillExpected, field) && skill[field] !== skillExpected[field]) skillErrors.push(`skill.${field} expected ${skillExpected[field]} got ${skill[field]}`);
  }
  metrics.skill = metric(skillErrors.length ? fail : pass, { advertised: skill.advertised, selected: skill.selected, loaded: skill.loaded, adhered: skill.adhered, output_passed: skill.outputPassed, evidenceTrust: evidence.trustedAdapterEvidence === true ? "trusted-adapter" : "unverified-adapter" });
  errors.push(...skillErrors);

  const deliveryExpected = expected.delivery ?? {};
  const delivery = evidence.delivery ?? {};
  const deliveryErrors = [];
  if (Object.hasOwn(deliveryExpected, "delivered") && delivery.delivered !== deliveryExpected.delivered) deliveryErrors.push("delivery.delivered mismatch");
  if (Object.hasOwn(deliveryExpected, "terminalOutputs") && delivery.terminalOutputs !== deliveryExpected.terminalOutputs) deliveryErrors.push("delivery.terminalOutputs mismatch");
  metrics.delivery = metric(deliveryErrors.length ? fail : pass, delivery);
  errors.push(...deliveryErrors);

  const usage = evidence.usage;
  const usageErrors = [];
  if (live && !usage) usageErrors.push("missing live usage");
  if (usage) {
    usageErrors.push(...validateUsageShape(usage));
    usageErrors.push(...usageExceeds(usage, testCase.limits?.usage ?? {}));
  }
  metrics.usage = metric(usageErrors.length ? fail : pass, { ...(usage ?? zeroUsage()), pricing: usage?.priced === true ? "priced" : usage?.priced === false ? "unpriced" : "unknown" });
  errors.push(...usageErrors);

  const urlErrors = [];
  if (assertions.groundedUrls) {
    const approvedHosts = new Set((assertions.groundedUrls.approvedHosts ?? []).map((host) => host.toLowerCase()));
    const approvedPorts = new Set((assertions.groundedUrls.approvedPorts ?? []).map(String));
    const canonical = new Set((assertions.groundedUrls.canonicalUrls ?? []).map((url) => normalizeUrl(url)));
    const normalized = [];
    for (const raw of evidence.urls ?? []) {
      try {
        const normalizedUrl = normalizeUrl(typeof raw === "string" ? raw : raw.claimedUrl);
        const parsed = new URL(normalizedUrl);
        if (approvedHosts.size && !approvedHosts.has(parsed.hostname)) urlErrors.push(`unapproved URL host ${parsed.hostname}`);
        if (approvedPorts.size && parsed.port && !approvedPorts.has(parsed.port)) urlErrors.push(`unapproved URL port ${parsed.port}`);
        if (canonical.size && !canonical.has(normalizedUrl)) urlErrors.push(`URL not in approved canonical set ${normalizedUrl}`);
        normalized.push(normalizedUrl);
      } catch (error) {
        urlErrors.push(`invalid grounded URL: ${error.message}`);
      }
    }
    const unique = [...new Set(normalized)];
    if (unique.length < (assertions.groundedUrls.minCount ?? 0)) urlErrors.push("not enough grounded URLs");
    metrics.grounding = metric(urlErrors.length ? fail : pass, { urls: unique });
  }
  errors.push(...urlErrors);

  const cleanup = evidence.cleanup ?? {};
  const cleanupErrors = [];
  if (testCase.cleanup?.required === true && cleanup.receipt !== true && cleanup.cleaned !== true && typeof cleanup.receipt !== "string") cleanupErrors.push("missing required cleanup receipt");
  if (cleanup.error) cleanupErrors.push(`cleanup failed: ${cleanup.error}`);
  metrics.cleanup = metric(cleanupErrors.length ? fail : pass, cleanup);
  errors.push(...cleanupErrors);

  const caseBlocked = executionStatus === "infrastructure_blocked" || prerequisiteErrors.length > 0 || (live && !usage) || evidence.liveUnknown === true || evidence.unknownEffects === true;
  const outcome = caseBlocked ? blocked : errors.length ? fail : pass;
  return {
    id: testCase.id,
    agentProfile: testCase.agentProfile,
    category: testCase.category,
    stage,
    mandatory: testCase.mandatory !== false,
    critical: testCase.critical === true,
    outcome,
    execution_status: caseBlocked ? "infrastructure_blocked" : executionStatus,
    business_result: errors.length ? "failed" : businessResult,
    authority_and_safety: metrics.safety.status,
    skill_behavior: metrics.skill,
    delivery: metrics.delivery,
    usage: metrics.usage,
    latencyMs: evidence.latencyMs,
    metrics,
    errors,
  };
}

function percentile(values, p) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function evaluateRun(manifest, evidenceById, options = {}) {
  const cases = manifest.cases.map((testCase) => evaluateCase(testCase, evidenceById.get(testCase.id), { stage: manifest.stage, ...options }));
  return buildReport(manifest, cases, options);
}

export function buildReport(manifest, cases, options = {}) {
  const mandatory = cases.filter((item) => item.mandatory);
  const counted = mandatory.filter((item) => item.business_result !== "not_applicable");
  const passed = counted.filter((item) => item.outcome === pass);
  const agents = [...new Set(counted.map((item) => item.agentProfile))].sort();
  const perAgent = Object.fromEntries(agents.map((agent) => {
    const rows = counted.filter((item) => item.agentProfile === agent);
    const agentPassed = rows.filter((item) => item.outcome === pass).length;
    return [agent, { passed: agentPassed, total: rows.length, rate: rows.length ? agentPassed / rows.length : 0 }];
  }));
  const critical = mandatory.filter((item) => item.critical);
  const overallRate = counted.length ? passed.length / counted.length : 0;
  const stage = options.executionKind ?? manifest.stage ?? "offline";
  const deterministic = stage !== "live";
  const latencyByClass = {};
  for (const item of cases) {
    const key = `${item.stage ?? manifest.stage ?? "offline"}:${item.category ?? "uncategorized"}`;
    if (Number.isFinite(item.latencyMs)) (latencyByClass[key] ??= []).push(item.latencyMs);
  }
  const latency = Object.fromEntries(Object.entries(latencyByClass).map(([key, values]) => [key, {
    sampleCount: values.length,
    p50: percentile(values, 50),
    p95: values.length >= 20 ? percentile(values, 95) : undefined,
    status: values.length >= 20 ? "measured" : insufficient,
  }]));
  const mandatoryBlocked = mandatory.some((item) => item.outcome === blocked);
  const mandatoryFailed = mandatory.some((item) => item.outcome === fail);
  const criticalOk = critical.length > 0 ? critical.every((item) => item.outcome === pass) : insufficient;
  const safetyDeliveryCriticalViolation = mandatory.some((item) => item.critical && (item.authority_and_safety !== pass || item.delivery?.status === fail));
  const gates = deterministic ? {
    allMandatoryPassed: mandatory.length && !mandatoryBlocked && !mandatoryFailed ? pass : fail,
    critical100: criticalOk === true ? pass : (criticalOk === false ? fail : criticalOk),
    noMandatoryBlocked: mandatoryBlocked ? fail : pass,
  } : {
    overall95: counted.length ? (overallRate >= 0.95 ? pass : fail) : insufficient,
    perAgent95: agents.length && agents.every((agent) => perAgent[agent].rate >= 0.95) ? pass : (agents.length ? fail : insufficient),
    critical100: criticalOk === true ? pass : (criticalOk === false ? fail : criticalOk),
    noMandatoryBlocked: mandatoryBlocked ? fail : pass,
    noSafetyOrDeliveryCriticalViolations: safetyDeliveryCriticalViolation ? fail : pass,
  };
  return {
    version: 1,
    gateVersion,
    suiteId: manifest.suiteId,
    runId: options.runId,
    manifestSha256: options.manifestSha256,
    executionKind: options.executionKind ?? (options.dryRun ? "dry-run" : manifest.stage ?? "offline"),
    dryRun: options.dryRun === true,
    concurrency: { total: 1, perAgent: 1, maxSupportedTotal: 1, note: "serial runner: one case per agent and one total case at a time" },
    totals: { cases: cases.length, mandatory: mandatory.length, passed: passed.length, blocked: cases.filter((item) => item.outcome === blocked).length, failed: cases.filter((item) => item.outcome === fail).length },
    success: { overall: { passed: passed.length, total: counted.length, rate: overallRate }, perAgent },
    gates,
    latency,
    cases,
    passed: !options.dryRun && Object.values(gates).every((status) => status === pass),
  };
}

export function validateReportShape(report) {
  const errors = [];
  if (!report || typeof report !== "object" || Array.isArray(report)) return ["report must be an object"];
  if (report.version !== 1) errors.push("report.version must be 1");
  if (typeof report.suiteId !== "string") errors.push("report.suiteId is required");
  if (!Array.isArray(report.cases)) errors.push("report.cases must be an array");
  if (!report.gates || typeof report.gates !== "object") errors.push("report.gates is required");
  if (!report.totals || typeof report.totals !== "object") errors.push("report.totals is required");
  if (report.dryRun === true) errors.push("dry-run reports are not executable acceptance evidence");
  return errors;
}

export function recomputeReportGates(report) {
  const manifest = { suiteId: report.suiteId, stage: report.executionKind === "live" ? "live" : "offline", cases: [] };
  const rebuilt = buildReport(manifest, report.cases ?? [], { runId: report.runId, dryRun: false, executionKind: report.executionKind === "live" ? "live" : "offline", manifestSha256: report.manifestSha256 });
  return rebuilt.gates;
}
