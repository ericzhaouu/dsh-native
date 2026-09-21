import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sourceModules = new Map([
  [new URL("../src/bridge/budget-ledger.js", import.meta.url).href, new URL("../src/bridge/budget-ledger.ts", import.meta.url)],
  [new URL("../src/durable-state.js", import.meta.url).href, new URL("../src/durable-state.ts", import.meta.url)],
]);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const url = context.parentURL && new URL(specifier, context.parentURL).href;
    return sourceModules.has(url) ? { url, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return sourceModules.has(url) ? {
      format: "module",
      shortCircuit: true,
      source: ts.transpileModule(readFileSync(sourceModules.get(url), "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      }).outputText,
    } : next(url, context);
  },
});
let BudgetLedger, budgetError;
try {
  ({ BudgetLedger, budgetError } = await import("../src/bridge/budget-ledger.js"));
} finally {
  hooks.deregister();
}

const CONFIG = "operational-budget-config.json";
const LEDGER = "operational-budget-ledger.json";
const EXCEEDED = "DSH_BUDGET_EXCEEDED";
const UNCERTAIN = "DSH_BUDGET_UNCERTAIN";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const code = (expected) => (error) => {
  assert.equal(error.code, expected);
  assert.ok(error.message.startsWith(`${expected}: `));
  assert.equal(error.message.includes("credential-secret"), false);
  return true;
};

function configuration(budget = {}, overrides = {}) {
  return {
    version: 1, runId: randomUUID(), sessionKey: "session", agentId: "agent",
    operationalBudget: {
      maxModelRequests: 10, maxInputTokens: 1000, maxOutputTokens: 500,
      maxToolCalls: 10, maxDurationMs: 60000, ...budget,
    },
    contextWindow: 100, maxTokens: 50, ...overrides,
  };
}

async function fixture(t, options = {}) {
  const directory = join(fileURLToPath(new URL(".", import.meta.url)), `.budget-ledger-${randomUUID()}`);
  await mkdir(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "owner.lock"), "parent-owned");
  const config = configuration(options.budget, options.config);
  const admittedAt = options.admittedAt ?? Date.now();
  const ledger = new BudgetLedger(directory, config, options.purpose ?? "main", admittedAt);
  const history = join(directory, "budgets", hash(config.runId));
  if (options.initialize !== false) await ledger.initialize();
  return {
    directory, history, config, admittedAt, ledger,
    latest: join(directory, LEDGER), historical: join(history, LEDGER),
  };
}

async function evidence(f) {
  const latest = await json(f.latest);
  assert.deepEqual(latest, await json(f.historical));
  const config = await json(join(f.directory, CONFIG));
  assert.deepEqual(config, await json(join(f.history, CONFIG)));
  assert.equal(latest.configSha256, hash(JSON.stringify(config)));
  assert.deepEqual([latest.version, latest.runId, latest.sessionKey, latest.agentId],
    [1, config.runId, config.sessionKey, config.agentId]);
  assert.equal(latest.entries[0].type, "admitted");
  assert.equal(latest.entries[0].at, f.admittedAt);
  let at = f.admittedAt;
  let terminal = false;
  for (const [seq, entry] of latest.entries.entries()) {
    assert.equal(entry.seq, seq);
    assert.ok(Number.isSafeInteger(entry.at) && entry.at >= 0 && entry.at >= at);
    assert.equal(terminal, false, "no entry follows a terminal event");
    at = entry.at;
    terminal = entry.type === "fenced" || entry.type === "settled";
  }
  assert.equal(await readFile(join(f.directory, "owner.lock"), "utf8"), "parent-owned");
  return latest;
}

async function settled(f) {
  await f.ledger.finish();
  await f.ledger.drain();
  assert.equal(f.ledger.retainOwnership, false);
  const proof = await evidence(f);
  assert.deepEqual(proof.entries.at(-1), {
    type: "settled", providerSettled: true, toolsSettled: true,
    seq: proof.entries.length - 1, at: proof.entries.at(-1).at,
  });
  return proof;
}

test("initialization snapshots the exact config, hashes run paths, and preserves immutable history", async (t) => {
  const f = await fixture(t, { initialize: false, config: { runId: "..\\credential-secret/unsafe-run" } });
  const original = structuredClone(f.config);
  f.config.maxTokens = 1;
  f.config.operationalBudget.maxModelRequests = 1;
  await f.ledger.initialize();
  await f.ledger.initialize();
  assert.deepEqual(await json(join(f.history, CONFIG)), original);
  assert.equal(f.ledger.failure, undefined);
  assert.equal(f.ledger.hasRequests, false);
  assert.equal(f.ledger.retainOwnership, false);
  const bytes = await readFile(join(f.history, CONFIG), "utf8");
  const grant = await f.ledger.reserve({ maxTokens: 100 });
  assert.equal(grant.maxTokens, 50);
  await f.ledger.settle({ requestId: grant.requestId, usage: zero });
  await settled(f);
  assert.equal(await readFile(join(f.history, CONFIG), "utf8"), bytes);
});

test("a compaction lifecycle persists grants and tool starts before acknowledgements", async (t) => {
  const f = await fixture(t, { purpose: "compaction" });
  const grant = await f.ledger.reserve({ maxTokens: 17 });
  assert.deepEqual(Object.keys(grant).sort(), ["maxTokens", "requestId"]);
  assert.equal(grant.maxTokens, 17);
  assert.equal(f.ledger.hasRequests, true);
  assert.equal(f.ledger.retainOwnership, true);
  assert.deepEqual((await evidence(f)).entries.at(-1), {
    type: "request_reserved", requestId: grant.requestId, purpose: "compaction",
    inputTokens: 100, outputTokens: 17, seq: 1, at: (await json(f.latest)).entries[1].at,
  });
  await f.ledger.startTool("tool-one");
  assert.equal((await evidence(f)).entries.at(-1).type, "tool_started");
  assert.deepEqual(await f.ledger.settle({
    requestId: grant.requestId, usage: { input: 10, output: 7, cacheRead: 20, cacheWrite: 5 },
  }), {});
  assert.equal(f.ledger.retainOwnership, true);
  await f.ledger.settleTool("tool-one");
  const proof = await settled(f);
  assert.deepEqual(proof.entries.map((entry) => entry.type),
    ["admitted", "request_reserved", "tool_started", "request_settled", "tool_settled", "settled"]);
  assert.equal(f.ledger.hasRequests, true);
});

test("concurrent provider admissions enforce the lifetime request limit and drain after exhaustion", async (t) => {
  const f = await fixture(t, { budget: { maxModelRequests: 3 } });
  const attempts = await Promise.allSettled(Array.from({ length: 20 }, () => f.ledger.reserve({ maxTokens: 5 })));
  const grants = attempts.filter((result) => result.status === "fulfilled").map((result) => result.value);
  assert.equal(grants.length, 3);
  assert.equal(new Set(grants.map((grant) => grant.requestId)).size, 3);
  for (const result of attempts.filter((result) => result.status === "rejected")) code(EXCEEDED)(result.reason);
  const failure = f.ledger.failure;
  assert.equal(failure.code, EXCEEDED);
  assert.equal((await evidence(f)).entries.some((entry) => entry.type === "fenced"), false);
  await Promise.all(grants.map(({ requestId }) => f.ledger.settle({ requestId, usage: zero })));
  assert.equal(f.ledger.retainOwnership, false);
  await assert.rejects(f.ledger.reserve({ maxTokens: 1 }), code(EXCEEDED));
  await assert.rejects(f.ledger.startTool("not-admitted"), code(EXCEEDED));
  await settled(f);
  assert.equal(f.ledger.failure, failure);
});

test("concurrent tool admissions count every start, including completed failed executions", async (t) => {
  const f = await fixture(t, { budget: { maxToolCalls: 3 } });
  const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => f.ledger.startTool(`tool-${i}`)));
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 3);
  for (const result of attempts.slice(3)) code(EXCEEDED)(result.reason);
  await Promise.all([0, 1, 2].map((i) => f.ledger.settleTool(`tool-${i}`)));
  await assert.rejects(f.ledger.startTool("retry-failed-tool"), code(EXCEEDED));
  const proof = await settled(f);
  assert.equal(proof.entries.filter((entry) => entry.type === "tool_started").length, 3);
  assert.equal(f.ledger.hasRequests, false);
});

test("input accounting includes cache usage and full outstanding context reservations", async (t) => {
  const f = await fixture(t, { budget: { maxInputTokens: 230 } });
  const first = await f.ledger.reserve({ maxTokens: 10 });
  const second = await f.ledger.reserve({ maxTokens: 10 });
  await f.ledger.settle({
    requestId: first.requestId, usage: { input: 10, output: 0, cacheRead: 10, cacheWrite: 10 },
  });
  const third = await f.ledger.reserve({ maxTokens: 10 });
  await f.ledger.settle({ requestId: second.requestId, usage: { ...zero, input: 1 } });
  await assert.rejects(f.ledger.reserve({ maxTokens: 10 }), code(EXCEEDED));
  await f.ledger.settle({ requestId: third.requestId, usage: zero });
  await settled(f);
});

test("output grants clip to requested, configured, used, and reserved output limits", async (t) => {
  const f = await fixture(t, { budget: { maxOutputTokens: 70 } });
  const first = await f.ledger.reserve({ maxTokens: 999 });
  const second = await f.ledger.reserve({ maxTokens: 999 });
  assert.equal(first.maxTokens, 50);
  assert.equal(second.maxTokens, 20);
  await f.ledger.settle({ requestId: first.requestId, usage: { ...zero, output: 40 } });
  const third = await f.ledger.reserve({ maxTokens: 999 });
  assert.equal(third.maxTokens, 10);
  await f.ledger.settle({ requestId: second.requestId, usage: { ...zero, output: 5 } });
  await f.ledger.settle({ requestId: third.requestId, usage: { ...zero, output: 10 } });
  const fourth = await f.ledger.reserve({ maxTokens: 7 });
  assert.equal(fourth.maxTokens, 7);
  await f.ledger.settle({ requestId: fourth.requestId, usage: { ...zero, output: 7 } });
  await settled(f);
});

for (const [label, budget] of [
  ["input", { maxInputTokens: 100 }],
  ["output", { maxOutputTokens: 50 }],
]) {
  test(`${label} exhaustion remains latched even after a valid zero-usage settlement`, async (t) => {
    const f = await fixture(t, { budget });
    const grant = await f.ledger.reserve({ maxTokens: 50 });
    await assert.rejects(f.ledger.reserve({ maxTokens: 1 }), code(EXCEEDED));
    await f.ledger.settle({ requestId: grant.requestId, usage: zero });
    await assert.rejects(f.ledger.reserve({ maxTokens: 1 }), code(EXCEEDED));
    assert.equal(f.ledger.retainOwnership, false);
    await settled(f);
  });
}

test("mixed queued mutations serialize through tool exhaustion and valid settlements", async (t) => {
  const f = await fixture(t, { budget: { maxToolCalls: 1 } });
  const grant = await f.ledger.reserve({ maxTokens: 10 });
  const results = await Promise.allSettled([
    f.ledger.startTool("first"), f.ledger.startTool("over-limit"),
    f.ledger.reserve({ maxTokens: 10 }),
    f.ledger.settle({ requestId: grant.requestId, usage: zero }),
    f.ledger.settleTool("first"), f.ledger.finish(),
  ]);
  assert.deepEqual(results.map((result) => result.status),
    ["fulfilled", "rejected", "rejected", "fulfilled", "fulfilled", "fulfilled"]);
  code(EXCEEDED)(results[1].reason);
  code(EXCEEDED)(results[2].reason);
  await f.ledger.drain();
  assert.equal(f.ledger.retainOwnership, false);
  assert.deepEqual((await evidence(f)).entries.map((entry) => entry.type),
    ["admitted", "request_reserved", "tool_started", "request_settled", "tool_settled", "settled"]);
});

const invalidUsage = [
  ["missing", undefined], ["null", null], ["array", []],
  ["missing cache field", { input: 0, output: 0, cacheRead: 0 }],
  ["extra field", { ...zero, credential: "credential-secret" }],
  ["negative", { ...zero, input: -1 }], ["fraction", { ...zero, output: 0.5 }],
  ["unsafe integer", { ...zero, cacheRead: Number.MAX_SAFE_INTEGER + 1 }],
  ["NaN", { ...zero, input: NaN }], ["infinity", { ...zero, cacheWrite: Infinity }],
  ["string", { ...zero, input: "0" }], ["output over grant", { ...zero, output: 11 }],
  ["input over context", { ...zero, input: 101 }],
  ["combined cache over context", { input: 50, output: 0, cacheRead: 30, cacheWrite: 21 }],
];
for (const [label, usage] of invalidUsage) {
  test(`invalid usage (${label}) fences without releasing the reservation`, async (t) => {
    const f = await fixture(t);
    const grant = await f.ledger.reserve({ maxTokens: 10 });
    await assert.rejects(f.ledger.settle({ requestId: grant.requestId, usage }), code(UNCERTAIN));
    const proof = await evidence(f);
    assert.deepEqual(proof.entries.map((entry) => entry.type), ["admitted", "request_reserved", "fenced"]);
    assert.equal(f.ledger.failure.code, UNCERTAIN);
    assert.equal(f.ledger.retainOwnership, true);
    await assert.rejects(f.ledger.settle({ requestId: grant.requestId, usage: zero }), code(UNCERTAIN));
    await assert.rejects(f.ledger.finish(), code(UNCERTAIN));
    assert.deepEqual(await evidence(f), proof);
    assert.equal(JSON.stringify(proof).includes("credential-secret"), false);
  });
}

test("safe-integer cache sums cannot overflow or lose a maximum-size input reservation", async (t) => {
  const f = await fixture(t, {
    budget: { maxInputTokens: Number.MAX_SAFE_INTEGER },
    config: { contextWindow: Number.MAX_SAFE_INTEGER },
  });
  const grant = await f.ledger.reserve({ maxTokens: 10 });
  await assert.rejects(f.ledger.settle({
    requestId: grant.requestId, usage: { ...zero, input: Number.MAX_SAFE_INTEGER, cacheRead: 1 },
  }), code(UNCERTAIN));
  assert.deepEqual((await evidence(f)).entries.map((entry) => entry.type),
    ["admitted", "request_reserved", "fenced"]);
  assert.equal(f.ledger.retainOwnership, true);
});

test("maximum safe accounting accepts exact capacity without arithmetic overflow", async (t) => {
  const f = await fixture(t, {
    budget: { maxInputTokens: Number.MAX_SAFE_INTEGER, maxOutputTokens: Number.MAX_SAFE_INTEGER },
    config: { contextWindow: Number.MAX_SAFE_INTEGER, maxTokens: Number.MAX_SAFE_INTEGER },
  });
  const grant = await f.ledger.reserve({ maxTokens: Number.MAX_SAFE_INTEGER });
  await f.ledger.settle({
    requestId: grant.requestId,
    usage: { input: Number.MAX_SAFE_INTEGER - 2, cacheRead: 1, cacheWrite: 1, output: Number.MAX_SAFE_INTEGER },
  });
  await assert.rejects(f.ledger.reserve({ maxTokens: 1 }), code(EXCEEDED));
  await settled(f);
});

for (const [label, params] of [
  ["missing", undefined], ["null", null], ["array", []], ["empty", {}],
  ["zero", { maxTokens: 0 }], ["negative", { maxTokens: -1 }],
  ["fraction", { maxTokens: 1.5 }], ["unsafe", { maxTokens: Number.MAX_SAFE_INTEGER + 1 }],
  ["string", { maxTokens: "5" }], ["extra", { maxTokens: 5, credential: "credential-secret" }],
  ["symbol field", { maxTokens: 5, [Symbol("extra")]: true }],
  ["accessor", { get maxTokens() { throw new Error("credential-secret"); } }],
]) {
  test(`malformed reserve RPC (${label}) permanently fences`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.ledger.reserve(params), code(UNCERTAIN));
    assert.deepEqual((await evidence(f)).entries.map((entry) => entry.type), ["admitted", "fenced"]);
    assert.equal(f.ledger.hasRequests, false);
    assert.equal(f.ledger.retainOwnership, true);
    await assert.rejects(f.ledger.reserve({ maxTokens: 1 }), code(UNCERTAIN));
  });
}

for (const [label, method, makeParams] of [
  ["settle missing id", "settle", () => ({ usage: zero })],
  ["settle unknown id", "settle", () => ({ requestId: "credential-secret", usage: zero })],
  ["settle extra field", "settle", (id) => ({ requestId: id, usage: zero, extra: "credential-secret" })],
  ["uncertain missing id", "uncertain", () => ({})],
  ["uncertain unknown id", "uncertain", () => ({ requestId: "credential-secret" })],
  ["uncertain extra field", "uncertain", (id) => ({ requestId: id, extra: "credential-secret" })],
]) {
  test(`malformed ${label} fences the outstanding request`, async (t) => {
    const f = await fixture(t);
    const grant = await f.ledger.reserve({ maxTokens: 10 });
    await assert.rejects(f.ledger[method](makeParams(grant.requestId)), code(UNCERTAIN));
    assert.deepEqual((await evidence(f)).entries.map((entry) => entry.type),
      ["admitted", "request_reserved", "fenced"]);
    assert.equal(f.ledger.retainOwnership, true);
  });
}

test("uncertainty is irreversible for late provider/tool settlement and all queued admissions", async (t) => {
  const f = await fixture(t);
  const grant = await f.ledger.reserve({ maxTokens: 10 });
  await f.ledger.startTool("tool");
  assert.deepEqual(await f.ledger.uncertain({ requestId: grant.requestId }), {});
  const before = await readFile(f.latest, "utf8");
  const failure = f.ledger.failure;
  const operations = [
    f.ledger.reserve({ maxTokens: 10 }), f.ledger.startTool("late"),
    f.ledger.settle({ requestId: grant.requestId, usage: zero }),
    f.ledger.settleTool("tool"), f.ledger.uncertain({ requestId: grant.requestId }), f.ledger.finish(),
  ];
  for (const result of await Promise.allSettled(operations)) {
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, failure);
  }
  await f.ledger.fence("credential-secret");
  await f.ledger.drain();
  assert.equal(await readFile(f.latest, "utf8"), before);
  assert.equal(await readFile(f.historical, "utf8"), before);
  assert.equal(f.ledger.retainOwnership, true);
});

for (const kind of ["request", "tool"]) {
  test(`finish fences and rejects an outstanding ${kind}`, async (t) => {
    const f = await fixture(t);
    if (kind === "request") await f.ledger.reserve({ maxTokens: 10 });
    else await f.ledger.startTool("tool");
    await assert.rejects(f.ledger.finish(), code(UNCERTAIN));
    assert.equal((await evidence(f)).entries.at(-1).type, "fenced");
    assert.equal(f.ledger.retainOwnership, true);
  });
}

test("a malformed RPC after known exhaustion escalates to permanent uncertainty", async (t) => {
  const f = await fixture(t, { budget: { maxModelRequests: 1 } });
  const grant = await f.ledger.reserve({ maxTokens: 10 });
  await assert.rejects(f.ledger.reserve({ maxTokens: 10 }), code(EXCEEDED));
  await assert.rejects(f.ledger.reserve({ maxTokens: 10, extra: true }), code(UNCERTAIN));
  await assert.rejects(f.ledger.settle({ requestId: grant.requestId, usage: zero }), code(UNCERTAIN));
  assert.equal((await evidence(f)).entries.at(-1).type, "fenced");
});

for (const operation of ["reserve", "startTool"]) {
  test(`${operation} checks the duration at dequeue time and permits drained known exhaustion`, async (t) => {
    const f = await fixture(t, { budget: { maxDurationMs: 10000 } });
    let now = f.admittedAt;
    t.mock.method(Date, "now", () => now);
    const pending = operation === "reserve" ? f.ledger.reserve({ maxTokens: 1 }) : f.ledger.startTool("late");
    now += 10000;
    await assert.rejects(pending, code(EXCEEDED));
    assert.equal(f.ledger.failure.code, EXCEEDED);
    assert.equal(f.ledger.retainOwnership, false);
    assert.equal((await evidence(f)).entries.length, 1);
    await settled(f);
  });
}

test("elapsed duration does not prevent valid pending settlements after known exhaustion", async (t) => {
  const f = await fixture(t, { budget: { maxDurationMs: 10000 } });
  const grant = await f.ledger.reserve({ maxTokens: 10 });
  await f.ledger.startTool("tool");
  t.mock.method(Date, "now", () => f.admittedAt + 10000);
  await assert.rejects(f.ledger.reserve({ maxTokens: 1 }), code(EXCEEDED));
  assert.equal(f.ledger.retainOwnership, true);
  await f.ledger.settle({ requestId: grant.requestId, usage: zero });
  await f.ledger.settleTool("tool");
  await settled(f);
  assert.equal(f.ledger.failure.code, EXCEEDED);
});

test("entry timestamps never decrease when the wall clock moves backwards", async (t) => {
  const f = await fixture(t);
  let now = f.admittedAt + 100;
  t.mock.method(Date, "now", () => now);
  const grant = await f.ledger.reserve({ maxTokens: 10 });
  now -= 1000;
  await f.ledger.settle({ requestId: grant.requestId, usage: zero });
  const proof = await settled(f);
  assert.deepEqual(proof.entries.map((entry) => entry.at),
    [f.admittedAt, f.admittedAt + 100, f.admittedAt + 100, f.admittedAt + 100]);
});

test("finish is idempotent, queued drain observes completion, and terminal evidence cannot reopen", async (t) => {
  const f = await fixture(t);
  const final = f.ledger.finish();
  assert.equal(f.ledger.retainOwnership, true);
  await f.ledger.drain();
  await final;
  const proof = await evidence(f);
  await f.ledger.finish();
  assert.equal(f.ledger.retainOwnership, false);
  await f.ledger.fence("credential-secret");
  await assert.rejects(f.ledger.finish(), code(UNCERTAIN));
  await assert.rejects(f.ledger.startTool("late"), code(UNCERTAIN));
  const fenced = await evidence(f);
  assert.equal(fenced.entries.length, proof.entries.length);
  assert.equal(fenced.entries.at(-1).type, "fenced");
  assert.deepEqual(fenced.entries.slice(0, -1), proof.entries.slice(0, -1));
  assert.equal(f.ledger.retainOwnership, true);
});

test("maximum safe duration remains valid without overflowing deadline arithmetic", async (t) => {
  const f = await fixture(t, { budget: { maxDurationMs: Number.MAX_SAFE_INTEGER } });
  const grant = await f.ledger.reserve({ maxTokens: 10 });
  await f.ledger.settle({ requestId: grant.requestId, usage: zero });
  await settled(f);
});

test("uncertain reports close queued admissions before their persistence can finish", async (t) => {
  const f = await fixture(t);
  const grant = await f.ledger.reserve({ maxTokens: 10 });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const write = f.ledger.writeLedger;
  t.mock.method(f.ledger, "writeLedger", async function () {
    if (this.entries.at(-1)?.type === "tool_started") {
      entered.resolve();
      await release.promise;
    }
    return write.call(this);
  });
  let effects = 0;
  const start = f.ledger.startTool("late").then(() => { effects++; });
  const rejected = assert.rejects(start, code(UNCERTAIN));
  await entered.promise;
  const reported = f.ledger.uncertain({ requestId: grant.requestId });
  assert.equal(f.ledger.failure.code, UNCERTAIN);
  release.resolve();
  await rejected;
  assert.deepEqual(await reported, {});
  assert.equal(effects, 0);
  assert.equal((await evidence(f)).entries.at(-1).type, "fenced");
  assert.equal(f.ledger.retainOwnership, true);
});

test("duplicate request settlement and reused tool ids are fail-closed", async (t) => {
  const f = await fixture(t);
  const grant = await f.ledger.reserve({ maxTokens: 10 });
  await f.ledger.settle({ requestId: grant.requestId, usage: zero });
  await assert.rejects(f.ledger.settle({ requestId: grant.requestId, usage: zero }), code(UNCERTAIN));
  assert.equal((await evidence(f)).entries.at(-1).type, "fenced");
  const tools = await fixture(t);
  await tools.ledger.startTool("once");
  await tools.ledger.settleTool("once");
  await assert.rejects(tools.ledger.startTool("once"), code(UNCERTAIN));
  assert.equal((await evidence(tools)).entries.at(-1).type, "fenced");
});

for (const [operation, id] of [["startTool", ""], ["startTool", "   "], ["startTool", 1], ["settleTool", "unknown"]]) {
  test(`${operation} rejects invalid or unknown tool id ${JSON.stringify(id)}`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.ledger[operation](id), code(UNCERTAIN));
    assert.deepEqual((await evidence(f)).entries.map((entry) => entry.type), ["admitted", "fenced"]);
  });
}

test("a new run preserves old history and replay cannot overwrite either run or the latest mirror", async (t) => {
  const f = await fixture(t);
  await settled(f);
  const historical = await readFile(f.historical, "utf8");
  const historicalConfig = await readFile(join(f.history, CONFIG), "utf8");
  const nextConfig = configuration();
  const next = new BudgetLedger(f.directory, nextConfig, "main", Date.now());
  await next.initialize();
  await next.finish();
  const latest = await readFile(f.latest, "utf8");
  const latestConfig = await readFile(join(f.directory, CONFIG), "utf8");
  const replay = new BudgetLedger(f.directory, { ...f.config, agentId: "different" }, "main", Date.now());
  await assert.rejects(replay.initialize(), code(UNCERTAIN));
  await assert.rejects(replay.fence(), code(UNCERTAIN));
  await assert.rejects(replay.reserve({ maxTokens: 1 }), code(UNCERTAIN));
  assert.equal(replay.retainOwnership, true);
  assert.equal(await readFile(f.latest, "utf8"), latest);
  assert.equal(await readFile(join(f.directory, CONFIG), "utf8"), latestConfig);
  assert.equal(await readFile(f.historical, "utf8"), historical);
  assert.equal(await readFile(join(f.history, CONFIG), "utf8"), historicalConfig);
});

test("exclusive historical mkdir admits only one of two concurrent initializers", async (t) => {
  const f = await fixture(t, { initialize: false });
  const other = new BudgetLedger(f.directory, f.config, "main", f.admittedAt);
  const results = await Promise.allSettled([f.ledger.initialize(), other.initialize()]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  code(UNCERTAIN)(results.find((result) => result.status === "rejected").reason);
  assert.equal((await evidence(f)).entries.length, 1);
});

for (const filename of [CONFIG, LEDGER]) {
  test(`initialization persistence failure at latest ${filename} fences surviving evidence`, async (t) => {
    const f = await fixture(t, { initialize: false });
    await mkdir(join(f.directory, filename));
    await assert.rejects(f.ledger.initialize(), code(UNCERTAIN));
    assert.equal(f.ledger.retainOwnership, true);
    assert.equal(f.ledger.failure.code, UNCERTAIN);
    assert.equal((await json(f.historical)).entries.at(-1).type, "fenced");
    if (filename === CONFIG) assert.deepEqual(await json(f.latest), await json(f.historical));
    await assert.rejects(f.ledger.reserve({ maxTokens: 1 }), code(UNCERTAIN));
    await assert.rejects(f.ledger.startTool("no-effect"), code(UNCERTAIN));
    await assert.rejects(f.ledger.finish(), code(UNCERTAIN));
    assert.equal(await readFile(join(f.directory, "owner.lock"), "utf8"), "parent-owned");
  });
}

for (const mirror of ["latest", "historical"]) {
  for (const operation of ["reserve", "startTool", "settle", "settleTool", "finish", "fence", "uncertain"]) {
    test(`${operation} persistence failure on ${mirror} denies acknowledgement and fences the other mirror`, async (t) => {
      const f = await fixture(t);
      let request;
      if (operation === "settle" || operation === "uncertain") request = await f.ledger.reserve({ maxTokens: 10 });
      if (operation === "settleTool") await f.ledger.startTool("tool");
      const broken = f[mirror];
      const healthy = f[mirror === "latest" ? "historical" : "latest"];
      const configBefore = await readFile(join(f.history, CONFIG), "utf8");
      await rm(broken);
      await mkdir(broken);
      const methods = {
        reserve: () => f.ledger.reserve({ maxTokens: 10 }),
        startTool: () => f.ledger.startTool("tool"),
        settle: () => f.ledger.settle({ requestId: request.requestId, usage: zero }),
        settleTool: () => f.ledger.settleTool("tool"),
        finish: () => f.ledger.finish(),
        fence: () => f.ledger.fence("credential-secret"),
        uncertain: () => f.ledger.uncertain({ requestId: request.requestId }),
      };
      let effects = 0;
      await assert.rejects(methods[operation]().then(() => { effects++; }), code(UNCERTAIN));
      assert.equal(effects, 0);
      await f.ledger.drain();
      assert.equal(f.ledger.retainOwnership, true);
      assert.equal(f.ledger.failure.code, UNCERTAIN);
      const proof = await json(healthy);
      assert.equal(proof.entries.at(-1).type, "fenced");
      assert.equal(proof.entries.filter((entry) => ["settled", "fenced"].includes(entry.type)).length, 1);
      assert.equal(JSON.stringify(proof).includes("credential-secret"), false);
      assert.equal(await readFile(join(f.history, CONFIG), "utf8"), configBefore);
      const before = await readFile(healthy, "utf8");
      await rm(broken, { recursive: true });
      await writeFile(broken, before);
      await assert.rejects(f.ledger.fence(), code(UNCERTAIN));
      await assert.rejects(f.ledger.finish(), code(UNCERTAIN));
      await assert.rejects(f.ledger.reserve({ maxTokens: 1 }), code(UNCERTAIN));
      if (request) await assert.rejects(f.ledger.settle({ requestId: request.requestId, usage: zero }), code(UNCERTAIN));
      assert.equal(await readFile(healthy, "utf8"), before);
      assert.equal(f.ledger.retainOwnership, true);
    });
  }
}

test("both failed mirrors retain permanent uncertainty without an admission acknowledgement", async (t) => {
  const f = await fixture(t);
  for (const path of [f.latest, f.historical]) {
    await rm(path);
    await mkdir(path);
  }
  await assert.rejects(f.ledger.reserve({ maxTokens: 1 }), code(UNCERTAIN));
  assert.equal(f.ledger.hasRequests, true);
  await f.ledger.drain();
  assert.equal(f.ledger.retainOwnership, true);
  await assert.rejects(f.ledger.finish(), code(UNCERTAIN));
});

test("all required budget caps and config bounds are defensively validated", () => {
  for (const key of Object.keys(configuration().operationalBudget)) {
    for (const value of [undefined, 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      assert.throws(() => new BudgetLedger(".", configuration({ [key]: value }), "main", 0), code(UNCERTAIN));
    }
    const config = configuration();
    delete config.operationalBudget[key];
    assert.throws(() => new BudgetLedger(".", config, "main", 0), code(UNCERTAIN));
  }
  for (const config of [
    configuration({ extra: true }), configuration({}, { contextWindow: 1001 }),
    configuration({}, { maxTokens: 101 }), configuration({ maxOutputTokens: 49 }),
    configuration({}, { version: 2 }), configuration({}, { runId: "" }),
    configuration({}, { sessionKey: " " }), configuration({}, { agentId: "" }),
  ]) {
    assert.throws(() => new BudgetLedger(".", config, "main", 0), code(UNCERTAIN));
  }
  assert.throws(() => new BudgetLedger(".", configuration(), "retry", 0), code(UNCERTAIN));
  assert.throws(() => new BudgetLedger(".", configuration(), "main", -1), code(UNCERTAIN));
  assert.throws(() => new BudgetLedger(".", configuration(), "main", Number.MAX_SAFE_INTEGER), code(UNCERTAIN));
  assert.throws(() => new BudgetLedger(".", configuration(), "main", 0.5), code(UNCERTAIN));
});

test("exported budget errors include stable codes in both Error.code and RPC messages", () => {
  for (const value of [EXCEEDED, UNCERTAIN]) {
    const error = budgetError(value, "Generic budget failure.");
    code(value)(error);
    assert.ok(error instanceof Error);
    assert.equal(error.message, `${value}: Generic budget failure.`);
  }
});
