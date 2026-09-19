import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";

const sourceModules = new Map([["native/source-reply",
  new URL("../src/native/source-reply.ts", import.meta.url)]].map(([name, source]) => [
  new URL(`../dist/${name}.js`, import.meta.url).href,
  source,
]));
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const url = context.parentURL && new URL(specifier, context.parentURL).href;
    return sourceModules.has(url) ? { url, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return sourceModules.has(url) ? { format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(sourceModules.get(url), "utf8"),
        { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText } : next(url, context);
  },
});
const {
  assertPrivateSourceReplyArgs, buildSourceReplyDeliveryEvidence, createPrivateSourceReplyArgs,
} = await import("../dist/native/source-reply.js");
hooks.deregister();

test("private source reply args are exactly current-source final text only", () => {
  const args = createPrivateSourceReplyArgs("Final text");
  assert.deepEqual(args, { action: "send", message: "Final text", final: true });
  assert.doesNotThrow(() => assertPrivateSourceReplyArgs(args, "Final text"));
  assert.throws(() => assertPrivateSourceReplyArgs({ ...args, to: "foreign" }, "Final text"), /explicit/);
  assert.throws(() => assertPrivateSourceReplyArgs({ ...args, message: "raw" }, "Final text"), /committed/);
  for (const action of ["reply", "SEND", " send ", null, { toString: () => "send" }]) {
    assert.throws(() => assertPrivateSourceReplyArgs({ ...args, action }, "Final text"), /canonical/);
  }
});

test("delivery flags are derived only from a verified message tool current-source receipt", () => {
  const sdk = {
    extractMessagingToolSend: (_tool, args) => ({ tool: "message", provider: "feishu", text: args.message, sourceReplyFinal: true }),
    extractMessagingToolSendResult: (pending, result) => ({ ...pending, text: result.details.deliveredText }),
    isDeliveredMessageToolOnlySourceReplyResult: (params) =>
      params.result.details.messageDelivery.sourceReplyDelivered === true && params.result.details.messageDelivery.status === "settled",
  };
  const result = {
    details: {
      deliveredText: "Final text",
      messageDelivery: { sourceReplyDelivered: true, status: "settled" },
      sourceReplySink: "internal-ui",
      sourceReply: { text: "Final text" },
    },
  };
  const evidence = buildSourceReplyDeliveryEvidence({
    sdk,
    attempt: { sourceReplyDeliveryMode: "message_tool_only", config: {}, currentChannelId: "chan" },
    args: createPrivateSourceReplyArgs("Final text"),
    result,
    isError: false,
  });
  assert.equal(evidence.didSendViaMessagingTool, true);
  assert.equal(evidence.didDeliverSourceReplyViaMessageTool, true);
  assert.deepEqual(evidence.messagingToolSentTexts, ["Final text"]);
  assert.deepEqual(evidence.messagingToolSourceReplyPayloads, [{ text: "Final text", sourceReplyFinal: true }]);
  const denied = buildSourceReplyDeliveryEvidence({
    ...{ sdk },
    attempt: { sourceReplyDeliveryMode: "message_tool_only", config: {} },
    args: createPrivateSourceReplyArgs("Final text"),
    result: { details: { messageDelivery: { sourceReplyDelivered: false } } },
    isError: false,
  });
  assert.equal(denied, undefined);
});

test("SDK-confirmed delivery survives absent attempt target hints without fabricating a target", async () => {
  const sdk = await import("openclaw/plugin-sdk/agent-harness-runtime");
  const params = {
    sdk, attempt: { sourceReplyDeliveryMode: "message_tool_only", config: {} },
    args: createPrivateSourceReplyArgs("Final text"), isError: false,
    result: { content: [{ type: "text", text: "Sent" }], details: {
      sourceReplyRoute: "current-source", deliveredText: "Final text",
      messageDelivery: { sourceReplyDelivered: true, status: "settled" },
    } },
  };
  assert.equal(sdk.extractMessagingToolSend("message", params.args, params.attempt), undefined);
  const evidence = buildSourceReplyDeliveryEvidence(params);
  assert.equal(evidence.sourceReplyDelivered, true);
  assert.deepEqual(evidence.messagingToolSentTexts, ["Final text"]);
  assert.deepEqual(evidence.messagingToolSentTargets, []);
  assert.equal(buildSourceReplyDeliveryEvidence({ ...params, result: { details: {} } }), undefined);
});
