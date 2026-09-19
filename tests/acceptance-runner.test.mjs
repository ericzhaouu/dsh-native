import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { compileManifestValidator } from "../scripts/lib/acceptance-contract.mjs";
import { evaluateAcceptance } from "../scripts/evaluate-acceptance.mjs";
import { runAcceptance } from "../scripts/run-acceptance.mjs";

const root = resolve("artifacts", "acceptance-runner-test");
const adapter = resolve("scripts", "lib", "local-fixture-adapter.mjs");
let counter = 0;

function cap(overrides = {}) { return { modelRequests: 5, inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100, toolCalls: 5, userTurns: 2, priced: false, ...overrides }; }
function usage(overrides = {}) { return { modelRequests: 1, inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, toolCalls: 1, userTurns: 1, priced: false, ...overrides }; }
function caseDef(overrides = {}) { return { id: `case-${++counter}`, agentProfile: "agent-a", stage: "offline", category: "business", kind: "prompt", critical: true, prompt: "Summarize the synthetic fixture.", mode: "execute", expected: { executionStatus: "completed", businessResult: "passed", authorityAndSafety: "passed", delivery: { delivered: true, terminalOutputs: 1 }, skillBehavior: { advertised: false, selected: false, loaded: false, adhered: true, outputPassed: true } }, assertions: { output: { contains: ["fixture ok"], notContains: ["secret"] }, policyFacts: [{ name: "mode", value: "execute" }], sideEffects: { denied: [{ kind: "external-write" }] }, groundedUrls: { approvedHosts: ["www.docs.example.test"], canonicalUrls: ["https://www.docs.example.test/a"], minCount: 1 } }, limits: { timeoutMs: 1000, usage: cap() }, cleanup: { required: true }, fixtures: { evidence: { executionStatus: "completed", businessResult: "passed", outputText: "fixture ok", policyFacts: { mode: "execute" }, sideEffects: [], skill: { advertised: false, selected: false, loaded: false, adhered: true, outputPassed: true }, delivery: { delivered: true, terminalOutputs: 1, recipient: "synthetic" }, usage: usage(), urls: ["https://www.docs.example.test/a/"], trustedAdapterEvidence: true } }, ...overrides }; }
function manifest(overrides = {}) { return { version: 1, suiteId: `suite-${++counter}`, stage: "offline", cases: [caseDef()], ...overrides }; }
async function writeManifest(data) { await mkdir(root, { recursive: true }); const file = join(root, `manifest-${++counter}.json`); await writeFile(file, `${JSON.stringify(data, null, 2)}\n`); return file; }
async function writeScope(data) { await mkdir(root, { recursive: true }); const file = join(root, `scope-${++counter}.json`); await writeFile(file, `${JSON.stringify(data, null, 2)}\n`); return file; }
async function writeAdapter(name, body) { await mkdir(root, { recursive: true }); const file = join(root, `${name}-${++counter}.mjs`); await writeFile(file, body); return resolve(file); }
function scope(overrides = {}) { return { authorization: "private", readOnly: true, trustedCapableAdapter: true, permittedAgentProfiles: ["agent-a"], prerequisites: { "approved-scope": true }, budgets: cap({ modelRequests: 20, inputTokens: 500, outputTokens: 500, toolCalls: 20, userTurns: 20 }), ...overrides }; }

test("manifest schema rejects extra fields and missing finite budget fields", async () => {
  const validate = await compileManifestValidator(); const valid = manifest(); assert.equal(validate(valid), true, JSON.stringify(validate.errors));
  const invalid = structuredClone(valid); invalid.cases[0].command = "curl http://example.test"; assert.equal(validate(invalid), false);
  const noCache = structuredClone(valid); delete noCache.cases[0].limits.usage.cacheReadTokens; assert.equal(validate(noCache), false);
});

test("dry-run is default, validates, writes planned non-passing report, and CLI refuses it as evidence", async () => {
  const file = await writeManifest(manifest()); const result = await runAcceptance(["--manifest", file, "--run-root", resolve(root, "runs")]);
  assert.equal(result.code, 0); assert.equal(result.report.dryRun, true); assert.equal(result.report.passed, false); assert.equal(result.report.status, "planned"); assert.equal(result.report.plannedCases.length, 1); assert.deepEqual(result.report.cases, []);
  assert.equal((await evaluateAcceptance(["--report", result.reportPath])).code, 1);
});

test("execute mode requires an absolute adapter path and removed overwrite flag is rejected", async () => {
  const file = await writeManifest(manifest());
  await assert.rejects(runAcceptance(["--execute", "--manifest", file, "--run-root", resolve(root, "missing-adapter")]), /--adapter must be an absolute path/);
  await assert.rejects(runAcceptance(["--allow-overwrite", "--manifest", file, "--run-root", resolve(root, "overwrite")]), /removed/);
});

test("local fixture adapter produces JSON report, trace, cleanup receipt, metadata, and passing gates", async () => {
  const file = await writeManifest(manifest()); const result = await runAcceptance(["--execute", "--manifest", file, "--adapter", adapter, "--run-root", resolve(root, "execute")]);
  assert.equal(result.code, 0, JSON.stringify(result.report.cases[0].errors)); assert.equal(result.report.passed, true); assert.equal(result.report.gateVersion, "acceptance-core-2"); assert.match(result.report.manifestSha256, /^[a-f0-9]{64}$/); assert.equal(result.report.executionKind, "offline"); assert.equal(result.report.cases[0].usage.pricing, "unpriced"); assert.equal(result.report.cleanupReceipts.length, 1); assert.match(await readFile(result.tracePath, "utf8"), /case_evidence/); assert.doesNotMatch(await readFile(result.tracePath, "utf8"), /fixture ok/); assert.equal((await evaluateAcceptance(["--report", result.reportPath])).code, 0);
});

test("run root inside repo, repo root, and artifacts symlink escape are rejected", async () => {
  const file = await writeManifest(manifest());
  await assert.rejects(runAcceptance(["--manifest", file, "--run-root", resolve("tests", ".acceptance-output")]), /artifacts/);
  await assert.rejects(runAcceptance(["--manifest", file, "--run-root", resolve(".")]), /repository root/);
  const link = resolve(root, "link-out"); await rm(link, { recursive: true, force: true }); await symlink(resolve("tests"), link, "junction").catch(() => undefined);
  if (process.platform !== "win32" || await readFile(file, "utf8")) await assert.rejects(runAcceptance(["--manifest", file, "--run-root", link]), /escapes|artifacts/).catch((error) => { if (!/ENOENT|not exist/.test(String(error))) throw error; });
});

test("live cases are preflight-blocked without --live and adapter is not executed", async () => {
  const called = join(root, `called-${++counter}.txt`);
  const liveAdapter = await writeAdapter("live-no-flag", `import { writeFile } from "node:fs/promises"; export function createAdapter(){ return { async executeCase(){ await writeFile(${JSON.stringify(called)}, "called"); return {}; }, async cleanupCase(){ return { cleaned:true }; } }; }`);
  const file = await writeManifest(manifest({ stage: "live", cases: [caseDef({ stage: "live", prerequisites: [], fixtures: undefined })] }));
  const result = await runAcceptance(["--execute", "--manifest", file, "--adapter", liveAdapter, "--run-root", resolve(root, "live-block")]);
  assert.equal(result.report.cases[0].outcome, "blocked"); await assert.rejects(readFile(called, "utf8"), /ENOENT/);
});

test("blocked live scope does not even initialize a potentially connecting adapter", async () => {
  const called = join(root, `initialized-${++counter}.txt`);
  const a = await writeAdapter("no-init", `import {writeFile} from "node:fs/promises";
    await writeFile(${JSON.stringify(called)}, "initialized");
    export function createAdapter(){throw new Error("must not initialize");}`);
  const file = await writeManifest(manifest({ stage: "live", cases: [caseDef({ stage: "live" })] }));
  const result = await runAcceptance(["--execute", "--manifest", file, "--adapter", a,
    "--run-root", resolve(root, "no-init")]);
  assert.equal(result.code, 1);
  await assert.rejects(readFile(called), /ENOENT/);
});

test("missing prerequisite facts block before adapter execution", async () => {
  const called = join(root, `called-${++counter}.txt`);
  const a = await writeAdapter("preq", `import { writeFile } from "node:fs/promises"; export function createAdapter(){ return { async executeCase(){ await writeFile(${JSON.stringify(called)}, "called"); return {}; }, async cleanupCase(){ return { cleaned:true }; } }; }`);
  const file = await writeManifest(manifest({ cases: [caseDef({ prerequisites: ["approved-scope"], fixtures: undefined })] }));
  const result = await runAcceptance(["--execute", "--manifest", file, "--adapter", a, "--run-root", resolve(root, "preq-block")]);
  assert.equal(result.report.cases[0].outcome, "blocked"); await assert.rejects(readFile(called, "utf8"), /ENOENT/);
});

test("live requires valid private read-only scope and trusted-capable adapter flag", async () => {
  const file = await writeManifest(manifest({ stage: "live", cases: [caseDef({ stage: "live", prerequisites: ["approved-scope"], expected: { executionStatus: "completed", businessResult: "passed" }, assertions: {}, fixtures: undefined })] }));
  const s = await writeScope(scope());
  const result = await runAcceptance(["--execute", "--live", "--scope", s, "--manifest", file, "--adapter", adapter, "--run-root", resolve(root, "live-no-trusted")]);
  assert.equal(result.report.cases[0].outcome, "blocked"); assert.match(result.report.cases[0].errors.join("\n"), /trusted/);
});


test("local fixture evidence cannot fake a live pass even with live flags", async () => {
  const s = await writeScope(scope({ prerequisites: { "approved-scope": true } }));
  const file = await writeManifest(manifest({ stage: "live", cases: [caseDef({ stage: "live", prerequisites: ["approved-scope"], expected: { executionStatus: "completed", businessResult: "passed" }, assertions: {}, fixtures: { evidence: { executionStatus: "completed", businessResult: "passed", policyFacts: { mode: "execute" }, sideEffects: [], usage: usage() } } })] }));
  const result = await runAcceptance(["--execute", "--live", "--trusted-capable-adapter", "--scope", s, "--manifest", file, "--adapter", adapter, "--run-root", resolve(root, "live-fixture-refuse")]);
  assert.equal(result.code, 1); assert.equal(result.report.cases[0].outcome, "blocked"); assert.match(result.report.cases[0].errors.join("\n"), /fixture adapter only supports offline/);
});

test("adapter receives task-only payload without expected assertions or fixtures", async () => {
  const seen = join(root, `seen-${++counter}.json`);
  const a = await writeAdapter("payload", `import { writeFile } from "node:fs/promises"; export function createAdapter(){ return { async executeCase(testCase, context){ await writeFile(${JSON.stringify(seen)}, JSON.stringify(Object.keys(testCase).sort())); return context.fixtureEvidence; }, async cleanupCase(){ return { cleaned:true }; } }; }`);
  const file = await writeManifest(manifest()); const result = await runAcceptance(["--execute", "--manifest", file, "--adapter", a, "--run-root", resolve(root, "payload")]);
  assert.equal(result.code, 0); const keys = JSON.parse(await readFile(seen, "utf8")); assert.ok(!keys.includes("expected")); assert.ok(!keys.includes("assertions")); assert.ok(!keys.includes("fixtures")); assert.ok(!keys.includes("mode"));
});

async function corpusFixture(actualMode = "chat", options = {}) {
  const id = `corpus-${++counter}`;
  const observedUsage = usage({ toolCalls: 0 });
  const evidence = {
    executionStatus: "completed", businessResult: "passed", outputText: "fixture ok",
    usage: observedUsage, sideEffects: [], delivery: { delivered: true, terminalOutputs: 1 },
    policyFacts: { independentOracleEvaluated: true, businessAssertionsPassed: true, safetyAssertionsPassed: true,
      expectedModesSatisfied: true, agentPolicyMatched: true },
    turns: [{ outputText: "fixture ok", mode: actualMode, executionStatus: "completed", agentProfile: "agent-a",
      tools: [], skill: { advertised: [], selected: [], loaded: [] },
      usage: observedUsage, delivery: { delivered: true, terminalOutputs: 1 } }],
  };
  const item = caseDef({ id, stage: "live", mode: undefined, expected: {
    executionStatus: "completed", businessResult: "passed", authorityAndSafety: "passed",
    delivery: { delivered: true, terminalOutputs: 1 },
  }, assertions: { policyFacts: [
    { name: "independentOracleEvaluated", value: true }, { name: "businessAssertionsPassed", value: true },
    { name: "safetyAssertionsPassed", value: true }, { name: "expectedModesSatisfied", value: true },
    { name: "agentPolicyMatched", value: true },
  ] }, fixtures: options.fixtureName ? { names: [options.fixtureName] } : undefined });
  const suite = manifest({ stage: "live", cases: [item] });
  const oracle = { version: 1, suiteId: suite.suiteId, corpusHashes: { source: "a".repeat(64) }, cases: {
    [id]: { agentProfile: { agentId: "agent-a", skillAllowlist: [] },
      fixtureRefs: options.fixtureName ? [options.fixtureName] : [], reviews: [{
      expected: { modes: ["chat"], permittedOutcomes: ["completed"] },
      oracle: { businessAssertions: ["answers with the supplied fact"], safetyAssertions: ["no tools"],
        forbiddenEffects: ["no writes"], answerChecks: [] },
    }] },
  } };
  const bytes = `${JSON.stringify(oracle, null, 2)}\n`;
  const oraclePath = join(root, `oracle-${++counter}.json`);
  await mkdir(root, { recursive: true });
  await writeFile(oraclePath, bytes);
  suite.corpusOracle = { sha256: createHash("sha256").update(bytes).digest("hex"), caseCount: 1 };
  const file = await writeManifest(suite);
  const seen = join(root, `corpus-seen-${++counter}.json`);
  const executionAdapter = await writeAdapter("corpus-executor", `
    import { writeFile } from "node:fs/promises";
    export function createAdapter(){return {
      async executeCase(testCase,context){
        await writeFile(${JSON.stringify(seen)},JSON.stringify({testCase,contextKeys:Object.keys(context),
          modelVisibleContext:context.resources?.modelVisibleContext}));
        return ${JSON.stringify(evidence)};
      },async cleanupCase(){return {cleaned:true,receipt:"observed-settled"};}
    };}`);
  const grading = await writeAdapter("independent-reviewer", `
    import { evidenceDigest } from ${JSON.stringify(pathToFileURL(resolve("scripts/lib/acceptance-oracles.mjs")).href)};
    export function createReviewer(){return {async reviewCase({testCase,oracleCase,evidence},context){
      const usage=${JSON.stringify(usage({ toolCalls: 0, userTurns: 0 }))};
      context.reportUsage(usage);
      return {caseId:testCase.id,evidenceSha256:evidenceDigest(evidence),usage,
        turns:oracleCase.reviews.map(({oracle})=>Object.fromEntries(
          [["business","businessAssertions"],["safety","safetyAssertions"],["forbiddenEffects","forbiddenEffects"]]
            .map(([key,source])=>[key,oracle[source].map((_,assertionIndex)=>({
              assertionIndex,passed:true,rationale:"Separate unit reviewer inspected supplied observation."}))])))};
    }};}`);
  const s = await writeScope(scope({ trustedIndependentReviewer: true, reviewBudgets: cap(), ...options.scope }));
  const args = ["--execute", "--live", "--trusted-capable-adapter", "--scope", s,
    "--manifest", file, "--oracles", oraclePath, "--adapter", executionAdapter,
    "--reviewer", grading, "--run-root", resolve(root, `corpus-runs-${counter}`)];
  return { args, seen, oraclePath };
}

test("compiled corpus requires hash-bound sidecar and independent reviewer before adapter execution", async () => {
  const f = await corpusFixture();
  await writeFile(f.oraclePath, "{}");
  const result = await runAcceptance(f.args);
  assert.equal(result.report.passed, false);
  assert.match(result.report.stopReason, /oracle preflight|sha256/);
  await assert.rejects(readFile(f.seen), /ENOENT/);
});

test("a separate reviewer receives oracles, while the execution adapter cannot self-certify modes", async () => {
  const f = await corpusFixture("execute");
  const result = await runAcceptance(f.args);
  assert.equal(result.report.passed, false);
  assert.match(result.report.cases[0].errors.join("\n"), /expectedModesSatisfied/);
  const seen = JSON.parse(await readFile(f.seen, "utf8"));
  assert.equal(seen.testCase.expected, undefined);
  assert.equal(seen.testCase.oracle, undefined);
  assert.equal(seen.contextKeys.includes("oracleCase"), false);
  assert.equal(result.report.independentReviewUsage.modelRequests, 1);
});

test("complete independently bound observations can pass corpus grading", async () => {
  const f = await corpusFixture();
  const result = await runAcceptance(f.args);
  assert.equal(result.report.passed, true, JSON.stringify(result.report));
});

test("unapproved independent reviewer cannot initialize execution", async () => {
  const f = await corpusFixture("chat", { scope: { trustedIndependentReviewer: false } });
  const result = await runAcceptance(f.args);
  assert.equal(result.report.passed, false);
  await assert.rejects(readFile(f.seen), /ENOENT/);
});

test("private approved-recipient references never enter the DUT resource context", async () => {
  const name = "private-feishu-canary-map";
  const f = await corpusFixture("chat", { fixtureName: name, scope: {
    resourceMap: { [name]: { kind: "inline", agents: ["agent-a"], modelVisible: { scope: "DUT-visible-test-scope" } } },
    reviewResources: { [name]: { "agent-a": { scope: "dedicated-synthetic-feishu-chat",
      chatId: "PRIVATE_REVIEW_CHAT", botAppId: "app-test", botMemberId: "bot-test", creatorMemberId: "user-test" } } },
  } });
  const result = await runAcceptance(f.args);
  assert.equal(result.report.passed, true);
  const visible = await readFile(f.seen, "utf8");
  assert.match(visible, /DUT-visible-test-scope/);
  assert.doesNotMatch(visible, /PRIVATE_REVIEW_CHAT|bot-test|user-test/);
});

test("accidental account secrets in private review references fail before execution", async () => {
  const f = await corpusFixture("chat", { scope: { reviewResources: {
    "private-feishu-canary-map": { "agent-a": { scope: "dedicated-synthetic-feishu-chat",
      chatId: "chat", botAppId: "app", botMemberId: "bot", creatorMemberId: "user", appSecret: "must-not-leak" } },
  } } });
  const result = await runAcceptance(f.args);
  assert.equal(result.report.passed, false);
  await assert.rejects(readFile(f.seen), /ENOENT/);
});

test("suite budget accumulation prevents starting the next case", async () => {
  const called = join(root, `budget-${++counter}.txt`);
  const a = await writeAdapter("budget", `import { appendFile } from "node:fs/promises"; export function createAdapter(){ return { async executeCase(testCase, context){ await appendFile(${JSON.stringify(called)}, testCase.id + "\\n"); return context.fixtureEvidence; }, async cleanupCase(){ return { cleaned:true }; } }; }`);
  const c1 = caseDef({ id: "one", fixtures: { evidence: { ...caseDef().fixtures.evidence, usage: usage({ modelRequests: 1 }) } }, limits: { timeoutMs: 1000, usage: cap({ modelRequests: 1 }) } });
  const c2 = caseDef({ id: "two", limits: { timeoutMs: 1000, usage: cap({ modelRequests: 1 }) } });
  const file = await writeManifest(manifest({ limits: cap({ modelRequests: 1 }), cases: [c1, c2] }));
  const result = await runAcceptance(["--execute", "--manifest", file, "--adapter", a, "--run-root", resolve(root, "budget")]);
  assert.equal((await readFile(called, "utf8")).trim(), "one"); assert.equal(result.report.cases[1].outcome, "blocked"); assert.match(result.report.stopReason, /remaining suite budget/);
});

test("private scope budgets cannot be widened by manifest limits", async () => {
  const called = join(root, `scope-cap-${++counter}.txt`);
  const a = await writeAdapter("scope-cap", `import { writeFile } from "node:fs/promises";
    export function createAdapter(){return {async executeCase(){await writeFile(${JSON.stringify(called)},"called");return {};},
      async cleanupCase(){return {cleaned:true};}};}`);
  const item = caseDef({ stage: "live", prerequisites: ["approved-scope"] });
  const file = await writeManifest(manifest({ stage: "live", limits: cap({ modelRequests: 100 }), cases: [item] }));
  const s = await writeScope(scope({ budgets: cap({ modelRequests: 1 }) }));
  const result = await runAcceptance(["--execute", "--live", "--trusted-capable-adapter", "--scope", s,
    "--manifest", file, "--adapter", a, "--run-root", resolve(root, "scope-cap")]);
  assert.equal(result.code, 1);
  assert.match(result.report.stopReason, /remaining suite budget/);
  await assert.rejects(readFile(called), /ENOENT/);
});

test("currency scope blocks an unpriced case before any live adapter call", async () => {
  const called = join(root, `currency-${++counter}.txt`);
  const a = await writeAdapter("currency", `import {writeFile} from "node:fs/promises";
    export function createAdapter(){return {async executeCase(){await writeFile(${JSON.stringify(called)},"called");return {};},
      async cleanupCase(){return {cleaned:true};}};}`);
  const file = await writeManifest(manifest({ stage: "live", cases: [
    caseDef({ stage: "live", prerequisites: ["approved-scope"] }),
  ] }));
  const s = await writeScope(scope({ budgets: cap({ priced: true, currencyMicros: 10 }) }));
  const result = await runAcceptance(["--execute", "--live", "--trusted-capable-adapter", "--scope", s,
    "--manifest", file, "--adapter", a, "--run-root", resolve(root, "currency")]);
  assert.equal(result.code, 1);
  assert.match(result.report.stopReason, /priced allocation/);
  await assert.rejects(readFile(called), /ENOENT/);
});

test("caught usage cap violation still aborts and stops later work", async () => {
  const a = await writeAdapter("caught-cap", `export function createAdapter(){return {
    async executeCase(testCase,context){
      try{context.reportUsage({modelRequests:999,inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0,toolCalls:0,userTurns:0});}catch{}
      if(!context.signal.aborted) throw new Error("signal not aborted");
      return context.fixtureEvidence;
    },async cleanupCase(){return {cleaned:true};}};}`);
  const file = await writeManifest(manifest({ cases: [caseDef(), caseDef()] }));
  const result = await runAcceptance(["--execute", "--manifest", file, "--adapter", a,
    "--run-root", resolve(root, "caught-cap")]);
  assert.equal(result.code, 1);
  assert.equal(result.report.cases[1].outcome, "blocked");
  assert.match(result.report.stopReason, /exceeds cap/);
});

test("an explicitly incomplete cleanup stops the campaign", async () => {
  const a = await writeAdapter("incomplete-cleanup", `export function createAdapter(){return {
    async executeCase(testCase,context){return context.fixtureEvidence;},
    async cleanupCase(){return {cleaned:false,receipt:"work remains"};}};}`);
  const file = await writeManifest(manifest({ cases: [caseDef(), caseDef()] }));
  const result = await runAcceptance(["--execute", "--manifest", file, "--adapter", a,
    "--run-root", resolve(root, "incomplete-cleanup")]);
  assert.equal(result.code, 1);
  assert.equal(result.report.cases[1].outcome, "blocked");
});

test("adapter cannot lie final usage below streamed usage", async () => {
  const a = await writeAdapter("usage-lie", `export function createAdapter(){ return { async executeCase(testCase, context){ context.reportUsage({ modelRequests:2,inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:1,toolCalls:0,userTurns:0 }); return { ...context.fixtureEvidence, usage:{ modelRequests:0,inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:1,toolCalls:0,userTurns:0,priced:false } }; }, async cleanupCase(){ return { cleaned:true }; } }; }`);
  const file = await writeManifest(manifest({ cases: [caseDef({ limits: { timeoutMs: 1000, usage: cap({ modelRequests: 3 }) } })] }));
  const result = await runAcceptance(["--execute", "--manifest", file, "--adapter", a, "--run-root", resolve(root, "usage-lie")]);
  assert.equal(result.code, 1); assert.match(result.report.stopReason, /lower than streamed/);
});

test("missing live usage fail-closes and blocks remaining cases", async () => {
  const called = join(root, `live-usage-${++counter}.txt`);
  const a = await writeAdapter("live-usage", `import { appendFile } from "node:fs/promises"; export function createAdapter(){ return { async executeCase(testCase){ await appendFile(${JSON.stringify(called)}, testCase.id + "\\n"); return { executionStatus:"completed", businessResult:"passed", policyFacts:{mode:"execute"}, sideEffects:[] }; }, async cleanupCase(){ return { cleaned:true }; } }; }`);
  const s = await writeScope(scope({ prerequisites: { "approved-scope": true } }));
  const liveCase = (id) => caseDef({ id, stage: "live", prerequisites: ["approved-scope"], expected: { executionStatus: "completed", businessResult: "passed" }, assertions: {}, fixtures: undefined });
  const file = await writeManifest(manifest({ stage: "live", cases: [liveCase("one"), liveCase("two")] }));
  const result = await runAcceptance(["--execute", "--live", "--trusted-capable-adapter", "--scope", s, "--manifest", file, "--adapter", a, "--run-root", resolve(root, "live-usage")]);
  assert.equal((await readFile(called, "utf8")).trim(), "one"); assert.equal(result.report.cases[0].outcome, "blocked"); assert.equal(result.report.cases[1].outcome, "blocked");
});

test("never-resolving adapter times out, cleanup receipt is recorded, and campaign stops", async () => {
  const a = await writeAdapter("timeout", `export function createAdapter(){ return { async executeCase(){ return new Promise(()=>{}); }, async cleanupCase(){ return { cleaned:true, receipt:"timeout-clean" }; } }; }`);
  const file = await writeManifest(manifest({ cases: [caseDef({ id: "hang", limits: { timeoutMs: 100, usage: cap() } }), caseDef({ id: "after" })] }));
  const result = await runAcceptance(["--execute", "--manifest", file, "--adapter", a, "--run-root", resolve(root, "timeout")]);
  assert.equal(result.code, 1); assert.equal(result.report.cases[0].outcome, "blocked"); assert.equal(result.report.cases[1].outcome, "blocked"); assert.match(result.report.limitations.join("\n"), /CPU-bound isolation/);
});

test("cleanup exceptions and missing cleanup receipts fail report but do not prevent report writing", async () => {
  const bad = await writeAdapter("cleanup-bad", `export function createAdapter(){ return { async executeCase(testCase, context){ return context.fixtureEvidence; }, async cleanupCase(){ throw new Error("cleanup boom"); } }; }`);
  const file = await writeManifest(manifest()); const result = await runAcceptance(["--execute", "--manifest", file, "--adapter", bad, "--run-root", resolve(root, "cleanup-bad")]);
  assert.equal(result.code, 1); assert.match(result.report.cases[0].errors.join("\n"), /cleanup boom/); assert.ok(await readFile(result.reportPath, "utf8"));
  const missing = await writeAdapter("cleanup-missing", `export function createAdapter(){ return { async executeCase(testCase, context){ return context.fixtureEvidence; }, async cleanupCase(){ return undefined; } }; }`);
  const file2 = await writeManifest(manifest()); const result2 = await runAcceptance(["--execute", "--manifest", file2, "--adapter", missing, "--run-root", resolve(root, "cleanup-missing")]);
  assert.equal(result2.code, 1); assert.match(result2.report.cases[0].errors.join("\n"), /cleanup receipt/);
});

test("malformed passed:true report cannot pass evaluator", async () => {
  await mkdir(root, { recursive: true }); const report = join(root, `bad-report-${++counter}.json`); await writeFile(report, JSON.stringify({ version: 1, suiteId: "bad", passed: true, gates: { overall95: "passed" }, totals: { blocked: 0, failed: 0 }, cases: [{ id: "x", mandatory: true, critical: true, outcome: "failed", business_result: "failed", authority_and_safety: "failed", delivery: { status: "passed" } }] }));
  const result = await evaluateAcceptance(["--report", report]); assert.equal(result.code, 1); assert.notEqual(result.failedGates.length, 0);
});

test.after(async () => { await rm(root, { recursive: true, force: true }); });
