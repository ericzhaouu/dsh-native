import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";

export const BRIDGE_KEY = "dsh.feishu.isolated.sdk";
export const PLUGIN_ID = "dsh-feishu-isolated-sdk";

export function register(api) {
  const bridge = globalThis[Symbol.for(BRIDGE_KEY)];
  assert.ok(bridge, "Channel must run inside its private SDK child");
  const { scope, port } = api.pluginConfig;
  const { channel, accountId, chatId, agentId } = scope;
  const target = `chat:${chatId}`;
  const sessionKey = `agent:${agentId}:${channel}:group:${chatId}`;
  // SDK outbound loading may register the same plugin in a second registry.
  // Both registrations must use the one provider-owned transport, never an unconnected copy.
  const state = bridge.transportState ??= { scope, port, activeInbound: 0, activeSends: 0 };
  assert.deepEqual(state.scope, scope);
  assert.equal(state.port, port);

  async function connect() {
    assert.ok(!state.socket || state.socket.destroyed, "Reconnect may only replace this fixture's closed socket");
    const next = createConnection({ host: "127.0.0.1", port });
    state.socket = next;
    next.setEncoding("utf8");
    let buffer = "";
    let socketError;
    let socketConnectionId;
    const ready = new Promise((resolve, reject) => { state.connecting = { resolve, reject }; });
    const timer = setTimeout(() => next.destroy(new Error("Private transport handshake timed out")), 10000);
    next.on("data", (chunk) => {
      if (state.socket !== next) return;
      buffer += chunk;
      if (buffer.length > 1024 * 1024) return next.destroy(new Error("Oversized private transport frame"));
      for (let end; (end = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const frame = JSON.parse(line);
          if (frame.kind === "hello" && state.connecting) {
            assert.equal(frame.ownerId, bridge.providerId);
            assert.equal(typeof frame.connectionId, "string");
            state.connectionId = frame.connectionId;
            socketConnectionId = frame.connectionId;
            bridge.record({ kind: "transport-connected", connectionId: state.connectionId, ownerId: frame.ownerId });
            state.connecting.resolve(state.connectionId);
            state.connecting = undefined;
          } else {
            assert.equal(frame.kind, "ack");
            assert.ok(state.pending, "Unsolicited transport acknowledgement");
            assert.equal(frame.replyId, state.pending.replyId);
            assert.equal(frame.connectionId, state.connectionId);
            bridge.record({ kind: "ack-received", replyId: frame.replyId, connectionId: state.connectionId });
            state.pending.resolve(frame);
            state.pending = undefined;
          }
        } catch (error) { next.destroy(error); }
      }
    });
    // EOF, not a settings boolean, determines whether acceptance is unknowable to the sender.
    next.on("error", (error) => {
      socketError = error;
      bridge.record({ kind: "transport-error", connectionId: socketConnectionId, error: error.stack });
    });
    next.once("close", () => {
      bridge.record({ kind: "transport-closed", connectionId: socketConnectionId });
      if (state.socket !== next) return;
      const error = new Error("Private transport closed before acknowledgement; outcome unknown",
        socketError ? { cause: socketError } : undefined);
      if (socketError) error.message += `: ${socketError.message}`;
      state.connecting?.reject(error);
      state.connecting = undefined;
      state.pending?.reject(error);
      state.pending = undefined;
    });
    try { return await ready; } finally { clearTimeout(timer); }
  }

  async function sendText(ctx) {
    assert.ok(bridge.current, "Outbound traffic outside an active isolated case");
    assert.ok([target, chatId].includes(ctx.to), "Fixture refuses foreign recipient");
    assert.equal(ctx.accountId, accountId);
    assert.ok(state.socket && !state.socket.destroyed && !state.pending, "Only one owned socket send may be active");
    const replyId = ctx.preparedMessageId ?? `isolated-reply-${randomUUID()}`;
    const { eventId, messageId } = bridge.current;
    bridge.record({ kind: "send-attempt", eventId, messageId, replyId, connectionId: state.connectionId, text: ctx.text });
    state.activeSends++;
    let timer;
    try {
      await ctx.onPlatformSendDispatch?.();
      const acknowledged = new Promise((resolve, reject) => { state.pending = { resolve, reject, replyId }; });
      timer = setTimeout(() => state.socket.destroy(new Error("Private transport acknowledgement timed out")), 10000);
      state.socket.write(`${JSON.stringify({
        kind: "send", ownerId: bridge.providerId, callbackId: bridge.current.callbackId,
        eventId, messageId, replyId, text: ctx.text, to: chatId, accountId,
      })}\n`);
      await acknowledged;
      const result = {
        channel, messageId: replyId, target: { kind: "chat", id: chatId }, timestamp: Date.now(),
        receipt: { primaryPlatformMessageId: replyId, platformMessageIds: [replyId], sentAt: Date.now(),
          parts: [{ platformMessageId: replyId, kind: "text", index: 0 }] },
      };
      await ctx.onDeliveryResult?.(result);
      return result;
    } finally {
      clearTimeout(timer);
      state.activeSends--;
    }
  }
  const outbound = { deliveryMode: "direct", sendText, deliveryCapabilities: { durableFinal: { text: true } } };
  api.registerChannel({ plugin: {
    id: channel,
    meta: { id: channel, label: "Isolated SDK transport", selectionLabel: "Isolated SDK transport",
      docsPath: "/channels/isolated-sdk", blurb: "Private loopback evidence; not actual Feishu." },
    capabilities: { chatTypes: ["group"], media: false },
    config: {
      listAccountIds: () => [accountId], defaultAccountId: () => accountId,
      resolveAccount: () => ({ accountId, enabled: true, configured: true }),
      isEnabled: () => true, isConfigured: () => true,
    },
    configSchema: { schema: { type: "object", properties: { enabled: { type: "boolean" } }, additionalProperties: false } },
    messaging: { normalizeTarget: (value) => value.trim().replace(/^chat:/u, ""),
      inferTargetChatType: () => "group",
      targetResolver: { looksLikeId: (value) => value.startsWith("chat:"), hint: target } },
    actions: { describeMessageTool: () => ({ actions: ["send"], capabilities: ["presentation"] }) },
    outbound,
    message: createChannelMessageAdapterFromOutbound({ id: channel, outbound }),
  } });
  api.on("message_received", () => bridge.record({ kind: "sdk-message-received" }));
  api.on("after_tool_call", (event) => {
    if (event.toolName === "message") bridge.record({
      kind: "sdk-source-reply", result: event.result, error: event.error,
    });
  });
  api.on("agent_end", (event, context) => bridge.record({
    kind: "agent-ended", nativeRunId: context.runId, success: event.success, error: event.error,
  }));

  bridge.channel = {
    connect,
    async reconnect() {
      const previousConnectionId = state.connectionId;
      assert.ok(state.socket?.destroyed, "Fault must disconnect the owned socket before reconnect");
      await connect();
      assert.notEqual(previousConnectionId, state.connectionId);
      bridge.record({ kind: "owned-socket-reconnect", previousConnectionId, connectionId: state.connectionId, ownerId: bridge.providerId });
    },
    snapshot: () => ({ activeInbound: state.activeInbound, activeSends: state.activeSends, pendingAcks: state.pending ? 1 : 0,
      connected: Boolean(state.socket && !state.socket.destroyed && !state.connecting), connectionId: state.connectionId }),
    close() { state.socket?.destroy(); },
    async dispatch(raw) {
      state.activeInbound++;
      const ingressId = `ingress-${randomUUID()}`;
      try {
        bridge.ingressId = ingressId;
        await bridge.checkpoint({ kind: "ingress-start", ingressId, eventId: raw.eventId, messageId: raw.messageId });
        // A fresh context is built from the exact same immutable raw event on redelivery.
        const ctxPayload = api.runtime.channel.inbound.buildContext({
          channel, accountId, provider: channel, surface: channel,
          messageId: raw.messageId, timestamp: raw.timestamp, from: "user:isolated-sender",
          sender: { id: "isolated-sender", name: "Isolated sender" },
          conversation: { kind: "group", id: chatId, label: chatId, routePeer: { kind: "group", id: chatId } },
          route: { agentId, accountId, routeSessionKey: sessionKey, dispatchSessionKey: sessionKey },
          reply: { to: target, originatingTo: target, nativeChannelId: chatId, replyTarget: target,
            deliveryTarget: target, replyToId: raw.messageId },
          message: { body: raw.prompt, bodyForAgent: raw.prompt, rawBody: raw.prompt,
            commandBody: raw.prompt, inboundEventKind: "user_request" },
          access: { commands: { authorized: false }, mentions: { canDetectMention: true, wasMentioned: true } },
          channelIngress: "unsupported",
        });
        const result = await api.runtime.channel.inbound.run({
          channel, accountId, raw,
          adapter: {
            ingest(event) {
              assert.strictEqual(event, raw);
              bridge.record({ kind: "sdk-ingest", eventId: event.eventId, messageId: event.messageId,
                timestamp: event.timestamp, bodySha256: createHash("sha256").update(event.prompt).digest("hex"),
                canonicalSha256: createHash("sha256").update(JSON.stringify(event)).digest("hex") });
              return { id: event.messageId, timestamp: event.timestamp, rawText: event.prompt, textForAgent: event.prompt };
            },
            classify: () => ({ kind: "message", canStartAgentTurn: true }),
            resolveTurn: () => ({
              cfg: api.config, channel, accountId, route: { agentId, sessionKey }, ctxPayload,
              messageId: raw.messageId, record: { createIfMissing: true },
              delivery: { deliver: async (payload) => {
                const sent = await sendText({ to: target, text: payload.text, accountId, replyToId: raw.messageId });
                return { messageIds: [sent.messageId], receipt: sent.receipt, visibleReplySent: true };
              } },
            }),
          },
          log: (event) => bridge.record({ kind: "sdk-stage", stage: event.stage, event: event.event }),
        });
        await bridge.checkpoint({ kind: "sdk-return", ingressId, eventId: raw.eventId, messageId: raw.messageId,
          dispatched: result.dispatched, dispatchResult: result.dispatchResult });
      } finally { state.activeInbound--; bridge.ingressId = undefined; }
    },
  };
}
