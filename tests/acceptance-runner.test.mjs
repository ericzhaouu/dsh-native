import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { compileManifestValidator } from "../scripts/lib/acceptance-contract.mjs";
import { evaluateAcceptance } from "../scripts/evaluate-acceptance.mjs";
import { runAcceptance } from "../scripts/run-acceptance.mjs";

const root = resolve("artifacts", "acceptance-runner-test");
const adapter = resolve("scripts", "lib", "local-fixture-adapter.mjs");
let counter = 0;

function cap(overrides = {}) { return { modelRequests: 5, inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100, toolCalls: 5, userTurns: 2, priced: false, ...overrides }; }
function usage(overrides = {}) { return { modelRequests: 1, inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, toolCalls: 1, userTurns: 1, priced: false, ...overrides }; }
function operationalBudget(overrides = {}) { return { maxModelRequests: 20, maxInputTokens: 1000, maxOutputTokens: 500, maxToolCalls: 20, maxDurationMs: 2000, ...overrides }; }
function caseDef(overrides = {}) { return { id: `case-${++counter}`, agentProfile: "agent-a", stage: "offline", category: "business", kind: "prompt", critical: true, prompt: "Summarize the synthetic fixture.", mode: "execute", expected: { executionStatus: "completed", businessResult: "passed", authorityAndSafety: "passed", delivery: { delivered: true, terminalOutputs: 1 }, skillBehavior: { advertised: false, selected: false, loaded: false, adhered: true, outputPassed: true } }, assertions: { output: { contains: ["fixture ok"], notContains: ["secret"] }, policyFacts: [{ name: "mode", value: "execute" }], sideEffects: { denied: [{ kind: "external-write" }] }, groundedUrls: { approvedHosts: ["www.docs.example.test"], canonicalUrls: ["https://www.docs.example.test/a"], minCount: 1 } }, limits: { timeoutMs: 1000, usage: cap() }, cleanup: { required: true }, fixtures: { evidence: { executionStatus: "completed", businessResult: "passed", outputText: "fixture ok", policyFacts: { mode: "execute" }, sideEffects: [], skill: { advertised: false, selected: false, loaded: false, adhered: true, outputPassed: true }, delivery: { delivered: true, terminalOutputs: 1, recipient: "synthetic" }, usage: usage(), urls: ["https://www.docs.example.test/a/"], trustedAdapterEvidence: true } }, ...overrides }; }
function manifest(overrides = {}) { return { version: 1, suiteId: `suite-${++counter}`, stage: "offline", cases: [caseDef()], ...overrides }; }
async function writeManifest(data) { await mkdir(root, { recursive: true }); const file = join(root, `manifest-${++counter}.json`); await writeFile(file, `${JSON.stringify(data, null, 2)}\n`); return file; }
async function writeScope(data) { await mkdir(root, { recursive: true }); const file = join(root, `scope-${++counter}.json`); await writeFile(file, `${JSON.stringify(data, null, 2)}\n`); return file; }
async function writeAdapter(name, body) { await mkdir(root, { recursive: true }); const file = join(root, `${name}-${++counter}.mjs`); await writeFile(file, body); return resolve(file); }
function scope(overrides = {}) { return { authorization: "private", readOnly: true, trustedCapableAdapter: true, permittedAgentProfiles: ["agent-a"], prerequisites: { "approved-scope": true }, budgets: cap({ modelRequests: 20, inputTokens: 500, outputTokens: 500, toolCalls: 20, userTurns: 20 }), ...overrides }; }

function assertBudgetGuidance(text) {
  assert.match(text, /legacy\/default executions remain unattested/);
  assert.match(text, /BEFORE every dispatch/);
  assert.match(text, /minimum of global operationalBudget and exact-agent operationalBudgetByAgent/);
  assert.match(text, /fit every remaining case\/campaign allocation, including duration/);
  assert.match(text, /ceilings, not automatic native narrowing/);
  assert.match(text, /Chat messages or prompt text cannot enforce/);
  assert.match(text, /prepared full contextWindow.*not guessed nominal prompt tokens/);
  assert.match(text, /Cache read\/write allocations cannot fund/);
  assert.match(text, /actual runtime enforcement\/settlement proof plus successful quiescent cleanup/);
  assert.match(text, /fenced\/locked runtimes remain unknown, never known zero or attested/);
  assert.match(text, /strictly below the case\/review deadline with setup headroom/);
  assert.match(text, /waiting timeouts do not guarantee remote abort or quiescence/);
  assert.match(text, /EACH remaining cacheReadTokens\/cacheWriteTokens allocation/);
  assert.match(text, /priced\/currency allocations.*rejected before dispatch/);
  assert.match(text, /outstandingReservations.*unresolvedExposure.*incomplete journals cannot release/);
}

test("CLI help explains configured-cap admission, full-context reservations, and legacy defaults", () => {
  const result = spawnSync(process.execPath, [resolve("scripts", "run-acceptance.mjs"), "--help"],
    { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assertBudgetGuidance(result.stdout);
});

test("manifest schema rejects extra fields and missing finite budget fields", async () => {
  const validate = await compileManifestValidator(); const valid = manifest(); assert.equal(validate(valid), true, JSON.stringify(validate.errors));
  const invalid = structuredClone(valid); invalid.cases[0].command = "curl http://example.test"; assert.equal(validate(invalid), false);
  const noCache = structuredClone(valid); delete noCache.cases[0].limits.usage.cacheReadTokens; assert.equal(validate(noCache), false);
});

test("dry-run is default, validates, writes planned non-passing report, and CLI refuses it as evidence", async () => {
  const file = await writeManifest(manifest()); const result = await runAcceptance(["--manifest", file, "--run-root", resolve(root, "runs")]);
  assert.equal(result.code, 0); assert.equal(result.report.dryRun, true); assert.equal(result.report.passed, false); assert.equal(result.report.status, "planned"); assert.equal(result.report.plannedCases.length, 1); assert.deepEqual(result.report.cases, []);
  assertBudgetGuidance(result.report.limitations.join("\n"));
  const started = JSON.parse((await readFile(result.tracePath, "utf8")).trim().split("\n")[0]);
  assertBudgetGuidance(started.operationalBudgetGuidance.join("\n"));
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

test("runner resource preparation consumes the inherited case deadline before Gateway dispatch", async (t) => {
  for (const elapsed of [800, 1100]) {
    await t.test(`${elapsed}ms resource preparation`, async (t) => {
      let now = 10000;
      t.mock.method(Date, "now", () => now);
      const map = join(root, `deadline-resources-${++counter}.json`);
      await mkdir(root, { recursive: true });
      await writeFile(map, JSON.stringify({ version: 1, resources: { sample: {
        kind: "inline", agents: ["agent-a"], modelVisible: { topic: "synthetic" },
      } } }));
      const originalRead = fs.readFile;
      const readMock = t.mock.method(fs, "readFile", async (path, ...args) => {
        const result = await originalRead(path, ...args);
        if (path === map) now += elapsed;
        return result;
      });
      syncBuiltinESMExports();
      t.after(() => { readMock.mock.restore(); syncBuiltinESMExports(); });
      const key = `deadlineRunner${++counter}`;
      const state = globalThis[key] = { initializations: 0, sends: 0 };
      t.after(() => { delete globalThis[key]; });
      const runtimeCap = operationalBudget({ maxModelRequests: 2, maxInputTokens: 50,
        maxOutputTokens: 25, maxToolCalls: 2, maxDurationMs: 500 });
      const adapterPath = await writeAdapter("deadline-gateway", `
        import { createGatewayAcceptanceAdapter } from ${JSON.stringify(pathToFileURL(resolve("scripts", "lib", "gateway-acceptance-adapter.mjs")).href)};
        export async function createAdapter() {
          const state = globalThis[${JSON.stringify(key)}]; state.initializations++;
          const adapter = await createGatewayAcceptanceAdapter({
            config: {hostRoot:${JSON.stringify(root)},configPath:${JSON.stringify(join(root, "host.json"))},
              stateDir:${JSON.stringify(root)},nativeStateDir:${JSON.stringify(join(root, "native"))},
              gatewayUrl:"ws://127.0.0.1:18789",agentMap:{"agent-a":"agent-a"},
              allowedAgentIds:["agent-a"],ownedSessionPrefix:"acceptance-deadline"},
            connectionFactory:async()=>({hostConfig:{plugins:{entries:{"dsh-native":{config:{
              operationalBudget:${JSON.stringify(runtimeCap)}}}}}},assertHealthy(){},
              client:{async request(method,params){
                if(method==="sessions.create")return {ok:true,key:params.key,entry:{sessionId:"fixture",permissionMode:"read-only"}};
                state.sends++; throw new Error("unexpected model dispatch");
              },async stopAndWait(){}}})
          });
          return {...adapter,async executeCase(testCase,context){
            state.deadlineAtMs=context.deadlineAtMs; state.remaining=context.deadlineAtMs-Date.now();
            return adapter.executeCase(testCase,context);
          }};
        }`);
      const cacheAllocation = { cacheReadTokens: 50, cacheWriteTokens: 50 };
      const file = await writeManifest(manifest({ cases: [caseDef({ fixtures: { names: ["sample"] },
        limits: { timeoutMs: 1000, usage: cap(cacheAllocation) } })] }));
      const s = await writeScope(scope({ resourceMapPath: map, operationalBudget: operationalBudget(),
        budgets: cap(cacheAllocation) }));
      const result = await runAcceptance(["--execute", "--manifest", file, "--scope", s, "--adapter", adapterPath,
        "--run-root", resolve(root, `deadline-runs-${counter}`)]);
      assert.equal(result.code, 1);
      assert.equal(state.sends, 0);
      if (elapsed === 800) {
        assert.equal(state.deadlineAtMs, 11000);
        assert.equal(state.remaining, 200);
        assert.match(result.report.stopReason, /maxDurationMs.*remaining/);
      } else {
        assert.equal(state.initializations, 0);
        assert.match(result.report.stopReason, /timed out/);
      }
    });
  }
});

async function corpusFixture(actualMode = "chat", options = {}) {
  const id = `corpus-${++counter}`;
  const observedUsage = usage({ toolCalls: 0, ...options.usage });
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
  const suite = manifest({ stage: "live", cases: Array.from({ length: options.caseCount ?? 1 },
    (_, index) => ({ ...item, id: index ? `${id}-${index}` : id })), ...options.manifest });
  const oracle = { version: 1, suiteId: suite.suiteId, corpusHashes: { source: "a".repeat(64) }, cases: {
    [id]: { agentProfile: { agentId: "agent-a", skillAllowlist: [] },
      fixtureRefs: options.fixtureName ? [options.fixtureName] : [], reviews: [{
      expected: { modes: ["chat"], permittedOutcomes: ["completed"] },
      oracle: { businessAssertions: ["answers with the supplied fact"], safetyAssertions: ["no tools"],
        forbiddenEffects: ["no writes"], answerChecks: [] },
    }] },
  } };
  for (const extra of suite.cases.slice(1)) oracle.cases[extra.id] = structuredClone(oracle.cases[id]);
  const bytes = `${JSON.stringify(oracle, null, 2)}\n`;
  const oraclePath = join(root, `oracle-${++counter}.json`);
  await mkdir(root, { recursive: true });
  await writeFile(oraclePath, bytes);
  suite.corpusOracle = { sha256: createHash("sha256").update(bytes).digest("hex"), caseCount: suite.cases.length };
  const file = await writeManifest(suite);
  const seen = join(root, `corpus-seen-${++counter}.json`);
  const reviewSeen = join(root, `review-seen-${++counter}.json`);
  const executionAdapter = await writeAdapter("corpus-executor", `
    import { writeFile } from "node:fs/promises";
    export function createAdapter(){return {
      async executeCase(testCase,context){
        await writeFile(${JSON.stringify(seen)},JSON.stringify({testCase,contextKeys:Object.keys(context),
          budget:context.budget,operationalBudget:context.operationalBudget,
          modelVisibleContext:context.resources?.modelVisibleContext}));
        ${options.execute ?? ""}
        return ${JSON.stringify(evidence)};
      },async cleanupCase(){return {cleaned:true,quiescent:true,receipt:"observed-settled"};}
    };}`);
  const grading = await writeAdapter("independent-reviewer", `
    import { evidenceDigest } from ${JSON.stringify(pathToFileURL(resolve("scripts/lib/acceptance-oracles.mjs")).href)};
    import { writeFile } from "node:fs/promises";
    let reviewContext;
    export function createReviewer(){${options.reviewInitialize ?? ""} return {async reviewCase({testCase,oracleCase,evidence},context){
      reviewContext=context;
      await writeFile(${JSON.stringify(reviewSeen)},JSON.stringify({budget:context.budget,
        operationalBudget:context.operationalBudget,timeoutMs:context.timeoutMs}));
      const usage=${JSON.stringify(usage({ toolCalls: 0, userTurns: 0 }))};
      ${options.review ?? ""}
      ${options.catchUsage ? "try { context.reportUsage(usage); } catch {}" : "context.reportUsage(usage);"}
      return {caseId:testCase.id,evidenceSha256:evidenceDigest(evidence),usage,${options.reviewResult ?? ""}
        turns:oracleCase.reviews.map(({oracle})=>Object.fromEntries(
          [["business","businessAssertions"],["safety","safetyAssertions"],["forbiddenEffects","forbiddenEffects"]]
            .map(([key,source])=>[key,oracle[source].map((_,assertionIndex)=>({
              assertionIndex,passed:true,rationale:"Separate unit reviewer inspected supplied observation."}))])))};
    },async close(){${options.reviewClose ?? ""}}};}`);
  const s = await writeScope(scope({ trustedIndependentReviewer: true, reviewBudgets: cap(), ...options.scope }));
  const args = ["--execute", "--live", "--trusted-capable-adapter", "--scope", s,
    "--manifest", file, "--oracles", oraclePath, "--adapter", executionAdapter,
    "--reviewer", grading, "--run-root", resolve(root, `corpus-runs-${counter}`)];
  return { args, seen, reviewSeen, oraclePath, file, scopePath: s };
}

test("runner review deadline includes reviewer initialization and does not hand out a fresh timeout", async (t) => {
  const key = `reviewDeadline${++counter}`;
  const clock = globalThis[key] = { now: 10000, sends: 0 };
  t.after(() => { delete globalThis[key]; });
  t.mock.method(Date, "now", () => clock.now);
  const f = await corpusFixture("chat", {
    reviewInitialize: `globalThis[${JSON.stringify(key)}].now += 800;`,
    review: `
      const {assertBudgetFitsDeadline} = await import(${JSON.stringify(pathToFileURL(resolve("scripts", "lib", "gateway-acceptance-adapter.mjs")).href)});
      globalThis[${JSON.stringify(key)}].remaining = context.deadlineAtMs-Date.now();
      assertBudgetFitsDeadline({maxDurationMs:500},context.deadlineAtMs);
      globalThis[${JSON.stringify(key)}].sends++;
    `,
  });
  const result = await runAcceptance(f.args);
  assert.equal(result.code, 1);
  assert.equal(clock.remaining, 200);
  assert.equal(clock.sends, 0);
  assert.match(result.report.stopReason, /maxDurationMs.*remaining/);
  assert.equal(result.report.budgetAccounting.review.status, "unknown");
});

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

test("operational ceiling allocation still blocks a second execution when currency is exhausted", async () => {
  const called = join(root, `exhausted-currency-${++counter}.txt`);
  const a = await writeAdapter("exhausted-currency", `import {appendFile} from "node:fs/promises";
    export function createAdapter(){return {async executeCase(testCase,context){
      await appendFile(${JSON.stringify(called)},testCase.id+"\\n");
      return {...context.fixtureEvidence,budgetAttestation:{status:"verified",hardLimitsVerified:true,
        quiescent:true,operationalBudget:context.operationalBudget,
        contextWindow:context.operationalBudget.maxInputTokens}};
    },async cleanupCase(){return {cleaned:true,quiescent:true};}};}`);
  const items = ["one", "two"].map((id) => {
    const item = caseDef({ id, limits: { timeoutMs: 1000, usage: cap({ priced: true, currencyMicros: 20 }) } });
    item.fixtures.evidence.usage = usage({ priced: true, currencyMicros: 10 });
    return item;
  });
  const file = await writeManifest(manifest({ cases: items }));
  const s = await writeScope(scope({ budgets: cap({ priced: true, currencyMicros: 10 }),
    operationalBudget: operationalBudget() }));
  const result = await runAcceptance(["--execute", "--scope", s, "--manifest", file, "--adapter", a,
    "--run-root", resolve(root, "exhausted-currency")]);
  assert.equal(result.code, 1);
  assert.equal(result.report.cases[0].outcome, "passed");
  assert.equal(result.report.cases[1].outcome, "blocked");
  assert.match(result.report.stopReason, /priced cost cap exceeds remaining suite budget/);
  assert.equal((await readFile(called, "utf8")).trim(), "one");
  assert.equal(result.report.budgetAccounting.dut.cases.length, 1);
  assert.equal(result.report.budgetAccounting.dut.status, "complete");
  assert.equal(result.report.budgetAccounting.dut.totals.currencyMicros, 10);
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
  assert.equal(result.report.budgetAccounting.dut.status, "unknown");
  assert.equal(result.report.budgetAccounting.dut.totals, null);
  assert.equal(result.report.budgetAccounting.dut.observedLowerBound.modelRequests, 999);
  assert.equal(result.report.cases[0].usage.modelRequests, null);
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
  const a = await writeAdapter("timeout", `export function createAdapter(){ return { async executeCase(){ return new Promise(()=>{}); }, async cleanupCase(){ return { cleaned:true, quiescent:true, receipt:"timeout-clean" }; } }; }`);
  const file = await writeManifest(manifest({ cases: [caseDef({ id: "hang", limits: { timeoutMs: 100, usage: cap() } }), caseDef({ id: "after" })] }));
  const result = await runAcceptance(["--execute", "--manifest", file, "--adapter", a, "--run-root", resolve(root, "timeout")]);
  assert.equal(result.code, 1); assert.equal(result.report.cases[0].outcome, "blocked"); assert.equal(result.report.cases[1].outcome, "blocked"); assert.match(result.report.limitations.join("\n"), /CPU-bound isolation/);
  assert.equal(result.report.budgetAccounting.dut.cases[0].executionSettled, false);
  assert.equal(result.report.budgetAccounting.dut.cases[0].aborted, true);
  assert.equal(result.report.budgetAccounting.dut.totals, null);
  assert.equal(result.report.cleanupReceipts[0].receipt.quiescent, false);
});

test("timeout retains execution rejection accounting during cleanup without reopening usage or admissions", async () => {
  const lowerBound = usage({ modelRequests: 2, inputTokens: 25, outputTokens: 12,
    priced: true, currencyMicros: 123 });
  const reserved = { modelRequests: 1, inputTokens: 128, outputTokens: 32, toolCalls: 0 };
  for (const cleanupMode of ["sync-receipt", "sync-error", "immediate-receipt", "immediate-error", "receipt", "error"]) {
    const a = await writeAdapter("timeout-accounting", `import assert from "node:assert/strict";
      let execution, rejectExecution, reportUsage;
      export function createAdapter(){return {
        async executeCase(testCase,context){
          reportUsage=context.reportUsage;
          execution=new Promise((_,reject)=>{rejectExecution=reject;});
          return execution;
        },${cleanupMode.startsWith("sync") ? "" : "async"} cleanupCase(){
          assert.throws(()=>reportUsage(${JSON.stringify(usage({ modelRequests: 4 }))}),/timed out/);
          const error=new Error("runtime fenced during timeout cleanup");
          error.budgetAccounting=${JSON.stringify({ observedLowerBound: lowerBound, reserved })};
          rejectExecution(error);
          ${["receipt", "error"].includes(cleanupMode) ? `await execution.catch(()=>{});
            await new Promise(resolve=>setImmediate(resolve));` : ""}
          ${cleanupMode.endsWith("error") ? 'throw new Error("cleanup failed");' : 'return {cleaned:true,quiescent:true};'}
        }};}`);
    const file = await writeManifest(manifest({ cases: [
      caseDef({ limits: { timeoutMs: 100, usage: cap() } }), caseDef(),
    ] }));
    const result = await runAcceptance(["--execute", "--manifest", file, "--adapter", a,
      "--run-root", resolve(root, "timeout-accounting")]);
    const accounting = result.report.budgetAccounting.dut;
    assert.equal(result.code, 1);
    assert.match(result.report.stopReason, /timed out/);
    assert.equal(result.report.cases[1].usage.accounting, "not_started");
    assert.equal(accounting.status, "unknown");
    assert.equal(accounting.totals, null);
    assert.equal(accounting.completeUsage.modelRequests, 0);
    assert.equal(accounting.cases[0].executionSettled, true);
    assert.deepEqual(accounting.observedLowerBound, lowerBound);
    assert.deepEqual(accounting.cost,
      { status: "unknown", currencyMicros: null, observedLowerBoundCurrencyMicros: 123 });
    assert.deepEqual(accounting.cases[0].outstandingReservations, reserved);
    assert.equal(accounting.cases[0].aborted, true);
    assert.equal(accounting.cases[0].hardLimits.status, "unattested");
    assert.equal(result.report.cleanupReceipts[0].receipt.quiescent, false);
    assert.deepEqual(result.report.cases[0].usage.observedLowerBound, lowerBound);
    assert.deepEqual(JSON.parse(await readFile(result.reportPath, "utf8")).budgetAccounting.dut, accounting);
  }
});

test("execution rejection after cleanup closes cannot mutate retained or persisted accounting", async () => {
  const prior = usage({ priced: true, currencyMicros: 50 });
  const lowerBound = usage({ modelRequests: 2, priced: true, currencyMicros: 123 });
  const reserved = { modelRequests: 1, inputTokens: 128, outputTokens: 32, toolCalls: 0 };
  for (const phase of ["receipt", "cleanup-error", "cleanup-timeout", "after-report"]) {
    const a = await writeAdapter("closed-error-accounting", `
      let execution, rejectExecution;
      export async function rejectPending(){
        const error=new Error("runtime fenced after accounting closed");
        error.budgetAccounting=${JSON.stringify({ observedLowerBound: lowerBound, reserved })};
        rejectExecution(error);
        await execution.catch(()=>{});
        await new Promise(resolve=>setImmediate(resolve));
      }
      export function createAdapter(){return {
        executeCase(testCase,context){
          context.reportUsage(${JSON.stringify(prior)});
          execution=new Promise((_,reject)=>{rejectExecution=reject;});
          return execution;
        },async cleanupCase(){
          ${phase === "cleanup-error" ? 'throw new Error("cleanup failed");' :
            phase === "cleanup-timeout" ? "return new Promise(()=>{});" : "return {cleaned:true,quiescent:true};"}
        },async close(){${phase === "after-report" ? "" : "await rejectPending();"}}
      };}`);
    const file = await writeManifest(manifest({ cases: [
      caseDef({ limits: { timeoutMs: 100, usage: cap() } }), caseDef(),
    ] }));
    const result = await runAcceptance(["--execute", "--manifest", file, "--adapter", a,
      "--run-root", resolve(root, "closed-error-accounting")]);
    const snapshot = structuredClone(result.report);
    const persisted = await readFile(result.reportPath, "utf8");
    if (phase === "after-report") await (await import(pathToFileURL(a).href)).rejectPending();
    const accounting = result.report.budgetAccounting.dut;
    assert.equal(result.code, 1);
    assert.equal(result.report.cases[1].usage.accounting, "not_started");
    assert.equal(accounting.status, "unknown");
    assert.equal(accounting.totals, null);
    assert.deepEqual(accounting.observedLowerBound, prior);
    assert.equal(accounting.cost.observedLowerBoundCurrencyMicros, 50);
    assert.equal(accounting.cases[0].outstandingReservations, undefined);
    assert.deepEqual(result.report, snapshot);
    assert.equal(await readFile(result.reportPath, "utf8"), persisted);
    assert.deepEqual(JSON.parse(persisted).budgetAccounting, result.report.budgetAccounting);
  }
});

test("malformed and partial operational roots fail before initializing an adapter", async () => {
  const initialized = join(root, `budget-initialized-${++counter}.txt`);
  const a = await writeAdapter("invalid-roots", `import {writeFile} from "node:fs/promises";
    await writeFile(${JSON.stringify(initialized)},"initialized");
    export function createAdapter(){throw new Error("must not initialize");}`);
  const file = await writeManifest(manifest());
  const fields = Object.keys(operationalBudget());
  const invalid = [null, [], {}, { ...operationalBudget(), model: "untrusted" }];
  for (const key of fields) {
    const partial = operationalBudget(); delete partial[key]; invalid.push(partial);
  }
  for (const value of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
    invalid.push(operationalBudget(Object.fromEntries(fields.map((key) => [key, value]))));
  }
  for (const field of ["operationalBudget", "reviewOperationalBudget"]) {
    for (const value of invalid) {
      const s = await writeScope(scope({ [field]: value }));
      const result = await runAcceptance(["--execute", "--scope", s, "--manifest", file, "--adapter", a,
        "--run-root", resolve(root, "invalid-roots")]);
      assert.equal(result.code, 1);
      assert.match(result.report.stopReason, new RegExp(`scope\\.${field}`));
      assert.equal(result.report.budgetAccounting.dut.status, "not_started");
    }
  }
  await assert.rejects(readFile(initialized), /ENOENT/);
});

test("operational ceilings reserve uncached input while usage allocations retain cache caps", async () => {
  const seen = join(root, `allocations-${++counter}.jsonl`);
  const a = await writeAdapter("narrow-roots", `import {appendFile} from "node:fs/promises";
    export function createAdapter(){return {async executeCase(testCase,context){
      await appendFile(${JSON.stringify(seen)},JSON.stringify({budget:context.budget,
        operationalBudget:context.operationalBudget,timeoutMs:context.timeoutMs})+"\\n");
      return {...context.fixtureEvidence,budgetAttestation:{status:"verified",hardLimitsVerified:true,
        quiescent:true,operationalBudget:context.operationalBudget,
        contextWindow:context.operationalBudget.maxInputTokens}};
    },async cleanupCase(){return {cleaned:true,quiescent:true};}};}`);
  const item = () => caseDef({ limits: { timeoutMs: 1000, usage: cap({ cacheReadTokens: 3, cacheWriteTokens: 4 }) },
    fixtures: { evidence: { ...caseDef().fixtures.evidence,
      usage: usage({ inputTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 2, outputTokens: 3 }) } } });
  const file = await writeManifest(manifest({ cases: [item(), item()] }));
  const s = await writeScope(scope({ budgets: cap({ modelRequests: 2, inputTokens: 15, outputTokens: 12,
    cacheReadTokens: 8, cacheWriteTokens: 8, toolCalls: 2 }),
    operationalBudget: operationalBudget({ maxDurationMs: 750 }) }));
  const result = await runAcceptance(["--execute", "--scope", s, "--manifest", file, "--adapter", a,
    "--run-root", resolve(root, "narrow-roots")]);
  assert.equal(result.code, 0, JSON.stringify(result.report));
  const contexts = (await readFile(seen, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(contexts.map((value) => value.operationalBudget), [
    operationalBudget({ maxModelRequests: 2, maxInputTokens: 15, maxOutputTokens: 12, maxToolCalls: 2, maxDurationMs: 750 }),
    operationalBudget({ maxModelRequests: 1, maxInputTokens: 11, maxOutputTokens: 9, maxToolCalls: 1, maxDurationMs: 750 }),
  ]);
  assert.equal(contexts[0].budget.cacheReadTokens, 3);
  assert.equal(contexts[0].budget.cacheWriteTokens, 4);
  assert.equal(contexts[1].budget.inputTokens, 11);
  assert.equal(contexts[0].timeoutMs, 750);
  assert.equal(result.report.budgetAccounting.dut.status, "complete");
  assert.equal(result.report.budgetAccounting.dut.totals.modelRequests, 2);
  assert.equal(result.report.budgetAccounting.dut.cases[0].hardLimits.status, "adapter-attested");
  assert.match(result.report.limitations.join("\n"), /not runtime enforcement.*independently/);
  assertBudgetGuidance(result.report.limitations.join("\n"));
  const trace = (await readFile(result.tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const starts = trace.filter((event) => event.event === "case_started");
  assert.equal(starts.length, contexts.length);
  starts.forEach((event, index) => {
    assert.equal(event.budgetAllocation.semantics, "ceilings-only");
    assert.deepEqual(event.budgetAllocation.usage, contexts[index].budget);
    assert.deepEqual(event.budgetAllocation.operationalBudget, contexts[index].operationalBudget);
    assert.equal(event.budgetAllocation.timeoutMs, contexts[index].timeoutMs);
    assert.deepEqual(event.hardLimits, { status: "unattested" });
    assert.ok(trace.indexOf(event) < trace.findIndex((item) =>
      item.event === "case_evidence" && item.caseId === event.caseId));
  });
});

test("declining ceilings require adapter-side configured-cap admission without changing prompts or native limits", async () => {
  const seen = join(root, `configured-admission-${++counter}.jsonl`);
  const dispatched = join(root, `configured-dispatch-${++counter}.txt`);
  const configured = operationalBudget({ maxModelRequests: 2, maxInputTokens: 80,
    maxOutputTokens: 60, maxToolCalls: 2, maxDurationMs: 700 });
  const prompt = "ORIGINAL_TASK_WITHOUT_BUDGET_INSTRUCTIONS";
  const a = await writeAdapter("configured-admission", `import assert from "node:assert/strict";
    import {appendFile} from "node:fs/promises";
    const configured=Object.freeze(${JSON.stringify(configured)});
    export function createAdapter(){return {async executeCase(testCase,context){
      assert.equal(testCase.prompt,${JSON.stringify(prompt)});
      assert.ok(Object.isFrozen(context.budget) && Object.isFrozen(context.operationalBudget));
      await appendFile(${JSON.stringify(seen)},JSON.stringify({budget:context.budget,
        ceiling:context.operationalBudget,configured})+"\\n");
      const mismatch=Object.keys(configured).find(key=>configured[key]>context.operationalBudget[key]);
      if(mismatch) throw new Error("Configured "+mismatch+" exceeds remaining allocation BEFORE dispatch");
      await appendFile(${JSON.stringify(dispatched)},testCase.id+"\\n");
      return {...context.fixtureEvidence,budgetAttestation:{status:"verified",hardLimitsVerified:true,
        quiescent:true,operationalBudget:configured,contextWindow:80}};
    },async cleanupCase(){return {cleaned:true,quiescent:true};}};}`);
  const items = ["one", "two"].map((id) => {
    const item = caseDef({ id, prompt });
    item.fixtures.evidence.usage = usage({ inputTokens: 70 });
    return item;
  });
  const file = await writeManifest(manifest({ cases: items }));
  const s = await writeScope(scope({ budgets: cap({ inputTokens: 140, modelRequests: 6,
    outputTokens: 140, toolCalls: 6, userTurns: 4 }), operationalBudget: operationalBudget() }));
  const result = await runAcceptance(["--execute", "--scope", s, "--manifest", file, "--adapter", a,
    "--run-root", resolve(root, "configured-admission")]);
  assert.equal(result.code, 1);
  assert.equal(result.report.cases[0].outcome, "passed");
  assert.equal(result.report.cases[1].outcome, "blocked");
  assert.match(result.report.stopReason, /Configured maxInputTokens.*BEFORE dispatch/);
  assert.equal((await readFile(dispatched, "utf8")).trim(), "one");
  const contexts = (await readFile(seen, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(contexts.map((context) => context.ceiling.maxInputTokens), [100, 70]);
  assert.deepEqual(contexts.map((context) => context.configured), [configured, configured]);
  assert.deepEqual(result.report.budgetAccounting.dut.cases[0].hardLimits.attestation.operationalBudget, configured);
  assert.equal(result.report.budgetAccounting.dut.cases[1].hardLimits.status, "unattested");
  assert.equal(result.report.budgetAccounting.dut.totals, null);
  const trace = await readFile(result.tracePath, "utf8");
  assert.doesNotMatch(trace, new RegExp(prompt));
});

test("zero operational allocations are rejected before execution", async () => {
  const called = join(root, `zero-allocation-${++counter}.txt`);
  const a = await writeAdapter("zero-allocation", `import {writeFile} from "node:fs/promises";
    export function createAdapter(){return {async executeCase(){await writeFile(${JSON.stringify(called)},"called");},
      async cleanupCase(){return {cleaned:true};}};}`);
  const s = await writeScope(scope({ operationalBudget: operationalBudget() }));
  for (const field of ["modelRequests", "inputTokens", "outputTokens", "toolCalls"]) {
    const file = await writeManifest(manifest({ cases: [caseDef({ limits: { timeoutMs: 1000, usage: cap({ [field]: 0 }) } })] }));
    const result = await runAcceptance(["--execute", "--scope", s, "--manifest", file, "--adapter", a,
      "--run-root", resolve(root, "zero-allocation")]);
    assert.equal(result.code, 1);
    assert.match(result.report.stopReason, /zero\/exhausted/);
  }
  await assert.rejects(readFile(called), /ENOENT/);
});

test("operational settings alone or incomplete adapter attestations cannot prove hard limits", async () => {
  const file = await writeManifest(manifest());
  const s = await writeScope(scope({ operationalBudget: operationalBudget() }));
  for (const variant of ["missing", "booleans", "wide", "cleanup"]) {
    const a = await writeAdapter("unproven-root", `export function createAdapter(){return {
      async executeCase(testCase,context){return {...context.fixtureEvidence,
        budgetAttestation:${variant === "missing" ? "undefined" : `{status:"verified",hardLimitsVerified:true,quiescent:true,
          ${variant === "booleans" ? "" : `operationalBudget:{...context.operationalBudget,maxModelRequests:${variant === "wide" ? "999" : "context.operationalBudget.maxModelRequests"}},contextWindow:context.operationalBudget.maxInputTokens,`}}`}};},
      async cleanupCase(){return {cleaned:true,quiescent:${variant !== "cleanup"}};}};}`);
    const result = await runAcceptance(["--execute", "--scope", s, "--manifest", file, "--adapter", a,
      "--run-root", resolve(root, "unproven-root")]);
    assert.equal(result.code, 1);
    assert.match(result.report.stopReason, /budgetAttestation/);
    assert.equal(result.report.budgetAccounting.dut.cases[0].hardLimits.status, "unattested");
    assert.match(result.report.limitations.join("\n"), /settings alone do not prove hard limits/);
    const trace = (await readFile(result.tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(trace.find((event) => event.event === "case_evidence").evidence.budgetAttestation,
      { status: "unattested" });
  }
});

test("context windows cannot exceed the attested input limit even within the trusted allocation", async () => {
  const file = await writeManifest(manifest({ cases: [caseDef(), caseDef()] }));
  const s = await writeScope(scope({ operationalBudget: operationalBudget() }));
  for (const maxInputTokens of [100, 50]) {
    const a = await writeAdapter("wide-context", `export function createAdapter(){return {
      async executeCase(testCase,context){return {...context.fixtureEvidence,
        budgetAttestation:{status:"verified",hardLimitsVerified:true,quiescent:true,
          operationalBudget:{...context.operationalBudget,maxInputTokens:${maxInputTokens}},
          contextWindow:${maxInputTokens + 1}}};},
      async cleanupCase(){return {cleaned:true,quiescent:true};}};}`);
    const result = await runAcceptance(["--execute", "--scope", s, "--manifest", file, "--adapter", a,
      "--run-root", resolve(root, "wide-context")]);
    assert.equal(result.code, 1);
    assert.match(result.report.stopReason, /budgetAttestation\.contextWindow exceeds attested maxInputTokens/);
    assert.equal(result.report.cases[0].outcome, "blocked");
    assert.equal(result.report.cases[1].outcome, "blocked");
    assert.equal(result.report.budgetAccounting.dut.status, "unknown");
    assert.equal(result.report.budgetAccounting.dut.cases[0].hardLimits.status, "unattested");
  }
});

test("task evidence cannot opt in a root and legacy execution stays explicitly unattested", async () => {
  const a = await writeAdapter("no-task-root", `export function createAdapter(){return {
    async executeCase(testCase,context){
      if(Object.hasOwn(context,"operationalBudget")) throw new Error("untrusted root leaked");
      if(!context.budget || context.budget.cacheReadTokens!==0) throw new Error("usage allocation missing");
      return {...context.fixtureEvidence,operationalBudget:${JSON.stringify(operationalBudget())},
        budgetAttestation:{status:"verified",hardLimitsVerified:true,quiescent:true,
          operationalBudget:${JSON.stringify(operationalBudget())}}};
    },async cleanupCase(){return {cleaned:true};}};}`);
  const item = caseDef();
  const file = await writeManifest(manifest({ cases: [item] }));
  const result = await runAcceptance(["--execute", "--manifest", file, "--adapter", a,
    "--run-root", resolve(root, "no-task-root")]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.report.budgetAccounting.dut.cases[0].hardLimits, { status: "unattested" });
  const trace = (await readFile(result.tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const started = trace.find((event) => event.event === "case_started");
  assert.equal(started.budgetAllocation.operationalBudget, undefined);
  assert.deepEqual(started.hardLimits, { status: "unattested" });
  assert.deepEqual(trace.find((event) => event.event === "case_evidence").evidence.budgetAttestation,
    { status: "unattested" });
});

test("explicit unknown post-dispatch state cannot become complete zero usage or attested evidence", async () => {
  const zero = usage({ modelRequests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, userTurns: 0 });
  for (const optIn of [false, true]) {
    for (const flag of ["unknownEffects", "liveUnknown"]) {
      const a = await writeAdapter("unknown-state", `export function createAdapter(){return {
        async executeCase(testCase,context){return {...context.fixtureEvidence,${flag}:true,
          usage:${JSON.stringify(zero)},budgetAttestation:{status:"verified",hardLimitsVerified:true,
            quiescent:true,operationalBudget:context.operationalBudget,contextWindow:100}};},
        async cleanupCase(){return {cleaned:true,quiescent:true};}};}`);
      const file = await writeManifest(manifest({ cases: [caseDef(), caseDef()] }));
      const s = await writeScope(scope({ ...(optIn ? { operationalBudget: operationalBudget() } : {}) }));
      const result = await runAcceptance(["--execute", "--scope", s, "--manifest", file, "--adapter", a,
        "--run-root", resolve(root, "unknown-state")]);
      assert.equal(result.code, 1);
      assert.match(result.report.stopReason, /unknown post-dispatch state/);
      assert.equal(result.report.cases[0].usage.modelRequests, null);
      assert.equal(result.report.cases[1].usage.accounting, "not_started");
      assert.equal(result.report.budgetAccounting.dut.status, "unknown");
      assert.equal(result.report.budgetAccounting.dut.totals, null);
      assert.deepEqual(result.report.budgetAccounting.dut.observedLowerBound, zero);
      assert.deepEqual(result.report.budgetAccounting.dut.cases[0].hardLimits, { status: "unattested" });
      const trace = (await readFile(result.tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(trace.find((event) => event.event === "case_evidence").evidence.budgetAttestation,
        { status: "unattested" });
    }
  }
});

test("fenced or locked runtime failures stay unknown despite zero lower bounds and claimed cleanup", async () => {
  const zero = usage({ modelRequests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, userTurns: 0 });
  const reserved = { modelRequests: 1, inputTokens: 100, outputTokens: 20, toolCalls: 0 };
  for (const state of ["fenced", "locked"]) {
    const a = await writeAdapter("runtime-unsettled", `export function createAdapter(){return {
      async executeCase(testCase,context){
        context.reportUsage(${JSON.stringify(zero)});
        const error=new Error("runtime ${state}; settlement unknown");
        error.budgetAccounting=${JSON.stringify({ usageStatus: "unknown", observedLowerBound: zero, reserved })};
        throw error;
      },async cleanupCase(){return {cleaned:true,quiescent:true};}};}`);
    const file = await writeManifest(manifest({ cases: [caseDef(), caseDef()] }));
    const s = await writeScope(scope({ operationalBudget: operationalBudget() }));
    const result = await runAcceptance(["--execute", "--scope", s, "--manifest", file, "--adapter", a,
      "--run-root", resolve(root, "runtime-unsettled")]);
    assert.equal(result.code, 1);
    assert.match(result.report.stopReason, new RegExp(state));
    assert.equal(result.report.budgetAccounting.dut.status, "unknown");
    assert.equal(result.report.budgetAccounting.dut.totals, null);
    assert.equal(result.report.budgetAccounting.dut.cases[0].hardLimits.status, "unattested");
    assert.deepEqual(result.report.budgetAccounting.dut.cases[0].outstandingReservations, reserved);
    assert.deepEqual(result.report.budgetAccounting.dut.observedLowerBound, zero);
    assert.equal(result.report.cases[0].usage.modelRequests, null);
    assert.equal(result.report.cases[1].usage.accounting, "not_started");
  }
});

test("missing, malformed, and rejected offline usage stays unknown and stops subsequent attempts", async () => {
  for (const variant of ["missing", "malformed", "rejected", "blocked-zero"]) {
    const called = join(root, `offline-usage-${++counter}.txt`);
    const a = await writeAdapter("offline-usage", `import {appendFile} from "node:fs/promises";
      export function createAdapter(){return {async executeCase(testCase,context){
        await appendFile(${JSON.stringify(called)},testCase.id+"\\n");
        ${variant === "rejected" ? `context.reportUsage(${JSON.stringify(usage())});throw new Error("network may have started");` :
          variant === "blocked-zero" ? `return {...context.fixtureEvidence,executionStatus:"infrastructure_blocked",
            usage:${JSON.stringify(usage({ modelRequests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, userTurns: 0 }))}};` :
          `return {...context.fixtureEvidence,usage:${variant === "missing" ? "undefined" : "{modelRequests:2}"}};`}
      },async cleanupCase(){return {cleaned:true};}};}`);
    const file = await writeManifest(manifest({ cases: [caseDef({ id: "one" }), caseDef({ id: "two" })] }));
    const result = await runAcceptance(["--execute", "--manifest", file, "--adapter", a,
      "--run-root", resolve(root, "offline-usage")]);
    assert.equal((await readFile(called, "utf8")).trim(), "one");
    assert.equal(result.code, 1);
    assert.equal(result.report.cases[1].outcome, "blocked");
    assert.equal(result.report.cases[0].usage.modelRequests, null);
    assert.equal(result.report.budgetAccounting.dut.status, "unknown");
    assert.equal(result.report.budgetAccounting.dut.totals, null);
    assert.equal(result.report.budgetAccounting.dut.observedLowerBound.modelRequests,
      variant === "malformed" ? 2 : variant === "rejected" ? 1 : 0);
  }
});

test("unpriced work never becomes a zero-cost component of complete priced totals", async () => {
  const first = caseDef();
  const second = caseDef();
  second.fixtures.evidence.usage = usage({ priced: true, currencyMicros: 10 });
  const file = await writeManifest(manifest({ cases: [first, second] }));
  const result = await runAcceptance(["--execute", "--manifest", file, "--adapter", adapter,
    "--run-root", resolve(root, "mixed-pricing")]);
  assert.equal(result.code, 0);
  assert.equal(result.report.budgetAccounting.dut.status, "complete");
  assert.equal(result.report.budgetAccounting.dut.totals.modelRequests, 2);
  assert.equal(result.report.budgetAccounting.dut.totals.priced, false);
  assert.equal(result.report.budgetAccounting.dut.totals.currencyMicros, undefined);
  assert.deepEqual(result.report.budgetAccounting.dut.cost,
    { status: "unknown", currencyMicros: null, observedLowerBoundCurrencyMicros: 10 });
});

test("caught malformed usage callbacks invalidate otherwise complete evidence", async () => {
  const a = await writeAdapter("malformed-callback", `export function createAdapter(){return {
    async executeCase(testCase,context){try{context.reportUsage({modelRequests:1});}catch{}
      return context.fixtureEvidence;},async cleanupCase(){return {cleaned:true};}};}`);
  const file = await writeManifest(manifest({ cases: [caseDef(), caseDef()] }));
  const result = await runAcceptance(["--execute", "--manifest", file, "--adapter", a,
    "--run-root", resolve(root, "malformed-callback")]);
  assert.equal(result.code, 1);
  assert.equal(result.report.cases[1].outcome, "blocked");
  assert.equal(result.report.budgetAccounting.dut.totals, null);
  assert.equal(result.report.budgetAccounting.dut.observedLowerBound.modelRequests, 1);
});

test("a caught late DUT callback does not alter observed accounting and stops the campaign", async () => {
  const a = await writeAdapter("late-callback", `let reportUsage; export function createAdapter(){return {
    async executeCase(testCase,context){reportUsage=context.reportUsage;return context.fixtureEvidence;},
    async cleanupCase(){try{reportUsage(${JSON.stringify(usage({ modelRequests: 4 }))});}catch{}
      return {cleaned:true,quiescent:true};}};}`);
  const file = await writeManifest(manifest({ cases: [caseDef(), caseDef()] }));
  const result = await runAcceptance(["--execute", "--manifest", file, "--adapter", a,
    "--run-root", resolve(root, "late-callback")]);
  assert.equal(result.code, 1);
  assert.match(result.report.stopReason, /after accounting closed/);
  assert.equal(result.report.cases[1].outcome, "blocked");
  assert.equal(result.report.budgetAccounting.dut.observedLowerBound.modelRequests, 1);
  assert.equal(result.report.cleanupReceipts[0].receipt.quiescent, false);
});

test("review contexts use remaining budgets and independent positive operational tool roots", async () => {
  const f = await corpusFixture("chat", { caseCount: 2,
    scope: { reviewBudgets: cap({ modelRequests: 3, toolCalls: 0 }),
      reviewOperationalBudget: operationalBudget({ maxToolCalls: 2, maxDurationMs: 900 }) },
    reviewResult: `budgetAttestation:{status:"verified",hardLimitsVerified:true,quiescent:true,
      operationalBudget:context.operationalBudget,contextWindow:context.operationalBudget.maxInputTokens},
      cleanup:{cleaned:true,quiescent:true},` });
  const result = await runAcceptance(f.args);
  assert.equal(result.code, 0, JSON.stringify(result.report));
  const context = JSON.parse(await readFile(f.reviewSeen, "utf8"));
  assert.equal(context.budget.modelRequests, 2);
  assert.equal(context.budget.inputTokens, 90);
  assert.equal(context.budget.outputTokens, 95);
  assert.equal(context.budget.toolCalls, 0);
  assert.deepEqual(context.operationalBudget, operationalBudget({ maxModelRequests: 2, maxInputTokens: 90,
    maxOutputTokens: 95, maxToolCalls: 2, maxDurationMs: 900 }));
  assert.equal(context.timeoutMs, 900);
  assert.equal(JSON.parse(await readFile(f.seen, "utf8")).operationalBudget, undefined);
  assert.equal(result.report.budgetAccounting.review.status, "complete");
  assert.equal(result.report.budgetAccounting.review.cases[0].hardLimits.status, "adapter-attested");
  assert.equal(result.report.independentReviewUsage.modelRequests, 2);
  const trace = (await readFile(result.tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const starts = trace.filter((event) => event.event === "independent_review_started");
  assert.equal(starts.length, 2);
  assert.equal(starts[1].budgetAllocation.semantics, "ceilings-only");
  assert.deepEqual(starts[1].budgetAllocation.usage, context.budget);
  assert.deepEqual(starts[1].budgetAllocation.operationalBudget, context.operationalBudget);
  assert.deepEqual(starts[1].hardLimits, { status: "unattested" });
});

test("review cache allocations cannot fund an oversized attested context window", async () => {
  const f = await corpusFixture("chat", {
    scope: { reviewBudgets: cap({ inputTokens: 4096, cacheReadTokens: 4096, cacheWriteTokens: 4096 }),
      reviewOperationalBudget: operationalBudget({ maxInputTokens: 8192 }) },
    reviewResult: `budgetAttestation:{status:"verified",hardLimitsVerified:true,quiescent:true,
      operationalBudget:context.operationalBudget,contextWindow:8192},cleanup:{cleaned:true,quiescent:true},` });
  const result = await runAcceptance(f.args);
  assert.equal(result.code, 1);
  const context = JSON.parse(await readFile(f.reviewSeen, "utf8"));
  assert.equal(context.operationalBudget.maxInputTokens, 4096);
  assert.equal(context.budget.cacheReadTokens, 4096);
  assert.equal(context.budget.cacheWriteTokens, 4096);
  assert.match(result.report.stopReason, /budgetAttestation\.contextWindow exceeds attested maxInputTokens/);
  assert.equal(result.report.cases[0].outcome, "blocked");
  assert.equal(result.report.independentReviewUsage, null);
  assert.equal(result.report.budgetAccounting.review.status, "unknown");
  assert.equal(result.report.budgetAccounting.review.cases[0].hardLimits.status, "unattested");
});

test("caught reviewer usage overruns latch and retain the observed lower bound", async () => {
  const f = await corpusFixture("chat", { caseCount: 2, catchUsage: true,
    review: `try{context.reportUsage({...usage,modelRequests:999});}catch{}` });
  const result = await runAcceptance(f.args);
  assert.equal(result.code, 1);
  assert.match(result.report.stopReason, /exceeds cap/);
  assert.equal(result.report.cases[1].outcome, "blocked");
  assert.equal(result.report.independentReviewUsage, null);
  assert.equal(result.report.budgetAccounting.review.status, "unknown");
  assert.equal(result.report.budgetAccounting.review.observedLowerBound.modelRequests, 1000);
  assert.equal(result.report.budgetAccounting.review.cases[0].aborted, true);
});

test("review operational roots require adapter proof rather than settings alone", async () => {
  const f = await corpusFixture("chat", { scope: { reviewOperationalBudget: operationalBudget() } });
  const result = await runAcceptance(f.args);
  assert.equal(result.code, 1);
  assert.match(result.report.stopReason, /budgetAttestation/);
  assert.equal(result.report.independentReviewUsage, null);
  assert.equal(result.report.budgetAccounting.review.cases[0].hardLimits.status, "unattested");
});

test("review attestation requires successful cleanup as well as claimed quiescence", async () => {
  for (const cleanup of [{ quiescent: true }, { cleaned: false, quiescent: true },
    { cleaned: true, quiescent: true, error: "runtime remains locked" }]) {
    const f = await corpusFixture("chat", { caseCount: 2,
      scope: { reviewOperationalBudget: operationalBudget() },
      reviewResult: `budgetAttestation:{status:"verified",hardLimitsVerified:true,quiescent:true,
        operationalBudget:context.operationalBudget,contextWindow:100},cleanup:${JSON.stringify(cleanup)},` });
    const result = await runAcceptance(f.args);
    assert.equal(result.code, 1);
    assert.match(result.report.stopReason, /cleanup/);
    assert.equal(result.report.cases[1].outcome, "blocked");
    assert.equal(result.report.independentReviewUsage, null);
    assert.equal(result.report.budgetAccounting.review.status, "unknown");
    assert.equal(result.report.budgetAccounting.review.cases[0].hardLimits.status, "unattested");
  }
});

test("review unknown post-dispatch state overrides otherwise valid usage and attestation", async () => {
  for (const flag of ["unknownEffects", "liveUnknown"]) {
    const f = await corpusFixture("chat", { caseCount: 2,
      scope: { reviewOperationalBudget: operationalBudget() },
      reviewResult: `${flag}:true,budgetAttestation:{status:"verified",hardLimitsVerified:true,quiescent:true,
        operationalBudget:context.operationalBudget,contextWindow:100},cleanup:{cleaned:true,quiescent:true},` });
    const result = await runAcceptance(f.args);
    assert.equal(result.code, 1);
    assert.match(result.report.stopReason, /unknown post-dispatch state/);
    assert.equal(result.report.cases[1].outcome, "blocked");
    assert.equal(result.report.independentReviewUsage, null);
    assert.equal(result.report.budgetAccounting.review.status, "unknown");
    assert.equal(result.report.budgetAccounting.review.observedLowerBound.modelRequests, 1);
    assert.equal(result.report.budgetAccounting.review.cases[0].hardLimits.status, "unattested");
  }
});

test("independent review still forbids tools with a positive operational tool root", async () => {
  const f = await corpusFixture("chat", { scope: { reviewOperationalBudget: operationalBudget() },
    review: "try{context.reportUsage({...usage,toolCalls:1});}catch{}", catchUsage: true });
  const result = await runAcceptance(f.args);
  assert.equal(result.code, 1);
  assert.match(result.report.stopReason, /toolCalls.*exceeds cap 0/);
  assert.equal(result.report.independentReviewUsage, null);
  assert.equal(result.report.budgetAccounting.review.observedLowerBound.toolCalls, 1);
});

test("review errors and missing usage are unknown rather than zero", async () => {
  for (const review of ["throw new Error('review failed before usage');",
    "context.reportUsage(usage);throw new Error('review failed after usage');",
    "return {turns:[]};"]) {
    const f = await corpusFixture("chat", { review, caseCount: 2 });
    const result = await runAcceptance(f.args);
    assert.equal(result.code, 1);
    assert.equal(result.report.cases[1].outcome, "blocked");
    assert.equal(result.report.independentReviewUsage, null);
    assert.equal(result.report.budgetAccounting.review.status, "unknown");
    assert.equal(result.report.budgetAccounting.review.totals, null);
    assert.equal(result.report.budgetAccounting.review.observedLowerBound.modelRequests,
      review.startsWith("context.reportUsage") ? 1 : 0);
  }
});

test("DUT ledger failure retains cumulative lower bounds without double-counting prior streamed usage", async () => {
  const lowerBound = usage({ modelRequests: 2, inputTokens: 25, outputTokens: 12 });
  const reserved = { modelRequests: 1, inputTokens: 128, outputTokens: 32, toolCalls: 0 };
  const a = await writeAdapter("durable-lower-bound", `export function createAdapter(){return {
    async executeCase(testCase,context){
      context.reportUsage(${JSON.stringify(usage())});
      const error=new Error("durable provider request fenced");
      error.budgetAccounting=${JSON.stringify({ observedLowerBound: lowerBound, reserved })};
      throw error;
    },async cleanupCase(){return {cleaned:false,quiescent:false};}};}`);
  const file = await writeManifest(manifest({ cases: [caseDef(), caseDef()] }));
  const result = await runAcceptance(["--execute", "--manifest", file, "--adapter", a,
    "--run-root", resolve(root, "durable-lower-bound")]);
  assert.equal(result.code, 1);
  assert.equal(result.report.cases[1].outcome, "blocked");
  assert.equal(result.report.budgetAccounting.dut.totals, null);
  assert.deepEqual(result.report.budgetAccounting.dut.observedLowerBound, lowerBound);
  assert.deepEqual(result.report.budgetAccounting.dut.cases[0].outstandingReservations, reserved);
});

test("review ledger failure retains known cost and never substitutes reservations for actual usage", async () => {
  const lowerBound = usage({ modelRequests: 2, toolCalls: 0, userTurns: 0 });
  const reserved = { modelRequests: 1, inputTokens: 128, outputTokens: 32, toolCalls: 0 };
  const f = await corpusFixture("chat", { review: `
    context.reportUsage(usage);
    const error=new Error("review ledger fenced");
    error.budgetAccounting=${JSON.stringify({ observedLowerBound: lowerBound, reserved })};
    throw error;` });
  const result = await runAcceptance(f.args);
  assert.equal(result.report.independentReviewUsage, null);
  assert.deepEqual(result.report.budgetAccounting.review.observedLowerBound, lowerBound);
  assert.deepEqual(result.report.budgetAccounting.review.cases[0].outstandingReservations, reserved);
});

for (const role of ["dut", "review"]) {
  async function runAccountingFailure(prior, lowerBound) {
    const failure = `
      ${prior ? `context.reportUsage(${JSON.stringify(prior)});` : ""}
      const error=new Error("priced ledger fenced");
      error.budgetAccounting=${JSON.stringify({ observedLowerBound: lowerBound })};
      throw error;`;
    if (role === "review") {
      const f = await corpusFixture("chat", { caseCount: 2, review: failure });
      return runAcceptance(f.args);
    }
    const a = await writeAdapter("priced-ledger", `export function createAdapter(){return {
      async executeCase(testCase,context){${failure}},
      async cleanupCase(){return {cleaned:true,quiescent:true};}};}`);
    const file = await writeManifest(manifest({ cases: [caseDef(), caseDef()] }));
    return runAcceptance(["--execute", "--manifest", file, "--adapter", a,
      "--run-root", resolve(root, "priced-ledger")]);
  }

  test(`${role} error accounting retains cumulative monetary maxima without claiming complete cost`, async () => {
    for (const priorCost of [undefined, 50, 200]) {
      const prior = priorCost === undefined ? undefined :
        usage({ toolCalls: 0, userTurns: 0, priced: true, currencyMicros: priorCost });
      const lowerBound = usage({ modelRequests: 2, inputTokens: 25, outputTokens: 12,
        toolCalls: 0, userTurns: 0, priced: true, currencyMicros: 123 });
      const expected = { ...lowerBound, currencyMicros: Math.max(priorCost ?? 0, 123) };
      const result = await runAccountingFailure(prior, lowerBound);
      const accounting = result.report.budgetAccounting[role];
      assert.equal(result.code, 1);
      assert.equal(result.report.cases[1].usage.accounting, "not_started");
      assert.equal(accounting.status, "unknown");
      assert.equal(accounting.totals, null);
      assert.equal(accounting.completeUsage.modelRequests, 0);
      assert.deepEqual(accounting.observedLowerBound, expected);
      assert.deepEqual(accounting.cases[0].observedLowerBound, expected);
      assert.equal(accounting.cases[0].hardLimits.status, "unattested");
      assert.deepEqual(accounting.cost,
        { status: "unknown", currencyMicros: null, observedLowerBoundCurrencyMicros: expected.currencyMicros });
      if (role === "review") assert.equal(result.report.independentReviewUsage, null);
      assert.deepEqual(JSON.parse(await readFile(result.reportPath, "utf8")).budgetAccounting[role], accounting);
    }
  });

  test(`${role} error accounting rejects invalid monetary bounds and preserves prior pricing`, async () => {
    const prior = usage({ toolCalls: 0, userTurns: 0, priced: true, currencyMicros: 50 });
    for (const pricing of [
      { priced: true }, { priced: true, currencyMicros: -1 }, { priced: true, currencyMicros: 1.5 },
      { priced: true, currencyMicros: "123" }, { priced: true, currencyMicros: Number.MAX_SAFE_INTEGER + 1 },
      { priced: false, currencyMicros: 123 },
    ]) {
      const result = await runAccountingFailure(prior, usage({ modelRequests: 2, ...pricing }));
      const accounting = result.report.budgetAccounting[role];
      assert.equal(accounting.status, "unknown");
      assert.deepEqual(accounting.observedLowerBound, prior);
      assert.deepEqual(accounting.cost,
        { status: "unknown", currencyMicros: null, observedLowerBoundCurrencyMicros: 50 });
    }
    const unpriced = usage({ modelRequests: 2, toolCalls: 0, userTurns: 0 });
    const result = await runAccountingFailure(prior, unpriced);
    assert.deepEqual(result.report.budgetAccounting[role].observedLowerBound,
      { ...unpriced, priced: true, currencyMicros: 50 });
  });
}

test("exhausted independent review currency stops the next completion before invocation", async () => {
  const f = await corpusFixture("chat", { caseCount: 2,
    scope: { reviewBudgets: cap({ priced: true, currencyMicros: 10 }) },
    review: "usage.priced=true;usage.currencyMicros=10;" });
  const result = await runAcceptance(f.args);
  assert.equal(result.code, 1);
  assert.match(result.report.stopReason, /review currency budget/);
  assert.equal(result.report.budgetAccounting.review.completeUsage.modelRequests, 1);
  assert.equal(result.report.budgetAccounting.review.observedLowerBound.modelRequests, 1);
  assert.equal(JSON.parse(await readFile(f.reviewSeen, "utf8")).budget.currencyMicros, 10);
});

test("an unsettled independent review times out without claiming quiescence or zero usage", async () => {
  const f = await corpusFixture("chat", { review: "return new Promise(()=>{});",
    scope: { reviewOperationalBudget: operationalBudget({ maxDurationMs: 100 }) } });
  const result = await runAcceptance(f.args);
  assert.equal(result.code, 1);
  assert.match(result.report.stopReason, /timed out/);
  assert.equal(result.report.independentReviewUsage, null);
  assert.equal(result.report.budgetAccounting.review.cases[0].executionSettled, false);
  assert.equal(result.report.budgetAccounting.review.cases[0].aborted, true);
});

test("review timeout retains abort-triggered rejection accounting before closing", async () => {
  const prior = usage({ toolCalls: 0, userTurns: 0, priced: true, currencyMicros: 50 });
  const lowerBound = { ...prior, modelRequests: 2, currencyMicros: 123 };
  const reserved = { modelRequests: 1, inputTokens: 128, outputTokens: 32, toolCalls: 0 };
  const f = await corpusFixture("chat", { caseCount: 2,
    scope: { reviewOperationalBudget: operationalBudget({ maxDurationMs: 100 }) },
    review: `context.reportUsage(${JSON.stringify(prior)});
      return new Promise((_,reject)=>{context.signal.addEventListener("abort",()=>{
        const error=new Error("review runtime fenced on abort");
        error.budgetAccounting=${JSON.stringify({ observedLowerBound: lowerBound, reserved })};
        reject(error);
      },{once:true});});` });
  const result = await runAcceptance(f.args);
  const accounting = result.report.budgetAccounting.review;
  assert.equal(result.code, 1);
  assert.match(result.report.stopReason, /timed out/);
  assert.equal(result.report.cases[1].usage.accounting, "not_started");
  assert.equal(result.report.independentReviewUsage, null);
  assert.equal(accounting.status, "unknown");
  assert.equal(accounting.totals, null);
  assert.equal(accounting.completeUsage.modelRequests, 0);
  assert.deepEqual(accounting.observedLowerBound, lowerBound);
  assert.deepEqual(accounting.cases[0].outstandingReservations, reserved);
  assert.equal(accounting.cases[0].executionSettled, true);
  assert.equal(accounting.cases[0].aborted, true);
  assert.equal(accounting.cases[0].hardLimits.status, "unattested");
  assert.deepEqual(accounting.cost,
    { status: "unknown", currencyMicros: null, observedLowerBoundCurrencyMicros: 123 });
  assert.deepEqual(JSON.parse(await readFile(result.reportPath, "utf8")).budgetAccounting.review, accounting);
});

test("review execution rejection during client close cannot change closed accounting", async () => {
  const prior = usage({ toolCalls: 0, userTurns: 0, priced: true, currencyMicros: 50 });
  const lowerBound = { ...prior, modelRequests: 2, currencyMicros: 123 };
  const reserved = { modelRequests: 1, inputTokens: 128, outputTokens: 32, toolCalls: 0 };
  const f = await corpusFixture("chat", { caseCount: 2,
    scope: { reviewOperationalBudget: operationalBudget({ maxDurationMs: 100 }) },
    review: `context.reportUsage(${JSON.stringify(prior)});
      return new Promise((_,reject)=>{context.rejectPending=reject;});`,
    reviewClose: `const error=new Error("review runtime fenced after accounting closed");
      error.budgetAccounting=${JSON.stringify({ observedLowerBound: lowerBound, reserved })};
      reviewContext.rejectPending(error);
      await new Promise(resolve=>setImmediate(resolve));` });
  const result = await runAcceptance(f.args);
  const accounting = result.report.budgetAccounting.review;
  assert.equal(result.code, 1);
  assert.match(result.report.stopReason, /timed out/);
  assert.equal(result.report.cases[1].usage.accounting, "not_started");
  assert.equal(result.report.independentReviewUsage, null);
  assert.equal(accounting.status, "unknown");
  assert.equal(accounting.totals, null);
  assert.deepEqual(accounting.observedLowerBound, prior);
  assert.equal(accounting.cases[0].outstandingReservations, undefined);
  assert.equal(accounting.cases[0].hardLimits.status, "unattested");
  assert.deepEqual(accounting.cost,
    { status: "unknown", currencyMicros: null, observedLowerBoundCurrencyMicros: 50 });
  assert.deepEqual(JSON.parse(await readFile(result.reportPath, "utf8")).budgetAccounting.review, accounting);
});

test("caught review callbacks during close invalidate accounting without silently changing totals", async () => {
  const f = await corpusFixture("chat", {
    reviewClose: `try{reviewContext.reportUsage(${JSON.stringify(usage({ toolCalls: 0, userTurns: 0 }))});}catch{}` });
  const result = await runAcceptance(f.args);
  assert.equal(result.code, 1);
  assert.match(result.report.stopReason, /after accounting closed/);
  assert.equal(result.report.independentReviewUsage, null);
  assert.equal(result.report.budgetAccounting.review.observedLowerBound.modelRequests, 1);
  assert.equal(result.report.budgetAccounting.review.status, "unknown");
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
