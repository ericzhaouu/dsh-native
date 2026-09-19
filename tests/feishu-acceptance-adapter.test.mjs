import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createFeishuAcceptanceAdapter } from "../scripts/lib/feishu-acceptance-adapter.mjs";

const root = resolve("artifacts", "feishu-acceptance-adapter-test");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const usage = { input: 8, output: 5, cacheRead: 1, cacheWrite: 0 };

function nativeRows(tool = "dsh_prepare_task") {
  return [
    { type: "turn/start", data: { turn: 1 } },
    { type: "step/start", data: { turn: 1 } },
    { type: "request/header", data: { header: { config: { provider: "github-copilot", model: "gpt-6-astra" } } } },
    { type: "tool/call", data: { turn: 1, callId: "prep-1", name: tool, arguments: "{}" } },
    { type: "tool/result", data: { turn: 1, message: { content: [
      { type: "tool-result", toolCallId: "prep-1", content: "ok", isError: false },
    ] } } },
    { type: "turn/end", data: { turn: 1 } },
  ];
}

function resolveBoundary(raw, sessionId) {
  const reset = raw.findLast((row) => row.type === "reset")?.id;
  if (!reset) return { kind: "none" };
  return {
    kind: "clear", resetId: reset, stateId: `${sessionId}\0reset\0${reset}`,
    assistantKeyPrefix: `dsh-native:reset:${reset}:`, messageIds: new Set(),
  };
}

async function fixture(t, { tool = "dsh_prepare_task", noNative = false, bareReadback = false } = {}) {
  const runDir = join(root, randomUUID());
  const nativeStateDir = join(runDir, "native");
  const sessionId = randomUUID();
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  t.after(() => rm(runDir, { recursive: true, force: true }));
  const physical = {
    chatId: "chat-private-1", botAppId: "bot-app-1", botMemberId: "bot-member-1",
    creatorMemberId: "creator-member-1",
  };
  const ledgerPath = join(runDir, "ledger.json");
  await writeFile(ledgerPath, JSON.stringify({ chats: { daily_assistant: physical } }));
  const config = {
    hostRoot: resolve("."), configPath: join(runDir, "config.json"), stateDir: join(runDir, "state"),
    nativeStateDir, larkCli: join(runDir, "lark-cli.exe"), chatLedgerPath: ledgerPath,
    logicalAgentMap: { "dsh-assistant": "daily_assistant", "dsh-partner": "think_partner" },
  };
  await writeFile(config.configPath, JSON.stringify({
    channels: { feishu: { accounts: { daily_assistant: { appId: physical.botAppId } } } },
    plugins: { entries: { "dsh-native": { config: { taskPreparation: {
      skillAllowlist: [], skillAllowlistByAgent: { daily_assistant: ["content-distill"] },
    } } } } },
  }));
  const entry = {
    sessionKey: "agent:daily_assistant:feishu:group:chat-private-1",
    entry: { sessionId,
      delivery: { route: { channel: "feishu", accountId: "daily_assistant" }, origin: { nativeChannelId: physical.chatId } } },
  };
  const raw = [];
  const messages = [];
  const sends = [];
  const calls = [];
  let resetId;
  function stateId() {
    return resetId ? `${sessionId}\0reset\0${resetId}` : sessionId;
  }
  async function commitTurn(messageId, prompt) {
    if (noNative) return;
    const runId = randomUUID();
    const prefix = resetId ? `dsh-native:reset:${resetId}:` : "dsh-native:";
    raw.push({ type: "message", id: `user-${messageId}`, message: {
      role: "user", content: prompt, delivery: { origin: { messageId, nativeChannelId: physical.chatId } },
    } });
    const canonical = { role: "assistant", content: "ok  \nJSON:{\"a\":1}", idempotencyKey: `${prefix}${runId}:assistant`, usage };
    raw.push({ type: "message", id: `assistant-${messageId}`, message: canonical });
    const dir = join(nativeStateDir, hash(stateId()));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "binding.json"), JSON.stringify({
      status: "ready", lastRunId: runId, sessionId: "native-session",
      taskPreparation: { state: { mode: "chat" } },
    }));
    messages.push({
      message_id: `bot-${messageId}`, chat_id: physical.chatId, create_time: Date.now() + 1,
      sender: { id: physical.botMemberId }, content: "ok\nJSON:{\"a\":1}",
    });
  }
  const execFile = async (_file, args) => {
    calls.push(args);
    assert.equal(args[args.indexOf("--as") + 1], "user", "Every Lark command must select the user identity");
    if (args[0] === "im" && args[1] === "+messages-send") {
      const chatId = args[args.indexOf("--chat-id") + 1];
      const text = args[args.indexOf("--text") + 1];
      const id = `user-${sends.length + 1}`;
      sends.push({ chatId, text, id });
      messages.push({ message_id: id, chat_id: chatId, create_time: Date.now(), sender: { id: physical.creatorMemberId }, content: text });
      if (text.endsWith("/new")) {
        resetId = `reset-${id}`;
        raw.push({ type: "reset", id: resetId, parentId: null, context: "clear" });
      } else {
        await commitTurn(id, text.replace(`<at user_id="${physical.botMemberId}">canary</at> `, ""));
      }
      return { stdout: JSON.stringify({ identity: "user", data: { message_id: id } }) };
    }
    if (args[0] === "im" && args[1] === "+chat-messages-list") return { stdout: JSON.stringify(bareReadback ? { messages } : { data: { messages } }) };
    if (args[1] === "+chat-members-list") {
      const membership = { bots: [{ app_id: physical.botAppId, member_id: physical.botMemberId }],
        users: [{ member_id: physical.creatorMemberId }] };
      return { stdout: JSON.stringify(bareReadback ? membership : { data: membership }) };
    }
    throw new Error(`unexpected lark args ${args.join(" ")}`);
  };
  const reported = [];
  const adapter = await createFeishuAcceptanceAdapter({
    config, execFile, gatewayAdapter: {
      executeCase: async (testCase) => ({ delegated: true, id: testCase.id }),
      cleanupCase: async () => ({ cleaned: true, receipt: "gateway" }),
      close: async () => { calls.push(["gateway-close"]); },
    },
    deps: {
      resolveActiveResetBoundary: resolveBoundary,
      store: {
        listSessionEntries: ({ agentId, readOnly }) => {
          assert.equal(readOnly, true);
          return agentId === "daily_assistant" ? [entry] : [];
        },
        loadTranscriptEventsSync: () => raw,
      },
    },
    readNativeRows: async () => nativeRows(tool),
  });
  const context = {
    runId: randomUUID(), runDir, signal: new AbortController().signal, caseTimeoutMs: 2000,
    reportUsage: (value) => reported.push(value),
    resources: { modelVisibleContext: "MUST NOT BE SENT" },
  };
  const testCase = (extra = {}) => ({
    id: "case-1", category: "delivery", agentProfile: "dsh-assistant",
    prompt: "只发送原始提示 JSON:{\"a\":1}", limits: { timeoutMs: 2000 },
    adapterControls: [{ type: "plain-nonce", visibleToModel: false, prerequisiteGateBeforeDelivery: true }],
    ...extra,
  });
  return { adapter, context, testCase, calls, sends, reported, runDir };
}

test("non-delivery cases delegate to the existing Gateway adapter", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.adapter.executeCase({ id: "g1", category: "business" }, f.context), { delegated: true, id: "g1" });
  assert.deepEqual(await f.adapter.cleanupCase({ id: "g1", category: "business" }, f.context), { cleaned: true, receipt: "gateway" });
  await f.adapter.close();
  assert.deepEqual(f.calls.at(-1), ["gateway-close"]);
});

test("unsupported Feishu platform controls block before any send and report zero usage", async (t) => {
  const f = await fixture(t);
  for (const type of ["duplicate-replay", "reconnect-card"]) {
    const result = await f.adapter.executeCase(f.testCase({ id: type, adapterControls: [{ type, visibleToModel: false, prerequisiteGateBeforeDelivery: true }] }), f.context);
    assert.equal(result.executionStatus, "infrastructure_blocked");
    assert.equal(result.usage.modelRequests, 0);
  }
  assert.equal(f.sends.length, 0);
});

test("actual delivery sends only the original prompt, correlates native evidence and verifies readback", async (t) => {
  const f = await fixture(t);
  const result = await f.adapter.executeCase(f.testCase(), f.context);
  assert.equal(result.executionStatus, "completed");
  assert.equal(result.turns[0].delivery.transport, "feishu");
  assert.equal(result.turns[0].delivery.recipient, "chat-private-1");
  assert.equal(result.turns[0].tools.length, 0);
  assert.equal(result.policyFacts.businessToolCalls, 0);
  assert.equal(result.outputText, "ok  \nJSON:{\"a\":1}");
  assert.deepEqual(f.reported, [result.usage]);
  assert.equal(f.sends.length, 1);
  assert.match(f.sends[0].text, /^<at user_id="bot-member-1">canary<\/at> 只发送原始提示/);
  assert.doesNotMatch(f.sends[0].text, /MUST NOT BE SENT/);
  assert.equal((await f.adapter.cleanupCase(f.testCase(), f.context)).cleaned, true);
  const ledger = await readFile(join(f.runDir, "feishu-acceptance-ledger.jsonl"), "utf8");
  assert.match(ledger, /send_planned/);
  assert.doesNotMatch(ledger, /chat-private-1|bot-member-1|creator-member-1/);
});

test("documented bare shortcut data and installed CLI envelopes use the same strict checks", async (t) => {
  const f = await fixture(t, { bareReadback: true });
  const result = await f.adapter.executeCase(f.testCase(), f.context);
  assert.equal(result.delivery.delivered, true);
  assert.equal(result.turns[0].delivery.recipient, "chat-private-1");
});

test("new-reset-prompt issues an actual /new control first and records reset receipt", async (t) => {
  const f = await fixture(t);
  const result = await f.adapter.executeCase(f.testCase({
    id: "reset-case",
    adapterControls: [{ type: "new-reset-prompt", visibleToModel: false, prerequisiteGateBeforeDelivery: true }],
  }), f.context);
  assert.equal(f.sends.length, 2);
  assert.match(f.sends[0].text, /\/new$/);
  assert.match(f.sends[1].text, /只发送原始提示/);
  assert.equal(result.controlReceipts[0].type, "new-reset-prompt");
  assert.equal(result.controlReceipts[0].transportControlled, true);
  assert.match(result.controlReceipts[0].receiptId, /^reset-/);
});

test("case marker prevents replay instead of sending a second message", async (t) => {
  const f = await fixture(t);
  await f.adapter.executeCase(f.testCase(), f.context);
  await assert.rejects(f.adapter.executeCase(f.testCase(), f.context), /EEXIST/);
  assert.equal(f.sends.length, 1);
});

test("missing native evidence is not converted into fake success", async (t) => {
  const f = await fixture(t, { noNative: true });
  await assert.rejects(f.adapter.executeCase(f.testCase(), f.context), /actual native Feishu turn/);
  assert.equal((await f.adapter.cleanupCase(f.testCase(), f.context)).cleaned, false);
});

test("business tool side effects make cleanup uncertain", async (t) => {
  const f = await fixture(t, { tool: "exec" });
  const result = await f.adapter.executeCase(f.testCase({ id: "tool-case" }), f.context);
  assert.equal(result.unknownEffects, true);
  assert.equal((await f.adapter.cleanupCase(f.testCase({ id: "tool-case" }), f.context)).cleaned, false);
});

