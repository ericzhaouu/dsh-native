import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { prepareIsolatedHost } from "./feishu-isolated-sdk-host.mjs";
import { startResponsesServer } from "./responses-server.mjs";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(dirname(fixtureDir));
const operations = ["ingress-redelivery", "accepted-lost-ack", "owned-socket-reconnect"];
const envelopeKeys = ["providerId", "evidenceClass", "epoch", "scope", "caseId", "runId",
  "type", "challenge", "promptSha256", "operation"];
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const preparationTool = "dsh_prepare_task";
const envelope = (request) => structuredClone(Object.fromEntries(envelopeKeys.map((key) => [key, request[key]])));
const binding = (request) => JSON.stringify(envelopeKeys.filter((key) => key !== "operation")
  .map((key) => key === "scope" ? ["agentId", "chatId", "accountId", "channel"].map((name) => request.scope[name]) : request[key]));

async function bounded(promise, timeoutMs, signal) {
  let timer;
  let abort;
  try {
    signal?.throwIfAborted();
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Isolated SDK operation timed out after ${timeoutMs}ms`)), timeoutMs);
      abort = () => reject(signal.reason ?? new Error("Isolated SDK operation aborted"));
      signal?.addEventListener("abort", abort, { once: true });
    })]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

function privateEnvironment(root, ports) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ["systemroot", "windir", "comspec", "pathext", "path"].includes(key.toLowerCase())));
  const home = join(root, "home");
  return {
    ...inherited, HOME: home, USERPROFILE: home, OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: join(root, "state"), OPENCLAW_CONFIG_PATH: join(root, "openclaw.json"),
    APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"), XDG_RUNTIME_DIR: join(root, "runtime"),
    DSH_HOME: join(root, "dsh-home"), TEMP: join(root, "tmp"), TMP: join(root, "tmp"), TMPDIR: join(root, "tmp"),
    DSH_ISOLATED_PORTS: JSON.stringify(ports), DSH_ISOLATED_ROOT: root, DO_NOT_TRACK: "1", FORCE_COLOR: "0",
    NODE_DISABLE_COMPILE_CACHE: "1",
  };
}

// Synthetic loopback transport and model; genuine SDK ingress, dedupe and native harness.
// This provider deliberately never labels its observations actual Feishu certification.
export async function createIsolatedSdkTransportProvider({
  id = `isolated-sdk-${randomUUID()}`, epoch = randomUUID(),
  scope = { agentId: "isolated-agent", chatId: "isolated-chat", accountId: "isolated-account", channel: "dsh-isolated" },
  outputText = "ISOLATED-SDK-REPLY", timeoutMs = 180000, taskPreparation = false,
} = {}) {
  assert.equal(process.platform, "linux",
    "Full isolated SDK fixture is Linux-only: Windows SDK process-start queries require forbidden spawnSync");
  for (const value of [id, epoch, outputText]) assert.ok(typeof value === "string" && value.length > 0);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 300000);
  assert.equal(typeof taskPreparation, "boolean", "Preparation is an explicit fixture opt-in");
  const expectedCalls = taskPreparation ? 2 : 1;
  assert.deepEqual(Object.keys(scope).sort(), ["accountId", "agentId", "channel", "chatId"]);
  for (const value of Object.values(scope)) assert.match(value, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/u);
  assert.ok(scope.agentId.length <= 64);
  scope = Object.freeze({ ...scope });
  const capabilities = Object.freeze({
    id, evidenceClass: "isolated-sdk", epoch, scope, dedicated: true, operations: Object.freeze([...operations]),
  });
  const root = join(packageRoot, "artifacts", "repairs-074-20260921", "channel-linux",
    `feishu-isolated-sdk-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await Promise.all(["tmp", "runtime", "dsh-home"].map((name) => mkdir(join(root, name), { mode: 0o700 })));
  const journalPath = join(root, "operations.jsonl");
  await writeFile(journalPath, "", { mode: 0o600 });
  let sequence = 0;
  let active;
  let modelActive = 0;
  let failure;
  let unresolvedReply;
  let closed = false;
  let closing;
  let child;
  let responses;
  let childClosed = Promise.resolve();
  let transport;
  let diagnostics = "";
  const sockets = new Map();
  const pending = new Map();
  const prepared = new Set();
  const consumed = new Set();
  const record = (event) => {
    appendFileSync(journalPath, `${JSON.stringify({ ...event, sequence: ++sequence })}\n`);
  };
  const journal = async () => (await readFile(journalPath, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
  const health = () => { assert.ok(!closed, "Provider is closed"); if (failure) throw failure; };
  const fail = (error) => {
    failure ??= error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  const rpc = (method, params = {}) => {
    assert.ok(child?.connected, "Private SDK child disconnected");
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      child.send({ id: requestId, method, ...params }, (error) => {
        if (error) { pending.delete(requestId); reject(error); }
      });
    });
  };
  const rowsFor = (rows, callbackId) => rows.filter((row) => row.callbackId === callbackId &&
    !["issued-receipt", "verification"].includes(row.kind));
  const idle = (snapshot) => !snapshot.busy && snapshot.activeNative === 0 && snapshot.activeInbound === 0 &&
    snapshot.activeSends === 0 && snapshot.pendingAcks === 0 && snapshot.connected && modelActive === 0;

  async function close() {
    if (closing) return closing;
    closing = (async () => {
      closed = true;
      const errors = [];
      if (child?.connected) {
        try {
          assert.equal((await bounded(rpc("close"), 25000)).closed, true);
        } catch (error) { errors.push(error); }
      }
      try {
        const status = await bounded(childClosed, 10000);
        if (child) assert.deepEqual(status, { code: 0, signal: null }, "Private SDK worker failed during shutdown");
      }
      catch (error) {
        errors.push(error);
        child?.kill("SIGKILL");
        try { await bounded(childClosed, 5000); } catch (cause) { errors.push(cause); }
      }
      for (const socket of sockets.values()) socket.destroy();
      if (transport?.listening) await new Promise((resolve) => transport.close(resolve));
      if (responses) await responses.close();
      fail(new Error("Provider closed"));
      await writeFile(join(root, "worker.log"), diagnostics, { mode: 0o600 });
      record({ kind: "provider-closed", errors: errors.map((error) => error.stack ?? error.message) });
      if (errors.length) throw new AggregateError(errors, "Private fixture cleanup failed");
    })();
    return closing;
  }

  try {
    transport = createServer((socket) => {
      const connectionId = `connection-${randomUUID()}`;
      sockets.set(connectionId, socket);
      record({ kind: "server-connected", connectionId, ownerId: id });
      socket.setEncoding("utf8");
      let buffer = "";
      let callbackId;
      socket.on("error", () => {});
      socket.once("close", () => {
        sockets.delete(connectionId);
        record({ kind: "server-closed", connectionId, callbackId });
      });
      socket.on("data", (chunk) => {
        try {
          buffer += chunk;
          assert.ok(buffer.length <= 1024 * 1024, "Oversized outbound frame");
          for (let end; (end = buffer.indexOf("\n")) >= 0;) {
            const frame = JSON.parse(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
            assert.equal(frame.kind, "send");
            assert.ok(active, "Server received outbound outside an active execution");
            assert.equal(frame.ownerId, id);
            assert.equal(frame.callbackId, active.callbackId);
            assert.equal(frame.eventId, active.eventId);
            assert.equal(frame.messageId, active.messageId);
            assert.equal(frame.to, scope.chatId);
            assert.equal(frame.accountId, scope.accountId);
            assert.equal(typeof frame.replyId, "string");
            assert.equal(typeof frame.text, "string");
            callbackId = frame.callbackId;
            // Every actual acceptance is counted, including accidental duplicates.
            record({ ...frame, kind: "server-accepted", connectionId });
            if (active.type === "reconnect-ack") {
              record({ kind: "ack-dropped", callbackId, connectionId, replyId: frame.replyId });
              socket.destroy(); // No ACK bytes and no foreign socket/process manipulation.
            } else {
              socket.write(`${JSON.stringify({ kind: "ack", replyId: frame.replyId, connectionId })}\n`);
              record({ kind: "ack-written", callbackId, connectionId, replyId: frame.replyId });
            }
          }
        } catch (error) { fail(error); socket.destroy(); }
      });
      socket.write(`${JSON.stringify({ kind: "hello", ownerId: id, connectionId })}\n`);
    });
    await new Promise((resolve, reject) => {
      transport.once("error", reject);
      transport.listen(0, "127.0.0.1", resolve);
    });
    transport.on("error", fail);
    responses = await startResponsesServer(({ body, tool, text, finish, response }) => {
      try {
        assert.ok(active, "Unscoped model request");
        const callbackId = active.callbackId;
        assert.ok(active.ingressId && active.nativeRunId, "Model request has no observed SDK ingress/native run");
        const requestId = `model-${randomUUID()}`;
        const attribution = { callbackId, requestId, ingressId: active.ingressId,
          eventId: active.eventId, messageId: active.messageId, runId: active.nativeRunId };
        const usage = { input_tokens: 20, output_tokens: 8, total_tokens: 28,
          input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } };
        const toolNames = (body.tools ?? []).map((entry) => entry.name);
        const outputs = (body.input ?? []).filter((entry) => entry.type === "function_call_output");
        const phase = toolNames.includes(preparationTool) ? "preparation" : outputs.length ? "final" : "text";
        modelActive++;
        record({ kind: "model-request", ...attribution, model: body.model, bodySha256: sha256(JSON.stringify(body)),
          phase, toolNames, ...(taskPreparation ? { body } : {}) });
        let ended = false;
        response.once("finish", () => {
          ended = true;
          modelActive--;
          record({ kind: "model-response-ended", ...attribution, phase, usage });
        });
        response.once("close", () => {
          if (!ended) { modelActive--; fail(new Error("Model response closed before completion")); }
        });
        if (taskPreparation && phase === "preparation") {
          assert.ok(!active.preparation, "Only one preparation call per original ingress");
          assert.deepEqual(toolNames, [preparationTool], "Only the internal control is exposed");
          const control = body.tools[0];
          const jsonStart = control.description.indexOf("\n{");
          assert.notEqual(jsonStart, -1);
          const request = JSON.parse(control.description.slice(jsonStart + 1));
          assert.equal(request.version, 1);
          assert.equal(request.userText, active.prompt, "Preparation must use the original admission text");
          assert.deepEqual(request.policy, {
            version: 1, executionTools: [], skillAllowlist: [], maxClarificationTurns: 1, maxToolCalls: 1,
          });
          const revision = request.previous?.revision ?? 0;
          assert.equal(control.parameters.properties.revision.const, revision);
          const decision = {
            version: 1, revision, mode: "draft", task: "new",
            goal: "Return the requested isolated text reply.", deliverables: ["One text reply"],
            constraints: ["Read-only: no host tools, file changes or external actions."],
            assumptions: [], unresolved: [], question: "",
            enhancedPrompt: "Return only the requested text; do not perform any actions.",
            evidence: { source: "current", quote: request.userText.slice(0, 512) },
          };
          const callId = `prepare-${randomUUID()}`;
          active.preparation = { callId, decision, users: body.input.filter((entry) => entry.role === "user") };
          tool(preparationTool, decision, callId);
        } else {
          assert.deepEqual(body.tools ?? [], [], "No host tools or business actions in isolated fixture");
          if (taskPreparation) {
            assert.equal(phase, "final", "Final request must contain the native preparation result");
            assert.ok(active.preparation, "Final response requires an observed preparation request");
            const { callId, decision, users } = active.preparation;
            assert.deepEqual(body.input.filter((entry) => entry.role === "user"), users);
            const calls = body.input.filter((entry) => entry.type === "function_call" && entry.call_id === callId);
            const results = outputs.filter((entry) => entry.call_id === callId);
            assert.equal(calls.length, 1);
            assert.equal(calls[0].name, preparationTool);
            assert.deepEqual(JSON.parse(calls[0].arguments), decision);
            assert.equal(results.length, 1);
            const { evidence: _evidence, task: _task, ...brief } = decision;
            assert.deepEqual(JSON.parse(results[0].output), {
              version: 1, decision, allowedTools: [],
              state: { ...brief, revision: decision.revision + 1, sourceRunId: active.nativeRunId,
                requestText: active.prompt, clarificationTurns: 0 },
            }, "Native preparation resolution must retain the original owner and allow zero host tools");
          }
          text(outputText);
        }
        finish(usage);
      } catch (error) { fail(error); throw error; }
    });
    await prepareIsolatedHost(root, {
      scope, providerId: id, transportPort: transport.address().port, modelBaseUrl: responses.baseUrl, taskPreparation,
    });
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    child = spawn(process.execPath, [
      "--import", pathToFileURL(join(fixtureDir, "feishu-isolated-sdk-guard.mjs")).href,
      join(fixtureDir, "feishu-isolated-sdk-host.mjs"), "--worker", root,
    ], {
      cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: privateEnvironment(root, [transport.address().port, Number(new URL(responses.baseUrl).port)]),
    });
    childClosed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    child.on("error", (error) => { readyReject(error); fail(error); });
    child.on("close", (code, signal) => {
      record({ kind: "worker-closed", pid: child.pid, code, signal });
      if (!closed) {
        const error = new Error(`Private SDK child exited (${code}, ${signal})\n${diagnostics}`);
        readyReject(error);
        fail(error);
      }
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-16000); });
      stream.on("error", fail);
    }
    child.on("message", (message) => {
      try {
        if (message.kind === "ready") readyResolve();
        else if (message.kind === "fatal") { const error = new Error(message.message); readyReject(error); fail(error); }
        else if (message.kind === "journal") {
          if (["native-start", "send-attempt", "sdk-ingest"].includes(message.event.kind)) {
            assert.ok(message.event.callbackId, "Runtime activity escaped the isolated execution");
          }
          if (message.event.kind === "ingress-start") {
            assert.ok(active && !active.ingressId, "Overlapping or unscoped SDK ingress");
            assert.equal(message.event.eventId, active.eventId);
            assert.equal(message.event.messageId, active.messageId);
            active.ingressId = message.event.ingressId;
          } else if (message.event.kind === "native-start") {
            assert.ok(active?.ingressId && !active.nativeRunId, "Unscoped or overlapping native run");
            assert.equal(message.event.ingressId, active.ingressId);
            active.nativeRunId = message.event.nativeRunId;
          } else if (message.event.kind === "native-end" || message.event.kind === "native-error") {
            assert.equal(message.event.nativeRunId, active?.nativeRunId);
            active.nativeRunId = undefined;
          } else if (message.event.kind === "sdk-return") {
            assert.equal(message.event.ingressId, active?.ingressId);
            assert.ok(!active.nativeRunId && modelActive === 0, "SDK returned before model/native settlement");
            active.ingressId = undefined;
          }
          record(message.event);
          if (message.journalId) child.send({ kind: "journal-ack", journalId: message.journalId });
        } else if (message.kind === "response") {
          const request = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) request?.reject(new Error(message.error.stack ?? message.error.message));
          else request?.resolve(message.result);
        }
      } catch (error) { readyReject(error); fail(error); }
    });
    await bounded(ready, timeoutMs);
    health();
  } catch (error) {
    let cleanupError;
    try { await close(); } catch (cause) { cleanupError = cause; }
    if (cleanupError) throw new AggregateError([error, cleanupError],
      `Isolated SDK boot and cleanup failed: ${error.message}; ${cleanupError.message}\n${diagnostics}`);
    throw new Error(`Isolated SDK boot failed: ${error.message}\n${diagnostics}`, { cause: error });
  }

  function validate(request, operation) {
    health();
    request.signal?.throwIfAborted();
    assert.equal(request.providerId, id);
    assert.equal(request.evidenceClass, "isolated-sdk");
    assert.equal(request.epoch, epoch);
    assert.deepEqual(request.scope, scope);
    assert.ok(["duplicate-replay", "reconnect-ack"].includes(request.type), "Isolated text transport does not implement card-fallback");
    assert.equal(request.operation, operation);
    for (const key of ["caseId", "runId", "challenge"]) assert.ok(typeof request[key] === "string" && request[key].length > 0);
    assert.match(request.promptSha256, /^[a-f0-9]{64}$/u);
    if (operation === "prepare") assert.equal(Object.hasOwn(request, "prompt"), false);
  }

  async function quiet(callbackId, signal) {
    const first = rowsFor(await journal(), callbackId);
    const firstSnapshot = await bounded(rpc("snapshot"), timeoutMs, signal);
    await delay(150, undefined, { signal });
    const secondSnapshot = await bounded(rpc("snapshot"), timeoutMs, signal);
    const second = rowsFor(await journal(), callbackId);
    health();
    return idle(firstSnapshot) && idle(secondSnapshot) && first.length === second.length;
  }

  function executionEvidence(rows, receipt, quiescent) {
    const observed = rowsFor(rows, receipt.callbackId);
    const of = (kind) => observed.filter((row) => row.kind === kind);
    const ingresses = of("sdk-ingest");
    assert.ok(ingresses.length > 0, "No genuine SDK ingress observed");
    const first = ingresses[0];
    for (const ingress of ingresses) {
      assert.equal(ingress.eventId, first.eventId);
      assert.equal(ingress.messageId, first.messageId);
      assert.equal(ingress.bodySha256, receipt.promptSha256);
      assert.equal(ingress.canonicalSha256, first.canonicalSha256, "Redelivery must preserve the canonical raw event");
    }
    const starts = of("native-start");
    const ends = of("native-end");
    const accepts = of("server-accepted");
    const sends = of("send-attempt");
    assert.equal(starts.length, 1, "Expected one actually observed native attempt");
    assert.equal(ends.length, starts.length);
    assert.equal(ends[0].nativeRunId, starts[0].nativeRunId);
    assert.ok(typeof starts[0].nativeRunId === "string" && starts[0].nativeRunId.length > 0);
    assert.equal(of("native-error").length, 0);
    assert.equal(of("model-request").length, expectedCalls, "Exact fixture-configured count, not a generic control limit");
    assert.deepEqual(of("model-request").map((row) => row.phase),
      taskPreparation ? ["preparation", "final"] : ["text"], "Phases come from physical request bodies");
    assert.equal(of("model-response-ended").length, of("model-request").length);
    assert.equal(accepts.length, 1, "Terminal receipts count actual server acceptances, not deduped IDs");
    assert.equal(sends.length, accepts.length);
    assert.equal(sends[0].replyId, accepts[0].replyId);
    assert.equal(accepts[0].eventId, first.eventId);
    assert.equal(accepts[0].messageId, first.messageId);
    const ingressStarts = of("ingress-start");
    const returns = of("sdk-return");
    const requests = of("model-request");
    assert.equal(ingressStarts.length, ingresses.length);
    assert.equal(returns.length, ingresses.length);
    const ingressEvidence = ingressStarts.map((start, index) => {
      const ingest = ingresses[index];
      const returned = returns[index];
      assert.equal(ingest.ingressId, start.ingressId);
      assert.equal(returned.ingressId, start.ingressId);
      assert.ok(start.sequence < ingest.sequence && ingest.sequence < returned.sequence);
      if (index) assert.ok(returns[index - 1].sequence < start.sequence);
      const attributed = requests.filter((row) => row.sequence > ingest.sequence && row.sequence < returned.sequence);
      for (const row of attributed) {
        assert.equal(row.ingressId, start.ingressId);
        assert.equal(row.eventId, ingest.eventId);
        assert.equal(row.messageId, ingest.messageId);
        assert.equal(row.runId, starts[0].nativeRunId);
        assert.ok(starts[0].sequence < row.sequence && row.sequence < ends[0].sequence);
        const completions = of("model-response-ended").filter((end) => end.requestId === row.requestId);
        assert.equal(completions.length, 1);
        assert.ok(row.sequence < completions[0].sequence && completions[0].sequence < returned.sequence);
      }
      return {
        ingressId: start.ingressId, kind: index === 0 ? "ingress" : "redeliver",
        eventId: ingest.eventId, messageId: ingest.messageId,
        modelRequestsBefore: requests.filter((row) => row.sequence < start.sequence).length,
        modelRequestsAfter: requests.filter((row) => row.sequence < returned.sequence).length,
        modelRequestIds: attributed.map((row) => row.requestId),
        runIds: starts.filter((row) => row.sequence < returned.sequence).map((row) => row.nativeRunId),
      };
    });
    assert.deepEqual(ingressEvidence[0].modelRequestIds, requests.map((row) => row.requestId),
      "All model work must belong to the original SDK ingress");
    assert.equal(ingressEvidence[0].modelRequestsBefore, 0);
    for (const entry of ingressEvidence.slice(1)) {
      assert.equal(entry.modelRequestsAfter - entry.modelRequestsBefore, 0, "SDK redelivery must not infer");
      assert.deepEqual(entry.modelRequestIds, []);
    }
    assert.equal(new Set(requests.map((row) => row.requestId)).size, requests.length);
    assert.equal(of("execution-settled").length, 1);
    assert.equal(of("sdk-message-received").length, 1, "SDK admission should suppress the redelivered event");
    assert.ok(quiescent, "Runtime/model/send work has not settled");
    const inbound = { eventId: first.eventId, messageId: first.messageId, bodySha256: first.bodySha256 };
    const identity = { eventId: first.eventId, messageId: first.messageId };
    const actualOperations = [{ kind: "ingress", ...identity }];
    const ackReceived = of("ack-received");
    if (receipt.type === "duplicate-replay") {
      assert.equal(ingresses.length, 2);
      assert.equal(ackReceived.length, accepts.length);
      assert.equal(ackReceived[0].replyId, accepts[0].replyId);
      assert.equal(of("ack-dropped").length, 0);
      assert.equal(ends[0].terminal, "ok");
      assert.equal(ends[0].outputDelivered, true);
      actualOperations.push({ kind: "redeliver", ...identity });
    } else {
      assert.equal(ingresses.length, 1);
      assert.equal(ackReceived.length, 0);
      assert.equal(of("ack-written").length, 0);
      assert.equal(of("ack-dropped").length, 1);
      assert.equal(of("ack-dropped")[0].replyId, accepts[0].replyId);
      assert.equal(ends[0].terminal, "failed");
      assert.equal(ends[0].receiptState, "unknown-after-started");
      const reconnects = of("owned-socket-reconnect");
      assert.equal(reconnects.length, 1);
      const reconnect = reconnects[0];
      assert.equal(reconnect.ownerId, id);
      assert.notEqual(reconnect.previousConnectionId, reconnect.connectionId);
      assert.equal(reconnect.previousConnectionId, accepts[0].connectionId);
      assert.ok(of("server-closed").some((row) => row.connectionId === reconnect.previousConnectionId));
      for (const connectionId of [reconnect.previousConnectionId, reconnect.connectionId]) {
        assert.ok(rows.some((row) => row.kind === "server-connected" && row.ownerId === id && row.connectionId === connectionId));
      }
      actualOperations.push({ kind: "accepted-lost-ack", ...identity, replyId: accepts[0].replyId },
        { kind: "owned-socket-reconnect", ...identity, previousConnectionId: reconnect.previousConnectionId,
          connectionId: reconnect.connectionId, ownerId: id });
    }
    return {
      inbound, operations: actualOperations,
      observation: {
        inboundEventId: first.eventId, inboundMessageId: first.messageId, bodySha256: first.bodySha256,
        runIds: starts.map((row) => row.nativeRunId), modelRequests: of("model-request").length,
        modelRequestIds: requests.map((row) => row.requestId), ingressEvidence,
        modelRequestEvidence: requests.map(({ requestId, ingressId, eventId, messageId, runId }) =>
          ({ requestId, ingressId, eventId, messageId, runId })),
        terminalReplyIds: accepts.map((row) => row.replyId),
        delivery: { receiptId: accepts[0].replyId, acknowledgement: ackReceived.length ? "received" : "unknown" },
        ingressCount: ingresses.length, sendAttempts: sends.length, quiescent, outputText: accepts[0].text,
        usage: {
          modelRequests: of("model-request").length,
          inputTokens: of("model-response-ended").reduce((sum, row) => sum + row.usage.input_tokens, 0),
          outputTokens: of("model-response-ended").reduce((sum, row) => sum + row.usage.output_tokens, 0),
          cacheReadTokens: of("model-response-ended").reduce((sum, row) => sum + row.usage.input_tokens_details.cached_tokens, 0),
          cacheWriteTokens: 0, toolCalls: 0, userTurns: new Set(ingresses.map((row) => row.messageId)).size, priced: false,
        },
      },
    };
  }

  return {
    capabilities, close, evidenceRoot: root,
    async prepare(request) {
      validate(request, "prepare");
      assert.ok(!unresolvedReply, "Previous source reply settlement is unconfirmed; a new case cannot clear this scope fence");
      assert.ok(!active, "Another case owns the isolated transport");
      const snapshot = await bounded(rpc("snapshot"), timeoutMs, request.signal);
      health();
      request.signal?.throwIfAborted();
      assert.ok(idle(snapshot) && sockets.has(snapshot.connectionId), "Owned transport/runtime not ready");
      const receipt = { ...envelope(request), receiptId: randomUUID(), callbackId: randomUUID(),
        readyOperations: [...operations] };
      record({ kind: "prepared", callbackId: receipt.callbackId, connectionId: snapshot.connectionId,
        readyOperations: [...operations] });
      record({ kind: "issued-receipt", receipt });
      prepared.add(binding(request));
      return structuredClone(receipt);
    },
    async perform(request) {
      validate(request, "execute");
      assert.ok(!unresolvedReply, "Previous source reply settlement is unconfirmed; never resend or admit a new case");
      assert.equal(typeof request.prompt, "string");
      assert.equal(sha256(request.prompt), request.promptSha256, "Prompt does not match the preparation binding");
      assert.ok(!active, "Another case owns the isolated transport");
      const key = binding(request);
      assert.ok(prepared.has(key), "Prepare the exact request before executing");
      assert.ok(!consumed.has(key), "An executed or uncertain case must never be replayed automatically");
      consumed.add(key);
      const receipt = { ...envelope(request), receiptId: randomUUID(), callbackId: randomUUID() };
      const raw = { eventId: `isolated-event-${randomUUID()}`, messageId: `isolated-inbound-${randomUUID()}`,
        timestamp: Date.now(), prompt: request.prompt };
      active = { ...raw, callbackId: receipt.callbackId, type: request.type };
      try {
        await bounded(rpc("execute", { raw, callbackId: receipt.callbackId, type: request.type }), timeoutMs, request.signal);
        const quiescent = await quiet(receipt.callbackId, request.signal);
        const actual = executionEvidence(await journal(), receipt, quiescent);
        health();
        receipt.inbound = actual.inbound;
        receipt.operations = actual.operations;
        if (actual.observation.delivery.acknowledgement === "unknown") {
          unresolvedReply = actual.observation.delivery.receiptId;
          record({ kind: "scope-fenced", callbackId: receipt.callbackId, replyId: unresolvedReply, scope });
        }
        record({ kind: "issued-receipt", receipt });
        return structuredClone(receipt);
      } catch (error) {
        // Abort/timeout consumes the request and tears down only this provider; never re-infer.
        const roots = (await journal()).filter((row) => ["native-end", "native-error"].includes(row.kind));
        record({ kind: "execution-failed", error: error.stack, roots });
        diagnostics += `\nNative terminal evidence: ${JSON.stringify(roots)}`;
        let cleanupError;
        try { await close(); } catch (cause) { cleanupError = cause; }
        if (cleanupError) throw new AggregateError([error, cleanupError],
          `Isolated SDK execution and cleanup failed: ${error.message}; ${cleanupError.message}\n${diagnostics}`);
        throw new Error(`Isolated SDK execution failed: ${error.message}\n${diagnostics}`, { cause: error });
      } finally { active = undefined; }
    },
    async verify(request, receipt) {
      assert.ok(["prepare", "execute"].includes(request.operation));
      validate(request, request.operation);
      assert.ok(!active, "Verify only after execution settlement");
      const rows = await journal();
      const issued = rows.find((row) => row.kind === "issued-receipt" && row.receipt.receiptId === receipt?.receiptId);
      assert.ok(issued, "Receipt is not in this provider's private operation journal");
      assert.deepEqual(receipt, issued.receipt, "Forged receipt differs from the independently stored receipt");
      assert.deepEqual(envelope(request), envelope(issued.receipt), "Receipt belongs to a different challenge/request");
      const result = { ...structuredClone(issued.receipt), verifiedReceiptId: issued.receipt.receiptId, verificationId: randomUUID() };
      if (request.operation === "execute") {
        const quiescent = await quiet(issued.receipt.callbackId, request.signal);
        const actual = executionEvidence(await journal(), issued.receipt, quiescent);
        assert.deepEqual(issued.receipt.inbound, actual.inbound);
        assert.deepEqual(issued.receipt.operations, actual.operations);
        result.observation = actual.observation;
      } else {
        const preparation = rows.find((row) => row.kind === "prepared" && row.callbackId === issued.receipt.callbackId);
        assert.ok(preparation);
        assert.deepEqual(issued.receipt.readyOperations, preparation.readyOperations);
        assert.ok(rows.some((row) => row.kind === "server-connected" && row.connectionId === preparation.connectionId && row.ownerId === id));
      }
      health();
      request.signal?.throwIfAborted();
      record({ kind: "verification", ...result });
      return result;
    },
  };
}
