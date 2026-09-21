import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { zeroUsage } from "../../scripts/lib/acceptance-contract.mjs";

// Pure protocol double. This is not transport evidence; real SDK tests use the
// separate feishu-isolated-sdk-transport fixture.
export function controlProviderDouble({ scope = {
  agentId: "daily_assistant", accountId: "daily_assistant", chatId: "chat-private-1", channel: "feishu",
}, operations = ["ingress-redelivery", "accepted-lost-ack", "owned-socket-reconnect"],
changeReceipt = (value) => value, changeObservation = (value) => value, perform } = {}) {
  const calls = [];
  const journal = new Map();
  const makeRequestIds = (count) => Array.from({ length: count }, () => randomUUID());
  const provider = {
    capabilities: { id: randomUUID(), epoch: randomUUID(), evidenceClass: "isolated-sdk", dedicated: true,
      scope, operations: [...operations] },
    async prepare(request) {
      calls.push({ kind: "prepare", request });
      return issue(request, { readyOperations: [...provider.capabilities.operations] });
    },
    async perform(request) {
      calls.push({ kind: "perform", request });
      if (perform) return perform(request);
      const inbound = { eventId: randomUUID(), messageId: randomUUID(), bodySha256: request.promptSha256 };
      const replyId = randomUUID();
      const identity = { eventId: inbound.eventId, messageId: inbound.messageId };
      const duplicate = request.type === "duplicate-replay";
      const requestIds = makeRequestIds(1);
      const runId = randomUUID();
      const ingressEvidence = duplicate
        ? [{ ingressId: randomUUID(), kind: "ingress", ...identity, modelRequestsBefore: 0,
          modelRequestsAfter: requestIds.length, modelRequestIds: [...requestIds], runIds: [runId] },
        { ingressId: randomUUID(), kind: "redeliver", ...identity, modelRequestsBefore: requestIds.length,
          modelRequestsAfter: requestIds.length, modelRequestIds: [], runIds: [runId] }]
        : [{ ingressId: randomUUID(), kind: "ingress", ...identity, modelRequestsBefore: 0,
          modelRequestsAfter: requestIds.length, modelRequestIds: [...requestIds], runIds: [runId] }];
      const modelRequestEvidence = requestIds.map((requestId) => ({
        requestId, ingressId: ingressEvidence[0].ingressId, eventId: inbound.eventId, messageId: inbound.messageId, runId,
      }));
      const operations = [{ kind: "ingress", ...identity }, ...(duplicate
        ? [{ kind: "redeliver", ...identity }]
        : [{ kind: "accepted-lost-ack", ...identity, replyId },
          { kind: "owned-socket-reconnect", ...identity, previousConnectionId: randomUUID(),
            connectionId: randomUUID(), ownerId: request.providerId },
          ...(request.type === "reconnect-card"
            ? [{ kind: "card-fallback", ...identity, replyId }]
            : [])])];
      const observation = changeObservation({
        inboundEventId: inbound.eventId, inboundMessageId: inbound.messageId, bodySha256: inbound.bodySha256,
        runIds: [runId], modelRequests: requestIds.length, modelRequestIds: requestIds,
        ingressEvidence,
        modelRequestEvidence,
        terminalReplyIds: [replyId],
        delivery: { receiptId: replyId, acknowledgement: duplicate ? "received" : "unknown" },
        ingressCount: duplicate ? 2 : 1, sendAttempts: 1, quiescent: true, outputText: "unit-only reply",
        usage: { ...zeroUsage(), modelRequests: requestIds.length, userTurns: 1, priced: false },
      });
      if (request.type === "reconnect-card") observation.outputText = "已收到重连测试-19";
      return issue(request, { inbound, operations }, observation);
    },
    async verify(request, receipt) {
      calls.push({ kind: "verify", request, receipt });
      const stored = journal.get(receipt.receiptId);
      assert.ok(stored, "not issued by this test double");
      assert.deepEqual(receipt, stored.receipt);
      return { ...structuredClone(stored.receipt), verifiedReceiptId: receipt.receiptId,
        verificationId: randomUUID(), observation: structuredClone(stored.observation) };
    },
  };
  function issue(request, extra, observation) {
    const { signal, prompt, ...envelope } = request;
    const receipt = changeReceipt({ ...envelope, receiptId: randomUUID(), callbackId: randomUUID(), ...extra });
    journal.set(receipt.receiptId, { receipt: structuredClone(receipt), observation });
    return receipt;
  }
  return { provider, calls, host: { testOnly: true, provider, scope,
    epoch: provider.capabilities.epoch, evidenceClass: "isolated-sdk" } };
}
