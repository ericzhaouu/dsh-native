import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

test("isolated SDK guard preserves Node filesystem APIs and refuses exec/network escapes", {
  skip: process.platform !== "linux" && "Linux-only POSIX isolation guard probes",
}, () => {
  const root = resolve("artifacts", "repairs-074-20260921", "channel-linux", "guard-smoke");
  const result = spawnSync(process.execPath, [
    "--import", new URL("./fixtures/feishu-isolated-sdk-guard.mjs", import.meta.url).href,
    "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import cp from "node:child_process";
      import net from "node:net";
      import dns from "node:dns";
      import { promisify } from "node:util";
      assert.equal(typeof promisify(fs.realpath.native), "function");
      for (const name of ["exec", "execSync", "execFile", "execFileSync", "spawnSync", "fork"]) {
        assert.throws(() => cp[name]("must-not-execute"), /forbids child_process/);
      }
      assert.throws(() => cp.spawn("must-not-execute"), /only its own Node children/);
      for (const host of ["localhost", "192.0.2.1", "127.0.0.2"]) {
        assert.throws(() => net.connect({ host, port: 40001 }), /forbids socket/);
      }
      assert.throws(() => net.connect({ host: "127.0.0.1", port: 40003 }), /forbids socket/);
      assert.throws(() => dns.lookup("must-not-resolve.invalid", () => {}), /numeric loopback/);
      if (process.platform === "linux") {
        for (const method of [fs.lstatSync, fs.realpathSync.native, fs.mkdirSync]) {
          assert.throws(() => method("/tmp/openclaw"), /shared temporary paths/);
        }
      }
    `,
  ], { encoding: "utf8", timeout: 10000, env: {
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root,
    DSH_ISOLATED_ROOT: root, DSH_ISOLATED_PORTS: JSON.stringify([40001, 40002]),
  } });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const requiredOperations = {
  "duplicate-replay": ["ingress-redelivery"],
  "reconnect-ack": ["accepted-lost-ack", "owned-socket-reconnect"],
};
const operationName = (operation) => operation.kind ?? operation.type ?? operation.operation;

function nonempty(value, label) {
  assert.equal(typeof value, "string", label);
  assert.ok(value.length > 0, label);
}

function assertEnvelope(actual, request) {
  const { signal, prompt, ...envelope } = request;
  for (const [key, value] of Object.entries(envelope)) {
    assert.deepEqual(actual[key], value, `bound envelope field: ${key}`);
  }
  assert.equal(Object.hasOwn(actual, "signal"), false);
  assert.equal(Object.hasOwn(actual, "prompt"), false);
}

// Private SDK/loopback evidence does not claim actual Feishu certification.
test("isolated SDK transport derives replay and reconnect evidence from real runtime activity", {
  skip: process.platform !== "linux"
    ? "Linux-only: the genuine Windows SDK queries process start via forbidden spawnSync; exec remains denied"
    : process.env.DSH_RUN_ISOLATED_SDK_TRANSPORT !== "1" && "Set DSH_RUN_ISOLATED_SDK_TRANSPORT=1 in a private Linux stage",
  timeout: 600000,
}, async (t) => {
  const { createIsolatedSdkTransportProvider } = await import("./fixtures/feishu-isolated-sdk-transport.mjs");
  const suffix = randomUUID();
  const id = `isolated-sdk-test-${suffix}`;
  const epoch = `epoch-${suffix}`;
  const scope = {
    agentId: `isolated-sdk-${suffix}`,
    chatId: `isolated-chat-${suffix}`,
    accountId: `isolated-sdk-${suffix}`,
    channel: "feishu",
  };
  const outputText = `ISOLATED-SDK-REPLY-${suffix}`;
  const controllerRunId = `controller-${suffix}`;
  const provider = await createIsolatedSdkTransportProvider({
    id, epoch, scope, outputText, timeoutMs: 180000,
  });
  t.after(async () => { await provider.close(); });

  const receiptIds = new Set();
  const callbackIds = new Set();
  const verificationIds = new Set();

  function unique(value, seen, label) {
    nonempty(value, label);
    assert.equal(seen.has(value), false, `${label} must be fresh`);
    seen.add(value);
  }

  function newCase(type, label) {
    const caseId = `${label}-${randomUUID()}`;
    const prompt = `Return the isolated transport reply for ${caseId}.\nUTF-8 probe: 飞书 🧪`;
    const common = {
      providerId: id,
      evidenceClass: "isolated-sdk",
      epoch,
      scope: { ...scope },
      caseId,
      runId: controllerRunId,
      type,
      challenge: `challenge-${randomUUID()}`,
      promptSha256: sha256(prompt),
      signal: new AbortController().signal,
    };
    return {
      prepare: { ...common, operation: "prepare" },
      execute: { ...common, operation: "execute", prompt },
    };
  }

  function checkReceipt(receipt, request) {
    assertEnvelope(receipt, request);
    unique(receipt.receiptId, receiptIds, "receiptId");
    unique(receipt.callbackId, callbackIds, "callbackId");
  }

  async function verify(request, receipt) {
    const result = await provider.verify(request, structuredClone(receipt));
    assertEnvelope(result, request);
    assert.equal(result.verifiedReceiptId, receipt.receiptId);
    unique(result.verificationId, verificationIds, "verificationId");
    return result;
  }

  async function prepare(testCase) {
    const receipt = await provider.prepare(testCase.prepare);
    checkReceipt(receipt, testCase.prepare);
    await verify(testCase.prepare, receipt);
    assert.ok(Array.isArray(receipt.readyOperations));
    assert.equal(new Set(receipt.readyOperations).size, receipt.readyOperations.length);
    for (const operation of requiredOperations[testCase.prepare.type]) {
      assert.ok(receipt.readyOperations.includes(operation), `${operation} must be ready`);
    }
    for (const operation of receipt.readyOperations) {
      assert.ok(provider.capabilities.operations.includes(operation));
    }
    return receipt;
  }

  function checkObservation(verified, request, receipt) {
    const observation = verified.observation;
    assert.ok(observation, "verification must reread execution evidence");
    nonempty(receipt.inbound.eventId, "inbound event ID");
    nonempty(receipt.inbound.messageId, "inbound message ID");
    assert.equal(receipt.inbound.bodySha256, sha256(request.prompt));
    assert.equal(observation.inboundEventId, receipt.inbound.eventId);
    assert.equal(observation.inboundMessageId, receipt.inbound.messageId);
    assert.equal(observation.bodySha256, request.promptSha256);
    assert.ok(Array.isArray(observation.runIds));
    assert.equal(observation.runIds.length, 1);
    nonempty(observation.runIds[0], "observed native run ID");
    assert.notEqual(observation.runIds[0], request.runId, "controller ID is not native run evidence");
    assert.equal(observation.modelRequests, 1);
    assert.equal(observation.modelRequestIds.length, 1);
    nonempty(observation.modelRequestIds[0], "observed model request ID");
    assert.equal(observation.usage.modelRequests, 1);
    assert.deepEqual(observation.ingressEvidence.map((entry) => entry.kind),
      request.type === "duplicate-replay" ? ["ingress", "redeliver"] : ["ingress"]);
    for (const [index, entry] of observation.ingressEvidence.entries()) {
      nonempty(entry.ingressId, "SDK ingress ID");
      assert.equal(entry.eventId, receipt.inbound.eventId);
      assert.equal(entry.messageId, receipt.inbound.messageId);
      assert.equal(entry.modelRequestsBefore, index === 0 ? 0 : 1);
      assert.equal(entry.modelRequestsAfter, 1);
      assert.deepEqual(entry.modelRequestIds, index === 0 ? observation.modelRequestIds : []);
      assert.deepEqual(entry.runIds, observation.runIds);
    }
    assert.deepEqual(observation.modelRequestEvidence, [{
      requestId: observation.modelRequestIds[0], ingressId: observation.ingressEvidence[0].ingressId,
      eventId: receipt.inbound.eventId, messageId: receipt.inbound.messageId, runId: observation.runIds[0],
    }]);
    assert.ok(Array.isArray(observation.terminalReplyIds));
    assert.equal(observation.terminalReplyIds.length, 1);
    nonempty(observation.terminalReplyIds[0], "accepted terminal reply ID");
    assert.equal(observation.delivery.receiptId, observation.terminalReplyIds[0]);
    assert.equal(observation.delivery.acknowledgement,
      request.type === "reconnect-ack" ? "unknown" : "received");
    assert.equal(observation.ingressCount, request.type === "duplicate-replay" ? 2 : 1);
    assert.equal(observation.sendAttempts, 1);
    assert.equal(observation.quiescent, true);
    assert.equal(observation.outputText, outputText);
    return observation;
  }

  function checkOperations(receipt, request, observation) {
    assert.ok(Array.isArray(receipt.operations));
    const names = request.type === "duplicate-replay"
      ? ["ingress", "redeliver"]
      : ["ingress", "accepted-lost-ack", "owned-socket-reconnect"];
    assert.deepEqual(receipt.operations.map(operationName), names);
    for (const operation of receipt.operations) {
      assert.equal(operation.eventId, receipt.inbound.eventId);
      assert.equal(operation.messageId, receipt.inbound.messageId);
    }
    if (request.type === "reconnect-ack") {
      const [, accepted, reconnect] = receipt.operations;
      assert.equal(accepted.replyId, observation.terminalReplyIds[0]);
      assert.equal(reconnect.ownerId, request.providerId);
      nonempty(reconnect.previousConnectionId, "previous owned connection");
      nonempty(reconnect.connectionId, "new owned connection");
      assert.notEqual(reconnect.previousConnectionId, reconnect.connectionId);
    }
  }

  async function perform(testCase) {
    const receipt = await provider.perform(testCase.execute);
    checkReceipt(receipt, testCase.execute);
    const verified = await verify(testCase.execute, receipt);
    const observation = checkObservation(verified, testCase.execute, receipt);
    checkOperations(receipt, testCase.execute, observation);
    return { receipt, observation: structuredClone(observation) };
  }

  async function rejectForgedReceipts(request, receipt) {
    const mutations = [
      ...["receiptId", "callbackId", "providerId", "epoch", "caseId", "runId", "challenge"]
        .map((key) => [key, (forged) => { forged[key] = `forged-${randomUUID()}`; }]),
      ["evidenceClass", (forged) => { forged.evidenceClass = "forged"; }],
      ["promptSha256", (forged) => { forged.promptSha256 = sha256("forged prompt"); }],
      ["type", (forged) => {
        forged.type = request.type === "duplicate-replay" ? "reconnect-ack" : "duplicate-replay";
      }],
      ["operation", (forged) => {
        forged.operation = request.operation === "prepare" ? "execute" : "prepare";
      }],
      ...Object.keys(scope).map((key) => [`scope.${key}`, (forged) => {
        forged.scope[key] = `forged-${randomUUID()}`;
      }]),
    ];
    if (request.operation === "prepare") {
      mutations.push(["readyOperations", (forged) => { forged.readyOperations = []; }]);
    } else {
      for (const key of ["eventId", "messageId", "bodySha256"]) {
        mutations.push([`inbound.${key}`, (forged) => {
          forged.inbound[key] = key === "bodySha256" ? sha256("forged body") : `forged-${randomUUID()}`;
        }]);
      }
      mutations.push(
        ["missing operations", (forged) => { forged.operations = []; }],
        ["reordered operations", (forged) => { forged.operations.reverse(); }],
        ["extra operation", (forged) => { forged.operations.push(structuredClone(forged.operations[0])); }],
      );
      for (const [index, operation] of receipt.operations.entries()) {
        for (const key of Object.keys(operation)) {
          mutations.push([`operations[${index}].${key}`, (forged) => {
            forged.operations[index][key] = `forged-${randomUUID()}`;
          }]);
        }
      }
    }
    for (const [label, mutate] of mutations) {
      const forged = structuredClone(receipt);
      mutate(forged);
      await assert.rejects(async () => provider.verify(request, forged), `reject forged ${label}`);
    }
    await verify(request, receipt);
  }

  async function rejectAlteredBindings(request, receipt) {
    const mutations = [
      ["epoch", (altered) => { altered.epoch = `wrong-${randomUUID()}`; }],
      ["promptSha256", (altered) => { altered.promptSha256 = sha256("wrong binding"); }],
      ["challenge", (altered) => { altered.challenge = `wrong-${randomUUID()}`; }],
      ...Object.keys(scope).map((key) => [`scope.${key}`, (altered) => {
        altered.scope[key] = `wrong-${randomUUID()}`;
      }]),
    ];
    for (const [label, mutate] of mutations) {
      const altered = { ...request, scope: { ...request.scope } };
      mutate(altered);
      await assert.rejects(async () => provider.verify(altered, structuredClone(receipt)),
        `reject altered request binding: ${label}`);
    }
  }

  const duplicate = newCase("duplicate-replay", "initial-duplicate");
  const reconnect = newCase("reconnect-ack", "lost-ack");
  const continued = newCase("duplicate-replay", "independent-before-fault");
  let duplicateResult;
  let reconnectResult;
  let continuedResult;

  await t.test("advertises dedicated, scoped isolated SDK capabilities", () => {
    assert.equal(provider.capabilities.id, id);
    assert.equal(provider.capabilities.evidenceClass, "isolated-sdk");
    assert.equal(provider.capabilities.epoch, epoch);
    assert.deepEqual(provider.capabilities.scope, scope);
    assert.equal(provider.capabilities.dedicated, true);
    assert.deepEqual([...provider.capabilities.operations].sort(),
      Object.values(requiredOperations).flat().sort());
  });

  await t.test("actual worker verifies private SDK temp/HOME and refuses exec, DNS and nonnumeric sockets", async () => {
    const rows = (await readFile(join(provider.evidenceRoot, "operations.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    const isolation = rows.find((row) => row.kind === "isolation-verified");
    assert.ok(isolation);
    assert.equal(isolation.node, process.version);
    assert.equal(isolation.platform, "linux");
    for (const name of ["execDenied", "dnsDenied", "nonnumericDenied", "externalSocketsDenied", "sharedTempDenied"]) {
      assert.equal(isolation[name], true);
    }
    assert.ok(isolation.sdkTemp.startsWith(`${provider.evidenceRoot}/`));
  });

  await t.test("rejects execute-before-prepare and aborted preparation before entry", async () => {
    await assert.rejects(async () => provider.perform(duplicate.execute));
    const controller = new AbortController();
    controller.abort(new Error("abort before prepare"));
    await assert.rejects(async () => provider.prepare({
      ...duplicate.prepare, signal: controller.signal,
    }));
  });

  await t.test("verifies prepared readiness, binds receipts and prevents prepare-to-execute escalation", async () => {
    const receipt = await prepare(duplicate);
    await rejectForgedReceipts(duplicate.prepare, receipt);
    await rejectAlteredBindings(duplicate.prepare, receipt);
    await assert.rejects(async () => provider.verify(duplicate.execute, structuredClone(receipt)));
    await assert.rejects(async () => provider.verify(duplicate.execute, {
      ...structuredClone(receipt), operation: "execute",
    }));
  });

  await t.test("rejects a mismatched prompt and pre-aborted execution without consuming the prepared case", async () => {
    await assert.rejects(async () => provider.perform({
      ...duplicate.execute, prompt: `${duplicate.execute.prompt}changed`,
    }));
    const controller = new AbortController();
    controller.abort(new Error("abort before execute"));
    await assert.rejects(async () => provider.perform({
      ...duplicate.execute, signal: controller.signal,
    }));
  });

  await t.test("redelivery retains ingress identity but produces only one native run and accepted reply", async () => {
    duplicateResult = await perform(duplicate);
  });

  await t.test("rejects forged execution IDs, envelopes, inbound identity, operations and request bindings", async () => {
    await rejectForgedReceipts(duplicate.execute, duplicateResult.receipt);
    await rejectAlteredBindings(duplicate.execute, duplicateResult.receipt);
    const receipt = duplicateResult.receipt;
    const originalEventId = receipt.inbound.eventId;
    try {
      receipt.inbound.eventId = `forged-returned-object-${randomUUID()}`;
      await assert.rejects(async () => provider.verify(duplicate.execute, receipt));
    } finally {
      receipt.inbound.eventId = originalEventId;
    }
    const verified = await verify(duplicate.execute, receipt);
    assert.deepEqual(checkObservation(verified, duplicate.execute, receipt), duplicateResult.observation);
  });

  await t.test("rejects reused perform requests instead of replaying a prior receipt or sending again", async () => {
    await assert.rejects(async () => provider.perform(duplicate.execute));
    await assert.rejects(async () => provider.perform({
      ...duplicate.execute, scope: { ...scope }, signal: new AbortController().signal,
    }));
    const verified = await verify(duplicate.execute, duplicateResult.receipt);
    assert.deepEqual(checkObservation(verified, duplicate.execute, duplicateResult.receipt),
      duplicateResult.observation);
  });

  await t.test("a distinct duplicate case before the fault has independent ingress, native and reply IDs", async () => {
    assert.notEqual(continued.execute.caseId, reconnect.execute.caseId);
    assert.notEqual(continued.execute.challenge, reconnect.execute.challenge);
    assert.notEqual(continued.execute.promptSha256, reconnect.execute.promptSha256);
    assert.equal(continued.execute.runId, reconnect.execute.runId);
    assert.deepEqual(continued.execute.scope, reconnect.execute.scope);
    await prepare(continued);
    continuedResult = await perform(continued);
    const observations = [duplicateResult, continuedResult].map((result) => result.observation);
    for (const key of ["inboundEventId", "inboundMessageId"]) {
      assert.equal(new Set(observations.map((observation) => observation[key])).size, 2,
        `independent cases must have distinct ${key}`);
    }
    assert.equal(new Set(observations.map((observation) => observation.runIds[0])).size, 2);
    assert.equal(new Set(observations.map((observation) => observation.terminalReplyIds[0])).size, 2);
  });

  await t.test("accepted reply with lost ACK reconnects an owned socket without retrying the send", async () => {
    await prepare(reconnect);
    reconnectResult = await perform(reconnect);
    await rejectForgedReceipts(reconnect.execute, reconnectResult.receipt);
    await rejectAlteredBindings(reconnect.execute, reconnectResult.receipt);
  });

  await t.test("unknown ACK fences new cases without ingress, inference or clearing previous evidence", async () => {
    const next = newCase("duplicate-replay", "after-unknown");
    const journalPath = join(provider.evidenceRoot, "operations.jsonl");
    const before = await readFile(journalPath, "utf8");
    await assert.rejects(() => provider.prepare(next.prepare), /settlement is unconfirmed/u);
    await assert.rejects(() => provider.perform(next.execute), /settlement is unconfirmed/u);
    assert.equal(await readFile(journalPath, "utf8"), before);
  });

  await t.test("rereading the unknown-ACK receipt after a blocked new case finds no late retry or changed evidence", async () => {
    await assert.rejects(async () => provider.verify(continued.execute, structuredClone(reconnectResult.receipt)));
    await assert.rejects(async () => provider.perform(reconnect.execute));
    const verified = await verify(reconnect.execute, reconnectResult.receipt);
    assert.deepEqual(checkObservation(verified, reconnect.execute, reconnectResult.receipt),
      reconnectResult.observation);
    const initial = await verify(duplicate.execute, duplicateResult.receipt);
    assert.deepEqual(checkObservation(initial, duplicate.execute, duplicateResult.receipt),
      duplicateResult.observation);
    const latest = await verify(continued.execute, continuedResult.receipt);
    assert.deepEqual(checkObservation(latest, continued.execute, continuedResult.receipt),
      continuedResult.observation);
  });

  await t.test("the acceptance adapter invokes and verifies real isolated controls without live certification", async () => {
    const { createFeishuAcceptanceAdapter } = await import("../scripts/lib/feishu-acceptance-adapter.mjs");
    await provider.close();
    const adapterScope = Object.fromEntries(Object.entries(scope).map(([key, value]) =>
      [key, key === "channel" ? value : `${value}-adapter`]));
    const adapterProvider = await createIsolatedSdkTransportProvider({
      scope: adapterScope, outputText, timeoutMs: 180000,
    });
    t.after(() => adapterProvider.close());
    {
      const scope = adapterScope;
      const provider = adapterProvider;
      const epoch = provider.capabilities.epoch;
      const runDir = join(provider.evidenceRoot, `adapter-${randomUUID()}`);
      await mkdir(runDir, { recursive: true });
      const chatLedgerPath = join(runDir, "ledger.json");
      await writeFile(chatLedgerPath, JSON.stringify({ chats: { [scope.agentId]: {
        chatId: scope.chatId, botAppId: "isolated-app", botMemberId: "isolated-bot", creatorMemberId: "isolated-user",
      } } }));
      const adapter = await createFeishuAcceptanceAdapter({
        config: { hostRoot: resolve("."), configPath: join(runDir, "unused-config.json"), stateDir: runDir,
          nativeStateDir: runDir, larkCli: join(runDir, "must-not-be-executed.exe"), chatLedgerPath,
          logicalAgentMap: { "dsh-assistant": scope.agentId } },
        deps: {},
        execFile: async () => { throw new Error("Isolated controls must not invoke Feishu"); },
        gatewayAdapter: { executeCase: async () => { throw new Error("No Gateway substitute"); } },
        transportControls: { testOnly: true, provider, scope, epoch, evidenceClass: "isolated-sdk" },
      });
      const usage = [];
      const context = { runId: randomUUID(), runDir, signal: new AbortController().signal,
        reportUsage: (value) => usage.push(value) };
      const cardCase = { id: randomUUID(), category: "delivery", agentProfile: "dsh-assistant",
        prompt: "Do not deliver: no card transport exists",
        adapterControls: [{ type: "reconnect-card", visibleToModel: false, prerequisiteGateBeforeDelivery: true }] };
      const card = await adapter.executeCase(cardCase, context);
      assert.equal(card.executionStatus, "infrastructure_blocked");
      assert.match(JSON.stringify(card), /Missing backend capability: card-fallback/u);
      assert.equal(card.usage.modelRequests, 0);
      assert.equal((await adapter.cleanupCase(cardCase, context)).cleaned, true);
      for (const type of ["duplicate-replay", "duplicate-replay", "reconnect-ack"]) {
        const testCase = { id: randomUUID(), category: "delivery", agentProfile: "dsh-assistant",
          prompt: `Original adapter prompt ${randomUUID()}`,
          adapterControls: [{ type, visibleToModel: false, prerequisiteGateBeforeDelivery: true }] };
        const result = await adapter.executeCase(testCase, context);
        assert.equal(result.executionStatus, "completed", JSON.stringify(result));
        assert.equal(result.evidenceClass, "isolated-sdk");
        assert.equal(result.channelCertified, false);
        assert.equal(result.controlReceipts[0].transportControlled, true);
        assert.equal(result.controlReceipts[0].channelCertified, false);
        assert.equal(result.policyFacts.actualReadbackReceipt, false);
        assert.equal(result.delivery.transport, "isolated-sdk");
        assert.equal(result.delivery.acknowledgement, type === "reconnect-ack" ? "unknown" : "received");
        assert.equal(result.delivery.delivered, type !== "reconnect-ack");
        assert.equal(result.delivery.terminalOutputs, 1);
        assert.equal(result.usage.modelRequests, 1);
        assert.equal(result.usage.userTurns, 1);
        assert.equal((await adapter.cleanupCase(testCase, context)).cleaned, true);
      }
      const fenced = await adapter.executeCase({ ...cardCase, id: randomUUID(),
        adapterControls: [{ type: "duplicate-replay", visibleToModel: false, prerequisiteGateBeforeDelivery: true }] }, context);
      assert.equal(fenced.executionStatus, "infrastructure_blocked");
      assert.equal(fenced.usage.modelRequests, 0);
      assert.equal(usage.filter((entry) => entry.modelRequests > 0).length, 3);
      await adapter.close();
      await provider.close();
    }
  });

  await t.test("close waits for actual worker termination and prevents every further callback", async () => {
    await provider.close();
    await provider.close();
    const journalPath = join(provider.evidenceRoot, "operations.jsonl");
    const closedJournal = await readFile(journalPath, "utf8");
    const rows = closedJournal.trim().split("\n").map(JSON.parse);
    assert.deepEqual(rows.findLast((row) => row.kind === "harnesses-disposed").statuses.map((entry) => entry.status),
      ["fulfilled"]);
    const workerClosed = rows.filter((row) => row.kind === "worker-closed");
    assert.equal(workerClosed.length, 1);
    assert.equal(workerClosed[0].code, 0);
    assert.equal(workerClosed[0].signal, null);
    assert.deepEqual(rows.at(-1).errors, []);
    assert.equal(rows.at(-1).kind, "provider-closed");
    await assert.rejects(() => provider.prepare(newCase("duplicate-replay", "after-close").prepare), /closed/u);
    await assert.rejects(() => provider.perform(continued.execute), /closed/u);
    await assert.rejects(() => provider.verify(continued.execute, continuedResult.receipt), /closed/u);
    assert.equal(await readFile(journalPath, "utf8"), closedJournal);
  });
});

test("genuine SDK preparation and final requests share one native owner through controls and adapter", {
  skip: process.platform !== "linux"
    ? "Linux-only: the genuine Windows SDK queries process start via forbidden spawnSync; exec remains denied"
    : process.env.DSH_RUN_ISOLATED_SDK_TRANSPORT !== "1" && "Set DSH_RUN_ISOLATED_SDK_TRANSPORT=1 in a private Linux stage",
  timeout: 300000,
}, async (t) => {
  const { createIsolatedSdkTransportProvider } = await import("./fixtures/feishu-isolated-sdk-transport.mjs");
  const { createFeishuAcceptanceAdapter } = await import("../scripts/lib/feishu-acceptance-adapter.mjs");
  const suffix = randomUUID();
  const scope = { agentId: `prep-${suffix}`, chatId: `chat-${suffix}`, accountId: `prep-${suffix}`, channel: "feishu" };
  const outputText = `PREPARED-ISOLATED-TEXT-${suffix}`;
  const provider = await createIsolatedSdkTransportProvider({ scope, outputText, taskPreparation: true });
  t.after(() => provider.close());
  const runDir = join(provider.evidenceRoot, "adapter");
  await mkdir(runDir);
  const chatLedgerPath = join(runDir, "ledger.json");
  await writeFile(chatLedgerPath, JSON.stringify({ chats: { [scope.agentId]: {
    chatId: scope.chatId, botAppId: "isolated-app", botMemberId: "isolated-bot", creatorMemberId: "isolated-user",
  } } }));
  const adapter = await createFeishuAcceptanceAdapter({
    config: { hostRoot: resolve("."), configPath: join(runDir, "unused-config.json"), stateDir: runDir,
      nativeStateDir: runDir, larkCli: join(runDir, "must-not-be-executed.exe"), chatLedgerPath,
      logicalAgentMap: { "dsh-assistant": scope.agentId } },
    deps: {},
    execFile: async () => { throw new Error("Preparation controls must not invoke Feishu"); },
    gatewayAdapter: { executeCase: async () => { throw new Error("No Gateway substitute"); } },
    transportControls: { testOnly: true, provider, scope, epoch: provider.capabilities.epoch, evidenceClass: "isolated-sdk" },
  });
  t.after(() => adapter.close());
  const reportedUsage = [];
  const context = { runId: `controller-${suffix}`, runDir, signal: new AbortController().signal,
    reportUsage: (value) => reportedUsage.push(value) };
  const testCase = { id: `preparation-${suffix}`, category: "delivery", agentProfile: "dsh-assistant",
    prompt: `Draft one text reply for ${suffix}. Read-only; no host tools or file changes. UTF-8: 准备 🧪`,
    adapterControls: [{ type: "duplicate-replay", visibleToModel: false, prerequisiteGateBeforeDelivery: true }] };
  const result = await adapter.executeCase(testCase, context);
  assert.equal(result.executionStatus, "completed", JSON.stringify(result));
  assert.equal(result.evidenceClass, "isolated-sdk");
  assert.equal(result.channelCertified, false);
  assert.equal(result.policyFacts.actualReadbackReceipt, false);
  assert.equal(result.controlReceipts.length, 1);
  assert.equal(result.controlReceipts[0].transportControlled, true);
  assert.equal(result.controlReceipts[0].channelCertified, false);
  assert.equal(result.delivery.transport, "isolated-sdk");
  assert.equal(result.delivery.acknowledgement, "received");
  assert.equal(result.delivery.delivered, true);
  assert.equal(result.delivery.terminalOutputs, 1);
  assert.equal(result.outputText, outputText, "Preparation control JSON must not leak into the accepted reply");
  assert.deepEqual(result.sideEffects, []);
  assert.deepEqual(result.usage, {
    modelRequests: 2, inputTokens: 40, outputTokens: 16, cacheReadTokens: 4, cacheWriteTokens: 0,
    toolCalls: 0, userTurns: 1, priced: false,
  });
  assert.deepEqual(reportedUsage.filter((value) => value.modelRequests > 0), [result.usage]);

  const journalPath = join(provider.evidenceRoot, "operations.jsonl");
  const readRows = async () => (await readFile(journalPath, "utf8")).trim().split("\n").map(JSON.parse);
  const rows = await readRows();
  const of = (kind) => rows.filter((row) => row.kind === kind);
  const requests = of("model-request");
  const completions = of("model-response-ended");
  const verified = of("verification").findLast((row) => row.operation === "execute");
  assert.ok(verified);
  const observation = verified.observation;
  const issued = of("issued-receipt").find((row) => row.receipt.receiptId === verified.verifiedReceiptId).receipt;
  assert.equal(result.controlReceipts[0].receiptId, issued.receiptId);
  assert.equal(result.controlReceipts[0].verificationId, verified.verificationId);
  assert.equal(observation.modelRequests, 2);
  assert.deepEqual(observation.usage, result.usage);
  assert.equal(observation.runIds.length, 1);
  const [nativeRunId] = observation.runIds;
  assert.notEqual(nativeRunId, context.runId);
  assert.equal(result.turns[0].runId, nativeRunId);
  assert.equal(of("native-start").length, 1);
  assert.equal(of("native-end").length, 1);
  assert.equal(of("native-end")[0].terminal, "ok");
  assert.equal(of("native-end")[0].outputDelivered, true);
  assert.equal(of("native-error").length, 0);
  assert.equal(of("execution-settled").length, 1);
  assert.equal(observation.quiescent, true);
  assert.equal(requests.length, 2);
  assert.equal(completions.length, 2);
  assert.deepEqual(requests.map((row) => row.phase), ["preparation", "final"]);
  assert.equal(new Set(requests.map((row) => row.requestId)).size, 2);
  assert.deepEqual(observation.modelRequestIds, requests.map((row) => row.requestId));
  assert.deepEqual(observation.modelRequestEvidence, requests.map(({ requestId, ingressId, eventId, messageId, runId }) =>
    ({ requestId, ingressId, eventId, messageId, runId })));
  for (const request of requests) {
    assert.equal(request.bodySha256, sha256(JSON.stringify(request.body)));
    assert.equal(request.callbackId, issued.callbackId);
    assert.equal(request.runId, nativeRunId);
    assert.equal(request.eventId, issued.inbound.eventId);
    assert.equal(request.messageId, issued.inbound.messageId);
    assert.equal(request.ingressId, observation.ingressEvidence[0].ingressId);
    const ended = completions.filter((row) => row.requestId === request.requestId);
    assert.equal(ended.length, 1, "Every physical request has exactly one usage-bearing completion");
    for (const key of ["callbackId", "runId", "ingressId", "eventId", "messageId", "phase"]) {
      assert.equal(ended[0][key], request[key]);
    }
    assert.ok(of("native-start")[0].sequence < request.sequence && request.sequence < ended[0].sequence &&
      ended[0].sequence < of("native-end")[0].sequence);
  }
  assert.ok(completions[0].sequence < requests[1].sequence, "Preparation completes before final inference");
  const [preparation, final] = requests.map((row) => row.body);
  assert.deepEqual(preparation.tools.map((tool) => tool.name), ["dsh_prepare_task"]);
  assert.deepEqual(final.tools ?? [], []);
  const calls = final.input.filter((entry) => entry.type === "function_call");
  const outputs = final.input.filter((entry) => entry.type === "function_call_output");
  assert.equal(calls.length, 1, "Only the internal preparation control, never a host business tool");
  assert.equal(calls[0].name, "dsh_prepare_task");
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].call_id, calls[0].call_id);
  const resolution = JSON.parse(outputs[0].output);
  assert.deepEqual(resolution.decision, JSON.parse(calls[0].arguments));
  assert.equal(resolution.decision.mode, "draft");
  assert.equal(resolution.state.sourceRunId, nativeRunId);
  assert.equal(resolution.state.requestText, testCase.prompt);
  assert.deepEqual(resolution.allowedTools, []);
  const ingresses = of("sdk-ingest");
  assert.equal(ingresses.length, 2);
  assert.equal(ingresses[0].canonicalSha256, ingresses[1].canonicalSha256);
  assert.deepEqual(observation.ingressEvidence.map((entry) =>
    [entry.kind, entry.modelRequestsBefore, entry.modelRequestsAfter, entry.modelRequestIds]),
  [["ingress", 0, 2, observation.modelRequestIds], ["redeliver", 2, 2, []]]);
  assert.equal(of("sdk-message-received").length, 1);
  assert.equal(of("send-attempt").length, 1);
  assert.equal(of("server-accepted").length, 1);
  assert.equal(of("server-accepted")[0].text, outputText);
  assert.deepEqual(observation.terminalReplyIds, [of("server-accepted")[0].replyId]);
  assert.equal(of("ack-received").length, 1);

  const request = Object.fromEntries(["providerId", "evidenceClass", "epoch", "scope", "caseId", "runId",
    "type", "challenge", "promptSha256", "operation"].map((key) => [key, issued[key]]));
  assert.deepEqual((await provider.verify(request, structuredClone(issued))).observation, observation);
  assert.equal((await adapter.cleanupCase(testCase, context)).cleaned, true);
  await adapter.close();
  await provider.close();
  const closedJournal = await readFile(journalPath, "utf8");
  const closed = await readRows();
  assert.equal(closed.filter((row) => row.kind === "model-request").length, 2, "No late inference on verification or close");
  assert.deepEqual(closed.findLast((row) => row.kind === "harnesses-disposed").statuses.map((entry) => entry.status),
    ["fulfilled"]);
  assert.equal(closed.findLast((row) => row.kind === "native-children-settled").remaining, 0);
  assert.ok(closed.filter((row) => row.kind === "native-child-closed").every((row) => !row.forced));
  const workers = closed.filter((row) => row.kind === "worker-closed");
  assert.equal(workers.length, 1);
  assert.equal(workers[0].code, 0);
  assert.equal(workers[0].signal, null);
  assert.equal(closed.at(-1).kind, "provider-closed");
  assert.deepEqual(closed.at(-1).errors, []);
  await provider.close();
  await assert.rejects(() => provider.verify(request, issued), /closed/u);
  assert.equal(await readFile(journalPath, "utf8"), closedJournal);
  await writeFile(join(runDir, "two-call-result.json"), JSON.stringify({
    result, observation, requestBodyPhases: requests.map(({ requestId, phase, bodySha256 }) => ({ requestId, phase, bodySha256 })),
    closeConfirmed: true, remainingNativeChildren: 0,
  }, null, 2));
});
