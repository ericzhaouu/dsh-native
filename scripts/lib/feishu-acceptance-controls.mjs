import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const scopeKeys = ["accountId", "agentId", "channel", "chatId"];
const envelopeKeys = ["providerId", "evidenceClass", "epoch", "scope", "caseId", "runId",
  "type", "challenge", "promptSha256", "operation"];
const maxModelRequests = 32;
const unconfirmedSettlement = "Previous source reply settlement is unconfirmed";
export const FEISHU_CONTROL_CONTRACT = Object.freeze({
  version: 1,
  evidenceClasses: Object.freeze(["actual-feishu", "isolated-sdk"]),
  scopeKeys: Object.freeze(scopeKeys),
  envelopeKeys: Object.freeze(envelopeKeys),
  methods: Object.freeze(["prepare", "perform", "verify"]),
  receiptFields: Object.freeze({
    prepare: Object.freeze(["receiptId", "callbackId", "readyOperations"]),
    execute: Object.freeze(["receiptId", "callbackId", "inbound", "operations"]),
  }),
  verificationFields: Object.freeze({
    prepare: Object.freeze(["verifiedReceiptId", "verificationId", "callbackId"]),
    execute: Object.freeze(["verifiedReceiptId", "verificationId", "callbackId", "observation"]),
  }),
  observationFields: Object.freeze(["inboundEventId", "inboundMessageId", "bodySha256", "runIds",
    "modelRequests", "modelRequestIds", "modelRequestEvidence", "ingressEvidence", "terminalReplyIds",
    "delivery", "ingressCount", "sendAttempts", "quiescent", "outputText", "usage"]),
  operations: Object.freeze({
    "duplicate-replay": Object.freeze(["ingress-redelivery"]),
    "reconnect-ack": Object.freeze(["accepted-lost-ack", "owned-socket-reconnect"]),
    "reconnect-card": Object.freeze(["accepted-lost-ack", "owned-socket-reconnect", "card-fallback"]),
  }),
});
const digest = (text) => createHash("sha256").update(text).digest("hex");
const text = (value, name) => assert.ok(typeof value === "string" && value.trim().length > 0, `${name} is required`);

function exactScope(actual, expected) {
  assert.deepEqual(Object.keys(actual ?? {}).sort(), scopeKeys, "Only exact agent/chat/account/channel ownership is accepted");
  for (const key of scopeKeys) {
    text(actual[key], `scope.${key}`);
    assert.equal(actual[key], expected[key], `Foreign scope.${key}`);
  }
}

function envelope(value, request) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "A receipted operation is required, not a boolean");
  for (const key of envelopeKeys) assert.deepEqual(value[key], request[key], `Unbound receipt ${key}`);
}

// This is a host capability, not a JSON configuration or model tool. A connector's
// verify callback must independently reread its operation journal/platform receipts.
// No controller can authenticate a malicious in-process host supplying both callbacks.
// prepare: read-only readiness receipt, before any chat/model input.
// perform: one original ingress then exact redelivery, OR accept/drop ACK/reconnect
// on a dedicated owned socket. It must not retry a timed-out or unknown send.
// verify: a fresh challenge-bound attestation plus measured native/model/delivery
// counts after settlement. An actual-feishu provider additionally needs authorized
// platform ingress and fault access; the local SDK fixture cannot supply that proof.
export function createFeishuAcceptanceControls({
  testOnly = false, provider, scope, epoch, evidenceClass = "actual-feishu", timeoutMs = 240000,
} = {}) {
  assert.equal(testOnly, true, "Dedicated test-host opt-in is required");
  assert.ok(provider?.capabilities, "Missing receipted host/channel control backend capability");
  const capabilities = structuredClone(provider.capabilities);
  text(capabilities.id, "providerId");
  text(epoch, "epoch");
  exactScope(scope, capabilities.scope);
  exactScope(capabilities.scope, scope);
  assert.equal(capabilities.epoch, epoch, "Stale provider epoch");
  assert.equal(capabilities.dedicated, true, "Shared adapters/accounts cannot be fault controlled");
  assert.ok(FEISHU_CONTROL_CONTRACT.evidenceClasses.includes(evidenceClass), "Unsupported evidence class");
  assert.equal(capabilities.evidenceClass, evidenceClass, "Evidence class mismatch; isolated SDK is not actual Feishu");
  assert.ok(Array.isArray(capabilities.operations), "Missing backend operations");
  for (const method of FEISHU_CONTROL_CONTRACT.methods) {
    assert.equal(typeof provider[method], "function", `Backend must implement ${method} callback`);
  }
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000, "Invalid control timeout");
  const ownedScope = Object.freeze({ ...scope });
  const tickets = new WeakMap();
  const cases = new Set();
  const receipts = new Set();
  const callbacks = new Set();
  const verifications = new Set();
  const events = new Set();
  const messages = new Set();
  const nativeRuns = new Set();
  const replies = new Set();
  const modelRequestEvents = new Set();
  let uncertain = false;
  let active = false;

  function unique(value, seen, name) {
    text(value, name);
    assert.ok(!seen.has(value), `Reused ${name}`);
    seen.add(value);
  }
  function current() {
    assert.equal(provider.capabilities.epoch, epoch, "Stale provider epoch");
    assert.deepEqual(provider.capabilities, capabilities, "Provider capability changed after binding");
    assert.ok(!uncertain, `${unconfirmedSettlement}; a new provider epoch is required`);
  }
  async function bounded(action, signal) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    let timer;
    let rejectAbort;
    const aborted = new Promise((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
      timer = setTimeout(() => controller.abort(new Error("Control watch timeout; outcome unknown; never resend")), timeoutMs);
    });
    try { return await Promise.race([Promise.resolve().then(() => action(controller.signal)), aborted]); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", rejectAbort);
    }
  }
  async function checked(request, receipt, signal) {
    signal?.throwIfAborted();
    envelope(receipt, request);
    unique(receipt.receiptId, receipts, "receiptId");
    unique(receipt.callbackId, callbacks, "callbackId");
    const verified = await provider.verify({ ...request, signal }, structuredClone(receipt));
    signal?.throwIfAborted();
    envelope(verified, request);
    assert.equal(verified.verifiedReceiptId, receipt.receiptId, "Verification must attest this exact receipt");
    assert.equal(verified.callbackId, receipt.callbackId, "Verification callback provenance mismatch");
    unique(verified.verificationId, verifications, "verificationId");
    current();
    return verified;
  }
  function validateObservation(request, receipt, observed) {
    const inbound = receipt.inbound;
    text(inbound?.eventId, "canonical inbound eventId");
    text(inbound?.messageId, "canonical inbound messageId");
    assert.equal(inbound.bodySha256, request.promptSha256, "Inbound content changed");
    assert.ok(observed && typeof observed === "object", "Independent observation callback is required");
    assert.equal(observed.inboundEventId, inbound.eventId);
    assert.equal(observed.inboundMessageId, inbound.messageId);
    assert.equal(observed.bodySha256, request.promptSha256);
    unique(inbound.eventId, events, "inbound eventId (collision)");
    unique(inbound.messageId, messages, "inbound messageId (collision)");
    assert.ok(Array.isArray(observed.runIds), "Native run IDs must be an observed array");
    assert.equal(observed.runIds.length, 1, "Expected exactly one observed native run");
    unique(observed.runIds[0], nativeRuns, "native runId");
    assert.notEqual(observed.runIds[0], request.runId, "Controller runId is not native run evidence");
    assert.ok(Number.isSafeInteger(observed.modelRequests) && observed.modelRequests > 0 &&
      observed.modelRequests <= maxModelRequests, `Observed model requests must be within 1..${maxModelRequests}`);
    assert.ok(Array.isArray(observed.modelRequestIds), "Model request IDs must be an observed array");
    assert.equal(observed.modelRequestIds.length, observed.modelRequests, "Model request IDs must exactly cover observed requests");
    const requestIds = new Set();
    for (const requestId of observed.modelRequestIds) {
      unique(requestId, requestIds, "model requestId");
      unique(requestId, modelRequestEvents, "model requestId (collision)");
    }
    assert.ok(Array.isArray(observed.ingressEvidence), "Ingress evidence must be an observed array");
    assert.ok(Array.isArray(observed.modelRequestEvidence), "Model request evidence must be an observed array");
    assert.ok(Array.isArray(observed.terminalReplyIds), "Terminal reply IDs must be an observed array");
    assert.equal(observed.terminalReplyIds.length, 1, "Expected exactly one terminal reply");
    unique(observed.terminalReplyIds[0], replies, "terminal replyId");
    assert.equal(observed.delivery?.receiptId, observed.terminalReplyIds[0], "Missing terminal delivery receipt");
    assert.equal(observed.sendAttempts, 1, "Unknown acknowledgement must not cause an automatic resend");
    assert.equal(observed.quiescent, true, "Verification must await settled runtime/transport activity");
    assert.equal(typeof observed.outputText, "string");
    assert.ok(observed.usage && typeof observed.usage === "object" && !Array.isArray(observed.usage), "Observed usage is required");
    assert.equal(observed.usage.modelRequests, observed.modelRequests, "usage.modelRequests must equal the verified total");
    const duplicate = request.type === "duplicate-replay";
    assert.equal(observed.ingressCount, duplicate ? 2 : 1, "Replay must redeliver, never create two user messages");
    assert.equal(observed.delivery.acknowledgement, duplicate ? "received" : "unknown");
    const names = duplicate ? ["ingress", "redeliver"] : ["ingress", ...FEISHU_CONTROL_CONTRACT.operations[request.type]];
    assert.deepEqual(receipt.operations?.map((op) => op.kind), names, "Actual transport operations are required");
    for (const op of receipt.operations) {
      assert.equal(op.eventId, inbound.eventId, "Operation targets a foreign event");
      assert.equal(op.messageId, inbound.messageId, "Operation targets a foreign inbound message");
    }
    assert.deepEqual(observed.ingressEvidence.map((entry) => entry?.kind),
      duplicate ? ["ingress", "redeliver"] : ["ingress"], "Ingress evidence must match the admitted ingress path exactly");
    const ingressIds = new Set();
    const ingressMap = new Map();
    for (const [index, entry] of observed.ingressEvidence.entries()) {
      assert.ok(entry && typeof entry === "object" && !Array.isArray(entry), "Ingress evidence entry is required");
      unique(entry.ingressId, ingressIds, "ingressEvidence ingressId");
      assert.equal(entry.kind, index === 0 ? "ingress" : "redeliver", "Unexpected ingress evidence kind");
      assert.equal(entry.eventId, inbound.eventId, "Ingress evidence eventId mismatch");
      assert.equal(entry.messageId, inbound.messageId, "Ingress evidence messageId mismatch");
      assert.ok(Number.isSafeInteger(entry.modelRequestsBefore) && entry.modelRequestsBefore >= 0,
        "Ingress evidence modelRequestsBefore must be a non-negative integer");
      assert.ok(Number.isSafeInteger(entry.modelRequestsAfter) && entry.modelRequestsAfter >= 0,
        "Ingress evidence modelRequestsAfter must be a non-negative integer");
      assert.ok(Array.isArray(entry.modelRequestIds), "Ingress evidence modelRequestIds must be an array");
      assert.ok(Array.isArray(entry.runIds), "Ingress evidence runIds must be an array");
      assert.deepEqual(entry.runIds, observed.runIds, "Ingress evidence must attribute work to the observed native run");
      const entryIds = new Set();
      for (const requestId of entry.modelRequestIds) {
        unique(requestId, entryIds, "ingressEvidence model requestId");
        assert.ok(requestIds.has(requestId), "Ingress evidence contains a forged model requestId");
      }
      const delta = entry.modelRequestsAfter - entry.modelRequestsBefore;
      assert.equal(delta, entry.modelRequestIds.length, "Ingress evidence request count delta must match request IDs");
      if (index === 0) {
        assert.equal(entry.modelRequestsBefore, 0, "Original ingress evidence must start from zero model requests");
        assert.equal(entry.modelRequestsAfter, observed.modelRequests, "Original ingress evidence must reach the verified total");
        assert.ok(delta > 0 && delta <= maxModelRequests,
          `Original ingress must attribute within 1..${maxModelRequests} model requests`);
      } else {
        assert.equal(delta, 0, "Redelivery must add exactly zero model requests");
        assert.equal(entry.modelRequestsBefore, observed.modelRequests, "Replay evidence must begin at the verified total");
        assert.equal(entry.modelRequestsAfter, observed.modelRequests, "Replay evidence must not add model requests");
      }
      ingressMap.set(entry.ingressId, entry);
    }
    const coveredRequestIds = new Set();
    for (const entry of observed.ingressEvidence) for (const requestId of entry.modelRequestIds) coveredRequestIds.add(requestId);
    assert.deepEqual([...coveredRequestIds].sort(), [...requestIds].sort(),
      "Ingress evidence must completely cover the observed model request IDs");
    const evidenceIds = new Set();
    for (const entry of observed.modelRequestEvidence) {
      assert.ok(entry && typeof entry === "object" && !Array.isArray(entry), "Model request evidence entry is required");
      unique(entry.requestId, evidenceIds, "modelRequestEvidence requestId");
      assert.ok(requestIds.has(entry.requestId), "Model request evidence contains a forged requestId");
      const ingress = ingressMap.get(entry.ingressId);
      assert.ok(ingress, "Model request evidence ingressId is unknown");
      assert.equal(entry.eventId, inbound.eventId, "Model request evidence eventId mismatch");
      assert.equal(entry.messageId, inbound.messageId, "Model request evidence messageId mismatch");
      assert.equal(entry.runId, observed.runIds[0], "Model request evidence runId mismatch");
      assert.ok(ingress.modelRequestIds.includes(entry.requestId), "Model request evidence is unattributed to its ingress");
    }
    assert.deepEqual([...evidenceIds].sort(), [...requestIds].sort(),
      "Model request evidence must completely cover the observed model request IDs");
    if (!duplicate) {
      const [, acceptance, reconnect] = receipt.operations;
      assert.equal(acceptance.replyId, observed.delivery.receiptId, "ACK fault is not tied to accepted delivery");
      assert.equal(reconnect.ownerId, request.providerId, "Cannot reconnect an unowned socket");
      text(reconnect.previousConnectionId, "previousConnectionId");
      text(reconnect.connectionId, "connectionId");
      assert.notEqual(reconnect.previousConnectionId, reconnect.connectionId, "No actual reconnect observed");
      if (request.type === "reconnect-card") {
        const fallback = receipt.operations[3];
        assert.equal(fallback.replyId, observed.delivery.receiptId, "Card fallback is not tied to accepted delivery");
      }
    }
    return observed.delivery.acknowledgement === "unknown";
  }
  return {
    async prepare({ caseId, runId, type, prompt, signal, scope: requestedScope = ownedScope }) {
      current();
      assert.ok(!active, "Control provider is already in use");
      exactScope(requestedScope, ownedScope);
      text(caseId, "caseId");
      text(runId, "runId");
      assert.equal(typeof prompt, "string");
      const required = FEISHU_CONTROL_CONTRACT.operations[type];
      assert.ok(required, "Unsupported transport control");
      for (const op of required) assert.ok(capabilities.operations.includes(op), `Missing backend capability: ${op}`);
      const caseKey = JSON.stringify([runId, caseId]);
      assert.ok(!cases.has(caseKey), "An attempted case cannot be automatically replayed");
      cases.add(caseKey);
      const request = Object.freeze({
        providerId: capabilities.id, evidenceClass, epoch, scope: ownedScope, caseId, runId, type,
        challenge: randomUUID(), promptSha256: digest(prompt), operation: "prepare",
      });
      active = true;
      try {
        await bounded(async (boundedSignal) => {
          const receipt = await provider.prepare({ ...request, signal: boundedSignal });
          await checked(request, receipt, boundedSignal);
          assert.ok(Array.isArray(receipt.readyOperations), "Readiness must list actual backend operations");
          for (const op of required) assert.ok(receipt.readyOperations?.includes(op), `Backend not ready: ${op}`);
        }, signal);
        const ticket = Object.freeze({});
        tickets.set(ticket, { request, prompt, consumed: false });
        return ticket;
      } finally { active = false; }
    },
    async execute(ticket, { signal } = {}) {
      current();
      assert.ok(!active, "Control provider is already in use");
      const entry = tickets.get(ticket);
      assert.ok(entry && !entry.consumed, "Invalid or consumed control ticket; never resend");
      entry.consumed = true;
      const request = Object.freeze({ ...entry.request, operation: "execute" });
      active = true;
      try {
        return await bounded(async (boundedSignal) => {
          const receipt = await provider.perform({ ...request, prompt: entry.prompt, signal: boundedSignal });
          const verified = await checked(request, receipt, boundedSignal);
          const unconfirmed = validateObservation(request, receipt, verified.observation);
          if (unconfirmed) uncertain = true;
          return {
            receipt: { ...structuredClone(receipt), verificationId: verified.verificationId,
              transportControlled: true, selfAsserted: false, channelCertified: evidenceClass === "actual-feishu" },
            observation: structuredClone(verified.observation), evidenceClass,
          };
        }, signal);
      } catch (error) {
        uncertain = true;
        throw error;
      } finally { active = false; }
    },
  };
}
