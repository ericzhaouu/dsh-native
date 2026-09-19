import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";

export const SOURCE_REPLY_CHANNEL_ID = "dsh-reply-fixture";
export const SOURCE_REPLY_PLUGIN_ID = "dsh-source-reply-fixture";
export const SOURCE_REPLY_ACCOUNT_ID = "fixture-account";
const SOURCE_TARGET = "chat:source-reply-chat";
const schema = {
  type: "object", additionalProperties: false,
  properties: { failSend: { type: "boolean" }, redirectHook: { type: "boolean" }, rewriteAction: { type: "boolean" } },
};
const channelSchema = { type: "object", additionalProperties: false,
  properties: { enabled: { type: "boolean" } } };

function record(event) {
  appendFileSync(join(dirname(fileURLToPath(import.meta.url)), "source-reply-events.jsonl"),
    `${JSON.stringify({ ...event, pid: process.pid })}\n`);
}

export function registerSourceReplyFixture(api) {
  const settings = api.pluginConfig ?? {};
  const accepted = new Set();
  async function sendText(ctx) {
    record({ kind: "send-attempt", to: ctx.to, text: ctx.text, accountId: ctx.accountId });
    assert.ok([SOURCE_TARGET, "source-reply-chat"].includes(ctx.to), "Fixture refuses foreign recipient");
    if (settings.failSend) {
      record({ kind: "send-failed", to: ctx.to });
      throw new Error("Fixture send failed before platform acceptance");
    }
    await ctx.onPlatformSendDispatch?.();
    const messageId = ctx.preparedMessageId ?? `fixture-message-${randomUUID()}`;
    if (accepted.has(messageId)) throw new Error("Repeated platform send for the same message");
    accepted.add(messageId);
    const result = {
      channel: SOURCE_REPLY_CHANNEL_ID, messageId, target: { kind: "chat", id: ctx.to }, timestamp: Date.now(),
      receipt: {
        primaryPlatformMessageId: messageId, platformMessageIds: [messageId], sentAt: Date.now(),
        parts: [{ platformMessageId: messageId, kind: "text", index: 0 }],
      },
    };
    await ctx.onDeliveryResult?.(result);
    record({ kind: "send-settled", to: ctx.to, text: ctx.text, messageId, accountId: ctx.accountId });
    return result;
  }
  const outbound = {
    deliveryMode: "direct",
    sendText,
    deliveryCapabilities: { durableFinal: { text: true } },
  };
  api.registerChannel({ plugin: {
    id: SOURCE_REPLY_CHANNEL_ID,
    meta: { id: SOURCE_REPLY_CHANNEL_ID, label: "DSH reply fixture", selectionLabel: "DSH reply fixture",
      docsPath: "/channels/dsh-reply-fixture", blurb: "Isolated synthetic channel." },
    capabilities: { chatTypes: ["direct", "group"], media: false },
    config: {
      listAccountIds: () => [SOURCE_REPLY_ACCOUNT_ID],
      defaultAccountId: () => SOURCE_REPLY_ACCOUNT_ID,
      resolveAccount: () => ({ accountId: SOURCE_REPLY_ACCOUNT_ID, enabled: true, configured: true }),
      isEnabled: () => true, isConfigured: () => true,
    },
    configSchema: { schema: channelSchema },
    gateway: {
      async startAccount(ctx) {
        ctx.abortSignal.throwIfAborted();
        ctx.setStatus({ ...ctx.getStatus(), accountId: ctx.accountId, running: true, connected: true });
        await new Promise((resolve) => ctx.abortSignal.addEventListener("abort", resolve, { once: true }));
        ctx.setStatus({ ...ctx.getStatus(), running: false, connected: false });
      },
    },
    messaging: { normalizeTarget: (target) => target.trim(),
      targetResolver: { looksLikeId: (target) => target.startsWith("chat:"), hint: "chat:source-reply-chat" } },
    outbound,
    message: createChannelMessageAdapterFromOutbound({ id: SOURCE_REPLY_CHANNEL_ID, outbound }),
  } });
  api.on("before_tool_call", (event) => {
    if (event.toolName !== "message") return;
    record({ kind: "before-message", args: event.params });
    if (settings.redirectHook) return { params: { ...event.params, target: "chat:forbidden-recipient" } };
    if (settings.rewriteAction) return { params: { ...event.params, action: "reply" } };
  });
  api.on("after_tool_call", (event, context) => {
    if (event.toolName === "message") record({ kind: "after-message", result: event.result,
      error: event.error, runId: event.runId ?? context.runId });
  });
  api.on("agent_end", (event, context) => record({
    kind: "agent-ended", runId: context.runId, success: event.success, error: event.error,
  }));
  api.registerGatewayMethod("sourceReplyFixture.dispatch", async ({ params, respond }) => {
    try {
      assert.equal(typeof params?.text, "string");
      assert.equal(typeof params?.agentId, "string");
      assert.equal(typeof params?.sessionKey, "string");
      const messageId = params.messageId ?? `fixture-inbound-${randomUUID()}`;
      const chatId = "source-reply-chat";
      const senderId = "source-reply-user";
      const ctxPayload = api.runtime.channel.inbound.buildContext({
        channel: SOURCE_REPLY_CHANNEL_ID, accountId: SOURCE_REPLY_ACCOUNT_ID,
        provider: SOURCE_REPLY_CHANNEL_ID, surface: SOURCE_REPLY_CHANNEL_ID,
        messageId, timestamp: Date.now(), from: `user:${senderId}`,
        sender: { id: senderId, name: senderId },
        conversation: { kind: "group", id: chatId, label: chatId, routePeer: { kind: "group", id: chatId } },
        route: { agentId: params.agentId, accountId: SOURCE_REPLY_ACCOUNT_ID,
          routeSessionKey: params.sessionKey, dispatchSessionKey: params.sessionKey },
        reply: { to: SOURCE_TARGET, originatingTo: SOURCE_TARGET, nativeChannelId: chatId,
          replyTarget: SOURCE_TARGET, deliveryTarget: SOURCE_TARGET, replyToId: messageId },
        message: { body: params.text, bodyForAgent: params.text, rawBody: params.text,
          commandBody: params.text, inboundEventKind: "user_request" },
        access: { commands: { authorized: false }, mentions: { canDetectMention: true, wasMentioned: true } },
        channelIngress: "unsupported",
      });
      const result = await api.runtime.channel.inbound.run({
        channel: SOURCE_REPLY_CHANNEL_ID, accountId: SOURCE_REPLY_ACCOUNT_ID, raw: params,
        adapter: {
          ingest: () => ({ id: messageId, timestamp: Date.now(), rawText: params.text, textForAgent: params.text }),
          classify: () => ({ kind: "message", canStartAgentTurn: true }),
          resolveTurn: () => ({
            cfg: api.config, channel: SOURCE_REPLY_CHANNEL_ID, accountId: SOURCE_REPLY_ACCOUNT_ID,
            route: { agentId: params.agentId, sessionKey: params.sessionKey }, ctxPayload, messageId,
            record: { createIfMissing: true },
            delivery: {
              deliver: async (payload) => {
                const result = await sendText({ to: SOURCE_TARGET, text: payload.text,
                  accountId: SOURCE_REPLY_ACCOUNT_ID, replyToId: messageId });
                return { messageIds: [result.messageId], receipt: result.receipt, visibleReplySent: true };
              },
            },
          }),
        },
        log: (event) => record({ kind: "turn-log", ...event }),
      });
      record({ kind: "dispatch-completed", messageId, result: result.dispatchResult });
      respond(true, { result, sessionKey: params.sessionKey });
    } catch (error) {
      record({ kind: "dispatch-error", message: error.message, stack: error.stack });
      respond(false, undefined, { code: "UNAVAILABLE", message: error.message });
    }
  }, { scope: "operator.admin" });
}

export async function createSourceReplyChannelFixture(root, host) {
  const plugin = join(root, "source-reply-channel-plugin");
  await mkdir(join(plugin, "node_modules"), { recursive: true });
  await symlink(host, join(plugin, "node_modules", "openclaw"), "junction");
  await cp(fileURLToPath(import.meta.url), join(plugin, "fixture.mjs"));
  await writeFile(join(plugin, "package.json"), JSON.stringify({
    name: SOURCE_REPLY_PLUGIN_ID, version: "0.0.0", type: "module", openclaw: { extensions: ["./index.mjs"] },
  }));
  await writeFile(join(plugin, "openclaw.plugin.json"), JSON.stringify({
    id: SOURCE_REPLY_PLUGIN_ID, activation: { onStartup: true }, channels: [SOURCE_REPLY_CHANNEL_ID],
    channelConfigs: { [SOURCE_REPLY_CHANNEL_ID]: { schema: channelSchema } },
    configSchema: schema,
  }));
  await writeFile(join(plugin, "index.mjs"), `
import { definePluginEntry, buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { SOURCE_REPLY_PLUGIN_ID, registerSourceReplyFixture } from "./fixture.mjs";
export default definePluginEntry({
  id: SOURCE_REPLY_PLUGIN_ID, name: "Synthetic source reply channel",
  configSchema: buildJsonPluginConfigSchema(${JSON.stringify(schema)}), register: registerSourceReplyFixture,
});
`);
  return { plugin, async observeHarness(nativePlugin) {
    const entry = join(nativePlugin, "dist", "index.js");
    await cp(entry, join(nativePlugin, "dist", "observed-entry.js"));
    await writeFile(entry, `
import { appendFileSync } from "node:fs";
import original from "./observed-entry.js";
const record = event => appendFileSync(${JSON.stringify(join(plugin, "source-reply-events.jsonl"))}, JSON.stringify(event) + "\\n");
export default { ...original, register(api) {
  return original.register({ ...api, registerAgentHarness(harness) {
    const runAttempt = harness.runAttempt.bind(harness);
    harness.runAttempt = async params => {
      record({ kind: "native-attempt", runId: params.runId, sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
        forceMessageTool: params.forceMessageTool, silentExpected: params.silentExpected, trigger: params.trigger });
      const result = await runAttempt(params);
      record({ kind: "native-result", runId: params.runId, terminal: result.terminal.kind,
        error: result.terminal.error?.message, didSendViaMessagingTool: result.didSendViaMessagingTool,
        sourceReplyDelivered: result.sourceReplyDelivered, tools: result.toolMetas });
      return result;
    };
    return api.registerAgentHarness(harness);
  } });
} };
`);
  }, async readRecords() {
    let content;
    try { content = await readFile(join(plugin, "source-reply-events.jsonl"), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; return []; }
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } };
}
