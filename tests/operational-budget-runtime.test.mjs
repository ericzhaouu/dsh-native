import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// This file is also the real SDK child's --import preload. Keep node:test and
// runtime imports inside the parent branch, and never generate dist artifacts.
const distRoot = new URL("../dist/", import.meta.url);
const srcRoot = new URL("../src/", import.meta.url);
const loaded = new Set();
function sourceFor(url) {
  if (!url?.startsWith(distRoot.href) || !url.endsWith(".js")) return undefined;
  const source = new URL(`${url.slice(distRoot.href.length, -3)}.ts`, srcRoot);
  return existsSync(source) ? source : undefined;
}
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const url = context.parentURL && new URL(specifier, context.parentURL).href;
    return sourceFor(url) ? { url, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    const source = sourceFor(url);
    if (!source) return next(url, context);
    loaded.add(source.href);
    return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(source, "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
  },
});
const isDshChild = /[/\\]@deepseek-ai[/\\]dsh[/\\]lib[/\\]bin\.js$/u.test(process.argv[1] ?? "");
if (!isDshChild) await parentTests();

async function parentTests() {
  const { default: assert } = await import("node:assert/strict");
  const { default: childProcess } = await import("node:child_process");
  const { createHash, randomUUID } = await import("node:crypto");
  const { EventEmitter } = await import("node:events");
  const { mkdir, readFile, readdir, rm, writeFile } = await import("node:fs/promises");
  const { syncBuiltinESMExports } = await import("node:module");
  const { join } = await import("node:path");
  const { PassThrough } = await import("node:stream");
  const { default: test } = await import("node:test");
  const { setTimeout: delay } = await import("node:timers/promises");
  const { startModelServer } = await import("./fixtures/model-server.mjs");
  let parseDshConfig, parseOperationalBudget, resolveOperationalBudget, createDshRuntime;
  let JsonRpcPeer, BRIDGE_VERSION, DSH_VERSION, validateRuntimeBudgetProof, PREPARATION_TOOL_NAME, BudgetLedger;
  try {
    ({ parseDshConfig, parseOperationalBudget, resolveOperationalBudget } = await import("../dist/config.js"));
    ({ createDshRuntime } = await import("../dist/runtime.js"));
    ({ JsonRpcPeer } = await import("../dist/rpc.js"));
    ({ BudgetLedger } = await import("../dist/bridge/budget-ledger.js"));
    ({ BRIDGE_VERSION, DSH_VERSION } = await import("../dist/protocol.js"));
    ({ PREPARATION_TOOL_NAME } = await import("../dist/preparation.js"));
    ({ validateRuntimeBudgetProof } = await import("../scripts/lib/gateway-acceptance-adapter.mjs"));
  } finally {
    hooks.deregister();
  }

  const limits = { timeout: 90_000, concurrency: false };
  const EXCEEDED = "DSH_BUDGET_EXCEEDED";
  const UNCERTAIN = "DSH_BUDGET_UNCERTAIN";
  const CONFIG = "operational-budget-config.json";
  const LEDGER = "operational-budget-ledger.json";
  const measured = { input: 18, output: 5, cacheRead: 2, cacheWrite: 0 };
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  const json = async (path) => JSON.parse(await readFile(path, "utf8"));
  const caps = (extra = {}) => ({
    maxModelRequests: 8, maxInputTokens: 20_000, maxOutputTokens: 100,
    maxToolCalls: 4, maxDurationMs: 60_000, ...extra,
  });
  const tool = {
    name: "read_fixture", description: "Read an authorized fixture",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  };
  const expectCode = (code) => (error) => {
    assert.equal(error.code, code, error.stack);
    assert.equal(error.message.includes("memory-only-budget-key"), false);
    return true;
  };
  const entriesOf = (proof, type) => proof.ledger.entries.filter((entry) => entry.type === type);
  const directoryOf = (f, input = f.input) => join(f.root, hash(input.nativeStateId ?? input.sessionId));
  const historyOf = (f, input = f.input) => join(directoryOf(f, input), "budgets", hash(input.runId));
  const bindingOf = (f, input = f.input) => json(join(directoryOf(f, input), "binding.json"));
  const done = ({ send, finish }) => { send({ role: "assistant", content: "done" }); finish(); };
  function requestTools({ send, finish }, ids = ["read-one"], name = tool.name, args = {}) {
    send({ role: "assistant", tool_calls: ids.map((id, index) => ({
      index, id, type: "function", function: { name, arguments: JSON.stringify(args) },
    })) });
    finish("tool_calls");
  }

  async function proofOf(f, input = f.input, { terminal = "settled", latest = true } = {}) {
    const historical = historyOf(f, input);
    const configBytes = await readFile(join(historical, CONFIG), "utf8");
    const ledgerBytes = await readFile(join(historical, LEDGER), "utf8");
    if (latest) {
      assert.equal(await readFile(join(directoryOf(f, input), CONFIG), "utf8"), configBytes);
      assert.equal(await readFile(join(directoryOf(f, input), LEDGER), "utf8"), ledgerBytes);
    }
    const runtimeConfig = JSON.parse(configBytes);
    const ledger = JSON.parse(ledgerBytes);
    assert.equal(ledger.configSha256, hash(JSON.stringify(runtimeConfig)));
    const accounting = validateRuntimeBudgetProof({ runtimeConfig, ledger }, {
      runId: input.runId, sessionKey: input.sessionId, agentId: input.agentId ?? "host",
      ...(terminal === "settled" ? { settled: true } : {}),
    });
    if (terminal) assert.equal(accounting.status, terminal);
    if (terminal === "settled") {
      assert.equal(accounting.quiescent, true);
      assert.deepEqual(accounting.reserved, { inputTokens: 0, outputTokens: 0, modelRequests: 0, toolCalls: 0 });
      if (latest) assert.equal(existsSync(join(directoryOf(f, input), "owner.lock")), false);
    }
    return { runtimeConfig, ledger, accounting, configBytes, ledgerBytes };
  }

  function mockChild(handler) {
    const child = new EventEmitter();
    Object.assign(child, {
      exitCode: null, signalCode: null,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    });
    // No fake PID: never signal an unrelated process or Linux process group.
    const exit = () => {
      if (child.exitCode !== null) return;
      child.exitCode = 0;
      child.stdout.end();
      child.emit("close", 0);
    };
    child.kill = () => { exit(); return true; };
    const peer = new JsonRpcPeer(child.stdin, child.stdout, {
      async onRequest(method, params) {
        if (method === "shutdown") { setImmediate(exit); return {}; }
        assert.ok(["run", "compact", "inspectCompact"].includes(method), method);
        const value = await handler({ method, params, peer });
        return method === "run"
          ? { text: "done", sessionId: params.sessionId, usage: measured, stopReason: "stop", toolCalls: 0, ...value }
          : { compacted: false, sessionId: params.sessionId, ...value };
      },
      onNotification(method) {
        assert.equal(method, "cancel");
        exit();
      },
    });
    setImmediate(() => { void peer.notify("event", {
      type: "ready", version: BRIDGE_VERSION, dshVersion: DSH_VERSION,
    }).catch(() => {}); });
    return {
      child,
      close() {
        peer.close(); exit();
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      },
    };
  }

  async function fixture(t, { budget, config: extraConfig = {}, responder = done, mock } = {}) {
    // Keep the SDK cwd (root + hashed session) below Windows' 258-character limit.
    const root = join(fileURLToPath(new URL(".", import.meta.url)), `.ob-runtime-${randomUUID()}`);
    await mkdir(root);
    const children = [], runtimes = [], serverErrors = [], controllers = [];
    let model, spawnMock;
    t.after(async () => {
      try {
        for (const controller of controllers) controller.abort();
        for (const runtime of runtimes) {
          try { await runtime.dispose(); }
          catch (error) { assert.ok([UNCERTAIN, "DSH_TERMINATION_UNCONFIRMED"].includes(error.code), error.stack); }
        }
      } finally {
        for (const entry of children) {
          if (entry.close) entry.close();
          else if (entry.child.exitCode === null && entry.child.signalCode === null) {
            const closed = new Promise((resolve) => entry.child.once("close", resolve));
            entry.child.kill("SIGKILL");
            await closed;
          }
          if (entry.stderr && entry.child.exitCode !== 0) t.diagnostic(entry.stderr.slice(-3000));
        }
        spawnMock?.mock.restore();
        syncBuiltinESMExports();
        try { await model?.close(); }
        finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      }
      assert.deepEqual(serverErrors, [], "HTTP fixture assertions must not be swallowed by the server");
    });
    model = await startModelServer(async (request) => {
      try { await responder(request); }
      catch (error) { serverErrors.push(error); throw error; }
    });
    const config = parseDshConfig({
      stateDir: root, allowedBaseUrls: [model.baseUrl], startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 3_000, streamIdleTimeoutMs: 10_000,
      maxConcurrentRuns: 1,
      ...extraConfig, ...(budget === undefined ? {} : { operationalBudget: budget }),
    });
    const create = (configuration = config) => {
      const runtime = createDshRuntime(configuration);
      runtimes.push(runtime);
      return runtime;
    };
    const controller = new AbortController();
    controllers.push(controller);
    const events = [];
    const input = {
      sessionId: "budget-session", runId: "run-one", agentId: "research",
      workspaceDir: root, systemPrompt: "Use only the supplied tools.", prompt: "Read the fixture.",
      modelId: "deepseek-v4-pro", apiKey: "memory-only-budget-key", baseUrl: model.baseUrl,
      contextWindow: 4096, maxTokens: 10, thinking: "disabled", tools: [],
      signal: controller.signal, assertActive() {}, onEvent(event) { events.push(event); },
      async executeTool() { assert.fail("Unexpected host side effect"); },
    };
    const actualSpawn = childProcess.spawn;
    spawnMock = t.mock.method(childProcess, "spawn", (command, args, options) => {
      assert.equal(command, process.execPath);
      assert.match(args[0], /[/\\]@deepseek-ai[/\\]dsh[/\\]lib[/\\]bin\.js$/u);
      assert.equal(options.shell, false);
      if (mock) {
        const entry = mockChild(mock);
        children.push(entry);
        return entry.child;
      }
      // Node's --import treats C:\... as an unsupported URL scheme on Windows.
      const preload = process.platform === "win32" ? import.meta.url : fileURLToPath(import.meta.url);
      const child = actualSpawn(command, ["--import", preload, ...args], options);
      const entry = { child, stderr: "" };
      child.stderr.on("data", (chunk) => {
        entry.stderr = (entry.stderr + chunk.toString("utf8")).slice(-16_384);
      });
      children.push(entry);
      return child;
    });
    syncBuiltinESMExports();
    return { root, model, config, input, events, controller, children, create, runtime: create() };
  }

  async function reserveAndSettle({ params, peer }) {
    const grant = await peer.request("budget.reserve", { maxTokens: params.maxTokens });
    await peer.request("budget.settle", { requestId: grant.requestId, usage: measured });
    return grant;
  }

  async function assertFenced(f, input = f.input) {
    const proof = await proofOf(f, input, { terminal: "fenced" });
    assert.equal(proof.accounting.usageStatus, "unknown");
    assert.equal(proof.accounting.quiescent, false);
    assert.equal(proof.accounting.hardLimitsVerified, false);
    assert.equal(entriesOf(proof, "settled").length, 0);
    assert.ok(existsSync(join(directoryOf(f, input), "owner.lock")));
    const state = await bindingOf(f, input);
    assert.equal(state.status, "blocked");
    assert.equal(state.budgetFailure, UNCERTAIN);
    return proof;
  }

  async function assertNoReplay(f, input = f.input) {
    const children = f.children.length, requests = f.model.requests.length;
    const before = await proofOf(f, input, { terminal: "fenced" });
    const lock = await readFile(join(directoryOf(f, input), "owner.lock"), "utf8");
    await assert.rejects(f.runtime.run({ ...f.input, sessionId: "other-session", runId: "other-run" }), expectCode(UNCERTAIN));
    assert.equal(existsSync(directoryOf(f, { ...f.input, sessionId: "other-session" })), false);
    await assert.rejects(f.runtime.dispose(), expectCode(UNCERTAIN));
    const { operationalBudget, operationalBudgetByAgent, ...legacyConfig } = f.config;
    const legacyInput = { ...input, runId: "retry-without-budget", signal: new AbortController().signal };
    delete legacyInput.operationalBudget;
    const restarted = f.create(legacyConfig);
    for (const method of ["run", "compact", "recoverCompaction"]) {
      await assert.rejects(restarted[method](legacyInput), expectCode(UNCERTAIN));
    }
    assert.equal(f.children.length, children);
    assert.equal(f.model.requests.length, requests);
    assert.equal(await readFile(join(directoryOf(f, input), "owner.lock"), "utf8"), lock);
    const after = await proofOf(f, input, { terminal: "fenced" });
    assert.equal(after.ledgerBytes, before.ledgerBytes);
    assert.equal(after.configBytes, before.configBytes);
  }

  test("runtime graph loads current source, including ledger, profile and config", limits, () => {
    for (const name of ["runtime", "config", "protocol", "rpc", "bridge/profile", "bridge/budget-ledger"]) {
      assert.ok(loaded.has(new URL(`${name}.ts`, srcRoot).href), name);
    }
    assert.equal(typeof parseOperationalBudget, "function");
    assert.equal(typeof resolveOperationalBudget, "function");
  });

  test("budget contract requires every cap and narrows trusted global, agent and attempt limits", limits, () => {
    const global = caps(), agent = caps({ maxModelRequests: 3, maxToolCalls: 2 });
    const attempt = caps({ maxInputTokens: 9000, maxOutputTokens: 7, maxDurationMs: 40_000 });
    const expected = { ...attempt, maxModelRequests: 3, maxToolCalls: 2 };
    assert.deepEqual(parseOperationalBudget(global), global);
    for (const field of Object.keys(global)) {
      const missing = { ...global }; delete missing[field];
      assert.throws(() => parseOperationalBudget(missing), undefined, field);
      for (const value of [0, -1, 1.1, "1", null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => parseOperationalBudget({ ...global, [field]: value }), undefined, `${field}: ${value}`);
      }
    }
    const config = { operationalBudget: global, operationalBudgetByAgent: { research: agent } };
    assert.deepEqual(resolveOperationalBudget(config, "research", attempt), expected);
    assert.deepEqual(resolveOperationalBudget(config, "other"), global);
    assert.equal(resolveOperationalBudget({}, "research"), undefined);
    assert.equal(resolveOperationalBudget({ operationalBudgetByAgent: { research: agent } }, "other"), undefined);
  });

  test("real legacy run is fully opt-in: unchanged max_tokens and no budget evidence", limits, async (t) => {
    const f = await fixture(t);
    f.input.maxTokens = 123;
    const result = await f.runtime.run(f.input);
    assert.equal(result.text, "done");
    assert.equal(f.model.requests.length, 1);
    assert.equal(f.model.requests[0].body.max_tokens, 123);
    const names = await readdir(directoryOf(f));
    for (const name of [CONFIG, LEDGER, "budgets", "owner.lock"]) assert.equal(names.includes(name), false, name);
    assert.equal((await bindingOf(f)).status, "ready");
  });

  test("omitted agentId resolves the trusted host agent cap and records host identity", limits, async (t) => {
    const f = await fixture(t, {
      config: { operationalBudgetByAgent: { host: caps({ maxOutputTokens: 7 }) } },
      mock: reserveAndSettle,
    });
    delete f.input.agentId;
    await f.runtime.run(f.input);
    const proof = await proofOf(f);
    assert.equal(proof.runtimeConfig.agentId, "host");
    assert.equal(proof.runtimeConfig.maxTokens, 7);
    assert.equal(proof.runtimeConfig.operationalBudget.maxOutputTokens, 7);
  });

  for (const method of ["run", "compact"]) {
    test(`${method} snapshots all five minima synchronously before caller mutation`, limits, async (t) => {
      const global = caps({ maxModelRequests: 5, maxOutputTokens: 9 });
      const agent = caps({ maxInputTokens: 8000, maxToolCalls: 2 });
      const attempt = caps({ maxModelRequests: 4, maxDurationMs: 50_000 });
      const expected = { maxModelRequests: 4, maxInputTokens: 8000, maxOutputTokens: 9, maxToolCalls: 2, maxDurationMs: 50_000 };
      const f = await fixture(t, { mock: async (request) => {
        if (request.params.maxTokens !== undefined) await reserveAndSettle(request);
        return request.method === "compact" ? { compacted: true } : {};
      } });
      if (method === "compact") await f.runtime.run({ ...f.input, maxTokens: undefined });
      f.config.operationalBudget = global;
      f.config.operationalBudgetByAgent = { research: agent, unrelated: caps({ maxOutputTokens: 1 }) };
      const input = { ...f.input, runId: `snapshot-${method}`, operationalBudget: attempt };
      const original = { ...input };
      const work = f.runtime[method](input);
      for (const cap of [global, agent, attempt]) {
        for (const key of Object.keys(cap)) cap[key] = 1_000_000;
      }
      input.contextWindow = 999_999;
      input.maxTokens = 999_999;
      input.agentId = "unrelated";
      input.operationalBudget = caps();
      f.config.operationalBudgetByAgent.research = caps();
      await work;
      const proof = await proofOf(f, original);
      assert.deepEqual(proof.runtimeConfig.operationalBudget, expected);
      assert.equal(proof.runtimeConfig.contextWindow, 4096);
      assert.equal(proof.runtimeConfig.maxTokens, 9);
      assert.equal(entriesOf(proof, "request_reserved")[0].outputTokens, 9);
      assert.equal(entriesOf(proof, "request_reserved")[0].purpose, method === "compact" ? "compaction" : "main");
    });

    test(`${method} rejects invalid contextWindow/maxTokens before spawning or writing state`, limits, async (t) => {
      const f = await fixture(t, { budget: caps(), mock: () => assert.fail("Must not spawn") });
      for (const field of ["contextWindow", "maxTokens"]) {
        const invalid = [0, -1, 0.5, "8", null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
        if (field === "contextWindow") invalid.push(undefined);
        for (const value of invalid) {
          await assert.rejects(f.runtime[method]({ ...f.input, [field]: value }), /positive safe integers/);
        }
      }
      assert.equal(f.children.length, 0);
      assert.deepEqual(await readdir(f.root), []);
    });
  }

  for (const [contextWindow, maxOutputTokens, expected] of [[64, 100, 64], [100, 64, 64]]) {
    test(`absent maxTokens defaults to min(context=${contextWindow}, output=${maxOutputTokens})`, limits, async (t) => {
      let sent;
      const f = await fixture(t, { budget: caps({ maxOutputTokens }), mock: async (request) => {
        sent = request.params.maxTokens;
        await reserveAndSettle(request);
      } });
      const input = { ...f.input, contextWindow };
      delete input.maxTokens;
      await f.runtime.run(input);
      const proof = await proofOf(f, input);
      assert.equal(sent, expected);
      assert.equal(proof.runtimeConfig.maxTokens, expected);
      assert.equal(entriesOf(proof, "request_reserved")[0].outputTokens, expected);
    });
  }

  test("input budget smaller than contextWindow fails admission without evidence or child", limits, async (t) => {
    const f = await fixture(t, { budget: caps({ maxInputTokens: 4095 }) });
    for (const method of ["run", "compact"]) await assert.rejects(f.runtime[method](f.input), expectCode(EXCEEDED));
    assert.equal(f.children.length, 0);
    assert.deepEqual(await readdir(f.root), []);
  });

  test("real attempt-only opt-in supplies absent maxTokens without enabling unrelated agents", limits, async (t) => {
    const f = await fixture(t, { config: {
      operationalBudgetByAgent: { unrelated: caps({ maxModelRequests: 1, maxOutputTokens: 1 }) },
    } });
    const input = { ...f.input, operationalBudget: caps({ maxOutputTokens: 7 }) };
    delete input.maxTokens;
    await f.runtime.run(input);
    assert.equal(f.model.requests.length, 1);
    assert.equal(f.model.requests[0].body.max_tokens, 7);
    const proof = await proofOf(f, input);
    assert.equal(proof.runtimeConfig.maxTokens, 7);
    assert.deepEqual(proof.runtimeConfig.operationalBudget, input.operationalBudget);
  });

  test("real multi-step flow measures usage and clips HTTP/ledger grants 10 -> 5 across a drained tool", limits, async (t) => {
    let f, calls = 0, toolDrained = false;
    f = await fixture(t, { budget: caps({ maxOutputTokens: 10 }), responder: async (request) => {
      const proof = await proofOf(f, f.input, { terminal: null });
      const reservations = entriesOf(proof, "request_reserved");
      assert.equal(reservations.length, request.index + 1, "durable reservation must precede HTTP");
      assert.equal(reservations.at(-1).outputTokens, request.body.max_tokens);
      if (request.index === 0) requestTools(request);
      else { assert.equal(toolDrained, true); done(request); }
    } });
    f.input.tools = [tool];
    f.input.executeTool = async (call) => {
      calls++;
      assert.equal(call.name, tool.name);
      const proof = await proofOf(f, f.input, { terminal: null });
      assert.equal(entriesOf(proof, "tool_started").length, 1, "tool admission precedes host effects");
      assert.equal(entriesOf(proof, "tool_settled").length, 0);
      await delay(20);
      toolDrained = true;
      return { text: "fixture-content", isError: false };
    };
    const result = await f.runtime.run(f.input);
    assert.equal(calls, 1);
    assert.equal(result.toolCalls, 1);
    assert.deepEqual(result.usage, { input: 36, output: 10, cacheRead: 4, cacheWrite: 0 });
    assert.deepEqual(f.model.requests.map(({ body }) => body.max_tokens), [10, 5]);
    assert.ok(f.model.requests[1].body.messages.some((message) => message.role === "tool" && message.content.includes("fixture-content")));
    const proof = await proofOf(f);
    assert.deepEqual(entriesOf(proof, "request_reserved").map((entry) => entry.outputTokens), [10, 5]);
    assert.deepEqual(entriesOf(proof, "request_settled").map((entry) => entry.usage), [measured, measured]);
    assert.equal(proof.accounting.usage.modelRequests, 2);
    assert.equal(proof.accounting.usage.toolCalls, 1);
    assert.equal(proof.accounting.usage.cacheReadTokens, 4);
    assert.equal(proof.accounting.hardLimitsVerified, true);
    const tampered = structuredClone(proof.runtimeConfig);
    tampered.maxTokens++;
    assert.throws(() => validateRuntimeBudgetProof({ runtimeConfig: tampered, ledger: proof.ledger }), /fingerprint/);
  });

  test("real request cap permits only one request, settles tools, and blocks budget-free session retry", limits, async (t) => {
    let calls = 0, drained = false;
    const f = await fixture(t, { budget: caps({ maxModelRequests: 1 }), responder: requestTools });
    f.input.tools = [tool];
    f.input.executeTool = async () => {
      calls++; await delay(20); drained = true;
      return { text: "read", isError: false };
    };
    await assert.rejects(f.runtime.run(f.input), expectCode(EXCEEDED));
    assert.equal(calls, 1);
    assert.equal(drained, true);
    assert.equal(f.model.requests.length, 1);
    const proof = await proofOf(f);
    assert.equal(proof.accounting.usage.modelRequests, 1);
    assert.equal(proof.accounting.usage.toolCalls, 1);
    assert.equal((await bindingOf(f)).status, "blocked");
    assert.equal((await bindingOf(f)).budgetFailure, EXCEEDED);
    const { operationalBudget, ...legacy } = f.config;
    const restarted = f.create(legacy);
    for (const method of ["run", "compact", "recoverCompaction"]) {
      await assert.rejects(restarted[method]({ ...f.input, runId: "retry" }), expectCode(EXCEEDED));
    }
    assert.equal(f.children.length, 1);
    assert.equal((await proofOf(f)).ledgerBytes, proof.ledgerBytes);
    await f.runtime.dispose();
  });

  for (const [inputCap, permitted] of [[4115, false], [4116, true]]) {
    test(`real input reserves used20 + context4096, not tiny prompt size (cap ${inputCap})`, limits, async (t) => {
      const f = await fixture(t, { budget: caps({ maxInputTokens: inputCap }), responder: (request) => {
        if (request.index === 0) requestTools(request); else done(request);
      } });
      f.input.prompt = "x";
      f.input.tools = [tool];
      f.input.executeTool = async () => ({ text: "x", isError: false });
      if (permitted) await f.runtime.run(f.input);
      else await assert.rejects(f.runtime.run(f.input), expectCode(EXCEEDED));
      assert.equal(f.model.requests.length, permitted ? 2 : 1);
      const proof = await proofOf(f);
      assert.ok(entriesOf(proof, "request_reserved").every((entry) => entry.inputTokens === 4096));
      assert.deepEqual(entriesOf(proof, "request_settled")[0].usage, measured);
    });
  }

  test("real two-tool response never performs more side effects than maxToolCalls", limits, async (t) => {
    let calls = 0;
    const f = await fixture(t, { budget: caps({ maxToolCalls: 1 }), responder: (request) => requestTools(request, ["one", "two"]) });
    f.input.tools = [tool];
    f.input.executeTool = async () => { calls++; return { text: "read", isError: false }; };
    await assert.rejects(f.runtime.run(f.input), expectCode(EXCEEDED));
    assert.equal(calls, 1);
    assert.equal(f.model.requests.length, 1);
    const proof = await proofOf(f);
    assert.equal(entriesOf(proof, "tool_started").length, 1);
    assert.equal(entriesOf(proof, "tool_settled").length, 1);
  });

  test("concurrent mock tool RPCs enforce the cap and cannot settle before callbacks drain", limits, async (t) => {
    const entered = Promise.withResolvers(), aborted = Promise.withResolvers(), release = Promise.withResolvers();
    let calls = 0, drained = false, completed = false;
    const f = await fixture(t, { budget: caps({ maxToolCalls: 1 }), mock: async (request) => {
      await reserveAndSettle(request);
      const first = request.peer.request("tool", { callId: "one", name: tool.name, arguments: {} });
      const all = [first];
      void first.catch(() => {});
      await entered.promise;
      all.push(request.peer.request("tool", { callId: "two", name: tool.name, arguments: {} }));
      await Promise.allSettled(all);
    } });
    f.input.tools = [tool];
    f.input.executeTool = async (_call, signal) => {
      calls++; entered.resolve();
      if (signal.aborted) aborted.resolve();
      else signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      await release.promise;
      drained = true;
      return { text: "drained", isError: false };
    };
    const work = f.runtime.run(f.input);
    void work.then(() => { completed = true; }, () => { completed = true; });
    const failure = assert.rejects(work, expectCode(EXCEEDED));
    try {
      await aborted.promise;
      assert.equal(calls, 1);
      assert.equal(completed, false);
      assert.equal(drained, false);
      const active = await proofOf(f, f.input, { terminal: null });
      assert.equal(entriesOf(active, "settled").length, 0);
      assert.ok(existsSync(join(directoryOf(f), "owner.lock")));
    } finally { release.resolve(); }
    await failure;
    assert.equal(drained, true);
    const proof = await proofOf(f);
    assert.equal(entriesOf(proof, "tool_started").length, 1);
    assert.equal(entriesOf(proof, "tool_settled").length, 1);
  });

  for (const mode of ["missing raw usage", "HTTP 503 retry", "external abort", "output exceeds grant"]) {
    test(`real ${mode} retains reservation, fences ownership/capacity and cannot replay after restart`, limits, async (t) => {
      if (mode === "HTTP 503 retry") {
        const { ServerResponse } = await import("node:http");
        const writeHead = ServerResponse.prototype.writeHead;
        // model-server commits SSE headers before invoking its responder.
        // Change only this authenticated loopback fixture's actual HTTP status.
        t.mock.method(ServerResponse.prototype, "writeHead", function (status, ...args) {
          if (status === 200 && this.req.url.endsWith("/chat/completions") &&
              this.req.headers.authorization === "Bearer memory-only-budget-key") {
            return writeHead.call(this, 503, { "content-type": "application/json", "retry-after": "0" });
          }
          return writeHead.call(this, status, ...args);
        });
      }
      let f;
      f = await fixture(t, { budget: caps(), responder: ({ send, response }) => {
        if (mode === "HTTP 503 retry") {
          assert.equal(response.statusCode, 503);
          response.end(JSON.stringify({ error: { message: "local retryable fixture error" } }));
        } else if (mode === "external abort") {
          response.flushHeaders();
          f.controller.abort(new Error("fixture abort after HTTP admission"));
        } else {
          send({ role: "assistant", content: "not proof" });
          send({}, "stop", mode === "missing raw usage" ? undefined : {
            prompt_tokens: 20, prompt_cache_hit_tokens: 2, prompt_cache_miss_tokens: 18,
            completion_tokens: 11, total_tokens: 31,
          });
          response.end("data: [DONE]\n\n");
        }
      } });
      await assert.rejects(f.runtime.run(f.input), expectCode(UNCERTAIN));
      assert.equal(f.model.requests.length, 1, "retryable errors cannot create unreserved second network attempts");
      const proof = await assertFenced(f);
      assert.equal(entriesOf(proof, "request_reserved").length, 1);
      assert.equal(entriesOf(proof, "request_settled").length, 0);
      assert.deepEqual(proof.accounting.reserved, { inputTokens: 4096, outputTokens: 10, modelRequests: 1, toolCalls: 0 });
      await assertNoReplay(f);
    });
  }

  for (const mode of ["duration timer", "unsettled successful result"]) {
    test(`${mode} never proves settlement while a provider reservation is pending`, limits, async (t) => {
      let granted = false;
      const f = await fixture(t, {
        budget: caps({ maxDurationMs: mode === "duration timer" ? 1500 : 60_000 }),
        mock: async ({ params, peer }) => {
          await peer.request("budget.reserve", { maxTokens: params.maxTokens });
          granted = true;
          if (mode === "duration timer") await peer.closed;
        },
      });
      const start = Date.now();
      await assert.rejects(f.runtime.run(f.input), expectCode(UNCERTAIN));
      assert.equal(granted, true, "timer must interrupt an admitted provider request, not merely SDK startup");
      assert.ok(Date.now() - start < 12_000, "budget timer bounds waiting independently of stream idle timeout");
      await assertFenced(f);
      await assertNoReplay(f);
    });
  }

  test("failed durable reservation never reaches a mock provider and retains ownership", limits, async (t) => {
    let f, acknowledged = false;
    f = await fixture(t, { budget: caps(), mock: async ({ params, peer }) => {
      const path = join(directoryOf(f), LEDGER);
      await rm(path);
      await mkdir(path);
      await peer.request("budget.reserve", { maxTokens: params.maxTokens });
      acknowledged = true;
    } });
    await assert.rejects(f.runtime.run(f.input), expectCode(UNCERTAIN));
    assert.equal(acknowledged, false);
    assert.equal(f.model.requests.length, 0);
    const proof = await proofOf(f, f.input, { terminal: "fenced", latest: false });
    assert.equal(proof.accounting.reserved.modelRequests, 1);
    assert.equal(existsSync(join(directoryOf(f), "owner.lock")), true);
    assert.equal((await bindingOf(f)).budgetFailure, UNCERTAIN);
    await assert.rejects(f.runtime.dispose(), expectCode(UNCERTAIN));
  });

  for (const event of ["admitted", "request_reserved", "tool_started"]) {
    test(`stalled ${event} persistence bounds waiting and cannot acknowledge or dispatch after fencing`, limits, async (t) => {
      const release = Promise.withResolvers();
      let f, captured, acknowledged = false, effects = 0;
      const write = BudgetLedger.prototype.writeLedger;
      const mockWrite = t.mock.method(BudgetLedger.prototype, "writeLedger", async function () {
        if (this.entries.at(-1)?.type === event && !captured) {
          captured = this;
          f.controller.abort(new Error("abort while durable admission is pending"));
          await release.promise;
        }
        return write.call(this);
      });
      f = await fixture(t, {
        budget: caps(), config: { shutdownTimeoutMs: 100 },
        mock: async (request) => {
          if (event === "tool_started") {
            await reserveAndSettle(request);
            await request.peer.request("tool", { callId: "stalled", name: tool.name, arguments: {} });
          } else await request.peer.request("budget.reserve", { maxTokens: request.params.maxTokens });
          acknowledged = true;
        },
      });
      f.input.tools = [tool];
      f.input.executeTool = async () => { effects++; return { text: "unexpected", isError: false }; };
      const start = Date.now();
      try {
        await assert.rejects(f.runtime.run(f.input), expectCode(UNCERTAIN));
        assert.ok(Date.now() - start < 5000, "cleanup must not await the stalled queue without a bound");
        assert.ok(captured);
        assert.equal(captured.failure.code, UNCERTAIN, "uncertainty is latched before persistence resumes");
        assert.equal(effects, 0);
        assert.equal(acknowledged, false);
        assert.ok(existsSync(join(directoryOf(f), "owner.lock")));
        await assert.rejects(f.runtime.dispose(), expectCode(UNCERTAIN));
      } finally {
        release.resolve();
        await captured?.drain();
        mockWrite.mock.restore();
      }
      await assertFenced(f);
      assert.equal(effects, 0);
      assert.equal(acknowledged, false);
      if (event === "admitted") assert.equal(f.children.length, 0, "late initialization must never spawn a child");
    });
  }

  test("ownership cleanup uncertainty replaces settled proof, restores a lock, and blocks stale ready bindings", limits, async (t) => {
    const f = await fixture(t, { budget: caps(), mock: reserveAndSettle });
    const finish = BudgetLedger.prototype.finish;
    let removed = false;
    t.mock.method(BudgetLedger.prototype, "finish", async function () {
      await finish.call(this);
      if (!removed) {
        removed = true;
        await rm(join(directoryOf(f), "owner.lock"));
      }
    });
    await assert.rejects(f.runtime.run(f.input), expectCode(UNCERTAIN));
    await assertFenced(f);
    await assertNoReplay(f);
    const state = await bindingOf(f);
    state.status = "ready";
    delete state.budgetFailure;
    await writeFile(join(directoryOf(f), "binding.json"), JSON.stringify(state));
    await rm(join(directoryOf(f), "owner.lock"));
    const { operationalBudget, ...legacy } = f.config;
    const restarted = f.create(legacy);
    const children = f.children.length;
    await assert.rejects(restarted.run({ ...f.input, runId: "cannot-bypass-proof" }), expectCode(UNCERTAIN));
    assert.equal(f.children.length, children);
    assert.ok(existsSync(join(directoryOf(f), "owner.lock")));
    await assert.rejects(restarted.dispose(), expectCode(UNCERTAIN));
  });

  test("unconfirmed host callback fences rather than treating child exit as tool settlement", limits, async (t) => {
    const release = Promise.withResolvers(), drained = Promise.withResolvers();
    let calls = 0;
    const f = await fixture(t, {
      budget: caps(), config: { shutdownTimeoutMs: 250 },
      mock: async (request) => {
        await reserveAndSettle(request);
        await request.peer.request("tool", { callId: "still-running", name: tool.name, arguments: {} });
      },
    });
    f.input.tools = [tool];
    f.input.executeTool = async () => {
      calls++;
      f.controller.abort(new Error("cancel while host effect remains active"));
      await release.promise;
      drained.resolve();
      return { text: "late", isError: false };
    };
    try {
      await assert.rejects(f.runtime.run(f.input), expectCode(UNCERTAIN));
      assert.equal(calls, 1);
      const proof = await assertFenced(f);
      assert.equal(proof.accounting.reserved.toolCalls, 1);
      assert.equal(proof.accounting.reserved.modelRequests, 0);
      assert.equal(entriesOf(proof, "tool_settled").length, 0);
      await assertNoReplay(f);
      release.resolve();
      await drained.promise;
      await delay(20);
      assert.equal((await assertFenced(f)).ledgerBytes, proof.ledgerBytes, "late callbacks cannot reopen a fence");
    } finally {
      release.resolve();
    }
  });

  test("binding persistence failure fences even after measured provider settlement", limits, async (t) => {
    let f;
    f = await fixture(t, { budget: caps(), mock: async (request) => {
      await reserveAndSettle(request);
      const path = join(directoryOf(f), "binding.json");
      await rm(path);
      await mkdir(path);
    } });
    await assert.rejects(f.runtime.run(f.input), expectCode(UNCERTAIN));
    const proof = await proofOf(f, f.input, { terminal: "fenced" });
    assert.equal(proof.accounting.usageStatus, "unknown");
    assert.equal(entriesOf(proof, "request_settled").length, 1);
    assert.equal(proof.accounting.quiescent, false);
    assert.ok(existsSync(join(directoryOf(f), "owner.lock")));
    await assertNoReplay(f);
  });

  const summary = [
    "## Primary Request and Intent\n- Preserve fixture.",
    "## Key Technical Concepts\n- Budget accounting.",
    "## Files and Code\n- None.",
    "## Errors and Fixes\n- None.",
    "## Pending Jobs\n- Continue.",
    "## Current Work\n- Summarizing.",
    "## Next Step\n- Continue.",
    "## Critical Context\n- Synthetic retained fixture.",
  ].join("\n\n");
  for (const requestLimit of [1, 8]) {
    test(`real automatic compaction shares request/output caps with foreground work (${requestLimit} requests)`, limits, async (t) => {
      const f = await fixture(t, {
        budget: caps({ maxOutputTokens: 1024 }),
        responder: ({ body, send, response }) => {
          const compacting = JSON.stringify(body.messages).includes("compaction engine");
          send({ role: "assistant", content: compacting ? summary : "visible response" });
          const promptTokens = compacting ? 200 : 2000;
          send({}, "stop", {
            prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5,
            prompt_cache_hit_tokens: 2, prompt_cache_miss_tokens: promptTokens - 2,
          });
          response.end("data: [DONE]\n\n");
        },
      });
      const pressured = { ...f.input, maxTokens: 1024 };
      await f.runtime.run({ ...pressured, prompt: `Remember: ${"alpha ".repeat(2500)}` });
      await f.runtime.run({ ...pressured, runId: "pressure-two", prompt: `Also: ${"beta ".repeat(2500)}` });
      const next = { ...pressured, runId: "pressure-three", prompt: "Continue.",
        operationalBudget: caps({ maxModelRequests: requestLimit, maxOutputTokens: 1024 }) };
      const before = f.model.requests.length;
      if (requestLimit === 1) await assert.rejects(f.runtime.run(next), expectCode(EXCEEDED));
      else assert.equal((await f.runtime.run(next)).stopReason, "stop");
      const actual = f.model.requests.slice(before);
      if (requestLimit === 1) assert.equal(actual.length, 1);
      else assert.ok(actual.length >= 2 && actual.length <= requestLimit);
      assert.ok(JSON.stringify(actual[0].body.messages).includes("compaction engine"));
      assert.deepEqual(actual[0].body.tools ?? [], []);
      const proof = await proofOf(f, next);
      const reservations = entriesOf(proof, "request_reserved");
      assert.equal(reservations.length, actual.length);
      assert.equal(proof.accounting.usage.modelRequests, actual.length);
      assert.equal(proof.accounting.usage.outputTokens, actual.length * 5);
      assert.deepEqual(reservations.map((entry) => entry.outputTokens),
        actual.map((_, index) => 1024 - index * 5));
      assert.deepEqual(actual.map((entry) => entry.body.max_tokens), reservations.map((entry) => entry.outputTokens));
    });
  }

  for (const failCompact of [false, true]) {
    test(`real explicit compaction ${failCompact ? "fences uncertain work without replay" : "has a separate proof and immutable prior run history"}`, limits, async (t) => {
      const f = await fixture(t, { budget: caps({ maxInputTokens: 2_000_000 }), responder: (request) => {
        if (JSON.stringify(request.body.messages).includes("compaction engine")) {
          if (failCompact) {
            request.send({ role: "assistant", content: summary });
            request.send({}, "stop");
            request.response.end("data: [DONE]\n\n");
          } else {
            request.send({ role: "assistant", content: summary });
            request.finish();
          }
        } else done(request);
      } });
      f.input.contextWindow = 1_000_000;
      await f.runtime.run({ ...f.input, prompt: `Retain this: ${"alpha ".repeat(5000)}` });
      const first = await proofOf(f);
      const second = { ...f.input, runId: "run-two", prompt: `More context: ${"beta ".repeat(5000)}` };
      await f.runtime.run(second);
      const previous = await proofOf(f, second);
      const compact = { ...f.input, runId: "compact-one", operationalBudget: caps({
        maxModelRequests: 1, maxInputTokens: 1_000_000, maxOutputTokens: 7,
      }) };
      const before = f.model.requests.length;
      if (failCompact) {
        await assert.rejects(f.runtime.compact(compact), expectCode(UNCERTAIN));
        const proof = await assertFenced(f, compact);
        assert.equal(entriesOf(proof, "request_reserved")[0].purpose, "compaction");
        assert.equal((await bindingOf(f)).pendingCompact.runId, compact.runId);
        await assertNoReplay(f, compact);
      } else {
        const result = await f.runtime.compact(compact);
        assert.equal(result.compacted, true);
        const proof = await proofOf(f, compact);
        assert.deepEqual(entriesOf(proof, "request_reserved").map((entry) => entry.purpose), ["compaction"]);
        assert.deepEqual(entriesOf(proof, "request_settled").map((entry) => entry.usage), [measured]);
        assert.equal(proof.runtimeConfig.maxTokens, 7);
        assert.equal(proof.accounting.usage.modelRequests, 1);
        assert.equal((await bindingOf(f)).pendingCompact, undefined);
        await assert.rejects(f.runtime.compact(compact), /already submitted/);
      }
      assert.equal(f.model.requests.length, before + 1);
      assert.equal(f.model.requests.at(-1).body.max_tokens, 7);
      assert.deepEqual(f.model.requests.at(-1).body.tools ?? [], []);
      assert.equal((await proofOf(f, f.input, { latest: false })).ledgerBytes, first.ledgerBytes);
      assert.equal((await proofOf(f, second, { latest: false })).ledgerBytes, previous.ledgerBytes);
      assert.equal(await readFile(join(historyOf(f), CONFIG), "utf8"), first.configBytes);
      assert.equal(await readFile(join(historyOf(f, second), CONFIG), "utf8"), previous.configBytes);
    });
  }

  test("real preparation consumes the same request cap before any authorized host effect", limits, async (t) => {
    const userText = "Read the fixture without changing files.";
    let decisions = 0, calls = 0;
    const f = await fixture(t, { budget: caps({ maxModelRequests: 1 }), responder: (request) => {
      assert.deepEqual(request.body.tools.map(({ function: fn }) => fn.name), [PREPARATION_TOOL_NAME]);
      requestTools(request, ["prepare-one"], PREPARATION_TOOL_NAME, {
        version: 1, revision: 0, mode: "execute", task: "new",
        goal: "Read the fixture.", deliverables: ["A summary"],
        constraints: ["Do not change files."], assumptions: [], unresolved: [], question: "",
        enhancedPrompt: userText, evidence: { source: "current", quote: userText },
      });
    } });
    f.input.tools = [tool];
    f.input.taskPreparation = {
      policy: { version: 1, executionTools: [tool.name], skillAllowlist: [], maxClarificationTurns: 2, maxToolCalls: 1 },
      userText,
    };
    f.input.onPreparationDecision = () => { decisions++; };
    f.input.executeTool = async () => { calls++; return { text: "must not run", isError: false }; };
    await assert.rejects(f.runtime.run(f.input), expectCode(EXCEEDED));
    assert.equal(decisions, 1);
    assert.equal(calls, 0);
    assert.equal(f.model.requests.length, 1);
    const proof = await proofOf(f);
    assert.equal(proof.accounting.usage.modelRequests, 1);
    assert.equal(proof.accounting.usage.toolCalls, 0);
  });
}
