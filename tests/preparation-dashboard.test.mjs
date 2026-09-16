import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { zstdDecompressSync } from "node:zlib";
import test from "node:test";
import { messageText, startDashboardGateway } from "./fixtures/dashboard-gateway.mjs";

const CONTROL_TOOL = "dsh_prepare_task";
const TASK_PREPARATION = {
  agentIds: ["dashboard-fixture"],
  executionTools: ["read", "write", "exec"],
  skillAllowlist: [],
  maxClarificationTurns: 3,
  maxToolCalls: 24,
};
const FIXTURE_TEXT = "DASHBOARD-HOST-READ\n";
const REPORT_TEXT = "DASHBOARD-PREPARED-REPORT\n";
const PROTECTED_TEXT = "DASHBOARD-PREPARATION-DO-NOT-DELETE\n";

function inputText(item) {
  if (typeof item.content === "string") return item.content;
  return Array.isArray(item.content)
    ? item.content.map((block) => typeof block.text === "string" ? block.text : "").join("")
    : "";
}

function decision(overrides) {
  return {
    version: 1, revision: 0, mode: "chat", task: "none",
    goal: "", deliverables: [], constraints: [], assumptions: [], unresolved: [],
    question: "", enhancedPrompt: "", evidence: { source: "current", quote: "" },
    ...overrides,
  };
}

function freshSession(gateway, name) {
  return `agent:${gateway.agentId}:preparation-${name}-${randomUUID()}`;
}

function makeTurn(sessionKey, message, preparationDecision, answer, hostCalls = []) {
  const runId = `prep-${randomUUID()}`;
  return {
    sessionKey, runId, message, decision: preparationDecision, answer,
    controlId: `${runId}_prepare`,
    plannerMarker: `PRIVATE-PREPARATION-TEXT-${runId}`,
    reasoningMarker: `PRIVATE-PREPARATION-REASONING-${runId}`,
    hostCalls: hostCalls.map((call, index) => ({ ...call, callId: `${runId}_host_${index}` })),
  };
}

function toolsOf(body) {
  return (body.tools ?? []).map((tool) => tool.name);
}

function outputFor(body, callId) {
  const outputs = body.input.filter((item) => item.type === "function_call_output" && item.call_id === callId);
  assert.equal(outputs.length, 1, `Exactly one native result for ${callId}`);
  assert.equal(typeof outputs[0].output, "string");
  return outputs[0].output;
}

function assertModelRequest(body, turn) {
  assert.equal(body.model, "gpt-6-astra");
  assert.equal(body.store, false);
  assert.equal(body.reasoning.effort, "medium");
  assert.ok(Array.isArray(body.input));
  assert.equal(body.input[0].role, "developer");
  const system = body.input.filter((item) => ["system", "developer"].includes(item.role)).map(inputText).join("\n");
  assert.match(system, /DSH callback-only host/, "Keep the source host instructions");
  assert.doesNotMatch(system, /^## Skills\b/im, "The public Skills catalog is not advertised by default");
  assert.doesNotMatch(system, /<available_skills>|<skill>/i);
  const users = body.input.filter((item) => item.role === "user");
  assert.ok(inputText(users.at(-1)).includes(turn.message), "The original user prompt still reaches the model");
  if (turn.firstInput) {
    assert.deepEqual(users, turn.firstInput.filter((item) => item.role === "user"),
      "Preparation must not replace or append an enhanced prompt as user input");
  }
}

function assertInitialPreparation(body, turn) {
  assert.deepEqual(toolsOf(body), [CONTROL_TOOL], "First model step exposes only the internal preparation control");
  const control = body.tools[0];
  assert.equal(control.parameters.properties.revision.const, turn.decision.revision);
  // The core control definition carries the bounded request as JSON after its prose description.
  const jsonStart = control.description.indexOf("\n{");
  assert.notEqual(jsonStart, -1, "The planner must receive its original user text and compact previous brief");
  const request = JSON.parse(control.description.slice(jsonStart + 1));
  const { agentIds: _agentIds, ...policy } = TASK_PREPARATION;
  assert.deepEqual(request.policy, { version: 1, ...policy });
  assert.equal(request.userText, turn.message, "Admission text, not an enhanced or generated prompt");
  assert.equal(request.version, 1);
  if (turn.previousState) {
    assert.deepEqual(request.previous, turn.previousState, "A fresh worker must receive the parent's saved compact brief");
  } else {
    assert.equal(request.previous, undefined, "Fresh sessions cannot inherit another session's preparation");
  }
  const source = turn.decision.evidence.source === "previous" ? request.previous?.requestText : request.userText;
  assert.ok(source?.includes(turn.decision.evidence.quote), "Synthetic evidence must be a literal user-source quote");
  turn.firstInput = body.input;
}

function assertPreparedRequest(body, turn) {
  const resolution = JSON.parse(outputFor(body, turn.controlId));
  assert.deepEqual(Object.keys(resolution).sort(), ["allowedTools", "decision", "state", "version"]);
  assert.equal(resolution.version, 1);
  assert.deepEqual(resolution.decision, turn.decision);
  const brief = turn.decision.task === "none" ? (turn.previousState ?? decision()) : turn.decision;
  const clarificationTurns = turn.decision.task === "new" ? 0 : (turn.previousState?.clarificationTurns ?? 0);
  assert.deepEqual(resolution.state, {
    version: 1, revision: turn.decision.revision + 1, sourceRunId: turn.runId, mode: turn.decision.mode,
    goal: brief.goal, deliverables: brief.deliverables, constraints: brief.constraints,
    assumptions: brief.assumptions, unresolved: brief.unresolved, question: brief.question,
    enhancedPrompt: brief.enhancedPrompt,
    requestText: turn.decision.task === "new" ? turn.message : (turn.previousState?.requestText ?? ""),
    clarificationTurns: clarificationTurns + (turn.decision.mode === "clarify" ? 1 : 0),
  }, "Validate every compact-brief field independently of the persisted binding");
  if (turn.resolution) assert.deepEqual(resolution, turn.resolution, "A decision cannot change between model steps");
  turn.resolution = resolution;
  const names = toolsOf(body);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual([...names].sort(), [...resolution.allowedTools].sort());
  if (turn.decision.mode === "execute") {
    assert.ok(names.length > 0);
    assert.ok(names.every((name) => TASK_PREPARATION.executionTools.includes(name)),
      "Execution cannot widen the ceiling to search, MCP, delegation, or other host tools");
    for (const call of turn.hostCalls) assert.ok(names.includes(call.name));
  } else {
    assert.deepEqual(names, [], `${turn.decision.mode} cannot use any host or preparation tools`);
  }
  assertNativePreparationHistory(body, turn);
}

function assertNativePreparationHistory(body, turn) {
  const controls = body.input.filter((item) => item.type === "function_call" && item.call_id === turn.controlId);
  assert.equal(controls.length, 1, "Exactly one control call, retained in native model history");
  assert.equal(controls[0].name, CONTROL_TOOL);
  assert.deepEqual(JSON.parse(controls[0].arguments), turn.decision);
  assert.deepEqual(JSON.parse(outputFor(body, turn.controlId)), turn.resolution);
  assert.equal(body.input.filter((item) => item.role === "assistant" &&
    inputText(item).includes(turn.plannerMarker)).length, 1,
  "Planner text stays in native history even though it must not reach the Dashboard");
}

async function assertNativeDurableHistory(binding, turns) {
  const logs = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /^session\.jsonl(?:\.zstd)?$/.test(entry.name)) {
        const bytes = await readFile(path);
        const content = (entry.name.endsWith(".zstd") ? zstdDecompressSync(bytes) : bytes).toString("utf8");
        const [header, ...rows] = content.trimEnd().split("\n").map((line) => JSON.parse(line));
        if (header.type === "session" && header.id === binding.value.sessionId) logs.push(rows);
      }
    }
  };
  // Only inspect this test's synthetic native home, never a user profile or a private fixture.
  await visit(join(dirname(binding.path), "home"));
  assert.equal(logs.length, 1, "Exactly one durable native session artifact matches the binding");
  const messages = logs[0].filter((row) => row.type === "assistant/message").map((row) => row.data.message);
  for (const turn of turns) {
    const planner = messages.filter((message) => message.content.some((block) =>
      block.type === "text" && block.text.includes(turn.plannerMarker)));
    assert.equal(planner.length, 1, "The original private planner message survives native persistence and resume");
    // Copilot replay strips signatures, so reasoning need not be re-sent on the Responses wire.
    assert.equal(planner[0].content.filter((block) =>
      block.type === "reasoning" && block.text === turn.reasoningMarker).length, 1,
    "Private reasoning remains in durable native history, not the Dashboard transcript");
    const controls = planner[0].content.filter((block) => block.type === "tool-call" && block.name === CONTROL_TOOL);
    assert.equal(controls.length, 1);
    assert.deepEqual(JSON.parse(controls[0].arguments), turn.decision);
    assert.equal(messages.filter((message) => messageText(message) === turn.answer).length, 1);
  }
}

function assertPrivateOutput(gateway, turn) {
  for (const frame of gateway.eventsForRun(turn.sessionKey, turn.runId)) {
    const { payload } = frame;
    if ((frame.event === "chat" && ["delta", "final"].includes(payload.state)) ||
        (frame.event === "agent" && ["assistant", "reasoning"].includes(payload.stream))) {
      const visible = [messageText(payload.message), payload.deltaText, payload.data?.text, payload.data?.delta]
        .filter((value) => typeof value === "string").join("\n");
      assert.equal(visible.includes(turn.plannerMarker), false, "Planner text must be hidden before streaming, not just at final");
      assert.equal(visible.includes(turn.reasoningMarker), false, "Planner reasoning is private");
      assert.doesNotMatch(visible, /dsh_prepare_task|"enhancedPrompt"|"allowedTools"|"requestText"/);
      assert.doesNotMatch(JSON.stringify(payload), /\b(?:dsh_prepare_task|enhancedPrompt|allowedTools|requestText|taskPreparation)\b/,
        "Preparation metadata must not leak through non-text assistant payload fields");
    }
    if (frame.event === "agent" && payload.stream === "tool") {
      assert.notEqual(payload.data?.name ?? payload.data?.toolName, CONTROL_TOOL,
        "The internal control is not a public host-tool call");
    }
  }
}

function assertDeliveredOnce(gateway, turn, final) {
  gateway.assertTurnHealthy(turn.sessionKey, turn.runId);
  const frames = gateway.eventsForRun(turn.sessionKey, turn.runId);
  const finals = frames.filter((frame) => frame.event === "chat" && frame.payload.state === "final");
  assert.equal(finals.length, 1, "Exactly one content-bearing final on the actual Control UI client");
  assert.equal(finals[0], final);
  assert.equal(final.payload.message?.role, "assistant");
  assert.equal(messageText(final.payload.message), turn.answer, "Status-only finals or control JSON are not delivery");
  const assistants = frames.filter((frame) => frame.event === "agent" && frame.payload.stream === "assistant");
  assert.ok(assistants.length > 0, "The global agent event must reach the real Dashboard client");
  let streamed = "";
  for (const frame of assistants) {
    const { text, delta = "" } = frame.payload.data;
    assert.equal(typeof text, "string");
    if (delta) assert.equal(text, streamed + delta, "No duplicate incremental assistant content");
    streamed = text;
    assert.ok(turn.answer.startsWith(text));
    assert.ok(gateway.events.indexOf(frame) < gateway.events.indexOf(final));
  }
  assert.equal(streamed, turn.answer);
  const deltas = frames.filter((frame) => frame.event === "chat" && frame.payload.state === "delta");
  assert.ok(deltas.length > 0, "History alone cannot stand in for live delivery");
  let delivered = "";
  for (const frame of deltas) {
    assert.equal(frame.payload.message?.role, "assistant");
    assert.equal(typeof frame.payload.deltaText, "string");
    delivered = frame.payload.replace ? frame.payload.deltaText : delivered + frame.payload.deltaText;
    assert.equal(messageText(frame.payload.message), delivered);
    assert.ok(turn.answer.startsWith(delivered));
    assert.ok(gateway.events.indexOf(frame) < gateway.events.indexOf(final));
  }
  assert.equal(delivered, turn.answer);
  assertPrivateOutput(gateway, turn);
}

function assertNoFallback(gateway, turn, history) {
  const frames = gateway.eventsForRun(turn.sessionKey, turn.runId);
  assert.deepEqual(frames.filter((frame) => frame.event === "agent" && frame.payload.stream === "lifecycle" &&
    ["fallback", "fallback_cleared"].includes(frame.payload.data?.phase)), []);
  for (const frame of frames) {
    assert.doesNotMatch(messageText(frame.payload.message), /model fallback|selected model unavailable/i);
    assert.doesNotMatch(frame.payload.data?.text ?? "", /model fallback|selected model unavailable/i);
  }
  assert.equal(history.sessionInfo.modelProvider, "github-copilot");
  assert.equal(history.sessionInfo.model, "gpt-6-astra");
  assert.equal(history.sessionInfo.activeModelProvider, undefined);
  assert.equal(history.sessionInfo.activeModel, undefined);
}

function assertHistory(history, turns) {
  assert.deepEqual(history.messages.filter((message) => message.role === "user").map(messageText),
    turns.map((turn) => turn.message), "Exactly one unchanged original admission per turn");
  const assistants = history.messages.filter((message) => message.role === "assistant");
  assert.deepEqual(assistants.map(messageText), turns.map((turn) => turn.answer));
  assistants.forEach((assistant, index) => {
    assert.equal(assistant.idempotencyKey ?? assistant.__openclaw?.idempotencyKey,
      `dsh-native:${turns[index].runId}:assistant`, "The history entry must be the native DSH commit");
    assert.equal(assistant.provider, "github-copilot");
    assert.equal(assistant.model, "gpt-6-astra");
  });
}

function assertHostCalls(gateway, turn, requests) {
  const before = new Set(turn.firstInput.filter((item) => item.type === "function_call_output").map((item) => item.call_id));
  const outputs = requests.at(-1).body.input.filter((item) =>
    item.type === "function_call_output" && !before.has(item.call_id) && item.call_id !== turn.controlId);
  assert.deepEqual(outputs.map((item) => item.call_id), turn.hostCalls.map((call) => call.callId),
    "Count actual host results only, excluding the internal preparation control and previous turns");
  const hostEvents = gateway.eventsForRun(turn.sessionKey, turn.runId)
    .filter((frame) => frame.event === "agent" && frame.payload.stream === "tool");
  if (turn.hostCalls.length === 0) assert.deepEqual(hostEvents, [], "A non-execution decision starts zero host calls");
  else for (const frame of hostEvents) {
    assert.ok(turn.hostCalls.some((call) => call.name === (frame.payload.data?.name ?? frame.payload.data?.toolName)));
  }
}

async function assertProtectedFiles(gateway) {
  assert.equal(await readFile(join(gateway.workspace, "fixture.txt"), "utf8"), FIXTURE_TEXT);
  assert.equal(await readFile(join(gateway.workspace, "do-not-delete.txt"), "utf8"), PROTECTED_TEXT);
}

async function waitForBlocked(gateway, turn) {
  const deadline = Date.now() + 60000;
  for (;;) {
    const binding = (await gateway.readDshBindings()).find((entry) => entry.value.lastRunId === turn.runId);
    const history = await gateway.chat.request("chat.history",
      { sessionKey: turn.sessionKey, agentId: gateway.agentId, limit: 20 }, { timeoutMs: 15000 });
    if (binding?.value.status === "blocked" && !history.inFlightRun) return { binding, history };
    assert.notEqual(binding?.value.status, "ready", "Invalid preparation cannot be committed as successful");
    assert.ok(Date.now() < deadline, "Invalid preparation must durably block its native binding");
    await delay(200);
  }
}

test("opted-in Dashboard preparation gates tools, preserves native state, and hides planner output", { timeout: 900000 }, async (t) => {
  let active;
  const completed = [];
  const histories = new Map();
  const gateway = await startDashboardGateway(async ({ body, index, reasoning, tool, text, finish }) => {
    assert.ok(active, "No model request outside an admitted human turn");
    const step = index - active.requestStart;
    assertModelRequest(body, active);
    if (step === 0) {
      assertInitialPreparation(body, active);
      reasoning(active.reasoningMarker);
      text(active.plannerMarker);
      if (active.invalid !== "missing") {
        const args = { ...active.decision };
        if (active.invalid === "malformed") delete args.evidence;
        tool(CONTROL_TOOL, args, active.controlId);
      }
      if (active.invalid === "mixed") {
        tool("write", { path: "forbidden-preparation.txt", content: "MUST-NOT-BE-WRITTEN\n" }, `${active.runId}_forbidden`);
      }
    } else {
      assert.equal(active.invalid, undefined, "Invalid or missing preparation is terminal, never retried");
      assert.ok(step <= active.hostCalls.length + 1, "No retry, extra preparation, or fallback provider step");
      assertPreparedRequest(body, active);
      if (step > 1) {
        const previous = active.hostCalls[step - 2];
        assert.match(outputFor(body, previous.callId), previous.expectedOutput, "The real host tool must have produced its result");
      }
      const call = active.hostCalls[step - 1];
      if (call) tool(call.name, call.args, call.callId);
      else text(active.answer);
    }
    finish();
  }, { taskPreparation: TASK_PREPARATION });

  const send = async (turn) => {
    active = turn;
    turn.requestStart = gateway.responses.requests.length;
    const response = await gateway.chat.request("chat.send", {
      sessionKey: turn.sessionKey, agentId: gateway.agentId, message: turn.message,
      thinking: "medium", idempotencyKey: turn.runId,
    }, { timeoutMs: 120000 });
    assert.equal(response?.status, "started");
    assert.equal(response?.runId, turn.runId);
  };
  const run = async (turn, previousTurns = []) => {
    await send(turn);
    const final = await gateway.waitForFinal(turn.sessionKey, turn.runId);
    const settled = await gateway.waitForDurableSettle(turn.sessionKey, turn.runId);
    const requests = gateway.responses.requests.slice(turn.requestStart);
    assert.equal(requests.length, turn.hostCalls.length + 2);
    requests.forEach((request, index) => {
      assert.equal(request.headers.authorization, "Bearer dashboard-not-a-real-key");
      assert.equal(request.headers["copilot-integration-id"], "copilot-developer-cli");
      assert.equal(request.headers["x-initiator"], index === 0 ? "user" : "agent");
    });
    assertDeliveredOnce(gateway, turn, final);
    assertHistory(settled.history, [...previousTurns, turn]);
    await assertNativeDurableHistory(settled.binding, [...previousTurns, turn]);
    assertNoFallback(gateway, turn, settled.history);
    assertHostCalls(gateway, turn, requests);
    assert.equal(settled.binding.value.status, "ready");
    assert.equal(settled.binding.value.lastRunId, turn.runId);
    assert.deepEqual(settled.binding.value.consumedRunIds, [...previousTurns, turn].map((item) => item.runId));
    assert.equal(settled.binding.value.taskPreparation?.version, 1);
    assert.match(settled.binding.value.taskPreparation.policyFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(settled.binding.value.taskPreparation.state, turn.resolution.state,
      "Only a successful native turn commits the validated preparation state in the parent binding");
    await assertProtectedFiles(gateway);
    completed.push({ turn, final });
    histories.set(turn.sessionKey, settled.history);
    return { ...settled, requests };
  };
  try {
    const config = JSON.parse(await readFile(gateway.configPath, "utf8"));
    assert.deepEqual(config.plugins.entries["dsh-native"].config.taskPreparation, TASK_PREPARATION);
    await writeFile(join(gateway.workspace, "do-not-delete.txt"), PROTECTED_TEXT);

    await t.test("normal explanatory chat answers visibly without any host execution", async () => {
      const message = "Explain what a local text fixture is in one friendly sentence.";
      const turn = makeTurn(freshSession(gateway, "chat"), message,
        decision({ evidence: { source: "current", quote: message } }),
        "A local text fixture is a small, predictable file that helps you check how your code behaves.");
      await run(turn);
      await assert.rejects(readFile(join(gateway.workspace, "fixture-report.txt")), { code: "ENOENT" });
    });

    await t.test("an idea asks one question, then a fresh child continues the saved brief and writes/reads locally", async () => {
      const sessionKey = freshSession(gateway, "clarification");
      const message = "I have an idea for a short report about the local fixture. Help me decide what to create.";
      const question = "What should the report file be called, and what should it contain?";
      const first = makeTurn(sessionKey, message, decision({
        mode: "clarify", task: "new", goal: "Create a short local fixture report.",
        unresolved: ["Report filename and content"], question,
        evidence: { source: "current", quote: "a short report about the local fixture" },
      }), question);
      const firstResult = await run(first);
      assert.equal(first.resolution.state.clarificationTurns, 1);
      assert.equal(first.resolution.state.question, question);
      assert.equal(first.resolution.state.requestText, message);
      await assert.rejects(readFile(join(gateway.workspace, "fixture-report.txt")), { code: "ENOENT" });

      const followup = "Create fixture-report.txt containing DASHBOARD-PREPARED-REPORT, then read it back.";
      const second = makeTurn(sessionKey, followup, decision({
        revision: 1, mode: "execute", task: "continue", goal: "Create and verify the local fixture report.",
        deliverables: ["fixture-report.txt containing DASHBOARD-PREPARED-REPORT"],
        constraints: ["Use only the local workspace."],
        enhancedPrompt: "PREPARED-REPORT-INSTRUCTION: write the requested report and read it back to verify the exact content.",
        evidence: { source: "previous", quote: "a short report about the local fixture" },
      }), "Created fixture-report.txt and verified its contents: DASHBOARD-PREPARED-REPORT.", [
        { name: "write", args: { path: "fixture-report.txt", content: REPORT_TEXT }, expectedOutput: /successfully wrote/i },
        { name: "read", args: { path: "fixture-report.txt" }, expectedOutput: /DASHBOARD-PREPARED-REPORT/ },
      ]);
      second.previousState = first.resolution.state;
      const secondResult = await run(second, [first]);
      assert.equal(secondResult.binding.path, firstResult.binding.path);
      assert.equal(secondResult.binding.value.sessionId, firstResult.binding.value.sessionId);
      assert.equal(secondResult.history.sessionId, firstResult.history.sessionId);
      assert.equal(second.resolution.state.revision, 2);
      assert.equal(second.resolution.state.question, "");
      assert.equal(await readFile(join(gateway.workspace, "fixture-report.txt"), "utf8"), REPORT_TEXT);
      const nativeContinuation = secondResult.requests[0].body.input;
      assert.equal(nativeContinuation.filter((item) => item.role === "assistant" && inputText(item) === question).length, 1);
      assert.equal(nativeContinuation.filter((item) => item.role === "user" && inputText(item).includes(message)).length, 1);
      assertNativePreparationHistory(secondResult.requests[0].body, first);
      assert.equal(secondResult.binding.value.taskPreparation.policyFingerprint,
        firstResult.binding.value.taskPreparation.policyFingerprint);

      const chatMessage = "Thanks! Explain what verifying a file means, without doing any more work.";
      const third = makeTurn(sessionKey, chatMessage, decision({
        revision: 2, evidence: { source: "current", quote: chatMessage },
      }), "Verifying a file means checking that its contents match what you expected.");
      third.previousState = second.resolution.state;
      await run(third, [first, second]);
      assert.equal(third.resolution.state.goal, second.decision.goal, "Casual chat preserves the brief, not its tool authority");
      assert.equal(await readFile(join(gateway.workspace, "fixture-report.txt"), "utf8"), REPORT_TEXT);
    });

    await t.test("drafting quoted delete/write imperatives never executes them", async () => {
      const message = 'Draft a prompt that says "delete do-not-delete.txt and write fixture-report.txt". Do not run it or change any files.';
      const answer = 'Draft prompt (not executed): "Delete do-not-delete.txt and write fixture-report.txt only after the operator authorizes those changes."';
      const turn = makeTurn(freshSession(gateway, "draft"), message, decision({
        mode: "draft", task: "new", goal: "Draft prompt text without performing the quoted operations.",
        deliverables: ["A prompt draft in the chat reply"], constraints: ["Do not execute or modify files."],
        enhancedPrompt: "Write only the requested prompt draft; the quoted file operations are text to discuss, not actions to run.",
        evidence: { source: "current", quote: "Do not run it or change any files." },
      }), answer);
      const before = await readFile(join(gateway.workspace, "fixture-report.txt"), "utf8").catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      await run(turn);
      if (before === undefined) await assert.rejects(readFile(join(gateway.workspace, "fixture-report.txt")), { code: "ENOENT" });
      else assert.equal(await readFile(join(gateway.workspace, "fixture-report.txt"), "utf8"), before);
    });

    await t.test("a clear local task gets only ceiling tools and returns the actual read result", async () => {
      const message = "Read fixture.txt in the local workspace and tell me its exact contents.";
      const turn = makeTurn(freshSession(gateway, "execute"), message, decision({
        mode: "execute", task: "new", goal: "Read the local fixture and report its contents.",
        deliverables: ["The exact text from fixture.txt"], constraints: ["Do not change any files."],
        enhancedPrompt: "PREPARED-READ-INSTRUCTION: read fixture.txt using the host tool and quote its observed content.",
        evidence: { source: "current", quote: message },
      }), "fixture.txt contains DASHBOARD-HOST-READ.", [
        { name: "read", args: { path: "fixture.txt" }, expectedOutput: /DASHBOARD-HOST-READ/ },
      ]);
      await run(turn);
    });

    for (const invalid of ["malformed", "mixed", "missing"]) {
      await t.test(`${invalid} initial preparation fails closed without execution, retry, or native success`, async () => {
        const message = "Write forbidden-preparation.txt containing a synthetic fixture marker.";
        const turn = makeTurn(freshSession(gateway, invalid), message, decision({
          mode: "execute", task: "new", goal: "Create a local synthetic marker.",
          deliverables: ["forbidden-preparation.txt"], enhancedPrompt: "Create only the requested local marker file.",
          evidence: { source: "current", quote: message },
        }), "MUST-NOT-DELIVER");
        turn.invalid = invalid;
        await send(turn);
        await assert.rejects(gateway.waitForFinal(turn.sessionKey, turn.runId), (error) => {
          assert.match(error.cause?.message ?? error.message, /Dashboard turn failed:/,
            "The real turn must report an error, not time out or fail only in the provider stub");
          return true;
        });
        const { binding, history } = await waitForBlocked(gateway, turn);
        assert.deepEqual(binding.value.consumedRunIds, [turn.runId]);
        assert.equal(binding.value.taskPreparation, undefined, "Rejected preparation cannot save a successful brief");
        assert.equal(gateway.responses.requests.length - turn.requestStart, 1, "No duplicate-control or missing-decision retry");
        const frames = gateway.eventsForRun(turn.sessionKey, turn.runId);
        assert.ok(frames.some((frame) => frame.event === "chat" && frame.payload.state === "error"));
        assert.deepEqual(frames.filter((frame) => frame.event === "chat" && frame.payload.state === "final"), []);
        assert.deepEqual(frames.filter((frame) => frame.event === "agent" && frame.payload.stream === "tool"), []);
        assert.deepEqual(history.messages.filter((item) => item.role === "assistant" &&
          ["stop", "length"].includes(item.stopReason)), [],
        "A rejected preparation is not a successful assistant history entry");
        assert.equal(history.messages.some((item) =>
          (item.idempotencyKey ?? item.__openclaw?.idempotencyKey) === `dsh-native:${turn.runId}:assistant`), false);
        assert.deepEqual(history.messages.filter((item) => item.role === "user").map(messageText), [message]);
        assertNoFallback(gateway, turn, history);
        assertPrivateOutput(gateway, turn);
        await assert.rejects(readFile(join(gateway.workspace, "forbidden-preparation.txt")), { code: "ENOENT" });
        await assertProtectedFiles(gateway);
      });
    }

    // Recheck after later turns to catch delayed, duplicated, or cross-session delivery.
    for (const { turn, final } of completed) {
      assertDeliveredOnce(gateway, turn, final);
      assertNoFallback(gateway, turn, histories.get(turn.sessionKey));
    }
    await gateway.assertHealthyLogs();
  } finally {
    await gateway.close();
  }
});

test("Dashboard preparation configured for another agent leaves this agent on the legacy tool path", { timeout: 620000 }, async () => {
  const taskPreparation = { ...TASK_PREPARATION, agentIds: ["other-fixture-agent"], executionTools: [] };
  let turn;
  const gateway = await startDashboardGateway(async ({ body, index, tool, text, finish }) => {
    const names = toolsOf(body);
    assert.equal(names.includes(CONTROL_TOOL), false, "An unlisted agent cannot enter internal preparation");
    assert.ok(names.includes("read"), "Another agent's empty execution ceiling must not remove legacy host tools");
    assert.ok(names.every((name) => gateway.coreTools.includes(name)));
    if (index === 0) {
      turn.firstInput = body.input;
      tool("read", { path: "fixture.txt" }, turn.hostCalls[0].callId);
    } else {
      assert.equal(index, 1, "No control retry, hidden preparation step, or fallback");
      assert.match(outputFor(body, turn.hostCalls[0].callId), /DASHBOARD-HOST-READ/);
      text(turn.answer);
    }
    finish();
  }, { taskPreparation });
  try {
    const config = JSON.parse(await readFile(gateway.configPath, "utf8"));
    assert.deepEqual(config.plugins.entries["dsh-native"].config.taskPreparation, taskPreparation);
    turn = makeTurn(freshSession(gateway, "unlisted"),
      "Read fixture.txt and tell me its exact contents.", undefined,
      "The local fixture contains DASHBOARD-HOST-READ.", [{ name: "read" }]);
    const response = await gateway.chat.request("chat.send", {
      sessionKey: turn.sessionKey, agentId: gateway.agentId, message: turn.message,
      thinking: "medium", idempotencyKey: turn.runId,
    }, { timeoutMs: 120000 });
    assert.equal(response?.status, "started");
    assert.equal(response?.runId, turn.runId);
    const final = await gateway.waitForFinal(turn.sessionKey, turn.runId);
    const settled = await gateway.waitForDurableSettle(turn.sessionKey, turn.runId);
    assert.equal(gateway.responses.requests.length, 2);
    assertDeliveredOnce(gateway, turn, final);
    assertHistory(settled.history, [turn]);
    assertNoFallback(gateway, turn, settled.history);
    assertHostCalls(gateway, turn, gateway.responses.requests);
    assert.equal(settled.binding.value.taskPreparation, undefined);
    assert.deepEqual(settled.binding.value.consumedRunIds, [turn.runId]);
    assert.equal(await readFile(join(gateway.workspace, "fixture.txt"), "utf8"), FIXTURE_TEXT);
    await gateway.assertHealthyLogs();
  } finally {
    await gateway.close();
  }
});
