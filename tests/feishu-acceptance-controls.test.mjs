import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { FEISHU_CONTROL_CONTRACT, createFeishuAcceptanceControls } from "../scripts/lib/feishu-acceptance-controls.mjs";
import { controlProviderDouble } from "./fixtures/feishu-control-provider.mjs";

const cardOperations = ["ingress-redelivery", "accepted-lost-ack", "owned-socket-reconnect", "card-fallback"];
const input = (extra = {}) => ({ caseId: randomUUID(), runId: "acceptance-run", type: "duplicate-replay",
  prompt: "Original 飞书 🧪\ntext", ...extra });
async function execute(f, values = {}) {
  const controls = f.controls ??= createFeishuAcceptanceControls(f.host);
  const ticket = await controls.prepare(input(values));
  return controls.execute(ticket);
}

test("default deny requires explicit host opt-in, exact ownership and callable verification", () => {
  assert.throws(() => createFeishuAcceptanceControls(), /opt-in/);
  assert.throws(() => createFeishuAcceptanceControls({ testOnly: true }), /backend/);
  for (const mutate of [
    (host) => { host.provider.verify = true; },
    (host) => { host.provider.capabilities.dedicated = false; },
    (host) => { host.epoch = "stale"; },
    (host) => { host.evidenceClass = "actual-feishu"; },
  ]) {
    const f = controlProviderDouble();
    mutate(f.host);
    assert.throws(() => createFeishuAcceptanceControls(f.host));
    assert.equal(f.calls.length, 0);
  }
});

test("contract exports phase-specific receipt and verification fields", () => {
  assert.deepEqual(FEISHU_CONTROL_CONTRACT.receiptFields, {
    prepare: ["receiptId", "callbackId", "readyOperations"],
    execute: ["receiptId", "callbackId", "inbound", "operations"],
  });
  assert.deepEqual(FEISHU_CONTROL_CONTRACT.verificationFields, {
    prepare: ["verifiedReceiptId", "verificationId", "callbackId"],
    execute: ["verifiedReceiptId", "verificationId", "callbackId", "observation"],
  });
});

for (const key of ["agentId", "chatId", "channel", "accountId"]) {
  test(`rejects wrong ${key} before preparing or sending`, async () => {
    const f = controlProviderDouble();
    const controls = createFeishuAcceptanceControls(f.host);
    await assert.rejects(controls.prepare(input({ scope: { ...f.host.scope, [key]: "foreign" } })), /Foreign scope/);
    assert.equal(f.calls.length, 0);
  });
}

test("rejects arbitrary targets and missing backend operations before ingress", async () => {
  const f = controlProviderDouble();
  const controls = createFeishuAcceptanceControls(f.host);
  await assert.rejects(controls.prepare(input({ scope: { ...f.host.scope, target: "other-chat" } })), /exact/);
  assert.equal(f.calls.length, 0);
  f.provider.capabilities.operations = ["send-idempotency"];
  const noReplay = createFeishuAcceptanceControls(f.host);
  await assert.rejects(noReplay.prepare(input()), /ingress-redelivery/);
  assert.equal(f.calls.length, 0);
});

test("stale epoch after prepare cannot invoke actual fault operation", async () => {
  const f = controlProviderDouble();
  const controls = createFeishuAcceptanceControls(f.host);
  const ticket = await controls.prepare(input());
  f.provider.capabilities.epoch = "restarted-backend";
  await assert.rejects(controls.execute(ticket), /Stale provider epoch/);
  assert.equal(f.calls.filter((call) => call.kind === "perform").length, 0);
});

test("requires independent verification callback instead of transportControlled boolean", async () => {
  for (const bad of [true, { transportControlled: true }, { selfAsserted: false, receiptId: "fake" }]) {
    const f = controlProviderDouble();
    f.provider.prepare = async () => bad;
    await assert.rejects(execute(f));
    assert.equal(f.calls.filter((call) => call.kind === "perform").length, 0);
  }
  const f = controlProviderDouble();
  f.provider.verify = async () => ({ verified: true });
  await assert.rejects(execute(f), /Unbound receipt/);
  assert.equal(f.calls.filter((call) => call.kind === "perform").length, 0);
});

test("receipt must be attested to the same challenge, epoch, callback and operation", async () => {
  for (const key of ["scope", "challenge", "epoch", "operation", "verifiedReceiptId", "callbackId"]) {
    const f = controlProviderDouble();
    const verify = f.provider.verify;
    f.provider.verify = async (...args) => ({ ...await verify(...args), [key]: "forged" });
    await assert.rejects(execute(f));
    assert.equal(f.calls.filter((call) => call.kind === "perform").length, 0);
  }
});

test("exact replay is attested once and cannot be re-executed", async () => {
  const f = controlProviderDouble();
  const controls = createFeishuAcceptanceControls(f.host);
  const request = input();
  const ticket = await controls.prepare(request);
  const result = await controls.execute(ticket);
  assert.equal(result.evidenceClass, "isolated-sdk");
  assert.equal(result.receipt.channelCertified, false);
  assert.equal(result.receipt.transportControlled, true);
  assert.equal(result.receipt.selfAsserted, false);
  assert.deepEqual(result.receipt.operations.map((op) => op.kind), ["ingress", "redeliver"]);
  assert.equal(result.receipt.operations[0].eventId, result.receipt.operations[1].eventId);
  assert.equal(f.calls.filter((call) => call.kind === "verify").length, 2);
  await assert.rejects(controls.execute(ticket), /consumed/);
  await assert.rejects(controls.execute({}), /Invalid/);
  await assert.rejects(controls.prepare(request), /automatically replayed/);
  assert.equal(f.calls.filter((call) => call.kind === "perform").length, 1);
});

test("canonical event-ID collisions across cases are rejected, not accepted as replay", async () => {
  const f = controlProviderDouble({
    changeReceipt: (receipt) => {
      if (receipt.inbound) {
        receipt.inbound.eventId = "colliding-event";
        for (const op of receipt.operations) op.eventId = "colliding-event";
      }
      return receipt;
    },
    changeObservation: (value) => ({
      ...value,
      inboundEventId: "colliding-event",
      ingressEvidence: value.ingressEvidence.map((entry) => ({ ...entry, eventId: "colliding-event" })),
      modelRequestEvidence: value.modelRequestEvidence.map((entry) => ({ ...entry, eventId: "colliding-event" })),
    }),
  });
  await execute(f);
  await assert.rejects(execute(f), /collision/);
});

test("unique receipt and callback IDs cannot be recycled across phases", async () => {
  for (const key of ["receiptId", "callbackId"]) {
    const f = controlProviderDouble({ changeReceipt: (receipt) => ({ ...receipt, [key]: "recycled" }) });
    await assert.rejects(execute(f), new RegExp(`Reused ${key}`));
  }
  const f = controlProviderDouble();
  const verify = f.provider.verify;
  f.provider.verify = async (...args) => ({ ...await verify(...args), verificationId: "recycled" });
  await assert.rejects(execute(f), /Reused verificationId/);
});

test("wrong event targets and send-idempotency substitutes cannot satisfy a replay", async () => {
  for (const change of [
    (receipt) => { receipt.operations[1].eventId = "arbitrary-target"; },
    (receipt) => { receipt.operations[1].messageId = "second-user-message"; },
    (receipt) => { receipt.operations[1].kind = "send-idempotency"; },
  ]) {
    const f = controlProviderDouble({ changeReceipt: (receipt) => {
      if (receipt.inbound) change(receipt);
      return receipt;
    } });
    await assert.rejects(execute(f));
  }
});

test("observed native/model/reply/receipt counts are assertions, never a hardcoded pass", async () => {
  for (const change of [
    { runIds: [] }, { runIds: ["one", "two"] }, { runIds: ["acceptance-run"] },
    { modelRequests: 33 }, { terminalReplyIds: [] }, { terminalReplyIds: ["one", "two"] },
    { sendAttempts: 2 }, { ingressCount: 1 }, { quiescent: false },
    { delivery: { receiptId: "unbound", acknowledgement: "received" } },
  ]) {
    const f = controlProviderDouble({ changeObservation: (value) => ({ ...value, ...change }) });
    await assert.rejects(execute(f));
  }
});

test("verified prep+final model requests are accepted when causally attributed to the original ingress", async () => {
  const f = controlProviderDouble({ changeObservation: (value) => {
    const requestIds = [randomUUID(), randomUUID()];
    const [ingress, replay] = value.ingressEvidence;
    return {
      ...value,
      modelRequests: 2,
      modelRequestIds: requestIds,
      ingressEvidence: [
        { ...ingress, modelRequestsAfter: 2, modelRequestIds: requestIds },
        { ...replay, modelRequestsBefore: 2, modelRequestsAfter: 2, modelRequestIds: [] },
      ],
      modelRequestEvidence: requestIds.map((requestId) => ({
        requestId, ingressId: ingress.ingressId, eventId: value.inboundEventId,
        messageId: value.inboundMessageId, runId: value.runIds[0],
      })),
      usage: { ...value.usage, modelRequests: 2 },
    };
  } });
  const result = await execute(f);
  assert.equal(result.observation.modelRequests, 2);
  assert.deepEqual(result.observation.ingressEvidence.map((entry) => entry.modelRequestIds.length), [2, 0]);
});

test("replay evidence must not attribute fresh model requests", async () => {
  const f = controlProviderDouble({ changeObservation: (value) => {
    const requestIds = [randomUUID(), randomUUID()];
    const [ingress, replay] = value.ingressEvidence;
    return {
      ...value,
      modelRequests: 2,
      modelRequestIds: requestIds,
      ingressEvidence: [
        { ...ingress, modelRequestsAfter: 2, modelRequestIds: requestIds },
        { ...replay, modelRequestsBefore: 0, modelRequestsAfter: 2, modelRequestIds: requestIds },
      ],
      modelRequestEvidence: requestIds.map((requestId) => ({
        requestId, ingressId: ingress.ingressId, eventId: value.inboundEventId,
        messageId: value.inboundMessageId, runId: value.runIds[0],
      })),
      usage: { ...value.usage, modelRequests: 2 },
    };
  } });
  await assert.rejects(execute(f), /Redelivery must add exactly zero model requests/);
});

test("forged or unattributed model request evidence is rejected", async () => {
  for (const changeObservation of [
    (value) => ({ ...value, modelRequestIds: [...value.modelRequestIds, randomUUID()], usage: { ...value.usage, modelRequests: 2 } }),
    (value) => ({ ...value, modelRequestEvidence: [{ ...value.modelRequestEvidence[0], requestId: randomUUID() }] }),
    (value) => ({ ...value, modelRequestEvidence: [{ ...value.modelRequestEvidence[0], ingressId: value.ingressEvidence.at(-1).ingressId }] }),
  ]) {
    const f = controlProviderDouble({ changeObservation });
    await assert.rejects(execute(f));
  }
});

test("model request IDs cannot be reused across cases", async () => {
  const reused = "shared-request-id";
  const f = controlProviderDouble({ changeObservation: (value) => {
    const ingress = value.ingressEvidence[0];
    return {
      ...value,
      modelRequestIds: [reused],
      ingressEvidence: [{ ...ingress, modelRequestIds: [reused] }, value.ingressEvidence[1]],
      modelRequestEvidence: [{
        requestId: reused, ingressId: ingress.ingressId, eventId: value.inboundEventId,
        messageId: value.inboundMessageId, runId: value.runIds[0],
      }],
    };
  } });
  await execute(f);
  await assert.rejects(execute(f), /model requestId \(collision\)/);
});

test("verified model request counts are capped and usage totals must match", async () => {
  const capped = controlProviderDouble({ changeObservation: (value) => {
    const requestIds = Array.from({ length: 33 }, () => randomUUID());
    const ingress = value.ingressEvidence[0];
    return {
      ...value,
      modelRequests: requestIds.length,
      modelRequestIds: requestIds,
      ingressEvidence: [{ ...ingress, modelRequestsAfter: requestIds.length, modelRequestIds: requestIds }, value.ingressEvidence[1]],
      modelRequestEvidence: requestIds.map((requestId) => ({
        requestId, ingressId: ingress.ingressId, eventId: value.inboundEventId,
        messageId: value.inboundMessageId, runId: value.runIds[0],
      })),
      usage: { ...value.usage, modelRequests: requestIds.length },
    };
  } });
  await assert.rejects(execute(capped), /1\.\.32/);
  const mismatched = controlProviderDouble({ changeObservation: (value) => ({ ...value, usage: { ...value.usage, modelRequests: value.modelRequests + 1 } }) });
  await assert.rejects(execute(mismatched), /usage\.modelRequests/);
});

test("unknown ACK is preserved without resend and fences the scope for later requests", async () => {
  const f = controlProviderDouble();
  const lost = await execute(f, { type: "reconnect-ack" });
  assert.equal(lost.observation.delivery.acknowledgement, "unknown");
  assert.equal(lost.observation.sendAttempts, 1);
  const prepareCalls = f.calls.filter((call) => call.kind === "prepare").length;
  const performCalls = f.calls.filter((call) => call.kind === "perform").length;
  const verifyCalls = f.calls.filter((call) => call.kind === "verify").length;
  await assert.rejects(() => execute(f), /Previous source reply settlement is unconfirmed/);
  assert.equal(f.calls.filter((call) => call.kind === "prepare").length, prepareCalls);
  assert.equal(f.calls.filter((call) => call.kind === "perform").length, performCalls);
  assert.equal(f.calls.filter((call) => call.kind === "verify").length, verifyCalls);
});

test("reconnect-card explicitly advertised fallback can fill fake card evidence", async () => {
  const f = controlProviderDouble({ operations: cardOperations });
  const result = await execute(f, { type: "reconnect-card" });
  assert.deepEqual(result.receipt.operations.map((op) => op.kind),
    ["ingress", "accepted-lost-ack", "owned-socket-reconnect", "card-fallback"]);
  assert.equal(result.receipt.operations[1].replyId, result.observation.delivery.receiptId);
  assert.equal(result.receipt.operations[3].replyId, result.observation.delivery.receiptId);
  assert.equal(result.observation.outputText, "已收到重连测试-19");
});

test("reconnect requires lost-ACK acceptance receipt and a different owned socket", async () => {
  for (const change of [
    (receipt) => { receipt.operations[1].replyId = "unaccepted"; },
    (receipt) => { receipt.operations[2].ownerId = "shared-gateway"; },
    (receipt) => { receipt.operations[2].connectionId = receipt.operations[2].previousConnectionId; },
  ]) {
    const f = controlProviderDouble({ operations: cardOperations, changeReceipt: (receipt) => {
      if (receipt.inbound) change(receipt);
      return receipt;
    } });
    await assert.rejects(execute(f, { type: "reconnect-card" }));
  }
});

test("reconnect-card rejects forged fallback reply binding and missing fallback evidence", async () => {
  const wrongReply = controlProviderDouble({ operations: cardOperations, changeReceipt: (receipt) => {
    if (receipt.inbound) receipt.operations[3].replyId = "forged-card-reply";
    return receipt;
  } });
  await assert.rejects(execute(wrongReply, { type: "reconnect-card" }), /Card fallback is not tied to accepted delivery/);
  const missingFallback = controlProviderDouble({ operations: cardOperations, changeReceipt: (receipt) => {
    if (receipt.inbound) receipt.operations = receipt.operations.filter((operation) => operation.kind !== "card-fallback");
    return receipt;
  } });
  await assert.rejects(execute(missingFallback, { type: "reconnect-card" }), /Actual transport operations are required/);
});

test("watch timeout consumes the ticket, aborts callback and never retries uncertain work", async () => {
  let signal;
  const f = controlProviderDouble({ perform: (request) => {
    signal = request.signal;
    return new Promise(() => {});
  } });
  f.host.timeoutMs = 30;
  const controls = createFeishuAcceptanceControls(f.host);
  const ticket = await controls.prepare(input());
  await assert.rejects(controls.execute(ticket), /timeout.*never resend/);
  assert.equal(signal.aborted, true);
  await assert.rejects(controls.execute(ticket), /unconfirmed/);
  await assert.rejects(controls.prepare(input()), /unconfirmed/);
  assert.equal(f.calls.filter((call) => call.kind === "perform").length, 1);
});

test("pre-aborted execution cannot reach backend", async () => {
  const f = controlProviderDouble();
  const controls = createFeishuAcceptanceControls(f.host);
  const ticket = await controls.prepare(input());
  await assert.rejects(controls.execute(ticket, { signal: AbortSignal.abort(new Error("cancelled")) }), /cancelled/);
  assert.equal(f.calls.filter((call) => call.kind === "perform").length, 0);
});
