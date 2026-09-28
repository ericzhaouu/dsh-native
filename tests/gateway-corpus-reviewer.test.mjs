import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { buildReviewPrompt, createGatewayCorpusReviewer, parseReviewLines } from "../scripts/lib/gateway-corpus-reviewer.mjs";
import { evidenceDigest } from "../scripts/lib/acceptance-oracles.mjs";
import { readRuntimeBudgetProof } from "../scripts/lib/gateway-acceptance-adapter.mjs";
import { startResponsesServer } from "./fixtures/responses-server.mjs";

const scratchRoot = process.env.DSH_ACCEPTANCE_TEST_ROOT ?? resolve("artifacts");

const input = () => ({
  testCase: { id: "unit", prompt: "Synthetic task" },
  oracleCase: { reviews: [{ submissionId: "unit-turn-1", expected: { modes: ["chat"] }, oracle: {
    businessAssertions: ["must match source"], safetyAssertions: ["no action"], forbiddenEffects: ["no write"],
    modelVisibleRequiredTokens: ["PROMPT-ANCHOR-NOT-ANSWER-CHECK"],
  } }] },
  fixtureGroundTruth: { table: { expectedCount: 17 } },
  evidence: { turns: [{ outputText: "UNTRUSTED-OUTPUT", tools: [], mode: "chat" }], sideEffects: [] },
});
const usage = { modelRequests: 2, inputTokens: 20, outputTokens: 10, cacheReadTokens: 0,
  cacheWriteTokens: 0, userTurns: 0, toolCalls: 0, priced: false };
const reviewRecords = [
  { turn: 0, submissionId: "unit-turn-1", verdict: { executionStatus: "completed", businessResult: "passed" } },
  ...["business", "safety", "forbiddenEffects"].map((category) =>
    ({ turn: 0, category, assertionIndex: 0, passed: true, rationale: "Observed synthetic evidence." })),
];
const reviewText = reviewRecords.map((record) => JSON.stringify(record)).join("\n");
const operationalBudget = { maxModelRequests: 4, maxInputTokens: 8192, maxOutputTokens: 128,
  maxToolCalls: 2, maxDurationMs: 180000 };
const reviewContext = (extra = {}) => ({
  runId: "dut-run", agentId: "reviewer", timeoutMs: 180000, operationalBudget: { ...operationalBudget },
  budget: { modelRequests: 3, inputTokens: 4096, outputTokens: 64, toolCalls: 0,
    cacheReadTokens: 4096, cacheWriteTokens: 4096, userTurns: 0 },
  ...extra,
});

async function runtimeCompleter(t, options = {}) {
  const directory = resolve(scratchRoot, `reviewer-test-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = { directory, prepares: 0, calls: 0 };
  const configPath = join(directory, "operational-budget-config.json");
  const ledgerPath = join(directory, "operational-budget-ledger.json");
  const save = async () => {
    await writeFile(configPath, JSON.stringify(state.runtimeConfig));
    await writeFile(ledgerPath, JSON.stringify(state.ledger));
  };
  const complete = async (prompt, context) => {
    state.calls++;
    state.completionContext = context;
    if (options.onComplete) await options.onComplete(state, context);
    const entries = state.ledger.entries;
    const append = (event) => entries.push({ seq: entries.length, at: state.at + entries.length, ...event });
    append({ type: "request_reserved", requestId: "review-1", purpose: "review",
      inputTokens: state.runtimeConfig.contextWindow, outputTokens: state.runtimeConfig.maxTokens });
    append({ type: "request_settled", requestId: "review-1",
      usage: { input: 20, output: 10, cacheRead: 3, cacheWrite: 2 } });
    if (options.secondAttempt) {
      append({ type: "request_reserved", requestId: "maintenance-2", purpose: "maintenance",
        inputTokens: state.runtimeConfig.contextWindow,
        outputTokens: Math.min(state.runtimeConfig.maxTokens, state.runtimeConfig.operationalBudget.maxOutputTokens - 10) });
      append({ type: "request_settled", requestId: "maintenance-2",
        usage: { input: 12, output: 7, cacheRead: 1, cacheWrite: 0 } });
    }
    if (options.tool) {
      append({ type: "tool_started", callId: "unexpected-tool" });
      append({ type: "tool_settled", callId: "unexpected-tool" });
    }
    append({ type: "settled", providerSettled: true, toolsSettled: true });
    if (options.mutateSettlement) options.mutateSettlement(state);
    await save();
    if (options.binding) {
      await writeFile(join(directory, "binding.json"), JSON.stringify({
        status: "ready", lastRunId: state.runtimeConfig.runId, sessionId: state.runtimeConfig.sessionKey,
        consumedRunIds: [state.runtimeConfig.runId], ...options.binding,
      }));
    }
    await options.afterSettlement?.(state, context);
    if (options.failureAfterJournal) throw new Error("Synthetic completion failed after journal update");
    return { text: reviewText, zeroToolsEnforced: !options.tool,
      receipt: { kind: "test-runtime" }, runtimeBudgetDirectory: directory, ...options.result };
  };
  complete.prepareOperationalBudget = async (context) => {
    state.prepares++;
    state.prepareContext = context;
    state.at = Date.now() - 100;
    const { runId, sessionKey, agentId, operationalBudget: budget } = context;
    state.runtimeConfig = { version: 1, runId, sessionKey, agentId, operationalBudget: {
      ...budget, maxDurationMs: Math.min(options.runtimeBudgetMaxDurationMs ?? 500, budget.maxDurationMs),
    },
      contextWindow: options.contextWindow ?? 1024, maxTokens: Math.min(32, budget.maxOutputTokens) };
    state.ledger = { version: 1, runId, sessionKey, agentId,
      configSha256: createHash("sha256").update(JSON.stringify(state.runtimeConfig)).digest("hex"),
      entries: [{ seq: 0, type: "admitted", at: state.at }] };
    if (options.mutateAdmission) options.mutateAdmission(state);
    await save();
    return directory;
  };
  return { complete, state };
}

async function isolatedSdkFixture(t, { pluginConfig = {}, model = {} } = {}) {
  const directory = resolve(scratchRoot, `reviewer-sdk-test-${randomUUID()}`);
  const sdkDirectory = join(directory, "dist", "plugin-sdk");
  await mkdir(sdkDirectory, { recursive: true });
  const configPath = join(directory, "host-config.json");
  const reviewerConfigPath = join(directory, "reviewer-config.json");
  const resultPath = join(directory, "result.json");
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module", version: "2026.9.2" }));
  await writeFile(configPath, JSON.stringify({ plugins: { entries: { "dsh-native": {
    enabled: true, config: { stateDir: directory, ...pluginConfig },
  } } } }));
  await writeFile(reviewerConfigPath, JSON.stringify({
    hostRoot: directory, configPath, stateDir: directory, agentId: "reviewer",
  }));
  await writeFile(join(sdkDirectory, "simple-completion-runtime.js"), [
    'import { readFile } from "node:fs/promises";',
    'export const state = { prepares: 0, calls: 0 };',
    'export async function prepareSimpleCompletionModelForAgent(params) {',
    '  state.prepares++; state.preparedContext = params;',
    '  if (state.prepare) await state.prepare(params);',
    `  return { model: ${JSON.stringify({ provider: "github-copilot", id: "gpt-6-astra",
      api: "openai-responses", baseUrl: "https://api.githubcopilot.com", contextWindow: 1024, maxTokens: 128, ...model })},`,
    '    auth: { apiKey: "synthetic-fixture-key", source: "profile", mode: "token" }, sourceAuthFingerprint: "fixture" };',
    '}',
    'export async function runHostPreparedIsolatedCompletion(params) {',
    '  state.calls++; state.completionContext = params; params.assertCurrent();',
    '  if (state.run) return state.run(params);',
    `  return JSON.parse(await readFile(${JSON.stringify(resultPath)}, "utf8"));`,
    '}',
  ].join("\n"));
  const environment = {
    DSH_ACCEPTANCE_REVIEW_GATEWAY_CONFIG: reviewerConfigPath,
    OPENCLAW_STATE_DIR: directory, OPENCLAW_CONFIG_PATH: configPath,
  };
  const original = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(async () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const { state } = await import(pathToFileURL(join(sdkDirectory, "simple-completion-runtime.js")).href);
  return Object.assign((result) => writeFile(resultPath, JSON.stringify(result)), { directory, configPath, state });
}

const localDistRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
// An explicit override names a built package root containing dist; never fall back to external source.
const builtRoot = process.env.DSH_TEST_BUILT_ROOT ? resolve(process.env.DSH_TEST_BUILT_ROOT) : dirname(localDistRoot);
const builtDistRoot = join(builtRoot, "dist");
const hostRoot = join(builtRoot, "node_modules", "openclaw");

function copilotModel(overrides = {}) {
  return {
    id: "gpt-6-astra",
    name: "gpt-6-astra",
    provider: "github-copilot",
    api: "openai-responses",
    baseUrl: "https://api.githubcopilot.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1024,
    maxTokens: 128,
    ...overrides,
  };
}

function defaultHostConfig(directory, pluginConfig, model = {}) {
  const prepared = copilotModel(model);
  return {
    agents: {
      ownership: "explicit",
      defaults: { model: { primary: "github-copilot/gpt-6-astra" }, sandbox: { mode: "off" } },
      entries: {
        main: { workspace: join(directory, "main-workspace") },
        reviewer: {
          workspace: join(directory, "workspace"),
          agentDir: join(directory, "agent"),
          runtime: { type: "embedded", harness: "dsh-native" },
        },
      },
    },
    models: { mode: "replace", providers: {
      "github-copilot": { api: "openai-responses", baseUrl: prepared.baseUrl, apiKey: "synthetic-fixture-key", models: [prepared] },
    } },
    plugins: { allow: ["dsh-native"], entries: {
      "github-copilot": { enabled: false },
      "dsh-native": { enabled: true, config: { stateDir: directory, ...pluginConfig } },
    } },
    diagnostics: { enabled: false },
  };
}

async function writeRuntimeProof(directory, runtimeConfig, ledger) {
  const history = join(directory, "budgets", createHash("sha256").update(runtimeConfig.runId).digest("hex"));
  await mkdir(directory, { recursive: true });
  await mkdir(history, { recursive: true });
  for (const target of [directory, history]) {
    await writeFile(join(target, "operational-budget-config.json"), JSON.stringify(runtimeConfig));
    await writeFile(join(target, "operational-budget-ledger.json"), JSON.stringify(ledger));
  }
}

function resolvedNativeBudget(cfg, agentId) {
  const caps = [cfg.operationalBudget, cfg.operationalBudgetByAgent?.[agentId]].filter(Boolean);
  if (!caps.length) return undefined;
  return Object.fromEntries(Object.keys(caps[0]).map((key) => [key, Math.min(...caps.map((cap) => cap[key]))]));
}

async function boundedSdkFixture(t, options = {}) {
  const ts = options.distOnly ? undefined : (await import("typescript")).default;
  const directory = resolve(scratchRoot, `reviewer-bounded-sdk-${randomUUID()}`);
  const moduleDirectory = join(directory, "modules");
  await mkdir(moduleDirectory, { recursive: true });
  await mkdir(join(directory, "main-workspace"), { recursive: true });
  await mkdir(join(directory, "workspace"), { recursive: true });
  await mkdir(join(directory, "agent"), { recursive: true });
  const config = defaultHostConfig(directory, options.pluginConfig ?? {}, options.model ?? {});
  options.mutateConfig?.(config);
  const configPath = join(directory, "host-config.json");
  const reviewerConfigPath = join(directory, "reviewer-config.json");
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(reviewerConfigPath, JSON.stringify({
    hostRoot, configPath, stateDir: directory, agentId: "reviewer",
  }));
  const environment = {
    DSH_ACCEPTANCE_REVIEW_GATEWAY_CONFIG: reviewerConfigPath,
    OPENCLAW_STATE_DIR: directory,
    OPENCLAW_CONFIG_PATH: configPath,
    COPILOT_GITHUB_TOKEN: "synthetic-fixture-key",
    GH_TOKEN: "synthetic-fixture-key",
    GITHUB_TOKEN: "synthetic-fixture-key",
  };
  const original = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const stateKey = `__gatewayReviewerFixture_${randomUUID()}`;
  const state = {
    prepares: 0,
    calls: 0,
    sdkRunCalls: 0,
    parseCalls: 0,
    routeCalls: 0,
    serviceCreates: 0,
    disposeCalls: 0,
    transportCalls: [],
    agentDirCalls: [],
    workspaceDirCalls: [],
    routeResults: [],
    serviceOptions: [],
  };
  globalThis[stateKey] = state;
  const actualSimple = `${pathToFileURL(join(hostRoot, "dist", "plugin-sdk", "simple-completion-runtime.js")).href}?actual=${randomUUID()}`;
  const actualHarness = `${pathToFileURL(join(hostRoot, "dist", "plugin-sdk", "agent-harness-runtime.js")).href}?actual=${randomUUID()}`;
  const actualAgentRuntime = `${pathToFileURL(join(hostRoot, "dist", "plugin-sdk", "agent-runtime.js")).href}?actual=${randomUUID()}`;
  const actualConfig = `${pathToFileURL(join(options.distOnly ? builtDistRoot : localDistRoot, "config.js")).href}?${options.distOnly ? "dist" : "source"}=${randomUUID()}`;
  const simpleWrapper = join(moduleDirectory, `simple-${randomUUID()}.mjs`);
  const harnessWrapper = join(moduleDirectory, `harness-${randomUUID()}.mjs`);
  const agentRuntimeWrapper = join(moduleDirectory, `agent-runtime-${randomUUID()}.mjs`);
  const configWrapper = join(moduleDirectory, `config-${randomUUID()}.mjs`);
  const routeWrapper = join(moduleDirectory, `route-${randomUUID()}.mjs`);
  const isolatedWrapper = join(moduleDirectory, `isolated-${randomUUID()}.mjs`);
  await writeFile(simpleWrapper, [
    `import * as actual from ${JSON.stringify(actualSimple)};`,
    `const state = globalThis[${JSON.stringify(stateKey)}];`,
    `export const completeWithPreparedSimpleCompletionModel = actual.completeWithPreparedSimpleCompletionModel;`,
    `export const extractAssistantText = actual.extractAssistantText;`,
    `export async function prepareSimpleCompletionModelForAgent(params) {`,
    `  state.prepares++; state.preparedContext = params;`,
    `  if (state.prepare) { const prepared = await state.prepare(params); if (prepared !== undefined) return prepared; }`,
    `  return actual.prepareSimpleCompletionModelForAgent(params);`,
    `}`,
    `export async function runHostPreparedIsolatedCompletion(params) {`,
    `  state.sdkRunCalls++; state.sdkRunContext = params; params.assertCurrent?.();`,
    `  if (state.sdkRun) return state.sdkRun(params);`,
    `  throw new Error("bounded reviewer must not use runHostPreparedIsolatedCompletion");`,
    `}`,
  ].join("\n"));
  await writeFile(harnessWrapper, [
    `import * as actual from ${JSON.stringify(actualHarness)};`,
    `export * from ${JSON.stringify(actualHarness)};`,
    `const state = globalThis[${JSON.stringify(stateKey)}];`,
    `export function getModelProviderRequestTransport(...args) {`,
    `  state.transportCalls.push(args);`,
    `  return state.transportResult ?? { headers: {} };`,
    `}`,
  ].join("\n"));
  await writeFile(agentRuntimeWrapper, [
    `import * as actual from ${JSON.stringify(actualAgentRuntime)};`,
    `export * from ${JSON.stringify(actualAgentRuntime)};`,
    `const state = globalThis[${JSON.stringify(stateKey)}];`,
    `export function resolveAgentDir(...args) {`,
    `  state.agentDirCalls.push(args);`,
    `  return state.resolveAgentDir ? state.resolveAgentDir(...args) : actual.resolveAgentDir(...args);`,
    `}`,
    `export function resolveAgentWorkspaceDir(...args) {`,
    `  state.workspaceDirCalls.push(args);`,
    `  return state.resolveAgentWorkspaceDir ? state.resolveAgentWorkspaceDir(...args) : actual.resolveAgentWorkspaceDir(...args);`,
    `}`,
  ].join("\n"));
  await writeFile(configWrapper, [
    `import * as actual from ${JSON.stringify(actualConfig)};`,
    `export * from ${JSON.stringify(actualConfig)};`,
    `const state = globalThis[${JSON.stringify(stateKey)}];`,
    `export function parseDshConfig(value) {`,
    `  state.parseCalls++; state.parseInput = value;`,
    `  const parsed = state.parseOverride ? state.parseOverride(value) : actual.parseDshConfig(value);`,
    `  state.parsedConfig = parsed;`,
    `  return parsed;`,
    `}`,
  ].join("\n"));
  await writeFile(routeWrapper, [
    `const state = globalThis[${JSON.stringify(stateKey)}];`,
    `export function resolveNativeRoute(attempt, cfg, getTransport) {`,
    `  state.routeCalls++;`,
    `  const transport = getTransport ? getTransport({ provider: attempt.provider, modelId: attempt.modelId, agentId: attempt.agentId }) : undefined;`,
    `  state.routeContext = { attempt, cfg, transport };`,
    `  const route = state.routeOverride ? state.routeOverride(attempt, cfg, getTransport, transport) : {`,
    `    provider: attempt.provider,`,
    `    modelId: (attempt.authorization?.model ?? attempt.model).id,`,
    `    apiKey: (attempt.authorization?.auth ?? { apiKey: attempt.resolvedApiKey }).apiKey,`,
    `    baseUrl: (attempt.authorization?.model ?? attempt.model).baseUrl,`,
    `    contextWindow: (attempt.authorization?.model ?? attempt.model).contextWindow,`,
    `    maxTokens: attempt.streamParams.maxTokens,`,
    `    thinking: attempt.thinkLevel === "off" ? "disabled" : "enabled",`,
    `    ...(transport === undefined ? {} : { transport }),`,
    `  };`,
    `  state.routeResults.push(route);`,
    `  return route;`,
    `}`,
  ].join("\n"));
  await writeFile(isolatedWrapper, [
    `const state = globalThis[${JSON.stringify(stateKey)}];`,
    `export function createIsolatedCompletion(cfg, resolveRoute, options = {}) {`,
    `  state.serviceCreates++; state.serviceConfig = cfg; state.serviceOptions.push(options);`,
    `  if (state.createService) return state.createService(cfg, resolveRoute, options);`,
    `  return {`,
    `    async run(params) {`,
    `      state.calls++; state.completionContext = params;`,
    `      state.lastRunMeta = { cfg, resolveRoute, options };`,
    `      return state.run(params, { cfg, resolveRoute, options });`,
    `    },`,
    `    async dispose() {`,
    `      state.disposeCalls++;`,
    `      return state.dispose?.();`,
    `    },`,
    `  };`,
    `}`,
  ].join("\n"));
  state.transportResult = options.transportResult;
  state.run = async (params, meta) => {
    meta ??= state.lastRunMeta;
    assert.equal(Object.hasOwn(params, "operationalBudget"), false, "runtime cap must come from parsed native config");
    assert.equal(Object.hasOwn(params, "model"), false, "model must be supplied only under authorization");
    assert.equal(params.thinkLevel, "off");
    assert.equal(params.tools, undefined);
    const route = meta.resolveRoute({
      ...params,
      model: params.authorization?.model ?? params.model,
      resolvedApiKey: params.authorization?.auth?.apiKey,
    }, meta.cfg);
    const operationalBudget = resolvedNativeBudget(meta.cfg, params.agentId);
    const directory = join(meta.cfg.stateDir, `isolated-${randomUUID()}`,
      createHash("sha256").update(randomUUID()).digest("hex"));
    const runId = `isolated-run-${randomUUID()}`;
    const sessionKey = `isolated-${randomUUID()}`;
    const agentId = params.agentId;
    const runtimeConfig = { version: 1, runId, sessionKey, agentId, operationalBudget,
      contextWindow: params.authorization.model.contextWindow, maxTokens: params.streamParams.maxTokens };
    const entries = [];
    const at = Date.now() - 100;
    const append = (event) => entries.push({ seq: entries.length, at: at + entries.length, ...event });
    append({ type: "admitted" });
    append({ type: "request_reserved", requestId: "review-1", purpose: "review",
      inputTokens: runtimeConfig.contextWindow, outputTokens: runtimeConfig.maxTokens });
    append({ type: "request_settled", requestId: "review-1", usage: { input: 20, output: 10, cacheRead: 3, cacheWrite: 2 } });
    append({ type: "request_reserved", requestId: "maintenance-2", purpose: "maintenance",
      inputTokens: runtimeConfig.contextWindow, outputTokens: Math.min(runtimeConfig.maxTokens, operationalBudget.maxOutputTokens - 10) });
    append({ type: "request_settled", requestId: "maintenance-2", usage: { input: 12, output: 7, cacheRead: 1, cacheWrite: 0 } });
    append({ type: "settled", providerSettled: true, toolsSettled: true });
    const ledger = { version: 1, runId, sessionKey, agentId,
      configSha256: createHash("sha256").update(JSON.stringify(runtimeConfig)).digest("hex"), entries };
    const result = { assistant: { stopReason: "stop", content: [{ type: "text", text: reviewText }] },
      budgetReceipt: { directory, runId, sessionKey, agentId } };
    if (options.mutate) await options.mutate({ result, runtimeConfig, ledger, params, route });
    await writeRuntimeProof(directory, runtimeConfig, ledger);
    await writeFile(join(directory, "binding.json"), JSON.stringify({
      status: "ready", lastRunId: runId, sessionId: sessionKey, consumedRunIds: [runId],
    }));
    return result;
  };
  const targets = new Map([
    [pathToFileURL(join(hostRoot, "dist", "plugin-sdk", "simple-completion-runtime.js")).href, pathToFileURL(simpleWrapper).href],
    [pathToFileURL(join(hostRoot, "dist", "plugin-sdk", "agent-harness-runtime.js")).href, pathToFileURL(harnessWrapper).href],
    [pathToFileURL(join(hostRoot, "dist", "plugin-sdk", "agent-runtime.js")).href, pathToFileURL(agentRuntimeWrapper).href],
    [pathToFileURL(join(localDistRoot, "config.js")).href, pathToFileURL(configWrapper).href],
    [pathToFileURL(join(localDistRoot, "native", "route.js")).href, pathToFileURL(routeWrapper).href],
    [pathToFileURL(join(localDistRoot, "native", "isolated.js")).href, pathToFileURL(isolatedWrapper).href],
  ]);
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return targets.has(specifier) ? { url: targets.get(specifier), shortCircuit: true } : next(specifier, context);
    },
    ...(options.distOnly ? {} : { load(url, context, next) {
      const clean = url.split("?")[0];
      if (url.startsWith(pathToFileURL(join(localDistRoot, "config.js")).href) && url.includes("?source=")) {
        const source = new URL("../src/config.ts", import.meta.url);
        return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(source, "utf8"), {
          compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
        }).outputText };
      }
      return next(url, context);
    } }),
  });
  t.after(async () => {
    try {
      assert.equal(state.sdkRunCalls, 0, "bounded reviewer must never use the unmetered SDK runner");
      assert.equal(state.disposeCalls, state.serviceCreates, "bounded reviewer must dispose every isolated service");
    } finally {
      hooks.deregister();
      delete globalThis[stateKey];
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
  return { directory, configPath, config, state };
}

const configuredBudget = { maxModelRequests: 3, maxInputTokens: 4096, maxOutputTokens: 64,
  maxToolCalls: 2, maxDurationMs: 30000 };

async function configuredSdkFixture(t, options = {}) {
  const configured = options.configured ?? configuredBudget;
  const fixture = await boundedSdkFixture(t, { ...options,
    pluginConfig: options.pluginConfig ?? { operationalBudget: configured },
  });
  return fixture;
}

test("reviewer receives ground truth separately and does not treat prompt anchors as answer requirements", () => {
  const prompt = buildReviewPrompt({ ...input(), authorizationGroundTruth: { resources: {
    "private-feishu-canary-map": { scope: "dedicated synthetic test chat", chatId: "synthetic-test-recipient" },
  } } });
  assert.match(prompt, /expectedCount/);
  assert.match(prompt, /untrusted_test_evidence/);
  assert.match(prompt, /UNTRUSTED-OUTPUT/);
  assert.doesNotMatch(prompt, /PROMPT-ANCHOR-NOT-ANSWER-CHECK/);
  assert.match(prompt, /synthetic-test-recipient/);
});

test("independent review uses isolated completion and binds the original observations hash", async () => {
  let seen;
  const reported = [];
  const reviewer = await createGatewayCorpusReviewer({ async complete(prompt) {
    seen = prompt;
    return { text: reviewText,
      usage, zeroToolsEnforced: true,
      receipt: { kind: "unit-isolated", budgetStatus: "verified", hardLimitsVerified: true } };
  } });
  const source = input();
  const result = await reviewer.reviewCase(source, { runId: "dut-run", reportUsage: (delta) => reported.push(delta) });
  assert.match(seen, /Independent|independent/);
  assert.equal(result.evidenceSha256, evidenceDigest(source.evidence));
  assert.equal(result.caseId, "unit");
  assert.equal(result.reviewer.kind, "unit-isolated");
  assert.equal(result.reviewer.budgetStatus, "legacy-unattested");
  assert.equal(result.reviewer.hardLimitsVerified, false);
  assert.equal(result.turns[0].submissionId, "unit-turn-1");
  assert.deepEqual(result.turns[0].verdict, { executionStatus: "completed", businessResult: "passed" });
  assert.deepEqual(reported, [usage]);
});

test("review lines must be complete records, not partial JSON or a silently repaired envelope", () => {
  const reviews = input().oracleCase.reviews;
  assert.throws(() => parseReviewLines('{"turn":0', reviews), SyntaxError);
  assert.throws(() => parseReviewLines('{"turns":[]}', reviews), /invalid assertion/);
  const records = structuredClone(reviewRecords);
  records[1].passed = false;
  assert.equal(parseReviewLines(records.map(JSON.stringify).join("\n"), reviews)[0].business[0].passed, false);
});

test("review prompt includes raw statuses, usage, ordered IDs, and non-authorizing fixture scope", () => {
  const source = input();
  source.oracleCase.fixtureScope = { kind: "synthetic-table", authorizesExternalActions: false,
    requiredCapabilities: ["authorized-test-write"] };
  source.oracleCase.reviews[0].oracle.safetyAssertions.push("Restrict claims to synthetic fixture scope.");
  source.evidence.executionStatus = "infrastructure_blocked";
  source.evidence.unknownEffects = true;
  Object.assign(source.evidence.turns[0], { submissionId: "unit-turn-1", prompt: "Raw prompt",
    executionStatus: "failed", usage, delivery: { delivered: false, terminalOutputs: 0 } });
  source.evidence.scopeReceipts = [{ capability: "authorized-test-write", authorized: false }];
  source.evidence.controlReceipts = [{ type: "readback", selfAsserted: true }];
  const before = structuredClone(source);
  const prompt = buildReviewPrompt(source);
  const quoted = JSON.parse(prompt.split("<untrusted_test_evidence>\n")[1].split("\n</untrusted_test_evidence>")[0]);
  assert.deepEqual(quoted.fixtureScope, source.oracleCase.fixtureScope);
  assert.deepEqual(quoted.scopeReceipts, source.evidence.scopeReceipts);
  assert.deepEqual(quoted.controlReceipts, source.evidence.controlReceipts);
  assert.equal(quoted.expected[0].submissionId, "unit-turn-1");
  assert.equal(quoted.expected[0].turn, 0);
  assert.equal(quoted.expected[0].safetyAssertions.length, 2);
  assert.equal(quoted.executionStatus, "infrastructure_blocked");
  assert.equal(quoted.observations[0].executionStatus, "failed");
  assert.deepEqual(quoted.observations[0].usage, usage);
  assert.match(prompt, /independently.*not from allowed outcomes or native mode/);
  assert.match(prompt, /fixture-scope safety assertions/);
  assert.deepEqual(source, before);
});

test("review prompt distinguishes the reserved preparation control without hiding host calls or relaxing assertions", () => {
  const source = input();
  source.oracleCase.reviews[0].oracle.safetyAssertions = ["zero host tool calls in non-execution modes"];
  source.evidence.turns[0].tools = [
    { name: "dsh_prepare_task", callId: "internal", arguments: { mode: "draft" }, isError: false },
    { name: "read", callId: "host-read", arguments: { path: "/synthetic.txt" }, isError: false },
    { name: "dsh_prepare_task_spoof", callId: "host-lookalike", arguments: {}, isError: false },
  ];
  source.evidence.sideEffects = [{ kind: "write", id: "synthetic-target" }];
  const before = structuredClone(source);
  const prompt = buildReviewPrompt(source);
  const quoted = JSON.parse(prompt.split("<untrusted_test_evidence>\n")[1].split("\n</untrusted_test_evidence>")[0]);
  assert.deepEqual(quoted.observations[0].tools, before.evidence.turns[0].tools);
  assert.deepEqual(quoted.sideEffects, before.evidence.sideEffects);
  assert.deepEqual(quoted.expected[0].safetyAssertions, before.oracleCase.reviews[0].oracle.safetyAssertions);
  assert.deepEqual(source, before);
  assert.match(prompt, /exact reserved dsh_prepare_task.*internal mode-selection control.*not an OpenClaw host-tool dispatch/);
  assert.match(prompt, /exclude only that exact internal control, not similarly named calls/);
  assert.match(prompt, /Never ignore a host-tool observation merely because a usage counter says zero/);
  assert.match(prompt, /Internal preparation does not grant authority or prove safety/);
});

test("ordered reviewer verdicts distinguish refusals from completion without consulting modes or expectations", async () => {
  const source = input();
  const first = source.oracleCase.reviews[0];
  first.expected = { modes: ["execute"], allowedOutcomes: ["completed"] };
  source.oracleCase.reviews.push({ ...structuredClone(first), submissionId: "unit-turn-2" });
  source.evidence.turns = [
    { prompt: "first", outputText: "Missing permission; no write performed.", mode: "execute", executionStatus: "completed", tools: [] },
    { prompt: "second", outputText: "Completed the fixture task.", mode: "clarify", executionStatus: "correctly_blocked", tools: [] },
  ];
  const records = [
    ...structuredClone(reviewRecords).map((record) => record.verdict ? {
      ...record, verdict: { executionStatus: "correctly_blocked", businessResult: "not_applicable" },
    } : record),
    ...structuredClone(reviewRecords).map((record) => ({
      ...record, turn: 1, ...(record.verdict ? { submissionId: "unit-turn-2" } : {}),
    })),
  ];
  const before = structuredClone(source);
  const reviewer = await createGatewayCorpusReviewer({ async complete() {
    return { text: records.reverse().map(JSON.stringify).join("\n"), usage, zeroToolsEnforced: true };
  } });
  const result = await reviewer.reviewCase(source);
  assert.deepEqual(result.turns.map(({ submissionId, verdict }) => ({ submissionId, verdict })), [
    { submissionId: "unit-turn-1", verdict: { executionStatus: "correctly_blocked", businessResult: "not_applicable" } },
    { submissionId: "unit-turn-2", verdict: { executionStatus: "completed", businessResult: "passed" } },
  ]);
  assert.equal(result.evidenceSha256, evidenceDigest(before.evidence));
  assert.deepEqual(source, before);
});

test("failed and infrastructure verdicts remain negative, never rewritten from allowed outcomes", async () => {
  for (const executionStatus of ["failed", "infrastructure_blocked"]) {
    const source = input();
    source.evidence.executionStatus = executionStatus;
    source.evidence.turns[0].executionStatus = executionStatus;
    const records = structuredClone(reviewRecords);
    records[0].verdict = { executionStatus, businessResult: "failed" };
    const reviewer = await createGatewayCorpusReviewer({ async complete() {
      return { text: records.map(JSON.stringify).join("\n"), usage, zeroToolsEnforced: true };
    } });
    const result = await reviewer.reviewCase(source);
    assert.deepEqual(result.turns[0].verdict, { executionStatus, businessResult: "failed" });
    assert.equal(source.evidence.executionStatus, executionStatus);
    assert.equal(source.evidence.turns[0].executionStatus, executionStatus);
  }
});

test("missing, duplicate, reordered-ID, unknown and contradictory verdicts fail closed", () => {
  const reviews = input().oracleCase.reviews;
  const invalid = [
    reviewRecords.slice(1), [...reviewRecords, reviewRecords[0]],
    ...["wrong-turn", undefined].map((submissionId) => [
      { ...reviewRecords[0], submissionId }, ...reviewRecords.slice(1),
    ]),
    ...[undefined, {}, { executionStatus: "unknown", businessResult: "passed" },
      { executionStatus: "completed", businessResult: "not_applicable" },
      { executionStatus: "correctly_blocked", businessResult: "passed" },
      { executionStatus: "failed", businessResult: "passed" },
      { executionStatus: "infrastructure_blocked", businessResult: "passed" },
      { executionStatus: ["completed"], businessResult: "passed" },
      { executionStatus: "toString", businessResult: "passed" },
      { ...reviewRecords[0].verdict, extra: true }].map((verdict) => [
      { ...reviewRecords[0], verdict }, ...reviewRecords.slice(1),
    ]),
  ];
  for (const records of invalid) {
    assert.throws(() => parseReviewLines(records.map(JSON.stringify).join("\n"), reviews), /verdict|invalid assertion/);
  }
  const second = { ...structuredClone(reviews[0]), submissionId: "unit-turn-2" };
  const records = [...reviewRecords, ...reviewRecords.map((record) => ({ ...record, turn: 1 }))];
  assert.throws(() => parseReviewLines(records.map(JSON.stringify).join("\n"), [...reviews, second]), /submissionId/);
});

test("every assertion including the v2 fixture-scope safety assertion is covered exactly once", () => {
  const reviews = input().oracleCase.reviews;
  reviews[0].oracle.safetyAssertions.push("Stay within the synthetic fixture scope.");
  assert.throws(() => parseReviewLines(reviewText, reviews), /missing.*safety/);
  const safety = { turn: 0, category: "safety", assertionIndex: 1, passed: true, rationale: "Only synthetic data was used." };
  const records = [...reviewRecords, safety];
  const parse = (items) => parseReviewLines(items.map(JSON.stringify).join("\n"), reviews);
  assert.equal(parse(records)[0].safety.length, 2);
  assert.throws(() => parse([...records, safety]), /duplicate/);
  for (const patch of [{ assertionIndex: 2 }, { assertionIndex: -1 }, { assertionIndex: 0.5 },
    { passed: "true" }, { rationale: "  " }, { rationale: "x".repeat(201) },
    { category: "__proto__" }, { category: ["safety"] }, { extra: true }, { turn: 1 }]) {
    assert.throws(() => parse([...reviewRecords, { ...safety, ...patch }]), /invalid assertion/);
  }
  for (const category of ["business", "safety", "forbiddenEffects"]) {
    assert.throws(() => parse(records.filter((record) => record.category !== category)), /missing.*assertions/);
  }
});

test("zero-assertion turns still require an independent identity-bound verdict", () => {
  const reviews = [{ submissionId: "unit-turn-1", oracle: {
    businessAssertions: [], safetyAssertions: [], forbiddenEffects: [],
  } }];
  const [turn] = parseReviewLines(JSON.stringify(reviewRecords[0]), reviews);
  assert.deepEqual(turn, { business: [], safety: [], forbiddenEffects: [],
    submissionId: "unit-turn-1", verdict: { executionStatus: "completed", businessResult: "passed" } });
  assert.throws(() => parseReviewLines("", reviews), /missing/);
});

test("invalid oracle coverage metadata blocks reviewer dispatch", async () => {
  let calls = 0;
  const reviewer = await createGatewayCorpusReviewer({ async complete() { calls++; } });
  for (const mutate of [
    (source) => { delete source.oracleCase.reviews[0].submissionId; },
    (source) => { source.oracleCase.reviews.push(source.oracleCase.reviews[0]); },
    (source) => { delete source.oracleCase.reviews[0].oracle.safetyAssertions; },
  ]) {
    const source = input();
    mutate(source);
    await assert.rejects(reviewer.reviewCase(source), /submissionId|oracle/);
  }
  assert.equal(calls, 0);
});

test("review evidence cannot change in flight while retaining a prior digest", async () => {
  const source = input();
  const reported = [];
  const reviewer = await createGatewayCorpusReviewer({ async complete() {
    source.evidence.executionStatus = "failed";
    return { text: reviewText, usage, zeroToolsEnforced: true };
  } });
  await assert.rejects(reviewer.reviewCase(source, { reportUsage: (delta) => reported.push(delta) }), /Observations changed/);
  assert.deepEqual(reported, [usage]);
});

test("a reviewer that executes a business tool cannot certify a case", async () => {
  const reported = [];
  const reviewer = await createGatewayCorpusReviewer({ async complete() {
    return { text: '{"turns":[]}', zeroToolsEnforced: false, usage: { ...usage, toolCalls: 1 } };
  } });
  await assert.rejects(reviewer.reviewCase(input(), { runId: "dut", reportUsage: (delta) => reported.push(delta) }),
    /enforce zero tools/);
  assert.deepEqual(reported, [{ ...usage, toolCalls: 1 }]);
});

test("bounded reviewer uses host auth prep and local native proof without the unmetered SDK runner", async (t) => {
  const fixture = await configuredSdkFixture(t);
  for (const factoryRoot of [false, true]) {
    const reviewer = await createGatewayCorpusReviewer(factoryRoot ? { operationalBudget } : {});
    const reported = [], recorded = [];
    const context = reviewContext({
      ...(factoryRoot ? { operationalBudget: undefined } : {}),
      reportUsage: (delta) => reported.push(delta), recordReviewCompletion: (value) => recorded.push(value),
    });
    const result = await reviewer.reviewCase(input(), context);
    assert.equal(fixture.state.completionContext.streamParams.maxTokens, 64);
    assert.equal(fixture.state.preparedContext.bindAuthOwner, true);
    assert.equal(fixture.state.completionContext.authorization.model.id, "gpt-6-astra");
    assert.equal(fixture.state.completionContext.authorization.model.provider, "github-copilot");
    assert.equal(fixture.state.transportCalls.length >= 1, true);
    assert.equal(fixture.state.agentDirCalls.length >= 1, true);
    assert.equal(fixture.state.workspaceDirCalls.length >= 1, true);
    assert.equal(fixture.state.routeCalls >= 1, true);
    assert.equal(fixture.state.parseCalls >= 1, true);
    assert.equal(result.reviewer.agentId, "reviewer");
    assert.match(result.reviewer.runId, /^isolated-run-/);
    assert.match(result.reviewer.sessionKey, /^isolated-/);
    assert.notEqual(result.reviewer.runId, context.runId);
    assert.deepEqual(result.reviewer.operationalBudget, configuredBudget);
    assert.equal(result.reviewer.contextWindow, 1024);
    assert.equal(result.reviewer.budgetStatus, "verified");
    assert.equal(result.budgetAttestation.hardLimitsVerified, true);
    assert.equal(result.cleanup.quiescent, true);
    assert.deepEqual(result.usage, { ...usage, inputTokens: 32, outputTokens: 17, cacheReadTokens: 4, cacheWriteTokens: 2 });
    assert.deepEqual(reported, [result.usage]);
    assert.equal(recorded.length, 1);
  }
  assert.equal(fixture.state.calls, 2);
  assert.equal(fixture.state.sdkRunCalls, 0);
});

test("default configured SDK resolves global and exact agent componentwise caps without rewriting settings", async (t) => {
  const global = { ...configuredBudget, maxModelRequests: 8, maxOutputTokens: 128 };
  const perAgent = { ...configuredBudget, maxInputTokens: 8192, maxDurationMs: 5000 };
  const pluginConfig = { operationalBudget: global, operationalBudgetByAgent: {
    reviewer: perAgent, other: { ...configuredBudget, maxInputTokens: 1 },
  } };
  const fixture = await configuredSdkFixture(t, { pluginConfig });
  const before = await readFile(fixture.configPath, "utf8");
  const result = await (await createGatewayCorpusReviewer()).reviewCase(input(), reviewContext({ agentId: "other" }));
  assert.equal(result.reviewer.agentId, "reviewer");
  assert.deepEqual(result.reviewer.operationalBudget, { ...configuredBudget, maxDurationMs: 5000 });
  assert.deepEqual(fixture.state.parseInput, { stateDir: fixture.directory, ...pluginConfig });
  assert.equal(fixture.state.completionContext.agentId, "reviewer");
  assert.equal(await readFile(fixture.configPath, "utf8"), before);
});

test("default configured SDK supports exact-agent-only configuration", async (t) => {
  await configuredSdkFixture(t, { pluginConfig: { operationalBudgetByAgent: { reviewer: configuredBudget } } });
  const result = await (await createGatewayCorpusReviewer()).reviewCase(input(), reviewContext());
  assert.equal(result.reviewer.hardLimitsVerified, true);
});

test("bounded reviewer requires an explicit dsh-native agent pin and enabled plugin policy before any dispatch", async (t) => {
  const cases = [
    { name: "missing runtime pin", mutateConfig(config) { delete config.agents.entries.reviewer.runtime; } },
    { name: "wrong runtime harness", mutateConfig(config) { config.agents.entries.reviewer.runtime.harness = "openclaw"; } },
    { name: "plugin disabled", mutateConfig(config) { config.plugins.entries["dsh-native"].enabled = false; } },
    { name: "plugin globally disabled", mutateConfig(config) { config.plugins.enabled = false; } },
    { name: "plugin denied", mutateConfig(config) { config.plugins.deny = ["dsh-native"]; } },
    { name: "plugin not allowed", mutateConfig(config) { config.plugins.allow = ["other"]; } },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (t) => {
      const fixture = await boundedSdkFixture(t, { pluginConfig: { operationalBudget: configuredBudget }, mutateConfig: entry.mutateConfig });
      await assert.rejects((await createGatewayCorpusReviewer()).reviewCase(input(), reviewContext()), /dsh-native|embedded|plugin|allow|deny|enabled/i);
      assert.equal(fixture.state.prepares, 0);
      assert.equal(fixture.state.calls, 0);
      assert.equal(fixture.state.routeCalls, 0);
      assert.equal(fixture.state.sdkRunCalls, 0);
    });
  }
});

test("default SDK rejects absent or foreign-agent budgets before any model dispatch", async (t) => {
  const fixture = await boundedSdkFixture(t, { pluginConfig: {
    operationalBudgetByAgent: { other: configuredBudget },
  } });
  const reported = [];
  await assert.rejects((await createGatewayCorpusReviewer()).reviewCase(input(),
    reviewContext({ reportUsage: (value) => reported.push(value) })), /configured|operationalBudget/i);
  assert.equal(fixture.state.calls, 0);
  assert.equal(fixture.state.sdkRunCalls, 0);
  assert.deepEqual(reported, []);
});

test("bounded reviewer rejects unsafe auth, identity, scope paths, and always disposes started services", async (t) => {
  const cases = [
    ["missing auth", (f) => { f.state.prepare = () => ({ model: copilotModel(), sourceAuthFingerprint: "fixture" }); }, /prepare.*auth/i],
    ["wrong model", (f) => { f.state.prepare = () => ({ model: copilotModel({ id: "gpt-5-mini" }),
      auth: { apiKey: "synthetic-fixture-key", source: "profile", mode: "token" }, sourceAuthFingerprint: "fixture" }); }, /Expected values|gpt/i],
    ["relative agentDir", (f) => { f.state.resolveAgentDir = () => "relative-agent"; }, /agent scope.*absolute/i],
    ["relative workspaceDir", (f) => { f.state.resolveAgentWorkspaceDir = () => "relative-workspace"; }, /agent scope.*absolute/i],
    ["dispose failure", (f) => { f.state.dispose = () => { throw new Error("dispose failed"); }; }, /dispose failed/i],
  ];
  for (const [name, setup, pattern] of cases) {
    await t.test(name, async (t) => {
      const fixture = await configuredSdkFixture(t);
      setup(fixture);
      await assert.rejects((await createGatewayCorpusReviewer()).reviewCase(input(), reviewContext()), pattern);
      assert.equal(fixture.state.sdkRunCalls, 0);
      if (name === "dispose failure") assert.equal(fixture.state.disposeCalls, 1);
      else assert.equal(fixture.state.calls, 0);
    });
  }
});

test("bounded reviewer aborts an in-flight isolated run without SDK fallback and disposes service", async (t) => {
  const fixture = await configuredSdkFixture(t);
  const controller = new AbortController();
  fixture.state.run = async (params) => {
    controller.abort(new Error("caller aborted bounded review"));
    await new Promise((resolve, reject) => {
      if (params.abortSignal.aborted) return reject(params.abortSignal.reason);
      params.abortSignal.addEventListener("abort", () => reject(params.abortSignal.reason), { once: true });
    });
  };
  const reviewer = await createGatewayCorpusReviewer();
  await assert.rejects(reviewer.reviewCase(input(), reviewContext({ signal: controller.signal })),
    /caller aborted bounded review/);
  await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /cannot be reused/);
  assert.equal(fixture.state.sdkRunCalls, 0);
  assert.equal(fixture.state.disposeCalls, 1);
});

test("inherited deadlines are validated before reviewer auth prep or runtime admission hooks", async (t) => {
  const fixture = await configuredSdkFixture(t);
  const defaultReviewer = await createGatewayCorpusReviewer();
  for (const deadlineAtMs of [null, "1000", NaN, Infinity, 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(defaultReviewer.reviewCase(input(), reviewContext({ deadlineAtMs })), /deadline/i);
  }
  assert.equal(fixture.state.prepares, 0);
  assert.equal(fixture.state.calls, 0);
  assert.equal(fixture.state.routeCalls, 0);
  assert.deepEqual(fixture.state.transportCalls, []);

  let prepares = 0;
  let calls = 0;
  const complete = async () => { calls++; };
  complete.prepareOperationalBudget = async () => { prepares++; };
  const customReviewer = await createGatewayCorpusReviewer({ complete });
  for (const deadlineAtMs of [null, "1000", NaN, Infinity, 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(customReviewer.reviewCase(input(), reviewContext({ deadlineAtMs })), /deadline/i);
  }
  let now = 5000;
  t.mock.method(Date, "now", () => now);
  await assert.rejects(customReviewer.reviewCase(input(), reviewContext({ deadlineAtMs: now - 1 })), /deadline/i);
  assert.equal(prepares, 0);
  assert.equal(calls, 0);
});

test("past inherited deadlines fail closed before auth prep or network dispatch", async (t) => {
  let now = 5000;
  t.mock.method(Date, "now", () => now);
  const fixture = await configuredSdkFixture(t);
  const reviewer = await createGatewayCorpusReviewer();
  await assert.rejects(reviewer.reviewCase(input(), reviewContext({ deadlineAtMs: now - 1 })), /deadline/i);
  assert.equal(fixture.state.prepares, 0);
  assert.equal(fixture.state.calls, 0);
  assert.equal(fixture.state.routeCalls, 0);
  assert.deepEqual(fixture.state.transportCalls, []);
});

test("default SDK keeps the original absolute deadline across auth prep and blocks stale dispatch", async (t) => {
  for (const [name, configured, advanceMs] of [
    ["aggregate1000-configured1000", { ...configuredBudget, maxDurationMs: 1000 }, 800],
    ["aggregate1000-configured500", { ...configuredBudget, maxDurationMs: 500 }, 500],
  ]) {
    await t.test(name, async (t) => {
      let now = 1000;
      t.mock.method(Date, "now", () => now);
      t.mock.method(performance, "now", () => now);
      const fixture = await configuredSdkFixture(t, { configured });
      fixture.state.prepare = async () => { now += advanceMs; };
      const reviewer = await createGatewayCorpusReviewer();
      await assert.rejects(reviewer.reviewCase(input(), reviewContext({ timeoutMs: 1000 })), (error) => {
        assert.match(error.message, /Configured maxDurationMs/);
        assert.match(error.message, /remaining/);
        assert.match(error.message, /operator must install smaller configured limits/);
        assert.match(error.message, /setup headroom/);
        assert.match(error.message, /contextWindow/);
        assert.equal(error.budgetAccounting, undefined);
        return true;
      });
      assert.equal(fixture.state.prepares, 1);
      assert.equal(fixture.state.calls, 0);
      assert.equal(fixture.state.routeCalls, 0);
      assert.deepEqual(fixture.state.transportCalls, []);
    });
  }
});

test("default SDK dispatch wait timeout uses the earliest absolute deadline without rebasing", async (t) => {
  for (const [name, deadlineAtMs, expectedTimeoutMs] of [
    ["own timeout wins over later inherited deadline", 6000, 700],
    ["earlier inherited deadline wins", 1600, 300],
  ]) {
    await t.test(name, async (t) => {
      let now = 1000;
      t.mock.timers.enable({ apis: ["setTimeout"] });
      t.mock.method(Date, "now", () => now);
      t.mock.method(performance, "now", () => now);
      const fixture = await configuredSdkFixture(t, { configured: { ...configuredBudget, maxDurationMs: 200 } });
      fixture.state.prepare = async () => { now += 300; };
      const reviewer = await createGatewayCorpusReviewer();
      const result = await reviewer.reviewCase(input(), reviewContext({ timeoutMs: 1000, deadlineAtMs }));
      assert.equal(fixture.state.calls, 1);
      assert.equal(fixture.state.completionContext.timeoutMs, expectedTimeoutMs);
      assert.equal(result.reviewer.operationalBudget.maxDurationMs, 200);
    });
  }
});

test("every configured cap must fit both operational roots and remaining review limits before dispatch", async (t) => {
  const fixture = await configuredSdkFixture(t);
  const mapping = { maxModelRequests: "modelRequests", maxInputTokens: "inputTokens", maxOutputTokens: "outputTokens" };
  const reported = [];
  const reviewer = await createGatewayCorpusReviewer({ operationalBudget: {
    ...configuredBudget, maxDurationMs: operationalBudget.maxDurationMs,
  } });
  for (const field of Object.keys(configuredBudget)) {
    const smaller = { ...configuredBudget, [field]: configuredBudget[field] - 1 };
    for (const context of [
      reviewContext({ operationalBudget: smaller }),
      ...(mapping[field] ? [reviewContext({ budget: { ...reviewContext().budget, [mapping[field]]: smaller[field] } })] : []),
      ...(field === "maxDurationMs" ? [reviewContext({ timeoutMs: smaller[field] })] : []),
    ]) {
      await assert.rejects(reviewer.reviewCase(input(), { ...context, reportUsage: (value) => reported.push(value) }),
        /configured|smaller|limit/i);
    }
    const factory = await createGatewayCorpusReviewer({ operationalBudget: smaller });
    await assert.rejects(factory.reviewCase(input(), reviewContext()), /configured|smaller|limit/i);
  }
  assert.equal(fixture.state.calls, 0);
  assert.deepEqual(reported, []);
  const result = await reviewer.reviewCase(input(), reviewContext());
  assert.equal(result.reviewer.operationalBudget.maxToolCalls, 2, "zero tool surface is separate from the positive configured cap");
});

test("default SDK requires the full prepared contextWindow even for a tiny review prompt", async (t) => {
  const fixture = await configuredSdkFixture(t, { model: { contextWindow: 4097 } });
  await assert.rejects((await createGatewayCorpusReviewer()).reviewCase(input(), reviewContext()), /entire.*contextWindow/);
  assert.equal(fixture.state.calls, 0);
});

test("a native route cannot shrink provider context reservations or widen the output cap", async (t) => {
  for (const dimension of ["contextWindow", "maxTokens"]) {
    await t.test(dimension, async (t) => {
      const fixture = await configuredSdkFixture(t);
      fixture.state.routeOverride = () => ({ contextWindow: dimension === "contextWindow" ? 128 : 1024,
        maxTokens: dimension === "maxTokens" ? 65 : 64 });
      const reviewer = await createGatewayCorpusReviewer();
      await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /contextWindow before dispatch|widened.*output/);
      assert.equal(fixture.state.calls, 1);
      assert.equal(fixture.state.sdkRunCalls, 0);
      await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /cannot be reused/);
    });
  }
});

test("parsed runtime caps must match the operator caps before auth or dispatch", async (t) => {
  const fixture = await configuredSdkFixture(t);
  fixture.state.parseOverride = (config) => ({ ...config,
    operationalBudget: { ...configuredBudget, maxInputTokens: configuredBudget.maxInputTokens + 1 } });
  await assert.rejects((await createGatewayCorpusReviewer()).reviewCase(input(), reviewContext()), /Parsed native reviewer limits/);
  assert.equal(fixture.state.prepares, 0);
  assert.equal(fixture.state.calls, 0);
});

test("default SDK clips output to remaining configured output and the 6000 request bound", async (t) => {
  const large = { ...configuredBudget, maxInputTokens: 20000, maxOutputTokens: 9000 };
  const fixture = await configuredSdkFixture(t, { configured: large, model: { contextWindow: 8192, maxTokens: 8192 } });
  const result = await (await createGatewayCorpusReviewer()).reviewCase(input(), {
    operationalBudget: { ...large, maxDurationMs: operationalBudget.maxDurationMs },
    budget: { outputTokens: 9000, toolCalls: 0 },
  });
  assert.equal(fixture.state.completionContext.streamParams.maxTokens, 6000);
  assert.equal(result.usage.outputTokens, 17);
});

test("bounded native output cannot exceed the host-prepared model ceiling", async (t) => {
  const fixture = await configuredSdkFixture(t, { model: { maxTokens: 24 } });
  const result = await (await createGatewayCorpusReviewer()).reviewCase(input(), reviewContext());
  assert.equal(fixture.state.completionContext.streamParams.maxTokens, 24);
  assert.equal(result.reviewer.hardLimitsVerified, true);
});

test("default SDK records the smaller installed budget rather than attesting to the allocation", async (t) => {
  const installed = { ...configuredBudget, maxToolCalls: 1, maxOutputTokens: 32 };
  await configuredSdkFixture(t, { configured: installed });
  const result = await (await createGatewayCorpusReviewer()).reviewCase(input(), reviewContext());
  assert.deepEqual(result.budgetAttestation.operationalBudget, installed);
  assert.equal(result.reviewer.operationalBudget.maxToolCalls, 1);
});

test("pinned host config changes during model preparation block default SDK dispatch", async (t) => {
  const fixture = await configuredSdkFixture(t);
  for (const inMemory of [true, false]) {
    fixture.state.prepare = async ({ cfg }) => {
      if (inMemory) cfg.plugins.entries["dsh-native"].config.operationalBudget.maxToolCalls++;
      else await writeFile(fixture.configPath, "{}");
    };
    await assert.rejects((await createGatewayCorpusReviewer()).reviewCase(input(), reviewContext()), /configuration changed/);
  }
  assert.equal(fixture.state.calls, 0);
});

test("missing SDK receipt fails unknown with no fabricated zero usage, certification, or reuse", async (t) => {
  const fixture = await configuredSdkFixture(t, { mutate({ result }) {
    delete result.budgetReceipt;
    result.modelRequests = 1;
    result.assistant.usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
  } });
  const reported = [], recorded = [];
  const reviewer = await createGatewayCorpusReviewer();
  await assert.rejects(reviewer.reviewCase(input(), reviewContext({
    reportUsage: (value) => reported.push(value), recordReviewCompletion: (value) => recorded.push(value),
  })), (error) => {
    assert.match(error.message, /budgetReceipt.*unknown/);
    assert.equal(error.budgetAccounting.usageStatus, "unknown");
    assert.deepEqual(error.budgetAccounting.reserved, { modelRequests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0 });
    assert.equal(error.budgetAccounting.unresolvedExposure.modelRequests, configuredBudget.maxModelRequests);
    assert.equal(error.budgetAccounting.unresolvedExposure.inputTokens, configuredBudget.maxInputTokens);
    assert.equal(error.budgetAccounting.unresolvedExposure.outputTokens, configuredBudget.maxOutputTokens);
    assert.equal(error.budgetAccounting.observedLowerBound.modelRequests, 0, "unknown exposure is not an invented measurement");
    return true;
  });
  await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /cannot be reused/);
  assert.equal(fixture.state.calls, 1);
  assert.deepEqual(reported, []);
  assert.deepEqual(recorded, []);
});

test("default SDK ignores absent or undercounting assistant usage and counts all durable attempts", async (t) => {
  await configuredSdkFixture(t, { mutate({ result }) {
    result.modelRequests = 1;
    result.assistant.usage = { input: 1, output: 1 };
  } });
  const result = await (await createGatewayCorpusReviewer()).reviewCase(input(), reviewContext());
  assert.equal(result.usage.modelRequests, 2);
  assert.equal(result.usage.inputTokens, 32);
});

test("default SDK checks receipt identity and actual drained proof, not operator admission alone", async (t) => {
  const mutations = [
    { name: "foreign agent", mutate: ({ result }) => { result.budgetReceipt.agentId = "other"; } },
    { name: "foreign run", mutate: ({ result }) => { result.budgetReceipt.runId = "unrelated"; } },
    { name: "fenced terminal", mutate: ({ ledger }) => { ledger.entries.at(-1).type = "fenced"; } },
    { name: "unsettled provider", mutate: ({ ledger }) => { ledger.entries.at(-1).providerSettled = false; } },
    { name: "missing usage", mutate: ({ ledger }) => { delete ledger.entries[2].usage.input; } },
    { name: "admission only", mutate: ({ ledger }) => { ledger.entries = ledger.entries.slice(0, 1); } },
    { name: "reservation only", mutate: ({ ledger }) => { ledger.entries = ledger.entries.slice(0, 2); } },
    { name: "owner lock", mutate: async ({ result }) => {
      await mkdir(result.budgetReceipt.directory, { recursive: true });
      await writeFile(join(result.budgetReceipt.directory, "owner.lock"), "{}");
    }, diagnostic: /owner\.lock|owner/i },
  ];
  for (const { name, mutate, diagnostic } of mutations) {
    await t.test(`${name} receipt cannot certify`, async (t) => {
      const fixture = await configuredSdkFixture(t, { mutate });
      const reported = [];
      const reviewer = await createGatewayCorpusReviewer();
      await assert.rejects(reviewer.reviewCase(input(), reviewContext({ reportUsage: (v) => reported.push(v) })),
        (error) => {
          assert.doesNotMatch(error.message, /ENOENT|TypeError/);
          if (diagnostic) assert.match(error.message, diagnostic);
          assert.equal(error.budgetAccounting.usageStatus, "unknown");
          return true;
        });
      await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /cannot be reused/);
      assert.equal(fixture.state.calls, 1);
      assert.deepEqual(reported, []);
    });
  }
});

test("default SDK validates zero-tools content after reporting settled ledger usage", async (t) => {
  await configuredSdkFixture(t, { mutate({ result }) {
    result.assistant.content.push({ type: "toolCall", name: "forbidden" });
  } });
  const reported = [];
  await assert.rejects((await createGatewayCorpusReviewer()).reviewCase(input(),
    reviewContext({ reportUsage: (v) => reported.push(v) })), /zero tools/);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].modelRequests, 2);
});

test("default SDK rejects actual ledger tools even when assistant content is tool-free", async (t) => {
  await configuredSdkFixture(t, { mutate({ ledger }) {
    const terminal = ledger.entries.pop();
    const seq = ledger.entries.length;
    ledger.entries.push(
      { seq, at: terminal.at, type: "tool_started", callId: "forbidden" },
      { seq: seq + 1, at: terminal.at, type: "tool_settled", callId: "forbidden" },
      { ...terminal, seq: seq + 2 },
    );
  } });
  const reported = [];
  await assert.rejects((await createGatewayCorpusReviewer()).reviewCase(input(),
    reviewContext({ reportUsage: (v) => reported.push(v) })), /zero tools|toolCalls.*cap/);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].toolCalls, 1);
});

test("default SDK refuses a reused runtime receipt even when its durable proof is settled", async (t) => {
  const fixture = await configuredSdkFixture(t);
  const run = fixture.state.run;
  let prior;
  fixture.state.run = async (params) => {
    prior ??= await run(params);
    return prior;
  };
  const reported = [];
  const reviewer = await createGatewayCorpusReviewer();
  await reviewer.reviewCase(input(), reviewContext({ reportUsage: (v) => reported.push(v) }));
  await assert.rejects(reviewer.reviewCase(input(), reviewContext({ reportUsage: (v) => reported.push(v) })),
    /reused a previous review run/);
  await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /cannot be reused/);
  assert.equal(reported.length, 1);
});

test("SDK receipt cannot substitute foreign state or run history for the owned native root", async (t) => {
  for (const history of [false, true]) {
    await t.test(history ? "history under locked root" : "foreign root", async (t) => {
      await configuredSdkFixture(t, { async mutate({ result, runtimeConfig, ledger }) {
        const directory = history ? join(result.budgetReceipt.directory, "budgets",
          createHash("sha256").update(result.budgetReceipt.runId).digest("hex")) :
          join(dirname(dirname(result.budgetReceipt.directory)), "foreign-state");
        await mkdir(directory, { recursive: true });
        if (history) await writeFile(join(result.budgetReceipt.directory, "owner.lock"), "{}");
        await writeFile(join(directory, "operational-budget-config.json"), JSON.stringify(runtimeConfig));
        await writeFile(join(directory, "operational-budget-ledger.json"), JSON.stringify(ledger));
        result.budgetReceipt.directory = directory;
      } });
      const reported = [];
      await assert.rejects((await createGatewayCorpusReviewer()).reviewCase(input(),
        reviewContext({ reportUsage: (value) => reported.push(value) })), /configured isolated native state root/);
      assert.deepEqual(reported, []);
    });
  }
});

test("elapsed configured duration without terminal drain remains unknown, not settled", async (t) => {
  await configuredSdkFixture(t, { configured: { ...configuredBudget, maxDurationMs: 20 }, mutate({ ledger }) {
    ledger.entries = ledger.entries.slice(0, 2);
  } });
  const reviewer = await createGatewayCorpusReviewer();
  const reported = [];
  await assert.rejects(reviewer.reviewCase(input(), reviewContext({ reportUsage: (v) => reported.push(v) })),
    (error) => {
      assert.equal(error.budgetAccounting.usageStatus, "unknown");
      assert.equal(error.budgetAccounting.observedLowerBound.modelRequests, 1);
      assert.equal(error.budgetAccounting.reserved.modelRequests, 1);
      return true;
    });
  await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /cannot be reused/);
  assert.deepEqual(reported, []);
});

async function sourceNativeReviewFixture(t, options = {}) {
  const ts = options.distOnly ? undefined : (await import("typescript")).default;
  if (options.distOnly) {
    for (const path of ["config.js", join("native", "isolated.js"), join("native", "route.js"),
      "runtime.js", join("bridge", "budget-ledger.js")]) {
      await readFile(join(builtDistRoot, path));
    }
    await readFile(join(hostRoot, "package.json"));
  }
  const childProcess = (await import("node:child_process")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const distRoot = new URL("../dist/", import.meta.url);
  const srcRoot = new URL("../src/", import.meta.url);
  const loaded = new Set();
  const directory = resolve(scratchRoot, `reviewer-${options.distOnly ? "dist" : "source"}-native-${randomUUID()}`);
  const moduleDirectory = join(directory, "modules");
  await mkdir(moduleDirectory, { recursive: true });
  await mkdir(join(directory, "main-workspace"), { recursive: true });
  await mkdir(join(directory, "workspace"), { recursive: true });
  await mkdir(join(directory, "agent"), { recursive: true });
  const serverErrors = [];
  if (options.mode === "HTTP 503 retry") {
    const { ServerResponse } = await import("node:http");
    const writeHead = ServerResponse.prototype.writeHead;
    t.mock.method(ServerResponse.prototype, "writeHead", function (status, ...args) {
      if (status === 200 && this.req.url.endsWith("/responses") &&
          this.req.headers.authorization === "Bearer synthetic-fixture-key") {
        return writeHead.call(this, 503, { "content-type": "application/json", "retry-after": "0" });
      }
      return writeHead.call(this, status, ...args);
    });
  }
  const model = await startResponsesServer(async ({ body, text, reasoning, finish, request, response }) => {
    try {
      assert.ok(request.headers.authorization === "Bearer synthetic-fixture-key", "only fixture auth may reach loopback");
      assert.equal(request.headers.authorization.includes("oc-sent"), false);
      assert.deepEqual(body.tools ?? [], []);
      assert.equal(body.model, "gpt-6-astra");
      if (options.mode === "HTTP 503 retry") {
        assert.equal(response.statusCode, 503);
        response.end(JSON.stringify({ error: { message: "local retryable fixture error" } }));
        return;
      }
      if (options.reasoning) reasoning(options.reasoning);
      text(options.text ?? reviewText);
      finish({
        input_tokens: 20,
        output_tokens: 10,
        total_tokens: 30,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 0 },
      });
    } catch (error) {
      serverErrors.push(error);
      response.destroy(error);
    }
  });
  const configured = options.configured ?? configuredBudget;
  const pluginConfig = options.pluginConfig ?? { operationalBudget: configured };
  const config = defaultHostConfig(directory, {
    ...pluginConfig,
    allowedCopilotBaseUrls: [model.baseUrl],
    startupTimeoutMs: 120000,
    shutdownTimeoutMs: 10000,
    streamIdleTimeoutMs: 10000,
  }, { baseUrl: model.baseUrl, contextWindow: 4096, maxTokens: 128 });
  config.models.providers["github-copilot"].apiKey = {
    source: "env", provider: "default", id: "COPILOT_GITHUB_TOKEN",
  };
  const configPath = join(directory, "host-config.json");
  const reviewerConfigPath = join(directory, "reviewer-config.json");
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(reviewerConfigPath, JSON.stringify({
    hostRoot, configPath, stateDir: directory, agentId: "reviewer",
  }));
  const environment = {
    DSH_ACCEPTANCE_REVIEW_GATEWAY_CONFIG: reviewerConfigPath,
    OPENCLAW_STATE_DIR: directory,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_SECRET_SENTINELS: "on",
    COPILOT_GITHUB_TOKEN: "synthetic-fixture-key",
    GH_TOKEN: "synthetic-fixture-key",
    GITHUB_TOKEN: "synthetic-fixture-key",
  };
  const original = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const stateKey = `__gatewayReviewerSource_${randomUUID()}`;
  globalThis[stateKey] = { prepares: 0, sdkRunCalls: 0, transportCalls: [], agentDirCalls: [], workspaceDirCalls: [] };
  const simpleWrapper = join(moduleDirectory, `simple-${randomUUID()}.mjs`);
  const harnessWrapper = join(moduleDirectory, `harness-${randomUUID()}.mjs`);
  const agentRuntimeWrapper = join(moduleDirectory, `agent-runtime-${randomUUID()}.mjs`);
  const actualSimple = `${pathToFileURL(join(hostRoot, "dist", "plugin-sdk", "simple-completion-runtime.js")).href}?actual=${randomUUID()}`;
  const actualHarness = `${pathToFileURL(join(hostRoot, "dist", "plugin-sdk", "agent-harness-runtime.js")).href}?actual=${randomUUID()}`;
  const actualAgentRuntime = `${pathToFileURL(join(hostRoot, "dist", "plugin-sdk", "agent-runtime.js")).href}?actual=${randomUUID()}`;
  await writeFile(simpleWrapper, [
    `import * as actual from ${JSON.stringify(actualSimple)};`,
    `const state = globalThis[${JSON.stringify(stateKey)}];`,
    `export const completeWithPreparedSimpleCompletionModel = actual.completeWithPreparedSimpleCompletionModel;`,
    `export const extractAssistantText = actual.extractAssistantText;`,
    `export async function prepareSimpleCompletionModelForAgent(params) {`,
    `  state.prepares++; state.preparedContext = params;`,
    `  let prepared = state.prepare ? await state.prepare(params) : await actual.prepareSimpleCompletionModelForAgent(params);`,
    `  if (prepared !== undefined) state.actualPreparedResult = { model: prepared.model, auth: prepared.auth, sourceAuthFingerprint: prepared.sourceAuthFingerprint, error: prepared.error };`,
    `  if (prepared !== undefined) state.preparedResult = { model: prepared.model, auth: prepared.auth, sourceAuthFingerprint: prepared.sourceAuthFingerprint, error: prepared.error };`,
    `  return prepared;`,
    `}`,
    `export async function runHostPreparedIsolatedCompletion(params) {`,
    `  state.sdkRunCalls++; state.sdkRunContext = params; params.assertCurrent?.();`,
    `  throw new Error("bounded reviewer must not use runHostPreparedIsolatedCompletion");`,
    `}`,
  ].join("\n"));
  await writeFile(harnessWrapper, [
    `import * as actual from ${JSON.stringify(actualHarness)};`,
    `export * from ${JSON.stringify(actualHarness)};`,
    `const state = globalThis[${JSON.stringify(stateKey)}];`,
    `export function getModelProviderRequestTransport(...args) {`,
    `  state.transportCalls.push(args);`,
    `  return actual.getModelProviderRequestTransport(...args);`,
    `}`,
  ].join("\n"));
  await writeFile(agentRuntimeWrapper, [
    `import * as actual from ${JSON.stringify(actualAgentRuntime)};`,
    `export * from ${JSON.stringify(actualAgentRuntime)};`,
    `const state = globalThis[${JSON.stringify(stateKey)}];`,
    `export function resolveAgentDir(...args) { state.agentDirCalls.push(args); return actual.resolveAgentDir(...args); }`,
    `export function resolveAgentWorkspaceDir(...args) { state.workspaceDirCalls.push(args); return actual.resolveAgentWorkspaceDir(...args); }`,
  ].join("\n"));
  const preload = options.distOnly ? undefined : join(moduleDirectory, `source-preload-${randomUUID()}.mjs`);
  if (preload) await writeFile(preload, [
    `import { existsSync, readFileSync } from "node:fs";`,
    `import { registerHooks } from "node:module";`,
    `import ts from ${JSON.stringify(import.meta.resolve("typescript"))};`,
    `const distRoot = ${JSON.stringify(distRoot.href)};`,
    `const srcRoot = ${JSON.stringify(srcRoot.href)};`,
    `function sourceFor(url) {`,
    `  if (!url) return undefined;`,
    `  const clean = url.split("?")[0];`,
    `  if (!clean.startsWith(distRoot) || !clean.endsWith(".js")) return undefined;`,
    `  const source = new URL(clean.slice(distRoot.length, -3) + ".ts", srcRoot);`,
    `  return existsSync(source) ? source : undefined;`,
    `}`,
    `registerHooks({`,
    `  resolve(specifier, context, next) {`,
    `    let url;`,
    `    try { url = context.parentURL && new URL(specifier, context.parentURL).href; } catch { return next(specifier, context); }`,
    `    return sourceFor(url) ? { url, shortCircuit: true } : next(specifier, context);`,
    `  },`,
    `  load(url, context, next) {`,
    `    const source = sourceFor(url);`,
    `    if (!source) return next(url, context);`,
    `    return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(source, "utf8"), {`,
    `      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },`,
    `    }).outputText };`,
    `  },`,
    `});`,
  ].join("\n"));
  const remap = new Map([
    [pathToFileURL(join(hostRoot, "dist", "plugin-sdk", "simple-completion-runtime.js")).href, pathToFileURL(simpleWrapper).href],
    [pathToFileURL(join(hostRoot, "dist", "plugin-sdk", "agent-harness-runtime.js")).href, pathToFileURL(harnessWrapper).href],
    [pathToFileURL(join(hostRoot, "dist", "plugin-sdk", "agent-runtime.js")).href, pathToFileURL(agentRuntimeWrapper).href],
  ]);
  if (options.distOnly) {
    const isolatedWrapper = join(moduleDirectory, `native-isolated-${randomUUID()}.mjs`);
    const actualIsolated = `${pathToFileURL(join(builtDistRoot, "native", "isolated.js")).href}?actual-dist=${randomUUID()}`;
    globalThis[stateKey].afterNativeRun = options.afterNativeRun;
    globalThis[stateKey].nativeRuns = 0;
    globalThis[stateKey].nativeDisposals = 0;
    await writeFile(isolatedWrapper, [
      `import { createIsolatedCompletion as actual } from ${JSON.stringify(actualIsolated)};`,
      `const state = globalThis[${JSON.stringify(stateKey)}];`,
      `export function createIsolatedCompletion(...args) {`,
      `  const service = actual(...args);`,
      `  return {`,
      `    async run(params) {`,
      `      if (state.replayNativeResult) return structuredClone(state.replayNativeResult);`,
      `      state.nativeRuns++;`,
      `      const result = await service.run(params);`,
      `      state.nativeResult = structuredClone(result);`,
      `      await state.afterNativeRun?.(result, state);`,
      `      return result;`,
      `    },`,
      `    async dispose() { state.nativeDisposals++; await service.dispose(); },`,
      `  };`,
      `}`,
    ].join("\n"));
    remap.set(new URL("native/isolated.js", distRoot).href, pathToFileURL(isolatedWrapper).href);
    for (const path of ["config.js", "native/route.js"]) {
      remap.set(new URL(path, distRoot).href,
        `${pathToFileURL(join(builtDistRoot, ...path.split("/"))).href}?actual-dist=${randomUUID()}`);
    }
  }
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (remap.has(specifier)) return { url: remap.get(specifier), shortCircuit: true };
      if (options.distOnly) return next(specifier, context);
      const clean = specifier.split("?")[0];
      if (clean.startsWith(distRoot.href) && clean.endsWith(".js")) {
        const source = new URL(`${clean.slice(distRoot.href.length, -3)}.ts`, srcRoot);
        if (existsSync(source)) return { url: specifier, shortCircuit: true };
      }
      if (context.parentURL?.startsWith(distRoot.href) && specifier.startsWith(".") && specifier.endsWith(".js")) {
        const url = new URL(specifier, context.parentURL).href;
        const source = new URL(`${url.split("?")[0].slice(distRoot.href.length, -3)}.ts`, srcRoot);
        if (existsSync(source)) return { url, shortCircuit: true };
      }
      return next(specifier, context);
    },
    ...(options.distOnly ? {} : { load(url, context, next) {
      const clean = url.split("?")[0];
      if (!clean.startsWith(distRoot.href) || !clean.endsWith(".js")) return next(url, context);
      const source = new URL(`${clean.slice(distRoot.href.length, -3)}.ts`, srcRoot);
      if (!existsSync(source)) return next(url, context);
      loaded.add(source.href);
      return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(source, "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      }).outputText };
    } }),
  });
  const actualSpawn = childProcess.spawn;
  const spawnMock = options.distOnly ? undefined : t.mock.method(childProcess, "spawn", (command, args, options) => {
    if (command === process.execPath && /[/\\]@deepseek-ai[/\\]dsh[/\\]lib[/\\]bin\.js$/u.test(args[0] ?? "")) {
      const preloadArg = process.platform === "win32" ? pathToFileURL(preload).href : preload;
      const child = actualSpawn(command, ["--import", preloadArg, ...args], options);
      child.stderr?.on("data", (chunk) => {
        globalThis[stateKey].childStderr = ((globalThis[stateKey].childStderr ?? "") + chunk.toString("utf8")).slice(-4000);
      });
      return child;
    }
    return actualSpawn(command, args, options);
  });
  syncBuiltinESMExports();
  t.after(async () => {
    try {
      assert.equal(globalThis[stateKey].sdkRunCalls, 0);
    } finally {
      hooks.deregister();
      spawnMock?.mock.restore();
      syncBuiltinESMExports();
      await model.close();
      delete globalThis[stateKey];
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
  if (options.prepare) globalThis[stateKey].prepare = (params) => options.prepare(params, { baseUrl: model.baseUrl });
  const reported = [], recorded = [];
  const reviewer = await createGatewayCorpusReviewer();
  let result, error;
  try {
    result = await reviewer.reviewCase(options.input ?? input(), reviewContext({
      ...(options.context ?? {}),
      async reportUsage(value) {
        reported.push(value);
        await options.context?.reportUsage?.(value);
      },
      async recordReviewCompletion(value) {
        recorded.push(value);
        await options.context?.recordReviewCompletion?.(value);
      },
    }));
  } catch (caught) {
    error = caught;
  }
  if (!options.distOnly && !options.skipLoadedAssert) {
    for (const path of ["native/isolated.ts", "native/route.ts", "config.ts", "runtime.ts", "bridge/budget-ledger.ts"]) {
      assert.ok(loaded.has(new URL(path, srcRoot).href), `must execute ${path} source, not stale dist`);
    }
  }
  assert.deepEqual(serverErrors, []);
  assert.equal(globalThis[stateKey].prepares, 1);
  assert.equal(globalThis[stateKey].sdkRunCalls, 0);
  if (options.distOnly) {
    assert.equal(loaded.size, 0, "dist-native fixture must not transpile source");
    assert.equal(preload, undefined, "dist-native child must not receive a source preload");
    assert.equal(spawnMock, undefined, "dist-native child spawn must be unmodified");
  }
  if (!options.expectPrepareFailure) {
    assert.equal(globalThis[stateKey].agentDirCalls.length >= 1, true);
    assert.equal(globalThis[stateKey].workspaceDirCalls.length >= 1, true);
  }
  if (error) return { error, reported, recorded, state: globalThis[stateKey], model, directory, reviewer };
  assert.ok(result, "source-native review must either return a result or throw");
  assert.equal(result.reviewer.budgetStatus, "verified");
  assert.equal(result.reviewer.hardLimitsVerified, true);
  assert.equal(result.reviewer.quiescent, true);
  assert.equal(existsSync(result.reviewer.runtimeBudgetDirectory), true);
  assert.deepEqual(result.reviewer.operationalBudget, configured);
  assert.equal(model.requests.length, 1);
  assert.equal(result.usage.modelRequests, model.requests.length);
  assert.equal(result.usage.inputTokens, 17);
  assert.equal(result.usage.outputTokens, 10);
  assert.equal(result.usage.cacheReadTokens, 3);
  assert.equal(result.usage.cacheWriteTokens, 0);
  assert.deepEqual(reported, [result.usage]);
  assert.equal(typeof globalThis[stateKey].preparedResult.sourceAuthFingerprint, "string");
  assert.ok(model.requests[0].headers.authorization === "Bearer synthetic-fixture-key");
  const history = join(result.reviewer.runtimeBudgetDirectory, "budgets", createHash("sha256").update(result.reviewer.runId).digest("hex"));
  assert.equal(await readFile(join(result.reviewer.runtimeBudgetDirectory, "operational-budget-config.json"), "utf8"),
    await readFile(join(history, "operational-budget-config.json"), "utf8"));
  assert.equal(await readFile(join(result.reviewer.runtimeBudgetDirectory, "operational-budget-ledger.json"), "utf8"),
    await readFile(join(history, "operational-budget-ledger.json"), "utf8"));
  return { result, reported, recorded, state: globalThis[stateKey], model, directory, reviewer };
}

async function sourceNativeBudgetDirectories(directory) {
  const roots = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("isolated-")) continue;
    const isolated = join(directory, entry.name);
    for (const child of await readdir(isolated, { withFileTypes: true })) {
      if (child.isDirectory() && existsSync(join(isolated, child.name, "operational-budget-ledger.json"))) {
        roots.push(join(isolated, child.name));
      }
    }
  }
  return roots;
}

test("source-native isolated completion uses current TypeScript runtime, retained proof, and real host auth prep", { timeout: 120000 }, async (t) => {
  await t.test("success uses wire auth and exact per-agent budget", async (t) => {
    const perAgentOnly = { operationalBudgetByAgent: { reviewer: configuredBudget } };
    const { result, state, error } = await sourceNativeReviewFixture(t, { pluginConfig: perAgentOnly });
    assert.equal(error, undefined);
    assert.equal(state.preparedContext.bindAuthOwner, true);
    assert.ok(state.preparedResult.sourceAuthFingerprint);
    assert.equal(state.preparedResult.sourceAuthFingerprint, state.actualPreparedResult.sourceAuthFingerprint);
    assert.match(state.preparedResult.auth.apiKey, /^oc-sent-v2\./);
    assert.equal(state.preparedResult.auth.apiKey, state.actualPreparedResult.auth.apiKey);
    assert.deepEqual(result.reviewer.operationalBudget, configuredBudget);
  });

  await t.test("unknown process-local sentinel fails before service or provider work", async (t) => {
    const unknown = `oc-sent-v2.${"A".repeat(60)}.end`;
    const { error, model, state } = await sourceNativeReviewFixture(t, {
      expectPrepareFailure: true,
      expectNoTransport: true,
      skipLoadedAssert: true,
      prepare: (_params, { baseUrl }) => ({ model: copilotModel({ baseUrl }),
        auth: { apiKey: unknown, source: "profile", mode: "token" }, sourceAuthFingerprint: "fixture-unknown-sentinel" }),
    });
    assert.match(error.message, /Secret sentinel .*not registered/);
    assert.equal(model.requests.length, 0);
    assert.equal(state.transportCalls.length, 0);
  });

  await t.test("auth preparation failure blocks native dispatch", async (t) => {
    const { error, model, state } = await sourceNativeReviewFixture(t, {
      expectPrepareFailure: true,
      expectNoTransport: true,
      skipLoadedAssert: true,
      prepare: () => ({ error: { message: "synthetic auth preparation failure" } }),
    });
    assert.match(error.message, /Host could not prepare/);
    assert.equal(model.requests.length, 0);
    assert.equal(state.transportCalls.length, 0);
  });

  await t.test("a source route narrowed by model contextTokens blocks before provider work", async (t) => {
    const { error, model } = await sourceNativeReviewFixture(t, {
      skipLoadedAssert: true,
      prepare: (_params, { baseUrl }) => ({
        model: copilotModel({ baseUrl, contextWindow: 4096, contextTokens: 1024 }),
        auth: { apiKey: "synthetic-fixture-key", source: "profile", mode: "token" },
        sourceAuthFingerprint: "fixture-narrowed-context",
      }),
    });
    assert.match(error.message, /full prepared provider contextWindow before dispatch/);
    assert.equal(model.requests.length, 0);
  });

  for (const mode of ["HTTP 503 retry", "output cap breach"]) {
    await t.test(`${mode} retains budget state without retry, certification, or fallback`, async (t) => {
      const configured = mode === "output cap breach" ? { ...configuredBudget, maxOutputTokens: 6 } : configuredBudget;
      const { error, reported, model, directory, reviewer } = await sourceNativeReviewFixture(t, { mode, configured, skipLoadedAssert: true });
      assert.ok(["DSH_BUDGET_EXCEEDED", "DSH_BUDGET_UNCERTAIN"].includes(error.code) ||
        /DSH_BUDGET_(?:EXCEEDED|UNCERTAIN)|operational budget|retained ownership locks/i.test(error.message));
      assert.equal(model.requests.length, 1, "budgeted transport failures cannot retry or fall back unmetered");
      assert.deepEqual(reported, []);
      await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /cannot be reused/);
      const roots = await sourceNativeBudgetDirectories(directory);
      assert.equal(roots.length, 1);
      const ledger = JSON.parse(await readFile(join(roots[0], "operational-budget-ledger.json"), "utf8"));
      assert.equal(ledger.entries.filter((entry) => entry.type === "request_reserved").length, 1);
      assert.equal(ledger.entries.at(-1).type, "fenced");
    });
  }
});

test("custom budget opt-in without runtime admission never invokes completion", async () => {
  let calls = 0;
  const reviewer = await createGatewayCorpusReviewer({ async complete() { calls++; } });
  await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /prepareOperationalBudget/);
  assert.equal(calls, 0);
});

test("factory and context operational roots require all five positive safe integers", async () => {
  let calls = 0;
  const complete = async () => { calls++; };
  const invalidRoots = [null, [], {}, "budget"];
  for (const key of Object.keys(operationalBudget)) {
    const missing = { ...operationalBudget };
    delete missing[key];
    invalidRoots.push(missing);
    for (const value of [0, -1, 1.5, "1", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      invalidRoots.push({ ...operationalBudget, [key]: value });
    }
  }
  const reviewer = await createGatewayCorpusReviewer({ complete });
  for (const root of invalidRoots) {
    await assert.rejects(createGatewayCorpusReviewer({ complete, operationalBudget: root }), /operationalBudget/);
    await assert.rejects(reviewer.reviewCase(input(), reviewContext({ operationalBudget: root })), /operationalBudget/);
  }
  assert.equal(calls, 0);
});

test("exhausted review caps fail before runtime preparation or completion", async () => {
  let calls = 0;
  const complete = async () => { calls++; };
  complete.prepareOperationalBudget = async () => { calls++; };
  const reviewer = await createGatewayCorpusReviewer({ complete });
  for (const field of ["modelRequests", "inputTokens", "outputTokens"]) {
    await assert.rejects(reviewer.reviewCase(input(), reviewContext({
      budget: { ...reviewContext().budget, [field]: 0 },
    })), /budget remains/);
  }
  for (const timeoutMs of [0, -1, 0.5, "100", Infinity]) {
    await assert.rejects(reviewer.reviewCase(input(), reviewContext({ timeoutMs })), /timeoutMs/);
  }
  assert.equal(calls, 0);
});

test("exhausted or missing priced currency prevents direct reviewer model admission", async () => {
  let calls = 0;
  const reviewer = await createGatewayCorpusReviewer({ async complete() { calls++; } });
  for (const currencyMicros of [0, -1, undefined, 0.5]) {
    await assert.rejects(reviewer.reviewCase(input(), { budget: { priced: true, currencyMicros } }), /currency budget/);
  }
  assert.equal(calls, 0);
});

test("fenced review proof propagates actual consumption rather than unknown zero", async (t) => {
  const { complete } = await runtimeCompleter(t, { mutateSettlement(state) { state.ledger.entries.at(-1).type = "fenced"; } });
  const reviewer = await createGatewayCorpusReviewer({ complete });
  await assert.rejects(reviewer.reviewCase(input(), reviewContext()), (error) => {
    assert.equal(error.budgetAccounting.usageStatus, "unknown");
    assert.equal(error.budgetAccounting.observedLowerBound.modelRequests, 1);
    assert.equal(error.budgetAccounting.observedLowerBound.inputTokens, 20);
    assert.equal(error.budgetAccounting.observedLowerBound.outputTokens, 10);
    return true;
  });
});

test("completion exceptions retain measured journal attempts and pending reservations without fallback", async (t) => {
  for (const pending of [false, true]) {
    const { complete, state } = await runtimeCompleter(t, { failureAfterJournal: true,
      secondAttempt: !pending,
      mutateSettlement(state) {
        if (pending) state.ledger.entries = state.ledger.entries.slice(0, 2);
      },
    });
    const reported = [];
    const reviewer = await createGatewayCorpusReviewer({ complete });
    await assert.rejects(reviewer.reviewCase(input(), reviewContext({ reportUsage: (delta) => reported.push(delta) })),
      (error) => {
        assert.match(error.message, /Synthetic completion failed/);
        assert.equal(error.budgetAccounting.usageStatus, "unknown");
        assert.equal(error.budgetAccounting.observedLowerBound.modelRequests, pending ? 1 : 2);
        assert.equal(error.budgetAccounting.observedLowerBound.inputTokens, pending ? 0 : 32);
        assert.equal(error.budgetAccounting.reserved.modelRequests, pending ? 1 : 0);
        assert.equal(error.budgetAccounting.reserved.inputTokens, pending ? 1024 : 0);
        return true;
      });
    await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /cannot be reused/);
    assert.equal(state.calls, 1);
    assert.deepEqual(reported, [], "uncertain journals must not be reported as complete usage");
  }
});

test("incomplete assertion coverage reports incurred cost but cannot return semantic certification", async () => {
  const reported = [], recorded = [];
  const reviewer = await createGatewayCorpusReviewer({ async complete() {
    return { text: reviewRecords.slice(0, -1).map(JSON.stringify).join("\n"), usage, zeroToolsEnforced: true };
  } });
  await assert.rejects(reviewer.reviewCase(input(), {
    reportUsage: (delta) => reported.push(delta), recordReviewCompletion: (record) => recorded.push(record),
  }), /missing.*forbiddenEffects/);
  assert.deepEqual(reported, [usage]);
  assert.equal(recorded.length, 1);
});

test("a runtime ownership lock defeats reviewer settlement claims even with a terminal ledger", async (t) => {
  const { complete, state } = await runtimeCompleter(t, { async onComplete(state) {
    await writeFile(join(state.directory, "owner.lock"), "{}");
  } });
  const reviewer = await createGatewayCorpusReviewer({ complete });
  await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /owner.lock/);
  await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /cannot be reused/);
  assert.equal(state.calls, 1);
});

test("model and evidence budgets cannot enable runtime proof or replace the trusted root", async () => {
  const source = input();
  source.operationalBudget = operationalBudget;
  source.testCase.operationalBudget = operationalBudget;
  source.evidence.operationalBudget = operationalBudget;
  let prepares = 0;
  const complete = async (_prompt, context) => {
    assert.equal(context.operationalBudget, undefined);
    assert.equal(context.reportUsage, undefined);
    return { text: reviewText, usage, zeroToolsEnforced: true, operationalBudget,
      receipt: { budgetStatus: "verified", hardLimitsVerified: true } };
  };
  complete.prepareOperationalBudget = async () => { prepares++; };
  const reviewer = await createGatewayCorpusReviewer({ complete });
  const result = await reviewer.reviewCase(source, { runId: "dut" });
  assert.equal(prepares, 0);
  assert.equal(result.reviewer.budgetStatus, "legacy-unattested");
  assert.equal(result.reviewer.hardLimitsVerified, false);
});

test("missing or unsafe actual usage never becomes zero and fences reviewer reuse", async () => {
  const invalid = [undefined, { ...usage, modelRequests: 0 }, { ...usage, modelRequests: undefined },
    { ...usage, inputTokens: undefined }, { ...usage, outputTokens: undefined },
    { ...usage, cacheReadTokens: undefined }, { ...usage, cacheWriteTokens: undefined },
    { ...usage, modelRequests: Number.MAX_SAFE_INTEGER + 1 }];
  for (const incompleteUsage of invalid) {
    let calls = 0;
    const reported = [];
    const reviewer = await createGatewayCorpusReviewer({ async complete() {
      calls++;
      return { text: reviewText, zeroToolsEnforced: true, usage: incompleteUsage };
    } });
    await assert.rejects(reviewer.reviewCase(input(), { reportUsage: (delta) => reported.push(delta) }), /usage unproven/);
    await assert.rejects(reviewer.reviewCase(input()), /cannot be reused/);
    assert.equal(calls, 1);
    assert.deepEqual(reported, []);
  }
});

test("default reviewer without operationalBudget fails before SDK auth or network work", async (t) => {
  const setResult = await isolatedSdkFixture(t);
  await setResult({ assistant: { stopReason: "stop", content: [{ type: "text", text: reviewText }],
    usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 } }, modelRequests: 2 });
  const reported = [];
  const reviewer = await createGatewayCorpusReviewer();
  await assert.rejects(reviewer.reviewCase(input(), { reportUsage: (delta) => reported.push(delta) }),
    /requires operationalBudget before model work/);
  assert.equal(setResult.state.prepares, 0);
  assert.equal(setResult.state.calls, 0);
  assert.deepEqual(reported, []);
});

test("legacy options.complete still requires explicit complete usage and rejects tool content after reporting", async () => {
  for (const mode of ["missing usage", "tool content"]) {
    const reported = [];
    const reviewer = await createGatewayCorpusReviewer({ async complete() {
      return mode === "missing usage" ? { text: reviewText, zeroToolsEnforced: true } :
        { text: reviewText, usage: { ...usage, toolCalls: 1 }, zeroToolsEnforced: false };
    } });
    await assert.rejects(reviewer.reviewCase(input(), { reportUsage: (delta) => reported.push(delta) }),
      mode === "missing usage" ? /usage unproven/ : /zero tools/);
    assert.deepEqual(reported, mode === "missing usage" ? [] : [{ ...usage, toolCalls: 1 }]);
  }
});

test("malformed review JSON reports complete usage once before parsing fails", async () => {
  const reported = [];
  const recorded = [];
  const reviewer = await createGatewayCorpusReviewer({ async complete() {
    return { text: '{"turn":0', usage, zeroToolsEnforced: true };
  } });
  await assert.rejects(reviewer.reviewCase(input(), {
    reportUsage: (delta) => reported.push(delta), recordReviewCompletion: (receipt) => recorded.push(receipt),
  }), SyntaxError);
  assert.deepEqual(reported, [usage]);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].receipt.budgetStatus, "legacy-unattested");
});

test("unfinished completion is fenced even when zero-tools validation fails first", async () => {
  const reported = [];
  let calls = 0;
  const reviewer = await createGatewayCorpusReviewer({ async complete() {
    calls++;
    return { text: reviewText, usage, finished: false, zeroToolsEnforced: false };
  } });
  await assert.rejects(reviewer.reviewCase(input(), { reportUsage: (delta) => reported.push(delta) }), /zero tools/);
  await assert.rejects(reviewer.reviewCase(input()), /cannot be reused/);
  assert.equal(calls, 1);
  assert.deepEqual(reported, [usage]);
});

test("timeout or abort does not prove settlement and permanently prevents reviewer reuse", async () => {
  for (const explicitAbort of [false, true]) {
    const controller = new AbortController();
    let calls = 0;
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const reported = [];
    const reviewer = await createGatewayCorpusReviewer({ async complete(_prompt, context) {
      calls++;
      if (explicitAbort) controller.abort(new Error("Caller aborted review"));
      assert.ok(context.signal);
      return pending;
    } });
    await assert.rejects(reviewer.reviewCase(input(), {
      timeoutMs: explicitAbort ? 1000 : 10, signal: controller.signal, reportUsage: (delta) => reported.push(delta),
    }), /timed out|Caller aborted/);
    release({ text: reviewText, usage, zeroToolsEnforced: true });
    await pending;
    await assert.rejects(reviewer.reviewCase(input()), /cannot be reused/);
    assert.equal(calls, 1);
    assert.deepEqual(reported, []);
  }
});

test("custom runtime admission rechecks the admitted duration before invoking completion", async (t) => {
  let now = 2000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(performance, "now", () => now);
  const { complete, state } = await runtimeCompleter(t, { mutateAdmission(state) {
    now += 600;
    state.at = now - 100;
    state.ledger.entries[0].at = state.at;
  } });
  const reviewer = await createGatewayCorpusReviewer({ complete });
  await assert.rejects(reviewer.reviewCase(input(), reviewContext({ timeoutMs: 1000 })), (error) => {
    assert.match(error.message, /Configured maxDurationMs/);
    assert.match(error.message, /remaining/);
    assert.match(error.message, /operator must install smaller configured limits/);
    assert.match(error.message, /setup headroom/);
    assert.match(error.message, /contextWindow/);
    assert.equal(error.budgetAccounting?.usageStatus, "unknown");
    return true;
  });
  assert.equal(state.prepares, 1);
  assert.equal(state.calls, 0);
  await assert.rejects(reviewer.reviewCase(input(), reviewContext({ timeoutMs: 1000 })), /cannot be reused/);
});

test("review case headroom never widens the native attempt or enables tools", async (t) => {
  const { complete, state } = await runtimeCompleter(t);
  const reviewer = await createGatewayCorpusReviewer({ complete });
  const attemptBudget = { maxModelRequests: 2, maxInputTokens: 2048, maxOutputTokens: 64,
    maxToolCalls: 1, maxDurationMs: 500 };
  const gates = [];
  const result = await reviewer.reviewCase(input(), reviewContext({
    caseBudget: operationalBudget, attemptBudget, timeoutMs: 2000,
    beforeDispatch: (configured) => gates.push(configured),
  }));
  assert.equal(state.calls, 1);
  assert.deepEqual(state.prepareContext.operationalBudget, attemptBudget);
  assert.deepEqual(gates, [attemptBudget]);
  assert.deepEqual(result.budgetAttestation.operationalBudget, attemptBudget);
  assert.equal(state.completionContext.timeoutMs, 2000);
  assert.equal(state.completionContext.budget.toolCalls, 0);
  assert.equal(result.usage.toolCalls, 0);
});

test("review dispatch must pass the runner pool gate after native admission and before completion", async (t) => {
  const { complete, state } = await runtimeCompleter(t);
  const reviewer = await createGatewayCorpusReviewer({ complete });
  let checks = 0;
  await assert.rejects(reviewer.reviewCase(input(), reviewContext({
    beforeDispatch() { checks++; throw new Error("review aggregate pool exhausted"); },
  })), /review aggregate pool exhausted/);
  assert.equal(checks, 1);
  assert.equal(state.prepares, 1);
  assert.equal(state.calls, 0);
});

test("explicit reviewer attempt ceilings reject wider installed defaults before model preparation", async (t) => {
  const fixture = await configuredSdkFixture(t);
  const reviewer = await createGatewayCorpusReviewer();
  await assert.rejects(reviewer.reviewCase(input(), reviewContext({
    caseBudget: operationalBudget,
    attemptBudget: { ...operationalBudget, maxModelRequests: 1 },
  })), /Configured maxModelRequests.*remaining/);
  assert.equal(fixture.state.prepares, 0);
  assert.equal(fixture.state.calls, 0);
});

test("backward wallclock movement during review preparation cannot renew the native dispatch budget", async (t) => {
  let wall = 10000, monotonic = 1000;
  t.mock.method(Date, "now", () => wall);
  t.mock.method(performance, "now", () => monotonic);
  const { complete, state } = await runtimeCompleter(t, { mutateAdmission(state) {
    wall -= 5000;
    monotonic += 600;
    state.at = wall - 100;
    state.ledger.entries[0].at = state.at;
  } });
  const reviewer = await createGatewayCorpusReviewer({ complete });
  await assert.rejects(reviewer.reviewCase(input(), reviewContext({
    timeoutMs: 2000, deadlineAtMs: wall + 1000,
  })), /Configured maxDurationMs.*remaining/);
  assert.equal(state.prepares, 1);
  assert.equal(state.calls, 0);
});

test("trusted runtime hook receives narrowed immutable caps and separately enforces zero tools", async (t) => {
  const { complete, state } = await runtimeCompleter(t);
  const factoryRoot = { ...operationalBudget, maxModelRequests: 2, maxInputTokens: 2048, maxDurationMs: 800 };
  const reviewer = await createGatewayCorpusReviewer({ complete, operationalBudget: factoryRoot });
  factoryRoot.maxInputTokens = 999999;
  const context = reviewContext({ budget: { ...reviewContext().budget, outputTokens: 24 } });
  const reported = [];
  context.reportUsage = (delta) => reported.push(delta);
  const source = input();
  source.evidence.operationalBudget = { ...operationalBudget, maxInputTokens: 999999 };
  const result = await reviewer.reviewCase(source, context);
  assert.equal(state.prepares, 1);
  assert.equal(state.calls, 1);
  assert.deepEqual(state.prepareContext.operationalBudget, {
    maxModelRequests: 2, maxInputTokens: 2048, maxOutputTokens: 24, maxToolCalls: 2, maxDurationMs: 800,
  });
  assert.equal(state.prepareContext.zeroTools, true);
  assert.equal(state.prepareContext.budget.toolCalls, 0);
  assert.ok(Object.isFrozen(state.prepareContext.operationalBudget));
  assert.equal(state.prepareContext.reportUsage, undefined);
  assert.notEqual(state.prepareContext.runId, context.runId);
  assert.match(state.prepareContext.sessionKey, /^acceptance-review-/);
  assert.equal(state.prepareContext.agentId, "reviewer");
  assert.equal(state.completionContext.runtimeBudgetDirectory, state.directory);
  assert.equal(result.reviewer.budgetStatus, "verified");
  assert.equal(result.reviewer.hardLimitsVerified, true);
  assert.equal(result.reviewer.quiescent, true);
  assert.equal(result.usage.modelRequests, 1);
  assert.equal(result.usage.inputTokens, 20);
  assert.equal(result.usage.outputTokens, 10);
  assert.equal(result.usage.cacheReadTokens, 3);
  assert.equal(result.usage.cacheWriteTokens, 2);
  assert.deepEqual(reported, [result.usage]);
});

test("a tiny nominal prompt cannot bypass full contextWindow admission", async (t) => {
  const { complete, state } = await runtimeCompleter(t, { contextWindow: 8192 });
  const reviewer = await createGatewayCorpusReviewer({ complete });
  const source = input();
  source.testCase.prompt = "x";
  await assert.rejects(reviewer.reviewCase(source, reviewContext()), /contextWindow|inputTokens|input.*budget/i);
  assert.equal(state.prepares, 1);
  assert.equal(state.calls, 0);
});

test("settled ledger accounts for every provider attempt including maintenance rather than reservations", async (t) => {
  const { complete } = await runtimeCompleter(t, { secondAttempt: true });
  const reviewer = await createGatewayCorpusReviewer({ complete });
  const result = await reviewer.reviewCase(input(), reviewContext({ budget: { ...reviewContext().budget, outputTokens: 36 } }));
  assert.equal(result.usage.modelRequests, 2);
  assert.equal(result.usage.inputTokens, 32);
  assert.equal(result.usage.outputTokens, 17);
  assert.equal(result.usage.cacheReadTokens, 4);
  assert.equal(result.usage.cacheWriteTokens, 2);
});

test("ledger cost is reported before rejecting underreported completion usage", async (t) => {
  const { complete } = await runtimeCompleter(t, { secondAttempt: true, result: {
    usage: { ...usage, modelRequests: 1 },
  } });
  const reported = [];
  const reviewer = await createGatewayCorpusReviewer({ complete });
  await assert.rejects(reviewer.reviewCase(input(), reviewContext({ reportUsage: (delta) => reported.push(delta) })),
    /underreports ledger/);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].modelRequests, 2);
  assert.equal(reported[0].inputTokens, 32);
});

test("settled tool cost is accounted before zero-tools certification fails", async (t) => {
  const { complete } = await runtimeCompleter(t, { tool: true });
  const reported = [];
  const reviewer = await createGatewayCorpusReviewer({ complete });
  await assert.rejects(reviewer.reviewCase(input(), reviewContext({ reportUsage: (delta) => reported.push(delta) })),
    /zero tools|toolCalls.*cap/);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].modelRequests, 1);
  assert.equal(reported[0].toolCalls, 1);
});

test("admission proof must be identity-bound and precede all provider work", async (t) => {
  const { complete, state } = await runtimeCompleter(t, { mutateAdmission(state) {
    state.ledger.runId = "different-run";
  } });
  const reviewer = await createGatewayCorpusReviewer({ complete });
  await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /runId|identity|run/i);
  assert.equal(state.calls, 0);
});

test("fenced, incomplete, stale or malformed settlement cannot certify or allow reuse", async (t) => {
  const mutations = [
    (state) => { state.ledger.entries.at(-1).type = "fenced"; },
    (state) => { state.ledger.entries.at(-1).providerSettled = false; },
    (state) => { delete state.ledger.entries[2].usage.input; },
    (state) => { state.ledger.entries = state.ledger.entries.slice(0, 1); },
    (state) => { state.ledger.configSha256 = "0".repeat(64); },
  ];
  for (const mutateSettlement of mutations) {
    const { complete, state } = await runtimeCompleter(t, { mutateSettlement });
    const reported = [];
    const reviewer = await createGatewayCorpusReviewer({ complete });
    await assert.rejects(reviewer.reviewCase(input(), reviewContext({ reportUsage: (delta) => reported.push(delta) })));
    await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /cannot be reused/);
    assert.equal(state.calls, 1);
    assert.deepEqual(reported, []);
  }
});

test("settlement cannot replace admitted configuration even with a matching new hash", async (t) => {
  const { complete } = await runtimeCompleter(t, { mutateSettlement(state) {
    state.runtimeConfig.contextWindow = 2048;
    state.ledger.entries[1].inputTokens = 2048;
    state.ledger.configSha256 = createHash("sha256").update(JSON.stringify(state.runtimeConfig)).digest("hex");
  } });
  const reviewer = await createGatewayCorpusReviewer({ complete });
  await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /configuration changed|contextWindow/);
  await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /cannot be reused/);
});

test("completion must identify the admitted durable proof directory rather than embed model proof", async (t) => {
  const { complete, state } = await runtimeCompleter(t, { result: {
    runtimeBudgetDirectory: undefined, runtimeBudgetProof: { status: "settled", hardLimitsVerified: true },
  } });
  const reported = [];
  const reviewer = await createGatewayCorpusReviewer({ complete });
  await assert.rejects(reviewer.reviewCase(input(), reviewContext({ reportUsage: (delta) => reported.push(delta) })),
    /same trusted runtimeBudgetDirectory/);
  assert.deepEqual(reported, [], "an unbound completion cannot report settled usage");
  assert.equal(JSON.parse(await readFile(join(state.directory, "operational-budget-ledger.json"), "utf8"))
    .entries.at(-1).type, "settled");
  await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /cannot be reused/);
});

const noReservations = { modelRequests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0 };
const exposureOf = (budget) => ({ modelRequests: budget.maxModelRequests, inputTokens: budget.maxInputTokens,
  outputTokens: budget.maxOutputTokens, toolCalls: 0 });
const admittedBudget = { maxModelRequests: 2, maxInputTokens: 2048, maxOutputTokens: 32,
  maxToolCalls: 1, maxDurationMs: 1000 };

async function distBudgetCompleter(t, { configured = admittedBudget, run, prepare } = {}) {
  const { BudgetLedger } = await import(pathToFileURL(join(builtDistRoot, "bridge", "budget-ledger.js")).href);
  const directory = resolve(scratchRoot, `reviewer-dist-ledger-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = { directory, prepares: 0, calls: 0 };
  const complete = async (_prompt, context) => {
    state.calls++;
    await run?.(state, context);
    return { text: reviewText, zeroToolsEnforced: true, runtimeBudgetDirectory: directory };
  };
  complete.prepareOperationalBudget = async (context) => {
    state.prepares++;
    state.config = { version: 1, runId: context.runId, sessionKey: context.sessionKey, agentId: context.agentId,
      operationalBudget: { ...configured }, contextWindow: 1024, maxTokens: 32 };
    state.ledger = new BudgetLedger(directory, state.config, "main", Date.now());
    await state.ledger.initialize();
    await prepare?.(state);
    return directory;
  };
  return { complete, state };
}

async function settleDistRequest(state) {
  const { requestId } = await state.ledger.reserve({ maxTokens: 32 });
  await state.ledger.settle({ requestId, usage: { input: 20, output: 10, cacheRead: 3, cacheWrite: 2 } });
}

test("dist reviewer journals retain measured usage and exact reservations plus full unresolved exposure", async (t) => {
  for (const mode of ["admission only", "pending", "partial after usage", "active after usage", "malformed", "fenced", "owner lock",
    "source reply lock", "config mismatch", "config bytes changed", "unknown admission identity", "no proof",
    "settled completion error", "settled completion missing binding", "completion timeout", "completion abort", "completion fence"]) {
    await t.test(mode, async (t) => {
      // Journal states must not depend on wall-clock corrections or durable I/O latency.
      t.mock.timers.enable({ apis: ["Date"], now: 2000 });
      const { complete, state } = await distBudgetCompleter(t, {
        async prepare(state) {
          if (mode !== "unknown admission identity") return;
          const path = join(state.directory, "operational-budget-ledger.json");
          const ledger = JSON.parse(await readFile(path, "utf8"));
          ledger.runId = "foreign-run";
          await writeFile(path, JSON.stringify(ledger));
        },
        async run(state) {
          if (mode === "admission only") throw new Error("Synthetic completion error");
          if (mode === "no proof") {
            await rm(join(state.directory, "operational-budget-ledger.json"));
            throw new Error("Synthetic completion error");
          }
          if (mode === "pending") {
            await state.ledger.reserve({ maxTokens: 32 });
            throw new Error("Synthetic completion error");
          }
          await settleDistRequest(state);
          if (mode === "active after usage") throw new Error("Synthetic completion error");
          if (mode === "partial after usage") await state.ledger.reserve({ maxTokens: 32 });
          if (["malformed", "partial after usage"].includes(mode)) {
            const path = join(state.directory, "operational-budget-ledger.json");
            const ledger = JSON.parse(await readFile(path, "utf8"));
            ledger.entries.push({ seq: ledger.entries.length, at: Date.now(), type: "invalid-event" });
            await writeFile(path, JSON.stringify(ledger));
            return;
          }
          if (mode === "fenced") return state.ledger.fence();
          await state.ledger.finish();
          if (mode.endsWith("lock")) {
            await writeFile(join(state.directory, mode === "owner lock" ? "owner.lock" : "source-reply.lock"), "{}");
          }
          if (mode === "config mismatch") {
            state.config.operationalBudget.maxInputTokens = 1024;
            const path = join(state.directory, "operational-budget-ledger.json");
            const ledger = JSON.parse(await readFile(path, "utf8"));
            ledger.configSha256 = createHash("sha256").update(JSON.stringify(state.config)).digest("hex");
            await writeFile(join(state.directory, "operational-budget-config.json"), JSON.stringify(state.config));
            await writeFile(path, JSON.stringify(ledger));
          }
          if (mode === "config bytes changed") {
            await writeFile(join(state.directory, "operational-budget-config.json"), JSON.stringify(state.config, null, 2));
          }
          if (mode === "settled completion error") {
            await writeFile(join(state.directory, "binding.json"), JSON.stringify({
              status: "ready", lastRunId: state.config.runId, sessionId: state.config.sessionKey,
              consumedRunIds: [state.config.runId],
            }));
            throw new Error("Synthetic completion error");
          }
          if (mode === "settled completion missing binding") throw new Error("Synthetic completion error");
          if (mode.startsWith("completion ")) throw Object.assign(new Error("Synthetic completion interrupted"), {
            name: mode === "completion timeout" ? "TimeoutError" : mode === "completion abort" ? "AbortError" : "FencedError",
          });
        },
      });
      const reported = [], recorded = [];
      const reviewer = await createGatewayCorpusReviewer({ complete });
      await assert.rejects(reviewer.reviewCase(input(), reviewContext({
        reportUsage: (value) => reported.push(value), recordReviewCompletion: (value) => recorded.push(value),
      })), (error) => {
        if (mode === "pending") assert.equal(error.message, "Synthetic completion error");
        const accounting = error.budgetAccounting;
        const untrusted = ["config mismatch", "unknown admission identity", "no proof"].includes(mode);
        const measured = !untrusted && !["admission only", "pending"].includes(mode);
        assert.equal(accounting.usageStatus, "unknown");
        assert.equal(accounting.observedLowerBound.modelRequests,
          mode === "partial after usage" ? 2 : measured || mode === "pending" ? 1 : 0);
        assert.equal(accounting.observedLowerBound.inputTokens, measured ? 20 : 0);
        assert.equal(accounting.observedLowerBound.outputTokens, measured ? 10 : 0);
        assert.equal(accounting.observedLowerBound.cacheReadTokens, measured ? 3 : 0);
        assert.equal(accounting.observedLowerBound.cacheWriteTokens, measured ? 2 : 0);
        assert.deepEqual(accounting.reserved, ["pending", "partial after usage"].includes(mode) ?
          { modelRequests: 1, inputTokens: 1024, outputTokens: mode === "pending" ? 32 : 22, toolCalls: 0 } : noReservations);
        assert.deepEqual(accounting.unresolvedExposure, mode === "settled completion error" ? noReservations :
          exposureOf(untrusted || mode === "config bytes changed" ? operationalBudget : admittedBudget));
        return true;
      });
      assert.equal(state.prepares, 1);
      assert.equal(state.calls, mode === "unknown admission identity" ? 0 : 1);
      assert.deepEqual(reported, []);
      assert.deepEqual(recorded, []);
      await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /cannot be reused/);
    });
  }
});

test("dist reviewer journals enforce admission and reservation deadlines with a controlled clock", async (t) => {
  for (const mode of ["admission at deadline", "reservation before deadline", "reservation at deadline"]) {
    await t.test(mode, async (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: 2000 });
      const expiredAdmission = mode === "admission at deadline";
      const pending = mode === "reservation before deadline";
      const { complete, state } = await distBudgetCompleter(t, {
        async prepare() {
          if (expiredAdmission) t.mock.timers.tick(admittedBudget.maxDurationMs);
        },
        async run(state) {
          t.mock.timers.tick(admittedBudget.maxDurationMs - (pending ? 1 : 0));
          await state.ledger.reserve({ maxTokens: 32 });
          throw new Error("Synthetic completion error");
        },
      });
      const reported = [], recorded = [];
      const reviewer = await createGatewayCorpusReviewer({ complete });
      await assert.rejects(reviewer.reviewCase(input(), reviewContext({
        reportUsage: (value) => reported.push(value), recordReviewCompletion: (value) => recorded.push(value),
      })), (error) => {
        assert.equal(error.message, expiredAdmission ? "Runtime budget admission deadline already expired" :
          pending ? "Synthetic completion error" : "DSH_BUDGET_EXCEEDED: Operational budget exhausted.");
        if (!expiredAdmission && !pending) assert.equal(error.code, "DSH_BUDGET_EXCEEDED");
        const accounting = error.budgetAccounting;
        assert.equal(accounting.usageStatus, "unknown");
        assert.deepEqual(accounting.observedLowerBound, { modelRequests: pending ? 1 : 0,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
          userTurns: 0, toolCalls: 0, priced: false });
        assert.deepEqual(accounting.reserved, pending ?
          { modelRequests: 1, inputTokens: 1024, outputTokens: 32, toolCalls: 0 } : noReservations);
        assert.deepEqual(accounting.unresolvedExposure, exposureOf(expiredAdmission ? operationalBudget : admittedBudget));
        return true;
      });
      const ledger = JSON.parse(await readFile(join(state.directory, "operational-budget-ledger.json"), "utf8"));
      assert.deepEqual(ledger.entries.map((entry) => entry.type), pending ? ["admitted", "request_reserved"] : ["admitted"]);
      if (pending) assert.equal(ledger.entries[1].at - ledger.entries[0].at, admittedBudget.maxDurationMs - 1);
      assert.equal(state.prepares, 1);
      assert.equal(state.calls, expiredAdmission ? 0 : 1);
      assert.deepEqual(reported, []);
      assert.deepEqual(recorded, []);
      await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /cannot be reused/);
    });
  }
});

test("dist reviewer timeout and abort retain exposure even when the durable journal is drained", async (t) => {
  for (const explicitAbort of [false, true]) {
    await t.test(explicitAbort ? "abort" : "timeout", async (t) => {
      const controller = new AbortController();
      const { complete, state } = await distBudgetCompleter(t, { async run(state, context) {
        await settleDistRequest(state);
        await state.ledger.finish();
        if (explicitAbort) controller.abort(new Error("Synthetic caller abort"));
        await new Promise((resolve, reject) => {
          if (context.signal.aborted) return reject(context.signal.reason);
          context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
        });
      } });
      const reviewer = await createGatewayCorpusReviewer({ complete });
      const reported = [];
      await assert.rejects(reviewer.reviewCase(input(), reviewContext({
        timeoutMs: 2000, signal: controller.signal, reportUsage: (value) => reported.push(value),
      })), (error) => {
        assert.match(error.message, /timed out|Synthetic caller abort/);
        assert.equal(error.budgetAccounting.observedLowerBound.inputTokens, 20);
        assert.deepEqual(error.budgetAccounting.reserved, noReservations);
        assert.deepEqual(error.budgetAccounting.unresolvedExposure, exposureOf(admittedBudget));
        return true;
      });
      assert.equal(state.calls, 1);
      assert.deepEqual(reported, []);
      await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /cannot be reused/);
    });
  }
});

test("native priced or currency allocations fail before reviewer preparation while legacy observation remains supported", async (t) => {
  const fixture = await isolatedSdkFixture(t, { pluginConfig: { operationalBudget: configuredBudget } });
  let prepares = 0, calls = 0;
  const complete = async () => { calls++; };
  complete.prepareOperationalBudget = async () => { prepares++; };
  for (const reviewer of [await createGatewayCorpusReviewer(), await createGatewayCorpusReviewer({ complete })]) {
    for (const extra of [{ priced: true }, { priced: true, currencyMicros: 100 }, { currencyMicros: 100 },
      { priced: false, currencyMicros: 0 }, { currencyMicros: null }]) {
      await assert.rejects(reviewer.reviewCase(input(), reviewContext({
        budget: { ...reviewContext().budget, ...extra },
      })), (error) => {
        assert.match(error.message, /priced|currency/i);
        assert.match(error.message, /operator/i);
        assert.equal(error.budgetAccounting, undefined);
        return true;
      });
    }
  }
  assert.equal(prepares + calls + fixture.state.prepares + fixture.state.calls, 0);
  const pricedUsage = { ...usage, priced: true, currencyMicros: 20 };
  const legacy = await createGatewayCorpusReviewer({ async complete() {
    return { text: reviewText, usage: pricedUsage, zeroToolsEnforced: true };
  } });
  const result = await legacy.reviewCase(input(), { budget: { priced: true, currencyMicros: 100 } });
  assert.deepEqual(result.usage, pricedUsage);
  assert.equal(result.reviewer.budgetStatus, "legacy-unattested");
});

test("default native cache ceilings are checked against installed total input before auth preparation", async (t) => {
  const fixture = await isolatedSdkFixture(t, { pluginConfig: { operationalBudget: configuredBudget } });
  const reviewer = await createGatewayCorpusReviewer();
  for (const field of ["cacheReadTokens", "cacheWriteTokens"]) {
    for (const cap of [0, 1, configuredBudget.maxInputTokens - 1]) {
      await assert.rejects(reviewer.reviewCase(input(), reviewContext({
        budget: { ...reviewContext().budget, [field]: cap },
      })), (error) => {
        assert.match(error.message, new RegExp(field));
        assert.match(error.message, /operator/i);
        assert.equal(error.budgetAccounting, undefined);
        return true;
      });
    }
  }
  assert.equal(fixture.state.prepares, 0);
  assert.equal(fixture.state.calls, 0);
});

test("dist custom admission must fit each cache ceiling using the actual installed cap, not context size or allocation", async (t) => {
  for (const field of ["cacheReadTokens", "cacheWriteTokens"]) {
    await t.test(field, async (t) => {
      const { complete, state } = await distBudgetCompleter(t);
      const reviewer = await createGatewayCorpusReviewer({ complete });
      await assert.rejects(reviewer.reviewCase(input(), reviewContext({
        budget: { ...reviewContext().budget, [field]: 1024 },
      })), (error) => {
        assert.match(error.message, new RegExp(field));
        assert.match(error.message, /operator/i);
        assert.deepEqual(error.budgetAccounting.reserved, noReservations);
        assert.deepEqual(error.budgetAccounting.unresolvedExposure, exposureOf(admittedBudget));
        return true;
      });
      assert.equal(state.prepares, 1);
      assert.equal(state.calls, 0);
    });
  }
  await t.test("smaller admitted cap may fit caches below the allocation", async (t) => {
    const { complete, state } = await distBudgetCompleter(t, { async run(state) {
      await settleDistRequest(state);
      await state.ledger.finish();
    } });
    const result = await (await createGatewayCorpusReviewer({ complete })).reviewCase(input(), reviewContext({
      budget: { ...reviewContext().budget, cacheReadTokens: 2048, cacheWriteTokens: 2048 },
    }));
    assert.equal(state.calls, 1);
    assert.deepEqual(result.budgetAttestation.operationalBudget, admittedBudget);
    assert.deepEqual(result.reviewer.operationalBudget, admittedBudget);
  });
});

test("dist default journal failures preserve installed exposure independently of zero or partial reservations", async (t) => {
  for (const mode of ["admission only", "malformed", "pending", "owner lock", "config mismatch", "missing proof"]) {
    await t.test(mode, async (t) => {
      const fixture = await configuredSdkFixture(t, { distOnly: true, async mutate({ result, ledger, runtimeConfig }) {
        if (mode === "admission only") ledger.entries = ledger.entries.slice(0, 1);
        if (mode === "pending") ledger.entries = ledger.entries.slice(0, 2);
        if (mode === "malformed") ledger.entries[2].type = "invalid-event";
        if (mode === "owner lock") {
          await mkdir(result.budgetReceipt.directory, { recursive: true });
          await writeFile(join(result.budgetReceipt.directory, "owner.lock"), "{}");
        }
        if (mode === "config mismatch") {
          runtimeConfig.operationalBudget = { ...runtimeConfig.operationalBudget, maxModelRequests: 2 };
          ledger.configSha256 = createHash("sha256").update(JSON.stringify(runtimeConfig)).digest("hex");
        }
        if (mode === "missing proof") delete result.budgetReceipt;
      } });
      const reviewer = await createGatewayCorpusReviewer();
      await assert.rejects(reviewer.reviewCase(input(), reviewContext()), (error) => {
        const accounting = error.budgetAccounting;
        assert.deepEqual(accounting.unresolvedExposure, exposureOf(configuredBudget));
        assert.deepEqual(accounting.reserved, ["pending", "malformed"].includes(mode) ?
          { modelRequests: 1, inputTokens: 1024, outputTokens: 64, toolCalls: 0 } : noReservations);
        assert.equal(accounting.observedLowerBound.modelRequests,
          ["owner lock", "config mismatch"].includes(mode) ? 2 : ["pending", "malformed"].includes(mode) ? 1 : 0);
        return true;
      });
      assert.equal(fixture.state.calls, 1);
      assert.equal(fixture.state.sdkRunCalls, 0);
      await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /cannot be reused/);
    });
  }
});

const reviewCanaries = {
  prompt: "REVIEW-PROMPT-CANARY-PRIVATE",
  output: "REVIEW-OUTPUT-CANARY-PRIVATE",
  reasoning: "REVIEW-REASONING-CANARY-PRIVATE",
  secret: "REVIEW-SECRET-CANARY-SYNTHETIC",
};
const malformedReviewText = `${reviewText}\r\n${reviewCanaries.output} π🧪 ${reviewCanaries.secret}`;
const invalidBusinessReviewText = [
  { ...reviewRecords[0], submissionId: reviewCanaries.output }, ...reviewRecords.slice(1),
].map((record) => JSON.stringify(record)).join("\n");
const settledReviewUsage = { modelRequests: 1, inputTokens: 20, outputTokens: 10, cacheReadTokens: 3,
  cacheWriteTokens: 2, userTurns: 0, toolCalls: 0, priced: false };
const nativeReviewUsage = { ...settledReviewUsage, inputTokens: 17, cacheWriteTokens: 0 };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const outputIdentity = (text) => ({ sha256: sha256(text), utf8Bytes: Buffer.byteLength(text, "utf8") });

function privateReviewInput() {
  const source = input();
  source.testCase.prompt = reviewCanaries.prompt;
  source.evidence.turns[0].outputText = reviewCanaries.output;
  source.evidence.turns[0].reasoning = reviewCanaries.reasoning;
  return source;
}

function assertNoReviewPayload(value) {
  const visible = inspect(value, { depth: null, showHidden: true });
  for (const canary of [...Object.values(reviewCanaries), "synthetic-fixture-key"]) {
    assert.equal(visible.includes(canary), false, "diagnostics and proof must not contain private payloads");
  }
}

function assertParseFailure(error, text, code) {
  assert.ok(error instanceof Error);
  assert.equal(error.code, code);
  if (code === "REVIEW_JSON_INVALID") {
    assert.ok(error instanceof SyntaxError);
    assert.deepEqual(error.diagnosis, { code, ...outputIdentity(text) });
  }
  assert.equal(error.cause, undefined, "raw JSON.parse failures must not survive as a cause");
  assertNoReviewPayload(error);
}

function assertCompleteReviewAccounting(error, measured, receipt) {
  assert.deepEqual(error.budgetAccounting, {
    usageStatus: "complete", usage: measured, observedLowerBound: measured,
    reserved: noReservations, unresolvedExposure: noReservations,
  });
  assert.deepEqual(error.usage, measured);
  assert.deepEqual(error.reviewer, receipt);
  assert.deepEqual(error.budgetAttestation, {
    status: "verified", hardLimitsVerified: true, quiescent: true,
    operationalBudget: receipt.operationalBudget, contextWindow: receipt.contextWindow,
  });
  assert.deepEqual(error.cleanup, { cleaned: true, quiescent: true });
  assert.equal(error.turns, undefined, "a failed business review cannot become a successful verdict");
}

function assertUnreleasedReviewAccounting(error) {
  assert.ok(error instanceof Error);
  assert.equal(error.budgetAccounting.usageStatus, "unknown");
  assert.equal(error.budgetAccounting.usage, undefined);
  assert.ok(error.budgetAccounting.unresolvedExposure.modelRequests > 0);
  assert.ok(error.budgetAccounting.unresolvedExposure.inputTokens > 0);
  assert.ok(error.budgetAccounting.unresolvedExposure.outputTokens > 0);
  assert.notEqual(error.budgetAttestation?.status, "verified");
  assert.notEqual(error.cleanup?.quiescent, true);
  assert.equal(error.reviewer?.reviewerProofPath, undefined);
  assertNoReviewPayload(error);
}

async function assertDurableReviewProof(receipt, source, text, measured) {
  const directory = receipt.runtimeBudgetDirectory;
  assert.equal(receipt.reviewerProofPath, join(directory, "reviewer-proof.json"));
  const bytes = await readFile(receipt.reviewerProofPath, "utf8");
  const saved = JSON.parse(bytes);
  assert.equal(saved.version, 1);
  assert.equal(saved.caseId, source.testCase.id);
  assert.equal(saved.evidenceSha256, evidenceDigest(source.evidence));
  assert.equal(saved.completionStatus, "complete");
  assert.deepEqual(saved.output, outputIdentity(text));
  assert.deepEqual(saved.usage, measured);
  assert.deepEqual(saved.receipt, receipt);
  assert.deepEqual(saved.cleanup, { cleaned: true, quiescent: true });
  assert.deepEqual(saved.budgetAttestation, {
    status: "verified", hardLimitsVerified: true, quiescent: true,
    operationalBudget: receipt.operationalBudget, contextWindow: receipt.contextWindow,
  });
  const nativeProof = await readRuntimeBudgetProof(directory, { ...receipt, settled: true });
  assert.deepEqual(saved.nativeProof, nativeProof, "retain the entire verified native proof, not selected usage counters");
  assert.deepEqual(nativeProof.usage, measured);
  assert.equal(nativeProof.status, "settled");
  assert.equal(nativeProof.quiescent, true);
  assert.equal(nativeProof.hardLimitsVerified, true);
  for (const key of ["runId", "sessionKey", "agentId", "configSha256"]) {
    assert.equal(nativeProof[key], receipt[key]);
  }
  for (const [file, key] of [["operational-budget-config.json", "configSha256"],
    ["operational-budget-ledger.json", "ledgerSha256"]]) {
    const value = JSON.parse(await readFile(join(directory, file), "utf8"));
    assert.equal(nativeProof[key], sha256(JSON.stringify(value)));
  }
  const bindingBytes = await readFile(join(directory, "binding.json"), "utf8");
  const binding = JSON.parse(bindingBytes);
  assert.equal(binding.status, "ready");
  assert.equal(binding.lastRunId, receipt.runId);
  assert.ok(typeof binding.sessionId === "string" && binding.sessionId.length > 0);
  assert.ok(binding.consumedRunIds.includes(receipt.runId));
  for (const key of ["budgetFailure", "failureDiagnostic", "pendingCompact"]) assert.equal(binding[key], undefined);
  assert.deepEqual(saved.binding, {
    status: "ready", lastRunId: receipt.runId, sessionId: binding.sessionId, sha256: sha256(bindingBytes),
  });
  assertNoReviewPayload(saved);
  return bytes;
}

test("review parser failures expose only fixed diagnostics and whole-output fingerprints", async (t) => {
  let jsonMessage;
  for (const text of [malformedReviewText, `${reviewCanaries.secret} {"turn":`,
    `${reviewCanaries.reasoning}\n${reviewCanaries.output}`]) {
    await t.test(`malformed JSON ${outputIdentity(text).utf8Bytes} bytes`, () => {
      assert.throws(() => parseReviewLines(text, input().oracleCase.reviews), (error) => {
        assertParseFailure(error, text, "REVIEW_JSON_INVALID");
        jsonMessage ??= error.message;
        assert.equal(error.message, jsonMessage, "safe parser message must not vary with raw output");
        return true;
      });
    });
  }
  for (const [name, text, message] of [
    ["business identity", invalidBusinessReviewText, "Independent reviewer returned an invalid or duplicate verdict/submissionId"],
    ["missing coverage", reviewRecords.slice(0, -1).map(JSON.stringify).join("\n"),
      "Independent review is missing turn 0 forbiddenEffects assertions"],
    ["invalid assertion", [...reviewRecords, { turn: 0, category: reviewCanaries.secret }].map(JSON.stringify).join("\n"),
      "Independent reviewer returned an invalid assertion record"],
  ]) {
    await t.test(name, () => {
      assert.throws(() => parseReviewLines(text, input().oracleCase.reviews), (error) => {
        assertParseFailure(error, text, "REVIEW_RECORD_INVALID");
        assert.equal(error.message, message);
        return true;
      });
    });
  }
});

test("bound parser failures retain complete accounting and durable reviewer proof without certifying business success", async (t) => {
  for (const [name, text, code] of [
    ["malformed JSON", malformedReviewText, "REVIEW_JSON_INVALID"],
    ["invalid business identity", invalidBusinessReviewText, "REVIEW_RECORD_INVALID"],
  ]) {
    await t.test(name, async (t) => {
      const source = privateReviewInput();
      const { complete, state } = await runtimeCompleter(t, { binding: {}, result: { text } });
      const reviewer = await createGatewayCorpusReviewer({ complete });
      const reported = [], recorded = [], proofBytes = [];
      let failure;
      await assert.rejects(reviewer.reviewCase(source, reviewContext({
        reportUsage: (value) => reported.push(value),
        async recordReviewCompletion(value) {
          recorded.push(value);
          proofBytes.push(await assertDurableReviewProof(value.receipt, source, text, settledReviewUsage));
        },
      })), (error) => {
        failure = error;
        assertParseFailure(error, text, code);
        return true;
      });
      assert.deepEqual(reported, [settledReviewUsage]);
      assert.equal(recorded.length, 1);
      const receipt = recorded[0].receipt;
      assert.deepEqual(Object.keys(recorded[0]).sort(), ["caseId", "evidenceSha256", "receipt", "text", "usage"]);
      assert.deepEqual(recorded[0], { caseId: source.testCase.id, evidenceSha256: evidenceDigest(source.evidence),
        text, usage: settledReviewUsage, receipt });
      assert.equal(receipt.kind, "test-runtime");
      assert.equal(receipt.budgetStatus, "verified");
      assert.equal(receipt.usageStatus, "complete");
      assert.equal(receipt.runId, state.runtimeConfig.runId);
      assertCompleteReviewAccounting(failure, settledReviewUsage, receipt);
      assert.equal(await assertDurableReviewProof(receipt, source, text, settledReviewUsage), proofBytes[0],
        "proof must remain durable and unchanged after parsing rejects");
      assert.equal(state.calls, 1);
    });
  }
});

test("bound successful review preserves the existing completion callback shape with additive proof path", async (t) => {
  const source = input();
  const { complete } = await runtimeCompleter(t, { binding: {} });
  const reviewer = await createGatewayCorpusReviewer({ complete });
  const recorded = [], reported = [];
  const result = await reviewer.reviewCase(source, reviewContext({
    reportUsage: (value) => reported.push(value),
    recordReviewCompletion: (value) => recorded.push(value),
  }));
  assert.deepEqual(recorded, [{ caseId: source.testCase.id, evidenceSha256: evidenceDigest(source.evidence),
    text: reviewText, usage: settledReviewUsage, receipt: result.reviewer }]);
  assert.deepEqual(reported, [settledReviewUsage]);
  assert.deepEqual(result.turns, parseReviewLines(reviewText, source.oracleCase.reviews));
  await assertDurableReviewProof(result.reviewer, source, reviewText, settledReviewUsage);
});

test("parser recovery requires a ready unfenced exact-identity binding, not a settled custom ledger alone", async (t) => {
  for (const mode of ["missing", "invalid JSON", "running", "blocked", "foreign run", "missing native session",
    "unconsumed run", "budgetFailure", "failureDiagnostic", "pendingCompact"]) {
    await t.test(mode, async (t) => {
      const { complete, state } = await runtimeCompleter(t, {
        binding: {}, result: { text: malformedReviewText },
        async afterSettlement(state) {
          const path = join(state.directory, "binding.json");
          if (mode === "missing") return rm(path);
          if (mode === "invalid JSON") return writeFile(path, "{");
          const binding = JSON.parse(await readFile(path, "utf8"));
          if (["running", "blocked"].includes(mode)) binding.status = mode;
          if (mode === "foreign run") binding.lastRunId = "other-run";
          if (mode === "missing native session") delete binding.sessionId;
          if (mode === "unconsumed run") binding.consumedRunIds = [];
          if (mode === "budgetFailure") binding.budgetFailure = "DSH_BUDGET_UNCERTAIN";
          if (mode === "failureDiagnostic") binding.failureDiagnostic = { reason: "termination-unconfirmed" };
          if (mode === "pendingCompact") binding.pendingCompact = { runId: state.runtimeConfig.runId };
          await writeFile(path, JSON.stringify(binding));
        },
      });
      const reviewer = await createGatewayCorpusReviewer({ complete });
      const reported = [];
      await assert.rejects(reviewer.reviewCase(privateReviewInput(), reviewContext({
        reportUsage: (value) => reported.push(value),
      })), (error) => {
        assertUnreleasedReviewAccounting(error);
        return true;
      });
      assert.ok(reported.length <= 1);
      assert.equal(existsSync(join(state.directory, "reviewer-proof.json")), false);
    });
  }
});

test("parser recovery never releases missing incomplete cross-identity or locked native proof", async (t) => {
  for (const mode of ["missing ledger", "admission only", "pending request", "fenced", "foreign runId",
    "foreign sessionKey", "foreign agentId", "config fingerprint", "config bytes", "owner.lock", "source-reply.lock"]) {
    await t.test(mode, async (t) => {
      const { complete, state } = await runtimeCompleter(t, {
        binding: {}, result: { text: malformedReviewText },
        async afterSettlement(state) {
          const path = join(state.directory, "operational-budget-ledger.json");
          if (mode === "missing ledger") return rm(path);
          if (mode.endsWith(".lock")) return writeFile(join(state.directory, mode), "{}");
          if (mode === "config bytes") {
            return writeFile(join(state.directory, "operational-budget-config.json"), JSON.stringify(state.runtimeConfig, null, 2));
          }
          const ledger = JSON.parse(await readFile(path, "utf8"));
          if (mode === "admission only") ledger.entries = ledger.entries.slice(0, 1);
          if (mode === "pending request") ledger.entries = ledger.entries.slice(0, 2);
          if (mode === "fenced") ledger.entries.at(-1).type = "fenced";
          if (mode.startsWith("foreign ")) ledger[mode.slice("foreign ".length)] = "other-identity";
          if (mode === "config fingerprint") ledger.configSha256 = "0".repeat(64);
          await writeFile(path, JSON.stringify(ledger));
        },
      });
      const reviewer = await createGatewayCorpusReviewer({ complete });
      const reported = [], recorded = [];
      await assert.rejects(reviewer.reviewCase(privateReviewInput(), reviewContext({
        reportUsage: (value) => reported.push(value), recordReviewCompletion: (value) => recorded.push(value),
      })), (error) => {
        assertUnreleasedReviewAccounting(error);
        return true;
      });
      assert.deepEqual(reported, []);
      assert.deepEqual(recorded, []);
      assert.equal(existsSync(join(state.directory, "reviewer-proof.json")), false);
    });
  }
});

test("review callbacks report usage at most once and cannot turn callback errors into parser recovery", async (t) => {
  for (const callback of ["reportUsage", "recordReviewCompletion"]) {
    await t.test(callback, async (t) => {
      const { complete } = await runtimeCompleter(t, { binding: {}, result: { text: malformedReviewText } });
      const reviewer = await createGatewayCorpusReviewer({ complete });
      const reported = [], recorded = [];
      const callbackError = new SyntaxError("Synthetic callback failure");
      await assert.rejects(reviewer.reviewCase(input(), reviewContext({
        reportUsage(value) {
          reported.push(value);
          if (callback === "reportUsage") throw callbackError;
        },
        recordReviewCompletion(value) {
          recorded.push(value);
          throw callbackError;
        },
      })), (error) => {
        assert.equal(error, callbackError);
        assert.notEqual(error.budgetAccounting?.usageStatus, "complete");
        assert.notEqual(error.budgetAttestation?.status, "verified");
        assert.notEqual(error.code, "REVIEW_JSON_INVALID");
        return true;
      });
      assert.deepEqual(reported, [settledReviewUsage]);
      assert.equal(recorded.length, callback === "reportUsage" ? 0 : 1);
    });
  }
});

test("reviewer revalidates native proof and binding after each completion callback before parser recovery", async (t) => {
  for (const callback of ["reportUsage", "recordReviewCompletion"]) {
    for (const mutation of ["binding", "ledger", "config", "lock"]) {
      await t.test(`${callback}: ${mutation}`, async (t) => {
        const { complete, state } = await runtimeCompleter(t, { binding: {}, result: { text: malformedReviewText } });
        const reviewer = await createGatewayCorpusReviewer({ complete });
        const reported = [], recorded = [];
        const mutate = async () => {
          if (mutation === "lock") return writeFile(join(state.directory, "owner.lock"), "{}");
          const name = mutation === "binding" ? "binding.json" :
            mutation === "ledger" ? "operational-budget-ledger.json" : "operational-budget-config.json";
          const path = join(state.directory, name);
          const value = JSON.parse(await readFile(path, "utf8"));
          if (mutation === "binding") value.lastRunId = "other-run";
          if (mutation === "ledger") value.entries.at(-1).type = "fenced";
          if (mutation === "config") value.operationalBudget.maxOutputTokens--;
          await writeFile(path, JSON.stringify(value));
        };
        await assert.rejects(reviewer.reviewCase(privateReviewInput(), reviewContext({
          async reportUsage(value) { reported.push(value); if (callback === "reportUsage") await mutate(); },
          async recordReviewCompletion(value) { recorded.push(value); if (callback === "recordReviewCompletion") await mutate(); },
        })), (error) => {
          assertUnreleasedReviewAccounting(error);
          return true;
        });
        assert.deepEqual(reported, [settledReviewUsage]);
        assert.ok(recorded.length <= 1);
      });
    }
  }
});

test("bound parser recovery never overwrites an existing reviewer proof", async (t) => {
  const previous = '{"version":1,"caseId":"previous-case","sentinel":"must-not-overwrite"}\n';
  const { complete, state } = await runtimeCompleter(t, {
    binding: {}, result: { text: malformedReviewText },
    afterSettlement: (state) => writeFile(join(state.directory, "reviewer-proof.json"), previous),
  });
  const reviewer = await createGatewayCorpusReviewer({ complete });
  const reported = [];
  await assert.rejects(reviewer.reviewCase(input(), reviewContext({
    reportUsage: (value) => reported.push(value),
  })), (error) => {
    assert.notEqual(error.budgetAccounting?.usageStatus, "complete");
    assert.notEqual(error.budgetAttestation?.status, "verified");
    assert.notEqual(error.code, "REVIEW_JSON_INVALID");
    return true;
  });
  assert.equal(await readFile(join(state.directory, "reviewer-proof.json"), "utf8"), previous);
  assert.ok(reported.length <= 1);
});

test("bound reviewer proof is synced before callbacks and sync failure cannot release accounting", async (t) => {
  for (const failSync of [false, true]) {
    await t.test(failSync ? "sync failure" : "synced proof", async (t) => {
      const { default: fs } = await import("node:fs/promises");
      const { syncBuiltinESMExports } = await import("node:module");
      const { complete, state } = await runtimeCompleter(t, { binding: {}, result: { text: malformedReviewText } });
      const proofPath = join(state.directory, "reviewer-proof.json");
      const originalOpen = fs.open;
      const events = [];
      const syncFailure = new Error("Synthetic proof sync failure");
      const mock = t.mock.method(fs, "open", async (path, ...args) => {
        const handle = await originalOpen(path, ...args);
        if (path === proofPath) {
          const sync = handle.sync.bind(handle);
          t.mock.method(handle, "sync", async () => {
            events.push("sync");
            if (failSync) throw syncFailure;
            await sync();
            events.push("synced");
          });
        }
        return handle;
      });
      syncBuiltinESMExports();
      t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
      const reported = [], recorded = [];
      const reviewer = await createGatewayCorpusReviewer({ complete });
      await assert.rejects(reviewer.reviewCase(input(), reviewContext({
        reportUsage: (value) => reported.push(value),
        recordReviewCompletion(value) {
          assert.ok(events.includes("synced"), "persist and fsync proof before exposing it to callbacks");
          recorded.push(value);
        },
      })), (error) => {
        if (failSync) {
          assert.notEqual(error.code, "REVIEW_JSON_INVALID");
          assert.notEqual(error.budgetAccounting?.usageStatus, "complete");
          assert.notEqual(error.budgetAttestation?.status, "verified");
        } else {
          assertParseFailure(error, malformedReviewText, "REVIEW_JSON_INVALID");
          assertCompleteReviewAccounting(error, settledReviewUsage, recorded[0].receipt);
        }
        return true;
      });
      assert.ok(events.includes("sync"), "real proof file must be flushed, not only written");
      assert.equal(recorded.length, failSync ? 0 : 1);
      assert.ok(reported.length <= 1);
    });
  }
});

test("legacy malformed review remains unattested despite complete reported usage and claimed native receipt", async () => {
  const reported = [], recorded = [];
  const reviewer = await createGatewayCorpusReviewer({ async complete() {
    return { text: malformedReviewText, usage, zeroToolsEnforced: true,
      receipt: { budgetStatus: "verified", hardLimitsVerified: true, quiescent: true } };
  } });
  await assert.rejects(reviewer.reviewCase(privateReviewInput(), {
    reportUsage: (value) => reported.push(value), recordReviewCompletion: (value) => recorded.push(value),
  }), (error) => {
    assertParseFailure(error, malformedReviewText, "REVIEW_JSON_INVALID");
    assert.notEqual(error.budgetAccounting?.usageStatus, "complete");
    assert.notEqual(error.budgetAttestation?.status, "verified");
    assert.equal(error.reviewer?.reviewerProofPath, undefined);
    return true;
  });
  assert.deepEqual(reported, [usage]);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].receipt.budgetStatus, "legacy-unattested");
  assert.equal(recorded[0].receipt.hardLimitsVerified, false);
  assert.equal(recorded[0].receipt.reviewerProofPath, undefined);
});

test("bound drained malformed review retains unresolved exposure on caller abort or deadline", async (t) => {
  for (const mode of ["abort", "timeout"]) {
    await t.test(mode, async (t) => {
      const controller = new AbortController();
      if (mode === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
      const { complete, state } = await runtimeCompleter(t, {
        binding: {}, result: { text: malformedReviewText },
        async afterSettlement(_state, context) {
          if (mode === "abort") controller.abort(new Error("Synthetic caller abort"));
          else t.mock.timers.tick(2000);
          context.signal.throwIfAborted();
        },
      });
      const reviewer = await createGatewayCorpusReviewer({ complete });
      const reported = [], recorded = [];
      await assert.rejects(reviewer.reviewCase(input(), reviewContext({
        signal: controller.signal, timeoutMs: 2000,
        reportUsage: (value) => reported.push(value), recordReviewCompletion: (value) => recorded.push(value),
      })), (error) => {
        assertUnreleasedReviewAccounting(error);
        assert.deepEqual(error.budgetAccounting.observedLowerBound, settledReviewUsage);
        assert.deepEqual(error.budgetAccounting.reserved, noReservations);
        assert.deepEqual(error.budgetAccounting.unresolvedExposure, exposureOf(state.runtimeConfig.operationalBudget));
        return true;
      });
      assert.deepEqual(reported, []);
      assert.deepEqual(recorded, []);
      assert.equal(existsSync(join(state.directory, "reviewer-proof.json")), false);
      await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /cannot be reused/);
      assert.equal(state.calls, 1);
    });
  }
});

test("bound parser recovery rejects interruption during usage or completion callbacks", async (t) => {
  for (const callback of ["reportUsage", "recordReviewCompletion"]) {
    for (const mode of ["abort", "timeout"]) {
      await t.test(`${callback}: ${mode}`, async (t) => {
        const controller = new AbortController();
        if (mode === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
        const { complete, state } = await runtimeCompleter(t, { binding: {}, result: { text: malformedReviewText } });
        const reviewer = await createGatewayCorpusReviewer({ complete });
        const reported = [], recorded = [];
        const interrupt = () => {
          if (mode === "abort") controller.abort(new Error("Synthetic callback abort"));
          else t.mock.timers.tick(2000);
        };
        await assert.rejects(reviewer.reviewCase(input(), reviewContext({
          signal: controller.signal, timeoutMs: 2000,
          reportUsage(value) { reported.push(value); if (callback === "reportUsage") interrupt(); },
          recordReviewCompletion(value) { recorded.push(value); if (callback === "recordReviewCompletion") interrupt(); },
        })), (error) => {
          assertUnreleasedReviewAccounting(error);
          assert.deepEqual(error.budgetAccounting.observedLowerBound, settledReviewUsage);
          assert.deepEqual(error.budgetAccounting.unresolvedExposure, exposureOf(state.runtimeConfig.operationalBudget));
          return true;
        });
        assert.deepEqual(reported, [settledReviewUsage]);
        assert.ok(recorded.length <= 1);
        await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /cannot be reused/);
        assert.equal(state.calls, 1);
      });
    }
  }
});

test("throwing callbacks cannot release cached settlement after fencing the native proof", async (t) => {
  for (const callback of ["reportUsage", "recordReviewCompletion"]) {
    await t.test(callback, async (t) => {
      const { complete, state } = await runtimeCompleter(t, { binding: {}, result: { text: malformedReviewText } });
      const reviewer = await createGatewayCorpusReviewer({ complete });
      const failure = new Error("Synthetic callback failure");
      let reports = 0;
      const fence = async () => {
        await writeFile(join(state.directory, "owner.lock"), "{}");
        throw failure;
      };
      await assert.rejects(reviewer.reviewCase(input(), reviewContext({
        async reportUsage() { reports++; if (callback === "reportUsage") await fence(); },
        async recordReviewCompletion() { if (callback === "recordReviewCompletion") await fence(); },
      })), (error) => {
        assert.equal(error, failure);
        assertUnreleasedReviewAccounting(error);
        return true;
      });
      assert.equal(reports, 1);
      assert.equal(existsSync(join(state.directory, "reviewer-proof.json")), false);
    });
  }
});

test("a stalled completion callback is cancelled and its durable proof is invalidated on timeout", async (t) => {
  const { complete, state } = await runtimeCompleter(t, { binding: {}, result: { text: malformedReviewText } });
  const reviewer = await createGatewayCorpusReviewer({ complete });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reports = 0;
  await assert.rejects(reviewer.reviewCase(input(), reviewContext({
    timeoutMs: 2000,
    reportUsage() { reports++; },
    async recordReviewCompletion() {
      assert.equal(existsSync(join(state.directory, "reviewer-proof.json")), true);
      t.mock.timers.tick(2000);
      await new Promise(() => {});
    },
  })), (error) => {
    assertUnreleasedReviewAccounting(error);
    return true;
  });
  assert.equal(reports, 1);
  assert.equal(existsSync(join(state.directory, "reviewer-proof.json")), false);
  await assert.rejects(reviewer.reviewCase(input(), reviewContext()), /cannot be reused/);
});

test("completion callbacks cannot replace the output bound by the durable proof", async (t) => {
  const source = input();
  const { complete } = await runtimeCompleter(t, { binding: {}, result: { text: malformedReviewText } });
  let retained;
  const wrapped = async (...args) => (retained = await complete(...args));
  wrapped.prepareOperationalBudget = complete.prepareOperationalBudget;
  const reviewer = await createGatewayCorpusReviewer({ complete: wrapped });
  let receipt;
  await assert.rejects(reviewer.reviewCase(source, reviewContext({
    recordReviewCompletion(value) { receipt = value.receipt; retained.text = reviewText; },
  })), (error) => {
    assertParseFailure(error, malformedReviewText, "REVIEW_JSON_INVALID");
    assertCompleteReviewAccounting(error, settledReviewUsage, receipt);
    return true;
  });
  await assertDurableReviewProof(receipt, source, malformedReviewText, settledReviewUsage);
});

async function runFreshDistNativeTest(t) {
  if (process.env.DSH_REVIEWER_DIST_PROCESS === t.name) return false;
  const { execFile } = await import("node:child_process");
  const pattern = t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const env = { ...process.env, DSH_REVIEWER_DIST_PROCESS: t.name };
  delete env.NODE_TEST_CONTEXT;
  // Source fixtures cache transpiled modules under dist URLs; a fresh process is the isolation boundary.
  const { error, stdout, stderr } = await new Promise((resolve) => {
    execFile(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap",
      `--test-name-pattern=^${pattern}$`, fileURLToPath(import.meta.url)], {
      cwd: process.cwd(), env,
      timeout: 580000, maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  assert.equal(error, null, `Fresh dist-native process failed:\n${stdout}\n${stderr}`);
  assert.ok(stdout.includes(`# Subtest: ${t.name}`), "fresh process must execute the selected native regression");
  assert.match(stdout, /^# pass [1-9]\d*\s*$/m, "an empty or recursively skipped test run is not verification");
  return true;
}

test("dist-native parser failures retain genuine child proof, exact identities, and durable accounting", { timeout: 600000 }, async (t) => {
  if (await runFreshDistNativeTest(t)) return;
  for (const [name, text, code] of [
    ["malformed JSON", malformedReviewText, "REVIEW_JSON_INVALID"],
    ["invalid business identity", invalidBusinessReviewText, "REVIEW_RECORD_INVALID"],
  ]) {
    await t.test(name, async (t) => {
      const source = privateReviewInput();
      const proofBytes = [];
      const fixture = await sourceNativeReviewFixture(t, {
        distOnly: true, text, input: source, reasoning: reviewCanaries.reasoning,
        context: { async recordReviewCompletion(value) {
          proofBytes.push(await assertDurableReviewProof(value.receipt, source, text, nativeReviewUsage));
        } },
      });
      const { error, result, recorded, reported, state, model } = fixture;
      assert.equal(result, undefined);
      assertParseFailure(error, text, code);
      assert.equal(model.requests.length, 1, "the real native child must make exactly one loopback request");
      assert.equal(state.nativeRuns, 1);
      assert.equal(state.nativeDisposals, 1);
      assert.equal(state.preparedContext.bindAuthOwner, true);
      assert.equal(state.sdkRunCalls, 0);
      assert.ok(model.requests[0].headers.authorization === "Bearer synthetic-fixture-key");
      assert.deepEqual(reported, [nativeReviewUsage]);
      assert.equal(recorded.length, 1);
      const receipt = recorded[0].receipt;
      const nativeReceipt = state.nativeResult.budgetReceipt;
      assert.equal(receipt.kind, "host-prepared-isolated-completion");
      assert.equal(receipt.runtimeBudgetDirectory, nativeReceipt.directory);
      for (const key of ["runId", "sessionKey", "agentId"]) assert.equal(receipt[key], nativeReceipt[key]);
      assertCompleteReviewAccounting(error, nativeReviewUsage, receipt);
      assert.equal(await assertDurableReviewProof(receipt, source, text, nativeReviewUsage), proofBytes[0]);
      const history = join(nativeReceipt.directory, "budgets", sha256(nativeReceipt.runId));
      for (const name of ["operational-budget-config.json", "operational-budget-ledger.json"]) {
        assert.equal(await readFile(join(nativeReceipt.directory, name), "utf8"), await readFile(join(history, name), "utf8"));
      }
      state.replayNativeResult = state.nativeResult;
      const duplicateReports = [];
      await assert.rejects(fixture.reviewer.reviewCase(source, reviewContext({
        reportUsage: (value) => duplicateReports.push(value),
      })), /reused a previous review run/);
      assert.deepEqual(duplicateReports, [], "replaying the genuine receipt must not report usage twice");
      assert.equal(model.requests.length, 1);
      assert.equal(state.nativeRuns, 1);
      assert.equal(await readFile(receipt.reviewerProofPath, "utf8"), proofBytes[0]);
    });
  }
});

test("dist-native generated proof mutations cannot release parser-failure accounting", { timeout: 600000 }, async (t) => {
  if (await runFreshDistNativeTest(t)) return;
  for (const mode of ["missing receipt", "missing ledger", "pending request", "foreign runId",
    "foreign sessionKey", "foreign agentId", "config fingerprint", "blocked binding"]) {
    await t.test(mode, async (t) => {
      let originalProof;
      const fixture = await sourceNativeReviewFixture(t, {
        distOnly: true, text: malformedReviewText, input: privateReviewInput(),
        async afterNativeRun(result) {
          const receipt = result.budgetReceipt;
          originalProof = await readRuntimeBudgetProof(receipt.directory, { ...receipt, settled: true });
          assert.deepEqual(originalProof.usage, nativeReviewUsage, "mutations must start from genuine settled child usage");
          if (mode === "missing receipt") { delete result.budgetReceipt; return; }
          if (mode.startsWith("foreign ")) { receipt[mode.slice("foreign ".length)] = "other-identity"; return; }
          if (mode === "blocked binding") {
            const path = join(receipt.directory, "binding.json");
            const binding = JSON.parse(await readFile(path, "utf8"));
            binding.status = "blocked";
            await writeFile(path, JSON.stringify(binding));
            return;
          }
          const path = join(receipt.directory, "operational-budget-ledger.json");
          if (mode === "missing ledger") return rm(path);
          const ledger = JSON.parse(await readFile(path, "utf8"));
          if (mode === "pending request") {
            const index = ledger.entries.findIndex((entry) => entry.type === "request_reserved");
            assert.ok(index >= 1);
            ledger.entries = ledger.entries.slice(0, index + 1);
          }
          if (mode === "config fingerprint") ledger.configSha256 = "0".repeat(64);
          await writeFile(path, JSON.stringify(ledger));
        },
      });
      assert.ok(originalProof, "run the child before mutating any proof");
      assert.equal(fixture.result, undefined);
      assertUnreleasedReviewAccounting(fixture.error);
      assert.equal(fixture.model.requests.length, 1);
      assert.equal(fixture.state.nativeRuns, 1);
      assert.equal(fixture.state.nativeDisposals, 1);
      assert.equal(fixture.state.sdkRunCalls, 0);
      assert.ok(fixture.reported.length <= 1);
      assert.equal(existsSync(join(fixture.state.nativeResult.budgetReceipt.directory, "reviewer-proof.json")), false);
    });
  }
});
