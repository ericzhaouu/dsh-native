import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  CampaignError, campaignStatus, claimCampaign, inspectProcess, prepareCampaign, processIdentity,
  runCampaign, validateCampaignConfig,
} from "../scripts/lib/acceptance-campaign.mjs";
import {
  HealthWaitExpired, TransientHealthError, sampleHealth, validateHealth, waitForHealth,
} from "../scripts/lib/acceptance-campaign-health.mjs";
import { hash, immutable, readJournal, readJson } from "../scripts/lib/acceptance-campaign-state.mjs";
import { campaignCli, campaignHelp } from "../scripts/run-acceptance-campaign.mjs";
import { campaignEnvironment } from "./fixtures/campaign-environment.mjs";

const { root: harness, skip } = campaignEnvironment(process.platform, process.env.DSH_CAMPAIGN_TEST_ROOT);
const save = (path, value) => writeFile(path, typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
  { mode: 0o600 });
const healthConfig = { url: "http://127.0.0.1:1/readyz", headers: {}, totalWaitMs: 1000,
  requestTimeoutMs: 25, initialBackoffMs: 10, maxBackoffMs: 40 };

function clockHealth(sequence = [true, true, true]) {
  let elapsed = 0;
  let calls = 0;
  const delays = [];
  return {
    now: () => elapsed,
    delay: async (ms) => { delays.push(ms); elapsed += ms; },
    probe: async () => {
      const value = sequence[Math.min(calls++, sequence.length - 1)];
      if (value !== true) throw value;
      return true;
    },
    calls: () => calls, delays,
  };
}

test("bounded exponential health wait resets consecutive samples and caps backoff", async () => {
  const health = clockHealth([
    new TransientHealthError("health-http-503"), new TransientHealthError("health-not-ready"),
    new TransientHealthError("health-connection"), new TransientHealthError("health-http-503"),
    true, true, new TransientHealthError("health-not-ready"), true, true, true,
  ]);
  const result = await waitForHealth(healthConfig, health);
  assert.equal(result.good, 3);
  assert.equal(health.calls(), 10);
  assert.deepEqual(health.delays.slice(0, 4), [10, 20, 40, 40]);
  assert.ok(health.delays.every((ms) => ms <= 40));
});

test("health deadline is monotonic and total expiry bounds every sleep", async () => {
  const health = clockHealth([new TransientHealthError("health-http-503")]);
  const wall = Date.now;
  Date.now = () => -123456789;
  try {
    await assert.rejects(waitForHealth({ ...healthConfig, totalWaitMs: 95 }, health), HealthWaitExpired);
  } finally { Date.now = wall; }
  assert.deepEqual(health.delays, [10, 20, 40, 25]);
  assert.equal(health.now(), 95);
});

test("hung health request is timed out and cannot consume an unbounded wait", async () => {
  const started = performance.now();
  await assert.rejects(waitForHealth({ ...healthConfig, totalWaitMs: 40, requestTimeoutMs: 15,
    initialBackoffMs: 1, maxBackoffMs: 2 }, { probe: async () => new Promise(() => {}) }), HealthWaitExpired);
  assert.ok(performance.now() - started < 1000);
});

test("static preflight and untyped probe errors are fatal, never retried", async () => {
  let requests = 0;
  await assert.rejects(waitForHealth(healthConfig, {
    preflight: async () => { throw new CampaignError("static-drift"); },
    probe: async () => { requests++; },
  }), /static-drift/);
  assert.equal(requests, 0);
  await assert.rejects(waitForHealth(healthConfig, {
    probe: async () => { requests++; throw new TypeError("bad config"); },
  }), /bad config/);
  assert.equal(requests, 1);
  assert.equal(validateHealth(healthConfig).goodSamples, 3);
  assert.throws(() => validateHealth({ ...healthConfig, goodSamples: 2 }), /invalid-health-config/);
});

test("health HTTP statuses, degraded readiness and transport errors are typed", async () => {
  for (const status of [429, 500, 502, 503, 504]) {
    await assert.rejects(sampleHealth(healthConfig, {
      fetchImpl: async () => new Response("", { status }),
    }), TransientHealthError);
  }
  for (const status of [401, 403, 404]) {
    await assert.rejects(sampleHealth(healthConfig, {
      fetchImpl: async () => new Response("", { status }),
    }), (error) => error instanceof CampaignError && !(error instanceof TransientHealthError));
  }
  for (const value of [{ ready: false }, { ready: true, eventLoop: { degraded: true } }]) {
    await assert.rejects(sampleHealth(healthConfig, {
      fetchImpl: async () => Response.json(value),
    }), TransientHealthError);
  }
  await assert.rejects(sampleHealth(healthConfig, {
    fetchImpl: async () => { throw new TypeError("private URL", { cause: { code: "ECONNRESET" } }); },
  }), TransientHealthError);
  await assert.rejects(sampleHealth(healthConfig, {
    fetchImpl: async () => { throw new TypeError("bad certificate", { cause: { code: "CERT_HAS_EXPIRED" } }); },
  }), /health-transport-config/);
  await assert.rejects(sampleHealth(healthConfig, {
    fetchImpl: async () => new Response("{broken"),
  }), /health-response-config/);
  assert.equal(await sampleHealth(healthConfig, {
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, "error");
      return Response.json({ ready: true, eventLoop: { degraded: false } });
    },
  }), true);
});

test("PID existence is not identity; reused PID is gone, inaccessible is unknown", async () => {
  const identity = { pid: 777, startId: "old" };
  assert.equal(await inspectProcess(identity, async () => identity), "alive");
  assert.equal(await inspectProcess(identity, async () => ({ pid: 777, startId: "new" })), "gone");
  assert.equal(await inspectProcess(identity, async () => null), "gone");
  assert.equal(await inspectProcess(identity, async () => { throw new Error("denied"); }), "unknown");
  assert.equal(await inspectProcess({ pid: 777 }), "unknown");
});

test("real local process identity round trips on supported hosts", {
  skip: !["linux", "win32"].includes(process.platform),
}, async () => {
  const identity = await processIdentity();
  assert.equal(identity.pid, process.pid);
  assert.equal(await inspectProcess(identity), "alive");
  assert.equal(await inspectProcess({ ...identity, startId: `${identity.startId}-not-this-process` }), "gone");
});

async function fixture(t, options = {}) {
  assert.ok(isAbsolute(harness));
  const directory = join(harness, `campaign-core-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  t.after(() => rm(directory, { force: true, recursive: true }));
  const sourceRoot = join(directory, "source");
  await mkdir(join(sourceRoot, "scripts", "lib"), { recursive: true, mode: 0o700 });
  const runner = join(sourceRoot, "scripts", "run-acceptance.mjs");
  const adapter = join(sourceRoot, "scripts", "lib", "adapter.mjs");
  const reviewer = join(sourceRoot, "scripts", "lib", "reviewer.mjs");
  const node = join(directory, "mock-node");
  for (const path of [runner, adapter, reviewer, node]) await save(path, "// synthetic offline fixture\n");
  const ids = options.ids ?? ["alpha", "beta"];
  const oracles = join(directory, "oracles.json");
  const originalOracle = { suiteId: "synthetic-suite", version: 1,
    cases: Object.fromEntries(ids.map((id) => [id, { privateExpected: `oracle-${id}` }])) };
  await save(oracles, originalOracle);
  const manifest = join(directory, "manifest.json");
  const originalManifest = { suiteId: "synthetic-suite", version: 1, cases: ids.map((id) => ({
    id, agentProfile: "synthetic-agent", kind: "prompt", prompt: `task-${id}`,
    limits: { timeoutMs: 500, usage: { modelRequests: 2 } },
  })), corpusOracle: { sha256: hash(await readFile(oracles)), caseCount: ids.length },
  limits: { concurrency: 4, perAgentConcurrency: 2, modelRequests: 17 } };
  await save(manifest, originalManifest);
  const scope = join(directory, "scope.json");
  await save(scope, { authorization: "private", readOnly: true, budgets: { modelRequests: 19 } });
  const config = { version: 1, campaignRoot: join(directory, "campaign"), sourceRoot,
    runner, adapter, reviewer, node, manifest, oracles, scope, caseIds: ids, live: false, env: {},
    health: healthConfig, heartbeatMs: 10, runnerTimeoutMs: 1000, pins: {} };
  for (const path of [runner, adapter, reviewer, node, manifest, oracles, scope]) {
    config.pins[path] = hash(await readFile(path));
  }
  const configPath = join(directory, "campaign-config.json");
  await save(configPath, config);
  if (!options.unprepared) await prepareCampaign(configPath);
  const executed = [];
  const results = new Map();
  const auditCalls = [];
  const reserved = [];
  const settled = [];
  const policy = {
    async audit({ events }) {
      assert.ok(Array.isArray(events));
      return { safeToContinue: true, proof: "synthetic-only" };
    },
    async reserve({ context, append }) {
      reserved.push(context.dispatchId);
      await append("test-reserved", { dispatchId: context.dispatchId });
      return { admitted: true, reservation: { synthetic: true, dispatchId: context.dispatchId } };
    },
    async settle({ context }) {
      settled.push(context.dispatchId);
      return { settled: true, accountingComplete: true, quiescent: true };
    },
  };
  const executor = {
    async execute(context, { onStarted }) {
      assert.ok(!(await readFile(context.manifestPath, "utf8")).includes("privateExpected"));
      const events = await readJournal(config.campaignRoot);
      assert.equal(events.at(-1).event, "dispatch-intent");
      assert.ok(events.some((event) => event.event === "reserved" && event.data.caseId === context.caseId));
      executed.push(context);
      await onStarted({ pid: 888, startId: context.dispatchId });
      const result = { status: "settled", accountingComplete: true, quiescent: true,
        outcome: context.caseId === ids[0] && options.failFirst ? "failed" : "passed",
        accounting: { synthetic: true } };
      results.set(context.dispatchId, result);
      return result;
    },
    async audit(context) {
      auditCalls.push(context.dispatchId);
      return results.get(context.dispatchId) ?? { status: "unknown", accountingComplete: false, quiescent: false };
    },
  };
  const seams = { identify: async (pid) => ({ pid, startId: "test-controller-identity" }),
    inspect: async () => "gone", policy, executor, health: clockHealth() };
  return { directory, root: config.campaignRoot, config, configPath, originalManifest, originalOracle,
    seams, policy, executor, executed, results, auditCalls, reserved, settled };
}

test("one private case per run, immutable inputs, source/oracles untouched, ordinary failure continues", { skip }, async (t) => {
  const f = await fixture(t, { failFirst: true });
  const before = new Map(await Promise.all(Object.keys(f.config.pins).map(async (path) => [path, await readFile(path)])));
  const result = await runCampaign(f.root, f.seams);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(result.completed, [{ caseId: "alpha", outcome: "failed" }, { caseId: "beta", outcome: "passed" }]);
  assert.equal(f.executed.length, 2);
  assert.equal(new Set(f.executed.map((context) => context.dispatchId)).size, 2);
  for (const context of f.executed) {
    const manifest = await readJson(context.manifestPath);
    const oracle = await readJson(context.oraclePath);
    assert.equal(manifest.cases.length, 1);
    assert.equal(manifest.cases[0].id, context.caseId);
    assert.deepEqual(Object.keys(oracle.cases), [context.caseId]);
    assert.deepEqual(manifest.cases[0], f.originalManifest.cases.find((item) => item.id === context.caseId));
    assert.equal(manifest.limits.modelRequests, f.originalManifest.limits.modelRequests);
    assert.equal(manifest.limits.concurrency, 1);
    assert.equal(manifest.corpusOracle.sha256, hash(await readFile(context.oraclePath)));
    await assert.rejects(immutable(context.scopePath, {}), { code: "EEXIST" });
  }
  for (const [path, bytes] of before) assert.deepEqual(await readFile(path), bytes);
  assert.equal(f.reserved.length, 2);
  assert.equal(f.settled.length, 2);
  assert.ok((await readJournal(f.root)).some((event) => event.event === "budget.test-reserved"));
  assert.deepEqual(await readJson(result.receipt.path).then((receipt) => receipt.status), "completed");
});

test("degraded health recovers; expiration is a durable paused terminal with no reservations", { skip }, async (t) => {
  const recovered = await fixture(t, { ids: ["only"] });
  const health = clockHealth([new TransientHealthError("health-not-ready"), true, true, true]);
  assert.equal((await runCampaign(recovered.root, { ...recovered.seams, health })).status, "completed");
  assert.equal(health.calls(), 4);
  const expired = await fixture(t, { ids: ["only"] });
  const result = await runCampaign(expired.root, {
    ...expired.seams, health: clockHealth([new TransientHealthError("health-http-503")]),
  });
  assert.equal(result.status, "paused");
  assert.equal(result.reason, "health-wait-expired");
  assert.equal(expired.executed.length, 0);
  assert.equal(expired.reserved.length, 0);
  assert.equal((await readJson(result.receipt.path)).status, "paused");
  const resumed = await runCampaign(expired.root, { ...expired.seams, resume: true });
  assert.equal(resumed.status, "completed");
  assert.equal(expired.executed.length, 1);
  assert.equal((await readdir(join(expired.root, "locks"))).filter((name) => name.startsWith("epoch")).length, 2);
});

test("source, oracle, authorization and config drift are fatal before health or dispatch", { skip }, async (t) => {
  for (const key of ["runner", "oracles", "scope", "configPath"]) {
    const f = await fixture(t);
    let probes = 0;
    if (key === "configPath") {
      await save(f.configPath, { ...f.config, caseIds: ["alpha"] });
      await assert.rejects(runCampaign(f.root, f.seams), /static-drift/);
    } else {
      await save(f.config[key], "{}\n");
      const result = await runCampaign(f.root, { ...f.seams, health: {
        ...clockHealth(), probe: async () => { probes++; return true; },
      } });
      assert.equal(result.status, "failed");
      assert.equal(result.reason, "static-drift");
      assert.equal((await readJson(result.receipt.path)).reason, "static-drift");
    }
    assert.equal(probes, 0);
    assert.equal(f.executed.length, 0);
  }
});

test("static drift during a transient wait stops without another health request", { skip }, async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const health = clockHealth();
  health.probe = async () => {
    calls++;
    await save(f.config.adapter, "drift\n");
    throw new TransientHealthError("health-http-503");
  };
  const result = await runCampaign(f.root, { ...f.seams, health });
  assert.equal(result.reason, "static-drift");
  assert.equal(calls, 1);
  assert.equal(f.executed.length, 0);
});

test("concurrent starts have one durable claim winner; living and uncertain owners block resume", { skip }, async (t) => {
  const f = await fixture(t);
  const starts = await Promise.allSettled([claimCampaign(f.root, f.seams), claimCampaign(f.root, f.seams)]);
  assert.equal(starts.filter((value) => value.status === "fulfilled").length, 1);
  const locks = await readdir(join(f.root, "locks"));
  assert.equal(locks.length, 1);
  for (const state of ["alive", "unknown"]) {
    await assert.rejects(claimCampaign(f.root, { ...f.seams, resume: true, inspect: async () => state }),
      /controller-alive|controller-identity-unknown/);
  }
  assert.deepEqual(await readdir(join(f.root, "locks")), locks);
});

test("concurrent resume uses immutable next-epoch CAS, never deletes old locks", { skip }, async (t) => {
  const f = await fixture(t);
  await claimCampaign(f.root, f.seams);
  const starts = await Promise.allSettled([
    claimCampaign(f.root, { ...f.seams, resume: true }),
    claimCampaign(f.root, { ...f.seams, resume: true }),
  ]);
  assert.equal(starts.filter((value) => value.status === "fulfilled").length, 1);
  assert.equal((await readdir(join(f.root, "locks"))).length, 2);
});

test("missing detached child identity is fenced even if launching parent PID was reused", { skip }, async (t) => {
  const f = await fixture(t);
  await claimCampaign(f.root, { ...f.seams, detached: true });
  await assert.rejects(claimCampaign(f.root, { ...f.seams, resume: true }), /launch-identity-unknown/);
  const status = await campaignStatus(f.root, f.seams);
  assert.equal(status.ownerState, "unknown");
  assert.equal(status.status, "paused");
});

test("started unknown is never replayed, even after PID reuse and explicit resume", { skip }, async (t) => {
  const f = await fixture(t);
  f.executor.execute = async (context, { onStarted }) => {
    f.executed.push(context);
    await onStarted({ pid: 888, startId: "old-child" });
    return { status: "unknown", quiescent: false, accountingComplete: false };
  };
  const result = await runCampaign(f.root, f.seams);
  assert.equal(result.status, "paused");
  for (let index = 0; index < 2; index++) {
    const resumed = await runCampaign(f.root, { ...f.seams, resume: true,
      inspect: (identity) => inspectProcess(identity, async (pid) => ({ pid, startId: "reused" })) });
    assert.equal(resumed.status, "paused");
    assert.equal(resumed.reason, "execution-unresolved");
  }
  assert.equal(f.executed.length, 1);
  assert.equal(f.reserved.length, 1);
  assert.deepEqual((await campaignStatus(f.root, f.seams)).fencedCaseIds, ["alpha"]);
});

test("completed results are audited but not replayed; changed receipt fences resume", { skip }, async (t) => {
  const f = await fixture(t);
  assert.equal((await runCampaign(f.root, f.seams)).status, "completed");
  assert.equal((await runCampaign(f.root, { ...f.seams, resume: true })).status, "completed");
  assert.equal(f.executed.length, 2);
  assert.equal(f.auditCalls.length, 2);
  const settled = (await readJournal(f.root)).find((event) => event.event === "case-settled");
  await save(settled.data.receipt.path, { forged: true });
  const resumed = await runCampaign(f.root, { ...f.seams, resume: true });
  assert.equal(resumed.status, "failed");
  assert.equal(resumed.reason, "receipt-changed");
  assert.equal(f.executed.length, 2);
});

test("changed but otherwise valid settled evidence cannot replace immutable settlement hashes", { skip }, async (t) => {
  for (const key of ["reportSha256", "ledgerSha256", "outcome", "accounting"]) {
    const f = await fixture(t, { ids: ["alpha"] });
    assert.equal((await runCampaign(f.root, f.seams)).status, "completed");
    const context = f.executed[0];
    const result = f.results.get(context.dispatchId);
    f.results.set(context.dispatchId, { ...result,
      [key]: key === "outcome" ? "blocked" : key === "accounting" ? { different: true } : "a".repeat(64) });
    const resumed = await runCampaign(f.root, { ...f.seams, resume: true });
    assert.equal(resumed.status, "failed");
    assert.equal(resumed.reason, "settled-evidence-changed");
    assert.equal(f.executed.length, 1);
  }
});

test("crash after execution before settlement audits accounting then continues only unstarted cases", { skip }, async (t) => {
  const f = await fixture(t);
  let crashed = false;
  const first = await runCampaign(f.root, { ...f.seams, checkpoint: async (point) => {
    if (!crashed && point === "after-execute") { crashed = true; throw new CampaignError("simulated-crash"); }
  } });
  assert.equal(first.status, "failed");
  assert.equal(f.executed.length, 1);
  const result = await runCampaign(f.root, { ...f.seams, resume: true });
  assert.equal(result.status, "completed");
  assert.deepEqual(f.executed.map((context) => context.caseId), ["alpha", "beta"]);
  assert.equal(f.reserved.length, 2);
  assert.equal(f.settled.length, 2);
});

test("abrupt process crashes before spawn and after start retain intentions and never duplicate", { skip }, async (t) => {
  const library = pathToFileURL(resolve("scripts", "lib", "acceptance-campaign.mjs")).href;
  for (const point of ["before-spawn", "after-start"]) {
    const f = await fixture(t);
    const script = join(f.directory, "crash.mjs");
    await save(script, `
      import {runCampaign} from ${JSON.stringify(library)};
      await runCampaign(${JSON.stringify(f.root)}, {
        identify: async pid => ({pid,startId:"crash-controller"}),
        inspect: async () => "gone",
        health: {now:()=>0,delay:async()=>{},probe:async()=>true},
        policy: {audit:async()=>({safeToContinue:true}),
          reserve:async()=>({admitted:true,reservation:{synthetic:true}}),
          settle:async()=>({settled:true,accountingComplete:true,quiescent:true})},
        executor:{execute:async(context,{onStarted})=>{
          await onStarted({pid:889,startId:"crashed-child"});
          throw Error("unreachable");
        }},
        checkpoint:async point=>{if(point===${JSON.stringify(point)})process.exit(88);}
      });
    `);
    const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 20000 });
    assert.equal(result.status, 88, result.stderr);
    const before = await readJournal(f.root);
    assert.ok(before.some((event) => event.event === "dispatch-intent"));
    assert.ok(!before.some((event) => event.event === "controller-terminal"));
    const resumed = await runCampaign(f.root, { ...f.seams, resume: true });
    assert.equal(resumed.status, "paused");
    assert.equal(resumed.reason, "execution-unresolved");
    assert.equal(f.executed.length, 0);
    assert.equal(f.reserved.length, 0);
  }
});

test("confirmed denial appends rejection and explicit resume retries the same prepared dispatch once", { skip }, async (t) => {
  const f = await fixture(t, { ids: ["only"] });
  let calls = 0;
  f.policy.reserve = async () => {
    calls++;
    return calls === 1 ? { admitted: false } :
      { admitted: true, reservation: { synthetic: true, dispatchId: `grant-${calls}` } };
  };
  const denied = await runCampaign(f.root, f.seams);
  assert.equal(denied.status, "paused");
  assert.equal(denied.reason, "budget-admission-denied");
  assert.equal(f.executed.length, 0);
  const before = await readJournal(f.root);
  const prepared = before.find((event) => event.event === "case-prepared").data.context;
  assert.ok(before.some((event) => event.event === "reservation-rejected" &&
    event.data.dispatchId === prepared.dispatchId));
  assert.ok(!before.some((event) => event.event === "reserved"));
  assert.deepEqual((await campaignStatus(f.root, f.seams)).fencedCaseIds, []);
  await assert.rejects(runCampaign(f.root, f.seams), /already-started/);
  const resumed = await runCampaign(f.root, { ...f.seams, resume: true });
  assert.equal(resumed.status, "completed");
  assert.equal(f.executed.length, 1);
  assert.equal(f.executed[0].dispatchId, prepared.dispatchId);
  assert.equal(calls, 2);
});

test("confirmed denial still requires safe accounting audit before explicit resume can retry", { skip }, async (t) => {
  const f = await fixture(t, { ids: ["only"] });
  let calls = 0;
  f.policy.reserve = async () => {
    calls++;
    return { admitted: false };
  };
  const denied = await runCampaign(f.root, f.seams);
  assert.equal(denied.reason, "budget-admission-denied");
  f.policy.audit = async () => ({ safeToContinue: false, proof: "unsafe" });
  const resumed = await runCampaign(f.root, { ...f.seams, resume: true });
  assert.equal(resumed.status, "paused");
  assert.equal(resumed.reason, "accounting-unresolved");
  assert.equal(calls, 1);
  assert.equal(f.executed.length, 0);
});

test("malformed denials stay fenced until operator review", { skip }, async (t) => {
  for (const admission of [
    { admitted: false, reservation: { synthetic: true } },
    Object.assign(Object.create({ reservation: { synthetic: true } }), { admitted: false }),
    { admitted: false, reservation: null },
    { admitted: false, reservation: 0 },
    { admitted: 0 },
    { admitted: "" },
    { admitted: null },
    { admitted: "false" },
    {},
    null,
  ]) {
    const f = await fixture(t, { ids: ["only"] });
    f.policy.reserve = async () => admission;
    const denied = await runCampaign(f.root, f.seams);
    assert.equal(denied.reason, "budget-admission-denied");
    const events = await readJournal(f.root);
    assert.ok(!events.some((event) => event.event === "reservation-rejected"));
    assert.deepEqual((await campaignStatus(f.root, f.seams)).fencedCaseIds, ["only"]);
    const resumed = await runCampaign(f.root, { ...f.seams, resume: true });
    assert.equal(resumed.reason, "reservation-unresolved");
    assert.equal(f.executed.length, 0);
  }
});

test("false denial with a durable reservation event cannot clear the intent", { skip }, async (t) => {
  for (const event of ["account-reserved", "reserved", "test-reservation"]) {
    const f = await fixture(t, { ids: ["only"] });
    let calls = 0;
    f.policy.reserve = async ({ context, append }) => {
      calls++;
      await append(event, { dispatchId: context.dispatchId });
      return { admitted: false };
    };
    assert.equal((await runCampaign(f.root, f.seams)).reason, "budget-admission-denied");
    assert.ok(!(await readJournal(f.root)).some((row) => row.event === "reservation-rejected"));
    assert.equal((await runCampaign(f.root, { ...f.seams, resume: true })).reason, "reservation-unresolved");
    assert.equal(calls, 1);
    assert.equal(f.executed.length, 0);
  }
});

test("reservation-related durable append plus throw remains fenced; missing policy never silently grants an allocation", { skip }, async (t) => {
  const f = await fixture(t);
  f.policy.reserve = async ({ context, append }) => {
    await append("account-reserved", { dispatchId: context.dispatchId });
    throw new Error("unknown allocation");
  };
  const crashed = await runCampaign(f.root, f.seams);
  assert.equal(crashed.reason, "controller-error");
  const events = await readJournal(f.root);
  assert.ok(events.some((event) => event.event === "budget.account-reserved"));
  assert.ok(!events.some((event) => event.event === "reservation-rejected"));
  const resumed = await runCampaign(f.root, { ...f.seams, resume: true });
  assert.equal(resumed.reason, "reservation-unresolved");
  assert.equal(f.executed.length, 0);
  const noPolicy = await fixture(t);
  const result = await runCampaign(noPolicy.root, { ...noPolicy.seams, policy: undefined });
  assert.equal(result.reason, "campaign-policy-required");
  assert.equal(noPolicy.executed.length, 0);
});

test("abrupt reserve interruption retains intent and never replays", { skip }, async (t) => {
  const library = pathToFileURL(resolve("scripts", "lib", "acceptance-campaign.mjs")).href;
  const f = await fixture(t, { ids: ["only"] });
  const script = join(f.directory, "reserve-crash.mjs");
  await save(script, `
    import {runCampaign} from ${JSON.stringify(library)};
    await runCampaign(${JSON.stringify(f.root)}, {
      identify: async pid => ({pid,startId:"crash-controller"}),
      inspect: async () => "gone",
      health: {now:()=>0,delay:async()=>{},probe:async()=>true},
      policy: {audit:async()=>({safeToContinue:true}),
        reserve:async()=>process.exit(89),
        settle:async()=>({settled:true,accountingComplete:true,quiescent:true})},
      executor:{execute:async()=>{throw Error("unreachable");}}
    });
  `);
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 89, result.stderr);
  const before = await readJournal(f.root);
  assert.ok(before.some((event) => event.event === "reservation-intent"));
  assert.ok(!before.some((event) => event.event === "reservation-rejected"));
  const resumed = await runCampaign(f.root, { ...f.seams, resume: true });
  assert.equal(resumed.status, "paused");
  assert.equal(resumed.reason, "reservation-unresolved");
  assert.equal(f.executed.length, 0);
});

test("unknown accounting or nonquiescent ordinary failure halts subsequent cases", { skip }, async (t) => {
  for (const field of ["accountingComplete", "quiescent"]) {
    const f = await fixture(t, { failFirst: true });
    const execute = f.executor.execute;
    f.executor.execute = async (...args) => ({ ...await execute(...args), [field]: false });
    const result = await runCampaign(f.root, f.seams);
    assert.equal(result.status, "paused");
    assert.equal(f.executed.length, 1);
    assert.equal(f.settled.length, 0);
  }
});

test("journal tail damage prevents resume and does not truncate or overwrite history", { skip }, async (t) => {
  const f = await fixture(t);
  await claimCampaign(f.root, f.seams);
  const path = join(f.root, "controller.jsonl");
  const bytes = Buffer.concat([await readFile(path), Buffer.from('{"interrupted":')]);
  await writeFile(path, bytes);
  await assert.rejects(runCampaign(f.root, { ...f.seams, resume: true }), /journal-torn/);
  assert.deepEqual(await readFile(path), bytes);
});

test("heartbeat reports current/next/remaining scope while child is in flight", { skip }, async (t) => {
  const f = await fixture(t);
  const execute = f.executor.execute;
  const snapshots = [];
  f.executor.execute = (context, { onStarted }) => execute(context, {
    onStarted: async (identity) => {
      await onStarted(identity);
      const started = (await readJournal(f.root)).at(-1);
      const deadline = performance.now() + f.config.runnerTimeoutMs;
      let status;
      do {
        // Heartbeats atomically replace this snapshot; the immutable readJson guard can race the rename.
        status = JSON.parse(await readFile(join(f.root, "status.json"), "utf8"));
        if (status.currentCase === context.caseId && status.journalSequence === started.seq) break;
        await new Promise((done) => setTimeout(done, f.config.heartbeatMs));
      } while (performance.now() < deadline);
      snapshots.push(status);
    },
  });
  const result = await runCampaign(f.root, f.seams);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(snapshots.length, f.config.caseIds.length);
  const events = await readJournal(f.root);
  for (const [index, status] of snapshots.entries()) {
    assert.equal(status.status, "running");
    assert.equal(status.currentCase, f.config.caseIds[index]);
    assert.equal(status.nextCase, f.config.caseIds[index + 1] ?? null);
    assert.deepEqual(status.remainingCaseIds, f.config.caseIds.slice(index + 1));
    assert.ok(status.heartbeat);
    assert.ok(Number.isSafeInteger(status.journalSequence));
    assert.equal(events[status.journalSequence].event, "child-started");
    assert.equal(events[status.journalSequence].data.caseId, status.currentCase);
  }
});

test("config validation and CLI help disclose explicit policy/env and forbid hidden authorization", { skip }, async (t) => {
  const f = await fixture(t);
  assert.throws(() => validateCampaignConfig({ ...f.config, env: undefined }), /explicit-env-required/);
  assert.throws(() => validateCampaignConfig({ ...f.config, env: { NODE_OPTIONS: "--import private.mjs" } }),
    /runtime-injection-forbidden/);
  assert.throws(() => validateCampaignConfig({ ...f.config, caseIds: ["alpha", "alpha"] }), /invalid-case-ids/);
  assert.throws(() => validateCampaignConfig({ ...f.config, pins: {} }), /required-pin-missing/);
  const help = campaignHelp();
  for (const phrase of ["createCampaignPolicy", "reserve", "settle", "audit", "built-in durable budget policy",
    "No ambient", "goodSamples", "private ACLs", "admitted:false", "reservation-rejected",
    "userTurns counts DUT inputs ONLY", "shared review pool is 0"]) assert.ok(help.includes(phrase));
  assert.equal((await campaignCli(["--help"])).code, 0);
  await assert.rejects(campaignCli(["start", "--root", f.root, "--config", f.configPath]), /invalid-arguments/);
  await assert.rejects(campaignCli(["prepare", "--config", f.configPath, "--detach"]), /invalid-arguments/);
});

test("live configuration is explicit and per-case gateway scope has unique private session namespaces", { skip }, async (t) => {
  const f = await fixture(t, { unprepared: true });
  await mkdir(join(f.directory, "dist"), { mode: 0o700 });
  await mkdir(join(f.config.sourceRoot, "dist"), { mode: 0o700 });
  await save(join(f.directory, "package.json"), { name: "synthetic-host" });
  const hostConfig = join(f.directory, "host.json");
  const gatewayConfig = join(f.directory, "gateway.json");
  const reviewerConfig = join(f.directory, "reviewer.json");
  await save(hostConfig, { synthetic: true });
  const gateway = { hostRoot: f.directory, configPath: hostConfig, stateDir: f.directory,
    nativeStateDir: f.directory, gatewayUrl: "ws://127.0.0.1:1",
    ownedSessionPrefix: "acceptance-synthetic", agentMap: { synthetic: "fixture" } };
  await save(gatewayConfig, gateway);
  await save(reviewerConfig, { hostRoot: f.directory, configPath: hostConfig, stateDir: f.directory,
    agentId: "independent-fixture" });
  await save(f.config.scope, { authorization: "private", readOnly: true,
    testNamespaces: ["acceptance-synthetic"], budgets: { modelRequests: 19 } });
  f.config.live = true;
  assert.throws(() => validateCampaignConfig(f.config), /explicit-OPENCLAW_STATE_DIR-required/);
  f.config.env = { OPENCLAW_STATE_DIR: f.directory, OPENCLAW_CONFIG_PATH: hostConfig,
    DSH_ACCEPTANCE_GATEWAY_CONFIG: gatewayConfig, DSH_ACCEPTANCE_REVIEW_GATEWAY_CONFIG: reviewerConfig };
  for (const path of [f.config.scope, hostConfig, gatewayConfig, reviewerConfig]) {
    f.config.pins[path] = hash(await readFile(path));
  }
  await save(f.configPath, f.config);
  await prepareCampaign(f.configPath);
  assert.equal((await runCampaign(f.root, f.seams)).status, "completed");
  const namespaces = [];
  for (const context of f.executed) {
    const config = await readJson(context.environmentFiles.DSH_ACCEPTANCE_GATEWAY_CONFIG);
    const scope = await readJson(context.scopePath);
    namespaces.push(config.ownedSessionPrefix);
    assert.deepEqual(scope.testNamespaces, [config.ownedSessionPrefix]);
    assert.equal(config.configPath, hostConfig);
    assert.deepEqual(config.agentMap, gateway.agentMap);
  }
  assert.equal(new Set(namespaces).size, 2);
  assert.deepEqual(await readJson(gatewayConfig), gateway);
  await save(join(f.directory, "dist", "new-host-code.js"), "// drift\n");
  const resumed = await runCampaign(f.root, { ...f.seams, resume: true });
  assert.equal(resumed.status, "failed");
  assert.equal(resumed.reason, "static-drift");
});

test("external resource maps and local files are pinned and isolated without changing source scope", { skip }, async (t) => {
  for (const changed of ["map", "file", "compiled", "dependency"]) {
    const f = await fixture(t, { ids: ["alpha"], unprepared: true });
    const file = join(f.directory, "fixture.txt");
    const map = join(f.directory, "resources.json");
    const compiled = join(f.config.sourceRoot, "dist", "runtime.js");
    const dependency = join(f.directory, "dependency", "index.js");
    await mkdir(join(f.config.sourceRoot, "dist"), { mode: 0o700 });
    await mkdir(join(f.directory, "dependency"), { mode: 0o700 });
    await save(compiled, "// pinned runtime\n");
    await save(dependency, "// pinned dependency\n");
    await save(file, "synthetic public fixture\n");
    await save(map, { version: 1, resources: {
      text: { kind: "file", path: file, agents: ["synthetic-agent"] },
      inline: { kind: "inline", modelVisible: { value: "fixture" }, agents: ["synthetic-agent"] },
    } });
    const scope = { authorization: "private", readOnly: true, resourceMapPath: map,
      allowedFixtureRoots: [f.directory] };
    await save(f.config.scope, scope);
    f.config.pins[f.config.scope] = hash(await readFile(f.config.scope));
    f.config.artifactRoots = [join(f.directory, "dependency")];
    await save(f.configPath, f.config);
    await prepareCampaign(f.configPath);
    assert.equal((await runCampaign(f.root, f.seams)).status, "completed");
    const isolatedScope = await readJson(f.executed[0].scopePath);
    assert.notEqual(isolatedScope.resourceMapPath, map);
    const isolatedMap = await readJson(isolatedScope.resourceMapPath);
    assert.equal(isolatedMap.resources.text.sha256, hash(await readFile(file)));
    assert.deepEqual(await readJson(f.config.scope), scope);
    await save({ map, file, compiled, dependency }[changed], "drift\n");
    const result = await runCampaign(f.root, { ...f.seams, resume: true });
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "static-drift");
    assert.equal(f.executed.length, 1);
  }
});

test("detached CLI worker outlives launcher and persists its own identity and terminal receipt offline", {
  skip: skip || !["linux", "win32"].includes(process.platform),
}, async (t) => {
  const f = await fixture(t, { ids: ["alpha"], unprepared: true });
  const policy = join(f.directory, "private-policy.mjs");
  await save(policy, `export function createCampaignPolicy(){return {
    preflight:async()=>{await new Promise(resolve=>setTimeout(resolve,500));throw Error("synthetic stop");},
    audit:async()=>({safeToContinue:true}),reserve:async()=>{throw Error("must not dispatch");},
    settle:async()=>{throw Error("must not settle");}
  }}\n`);
  delete f.config.pins[f.config.node];
  f.config.node = process.execPath;
  f.config.policyModule = policy;
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "PATH"]) {
      if (process.env[key]) f.config.env[key] = process.env[key];
    }
  }
  f.config.pins[process.execPath] = hash(await readFile(process.execPath));
  f.config.pins[policy] = hash(await readFile(policy));
  await save(f.configPath, f.config);
  await prepareCampaign(f.configPath);
  const cli = resolve("scripts", "run-acceptance-campaign.mjs");
  const launcher = spawnSync(process.execPath, [cli, "start", "--root", f.root, "--detach"],
    { encoding: "utf8", timeout: 20000 });
  assert.equal(launcher.status, 0, launcher.stderr);
  const launched = JSON.parse(launcher.stdout);
  assert.equal(launched.status, "launch-requested");
  const deadline = performance.now() + 20000;
  let terminal;
  while (performance.now() < deadline) {
    terminal = (await readJournal(f.root)).find((event) => event.event === "controller-terminal");
    if (terminal) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(terminal, JSON.stringify(await campaignStatus(f.root)));
  assert.equal(terminal.data.status, "failed");
  const worker = await readJson(join(f.root, "locks", "worker-00000000.json"));
  assert.equal(worker.identity.pid, launched.pid);
  assert.ok(worker.identity.startId);
  assert.equal((await readJson(terminal.data.receipt.path)).reason, "controller-error");
  const deadlineExit = performance.now() + 10000;
  while (await inspectProcess(worker.identity) === "alive" && performance.now() < deadlineExit) {
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(await inspectProcess(worker.identity), "gone");
  assert.equal((await readdir(join(f.root, "cases"))).length, 0);
});
