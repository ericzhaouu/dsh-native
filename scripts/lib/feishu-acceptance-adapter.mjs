import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createGatewayAcceptanceAdapter, nativeTurnEvidence } from "./gateway-acceptance-adapter.mjs";
import { validateUsageShape, zeroUsage } from "./acceptance-contract.mjs";

const execFileDefault = promisify(execFileCallback);
const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const hash = (text) => createHash("sha256").update(text).digest("hex");
const usageKeys = Object.keys(zeroUsage());
const sumUsage = (a, b) => Object.fromEntries([
  ...usageKeys.map((key) => [key, (a[key] ?? 0) + (b[key] ?? 0)]), ["priced", false],
]);
const DELIVERY_CONTROLS = new Set(["plain-nonce", "unicode-format", "long-bounded", "new-reset-prompt"]);
const UNSAFE_CONTROLS = new Set(["duplicate-replay", "reconnect-card"]);

function textOf(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join("");
  return "";
}

function compareText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/ {2}\n/g, "\n");
}

function requireAbsolute(value, key) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${key} must be an absolute path`);
  return value;
}

function validateConfig(value) {
  for (const key of ["hostRoot", "configPath", "stateDir", "nativeStateDir", "larkCli", "chatLedgerPath"]) {
    requireAbsolute(value?.[key], key);
  }
  const map = value.logicalAgentMap;
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("logicalAgentMap is required");
  for (const [logical, physical] of Object.entries(map)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(logical) || !/^[a-z][a-z0-9_-]*$/.test(physical)) {
      throw new Error("logicalAgentMap contains an invalid agent id");
    }
  }
  return { ...value };
}

function controlType(testCase) {
  const controls = testCase.adapterControls ?? [];
  if (controls.length !== 1) return undefined;
  const [control] = controls;
  if (control?.visibleToModel !== false || control?.prerequisiteGateBeforeDelivery !== true) {
    throw new Error("Delivery control must be hidden and prerequisite-gated");
  }
  return control.type;
}

function block(reason) {
  return {
    executionStatus: "infrastructure_blocked", businessResult: "failed", outputText: "",
    policyFacts: { blockedReason: reason, adapter: "real-Feishu" }, sideEffects: [],
    usage: { ...zeroUsage(), priced: false }, delivery: { delivered: false, terminalOutputs: 0 },
    turns: [], controlReceipts: [],
  };
}

function sideEffects(tools) {
  const effects = [];
  let unknown = false;
  for (const tool of tools) {
    if (["write", "edit", "apply_patch"].includes(tool.name)) effects.push({ kind: "write", tool: tool.name, callId: tool.callId });
    else if (!["read", "grep", "glob", "find", "ls", "web_search", "web_fetch", "dsh_prepare_task"].includes(tool.name)) {
      effects.push({ kind: "unclassified", tool: tool.name, callId: tool.callId });
      unknown = true;
    }
  }
  return { effects, unknown };
}

async function appendLedger(context, value) {
  await mkdir(context.runDir, { recursive: true, mode: 0o700 });
  await appendFile(join(context.runDir, "feishu-acceptance-ledger.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`, { mode: 0o600 });
}

function parseJson(stdout, label) {
  try {
    const value = JSON.parse(stdout);
    if (value.ok === false || typeof value.code === "number" && value.code !== 0) throw new Error("CLI reported failure");
    return value;
  }
  catch (error) { throw new Error(`${label} returned non-JSON output: ${error.message}`); }
}

function shortcutData(response) {
  const value = Object.hasOwn(response, "data") ? response.data : response;
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Invalid CLI data envelope");
  return value;
}

function findValue(object, names) {
  if (!object || typeof object !== "object") return undefined;
  for (const name of names) if (typeof object[name] === "string" && object[name]) return object[name];
  for (const value of Object.values(object)) {
    const found = findValue(value, names);
    if (found) return found;
  }
  return undefined;
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  const raw = message?.body?.content ?? message?.content ?? message?.text ?? message?.body ?? "";
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return messageText(parsed);
    } catch {
      return raw;
    }
  }
  if (Array.isArray(raw)) return raw.map(messageText).join("");
  if (raw && typeof raw === "object") {
    if (typeof raw.text === "string") return raw.text;
    if (Array.isArray(raw.content)) return raw.content.map(messageText).join("");
  }
  return "";
}

function senderId(message) {
  return message?.sender?.id ?? message?.sender_id?.open_id ?? message?.sender_id?.user_id ??
    message?.sender_id?.union_id ?? message?.from?.id ?? message?.from;
}

function messageId(message) {
  return message?.message_id;
}

function messageChatId(message) {
  return message?.chat_id ?? message?.chatId ?? message?.chat?.id ?? findValue(message, ["chat_id", "chatId"]);
}

function hasDeepValue(object, expected) {
  if (!expected) return false;
  if (typeof object === "string") return object.includes(expected);
  if (!object || typeof object !== "object") return false;
  return Object.values(object).some((value) => hasDeepValue(value, expected));
}

async function sleep(ms, signal) {
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function waitFor(predicate, signal, timeoutMs, label, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
  }
}

function sessionIdOf(entry) {
  return entry?.entry?.sessionId;
}

function sessionKeyOf(entry) {
  return entry?.sessionKey;
}

function matchesDelivery(entry, physical, agentId) {
  const delivery = entry?.entry?.delivery;
  return entry?.sessionKey?.startsWith(`agent:${agentId}:`) &&
    delivery?.route?.channel === "feishu" && delivery.route.accountId === agentId &&
    delivery.origin?.nativeChannelId === physical.chatId;
}

function assertReadbackEnvelope(message, physical, sender, label) {
  assert.equal(messageChatId(message), physical.chatId, `${label} chat_id must match the private ledger exactly`);
  assert.equal(senderId(message), sender, `${label} sender.id must match the private ledger exactly`);
}

function selectPhysical(ledgerDoc, agentId) {
  const physical = ledgerDoc?.chats?.[agentId];
  if (!physical || typeof physical !== "object") throw new Error("chatLedgerPath lacks the selected Agent's chat");
  for (const key of ["chatId", "botAppId", "botMemberId", "creatorMemberId"]) {
    if (typeof physical[key] !== "string" || !physical[key]) throw new Error(`chats.physical.${key} is required`);
  }
  if (physical.agentId !== undefined && physical.agentId !== agentId) throw new Error("ledger physical agent mismatch");
  return physical;
}

async function defaultDeps(config) {
  const [store, reset] = await Promise.all([
    import(pathToFileURL(join(config.hostRoot, "dist", "plugin-sdk", "session-store-runtime.js")).href),
    import(pathToFileURL(join(packageRoot, "dist", "native", "reset-boundary.js")).href),
  ]);
  return { store, resolveActiveResetBoundary: reset.resolveActiveResetBoundary };
}

async function readNativeRows(directory) {
  const files = [];
  async function visit(path, depth = 0) {
    if (depth > 8) throw new Error("Unexpected native transcript directory depth");
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        if (entry.name === "session.jsonl") throw new Error("Native transcript cannot be a symlink");
        continue;
      }
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child, depth + 1);
      else if (entry.name === "session.jsonl") files.push(child);
    }
  }
  await visit(join(directory, "home"));
  assert.equal(files.length, 1, "Expected one native transcript for the exact Feishu turn");
  const text = await readFile(files[0], "utf8");
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error("Native channel evidence exceeds the bounded size");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export async function createFeishuAcceptanceAdapter(options = {}) {
  const gateway = options.gatewayAdapter ?? await createGatewayAcceptanceAdapter({
    ...(options.gatewayOptions ?? {}),
    env: options.env ?? process.env,
  });
  const env = options.env ?? process.env;
  const inputPath = env.DSH_ACCEPTANCE_FEISHU_CONFIG;
  if (!options.config && (!inputPath || !isAbsolute(inputPath))) throw new Error("Explicit private Feishu adapter config path is required");
  const config = validateConfig(options.config ?? JSON.parse(await readFile(inputPath, "utf8")));
  const deps = options.deps ?? await defaultDeps(config);
  const execFile = options.execFile ?? execFileDefault;
  const states = new Map();
  let receiptSequence = 0;
  const storeEnv = { ...process.env, OPENCLAW_STATE_DIR: config.stateDir, OPENCLAW_CONFIG_PATH: config.configPath };
  const lark = async (args, context, label) => {
    const receipt = join(context.runDir, `lark-${++receiptSequence}-${label}.private.json`);
    let result;
    try {
      result = await execFile(config.larkCli, args, {
        signal: context.signal, timeout: 60000, shell: false, maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      await writeFile(receipt, JSON.stringify({ failed: true, stdout: error.stdout, stderr: error.stderr }),
        { flag: "wx", mode: 0o600 });
      throw new Error(`Private ${label} CLI receipt records failure`);
    }
    await writeFile(receipt, JSON.stringify(result), { flag: "wx", mode: 0o600 });
    return parseJson(result.stdout, label);
  };
  const listMessages = async (chatId, context, start) => {
    const response = await lark(["im", "+chat-messages-list", "--as", "user", "--chat-id", chatId,
      "--start", start, "--page-size", "20", "--order", "asc", "--no-reactions", "--format", "json"], context, "readback");
    const data = shortcutData(response);
    assert.ok(Array.isArray(data.messages), "Missing actual message readback array");
    const messages = data.messages;
    assert.ok(messages.length < 20, "Readback may be truncated");
    assert.ok(messages.every((message) => message.chat_id === chatId), "Foreign chat in readback");
    return messages;
  };
  const listEntries = (agentId) => deps.store.listSessionEntries({ agentId, readOnly: true, env: storeEnv });
  const loadTranscript = (entry, agentId) => deps.store.loadTranscriptEventsSync({
    sessionKey: sessionKeyOf(entry), agentId, sessionId: sessionIdOf(entry), env: storeEnv,
  });

  async function sendText(physical, text, context, kind) {
    const idempotencyKey = randomUUID();
    const rendered = `<at user_id="${physical.botMemberId}">canary</at> ${text}`;
    const submittedAt = new Date().toISOString();
    await appendLedger(context, {
      event: `${kind}_planned`, chatIdHash: hash(physical.chatId), idempotencyKey,
      promptSha256: hash(text), senderIdHash: hash(physical.creatorMemberId), submittedAt,
    });
    const payload = await lark([
      "im", "+messages-send", "--as", "user", "--chat-id", physical.chatId,
      "--text", rendered, "--idempotency-key", idempotencyKey,
    ], context, "send");
    assert.equal(payload.identity, "user", "Canary ingress must use the existing user identity");
    const outboundId = findValue(payload, ["message_id"]);
    if (!outboundId) throw new Error("messages-send did not return a message id");
    await appendLedger(context, { event: `${kind}_accepted`, idempotencyKey, messageId: outboundId, submittedAt });
    return { idempotencyKey, outboundId, rendered, submittedAt };
  }

  async function findInbound(physical, sent, context) {
    return waitFor(async () => {
      const messages = await listMessages(physical.chatId, context, sent.submittedAt);
      const matches = messages.filter((message) => {
        const id = messageId(message);
        return id === sent.outboundId && messageChatId(message) === physical.chatId &&
          senderId(message) === physical.creatorMemberId;
      });
      assert.ok(matches.length <= 1, "Duplicate exact inbound readback messages");
      return matches[0];
    }, context.signal, 30000, "actual user message readback");
  }

  async function settleNative(physical, agentId, inboundId, prompt, context, resetRequired, timeoutMs) {
    return waitFor(async () => {
      const entries = (await listEntries(agentId)).filter((entry) => matchesDelivery(entry, physical, agentId));
      for (const entry of entries) {
        const sessionId = sessionIdOf(entry);
        const sessionKey = sessionKeyOf(entry);
        if (!sessionId || !sessionKey) continue;
        const raw = await loadTranscript(entry, agentId);
        const user = raw.findLast((row) => row?.type === "message" && row.message?.role === "user" &&
          hasDeepValue(row.message, inboundId) && compareText(textOf(row.message)).includes(compareText(prompt)));
        if (!user) continue;
        if (raw.findLast((row) => row?.type === "message" && row.message?.role === "user") !== user) {
          throw new Error("Unexpected concurrent input in the dedicated chat");
        }
        const boundary = deps.resolveActiveResetBoundary(raw, sessionId);
        if (resetRequired && boundary.kind !== "clear") continue;
        const stateId = boundary.kind === "clear" ? boundary.stateId : sessionId;
        const directory = join(config.nativeStateDir, hash(stateId));
        let binding;
        try { binding = JSON.parse(await readFile(join(directory, "binding.json"), "utf8")); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (binding.status === "blocked") throw new Error("Native binding is blocked");
        if (binding.status !== "ready" || !binding.lastRunId) continue;
        const prefix = boundary.kind === "clear" ? boundary.assistantKeyPrefix : "dsh-native:";
        const key = `${prefix}${binding.lastRunId}:assistant`;
        const canonical = raw.findLast((row) => row?.type === "message" && row.message?.idempotencyKey === key)?.message;
        if (!canonical) continue;
        if (raw.findLastIndex((row) => row?.type === "message" && row.message === canonical) <= raw.indexOf(user)) continue;
        return { entry, raw, boundary, canonical, binding, directory, runId: binding.lastRunId, sessionId, sessionKey };
      }
      return undefined;
    }, context.signal, Math.min(240000, timeoutMs ?? 240000), "actual native Feishu turn");
  }

  async function waitForReset(physical, agentId, before, context) {
    return waitFor(async () => {
      const entries = (await listEntries(agentId)).filter((entry) => matchesDelivery(entry, physical, agentId));
      for (const entry of entries) {
        const sessionId = sessionIdOf(entry);
        if (!sessionId) continue;
        const raw = await loadTranscript(entry, agentId);
        const boundary = deps.resolveActiveResetBoundary(raw, sessionId);
        if (boundary.kind === "clear" && boundary.resetId !== before?.resetId) return { entry, boundary };
      }
      return undefined;
    }, context.signal, 60000, "actual /new reset boundary");
  }

  async function snapshotBoundary(physical, agentId) {
    const entries = (await listEntries(agentId)).filter((entry) => matchesDelivery(entry, physical, agentId));
    const entry = entries.at(-1);
    if (!entry) return undefined;
    const sessionId = sessionIdOf(entry);
    if (!sessionId) return undefined;
    const raw = await loadTranscript(entry, agentId);
    const boundary = deps.resolveActiveResetBoundary(raw, sessionId);
    return { sessionId, resetId: boundary.kind === "clear" ? boundary.resetId : undefined };
  }

  async function verifyBotReadback(physical, inbound, canonicalText, context, submittedAt) {
    const earliest = Date.now() + 3000;
    if (Date.now() < earliest) await sleep(earliest - Date.now(), context.signal);
    return waitFor(async () => {
      const messages = await listMessages(physical.chatId, context, submittedAt);
      const inboundIndex = messages.findIndex((message) => message.message_id === messageId(inbound));
      assert.ok(inboundIndex >= 0, "Owned inbound disappeared from readback");
      const replies = messages.slice(inboundIndex + 1);
      assert.ok(replies.length <= 1, "Duplicate actual Feishu bot replies");
      if (!replies.length) return undefined;
      assert.ok([physical.botMemberId, physical.botAppId].includes(senderId(replies[0])), "Unexpected reply sender");
      assert.equal(compareText(messageText(replies[0])), compareText(canonicalText), "Platform text differs from committed text");
      return replies[0];
    }, context.signal, 240000, "actual Feishu bot reply readback");
  }

  return {
    async executeCase(testCase, context) {
      if (testCase.category !== "delivery") return gateway.executeCase(testCase, context);
      const type = controlType(testCase);
      const state = { settled: false, delivery: true };
      states.set(testCase.id, state);
      if (UNSAFE_CONTROLS.has(type)) {
        state.settled = true;
        await appendLedger(context, { event: "delivery_control_blocked", caseId: testCase.id, type });
        return block(`No safe authentic Feishu ${type} platform control is available; no input sent`);
      }
      if (!DELIVERY_CONTROLS.has(type)) { state.settled = true; return block("Unsupported Feishu delivery control; no input sent"); }
      const agentId = config.logicalAgentMap[testCase.agentProfile];
      if (!agentId) { state.settled = true; return block("Agent profile not authorized for Feishu delivery"); }
      const ledgerDoc = JSON.parse(await readFile(config.chatLedgerPath, "utf8"));
      const physical = selectPhysical(ledgerDoc, agentId);
      await mkdir(context.runDir, { recursive: true, mode: 0o700 });
      const marker = join(context.runDir, `feishu-case-${hash(`${context.runId}:${testCase.id}`).slice(0, 24)}.json`);
      await writeFile(marker, JSON.stringify({ caseId: testCase.id, runId: context.runId, type }), { flag: "wx", mode: 0o600 });
      const startedAt = Date.now();
      const usage = { ...zeroUsage(), priced: false };
      const controlReceipts = [];
      try {
        const hostConfig = JSON.parse(await readFile(config.configPath, "utf8"));
        assert.equal(hostConfig.channels.feishu.accounts[agentId].appId, physical.botAppId);
        const members = await lark(["im", "+chat-members-list", "--as", "user", "--chat-id", physical.chatId,
          "--page-all"], context, "members");
        const membership = shortcutData(members);
        assert.equal(membership.bots?.length, 1);
        assert.equal(membership.users?.length, 1);
        assert.equal(membership.bots[0].app_id, physical.botAppId);
        assert.equal(membership.bots[0].member_id, physical.botMemberId);
        assert.equal(membership.users[0].member_id, physical.creatorMemberId);
        if (type === "new-reset-prompt") {
          const before = await snapshotBoundary(physical, agentId);
          const resetMessage = await sendText(physical, "/new", context, "reset");
          state.controlMessages = [resetMessage.outboundId];
          await findInbound(physical, resetMessage, context);
          const reset = await waitForReset(physical, agentId, before, context);
          controlReceipts.push({
            type: "new-reset-prompt", transportControlled: true, selfAsserted: false,
            receiptId: reset.boundary.resetId, controlMessageId: resetMessage.outboundId,
          });
        }
        assert.equal(typeof testCase.prompt, "string", "Feishu delivery uses only the original prompt string");
        const sent = await sendText(physical, testCase.prompt, context, "send");
        state.activeMessageId = sent.outboundId;
        const inbound = await findInbound(physical, sent, context);
        assertReadbackEnvelope(inbound, physical, physical.creatorMemberId, "inbound");
        const inboundId = messageId(inbound);
        assert.equal(inboundId, sent.outboundId, "Inbound readback id changed");
        const settled = await settleNative(physical, agentId, inboundId, testCase.prompt, context,
          type === "new-reset-prompt", testCase.limits?.timeoutMs);
        const rows = await (options.readNativeRows ?? readNativeRows)(settled.directory);
        const native = nativeTurnEvidence(rows, settled.canonical);
        const business = native.calls.filter((call) => call.name !== "dsh_prepare_task");
        const outputText = textOf(settled.canonical);
        const reply = await verifyBotReadback(physical, inbound, outputText, context, sent.submittedAt);
        assert.equal(messageChatId(reply), physical.chatId);
        const mode = settled.binding.taskPreparation?.state?.mode;
        if (!["chat", "clarify", "draft", "execute"].includes(mode)) throw new Error("Missing actual native preparation mode");
        const usageErrors = validateUsageShape(native.usage);
        if (usageErrors.length) throw new Error(usageErrors.join("; "));
        context.reportUsage(native.usage);
        Object.assign(usage, sumUsage(usage, native.usage));
        const effects = sideEffects(business);
        state.settled = !effects.unknown && effects.effects.length === 0 && business.length === 0;
        state.activeMessageId = undefined;
        await appendLedger(context, {
          event: "turn_settled", caseId: testCase.id, receiptIdHash: hash(messageId(reply)),
          inboundIdHash: hash(inboundId), runId: settled.runId,
        });
        const preparation = hostConfig.plugins.entries["dsh-native"].config.taskPreparation;
        const advertised = preparation.skillAllowlistByAgent?.[agentId] ?? preparation.skillAllowlist;
        const turn = {
          agentProfile: testCase.agentProfile, prompt: testCase.prompt, outputText,
          mode, executionStatus: mode === "clarify" ? "correctly_blocked" : "completed",
          tools: business, skill: { advertised, selected: [], loaded: [] }, usage: native.usage,
          delivery: {
            delivered: true, terminalOutputs: 1, receiptId: messageId(reply),
            recipient: physical.chatId, transport: "feishu", inboundId,
          },
          provider: native.provider, model: native.model, sessionId: settled.sessionId,
          nativeSessionId: settled.binding.sessionId, runId: settled.runId,
        };
        return {
          executionStatus: turn.executionStatus, businessResult: "partial", outputText,
          turns: [turn], usage, sideEffects: effects.effects,
          unknownEffects: effects.unknown || business.length > 0 || undefined,
          controlReceipts, controlMessages: state.controlMessages ?? [],
          delivery: { delivered: true, terminalOutputs: 1, recipient: physical.chatId, transport: "feishu" },
          policyFacts: { mode, adapter: "real-Feishu", actualReadbackReceipt: true, businessToolCalls: business.length },
          latencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        state.settled = false;
        await appendLedger(context, { event: "case_failed", caseId: testCase.id, reason: error.message });
        throw error;
      }
    },
    async cleanupCase(testCase, context) {
      if (testCase.category !== "delivery") return gateway.cleanupCase(testCase, context);
      const state = states.get(testCase.id);
      if (!state) return { cleaned: false, error: "No Feishu delivery execution/skip receipt for this case" };
      if (state.activeMessageId) return { cleaned: false, error: "Feishu user input was sent and settlement is uncertain; cannot unsend" };
      return state.settled ? { cleaned: true, receipt: "Actual Feishu delivery settled or was safely skipped; private read-only receipts retained" }
        : { cleaned: false, error: "Actual Feishu delivery failed or had unexpected side effects; review private receipt ledger" };
    },
    async close() {
      if (typeof gateway.close === "function") await gateway.close();
    },
  };
}

export function createAdapter() {
  return createFeishuAcceptanceAdapter();
}

