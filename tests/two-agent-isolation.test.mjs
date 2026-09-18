import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import test from "node:test";
import { messageText, startDashboardGateway } from "./fixtures/dashboard-gateway.mjs";

const CONTROL_TOOL = "dsh_prepare_task";
const PRIMARY_AGENT = "dashboard-fixture";
const PEER_AGENT = "dashboard-peer";
const METHOD_SKILL = "fixture-method";
const PEER_SKILL = "fixture-peer-leak";
const METHOD_CANARY = "METHOD-CANARY-6A6F7C11";
const PEER_CANARY = "PEER-CANARY-MUST-NOT-LEAK-97634C";
const TASK_PREPARATION = {
  agentIds: [PRIMARY_AGENT, PEER_AGENT],
  executionTools: ["read"],
  skillAllowlist: [],
  skillAllowlistByAgent: { [PRIMARY_AGENT]: [METHOD_SKILL], [PEER_AGENT]: [] },
  maxClarificationTurns: 2,
  maxToolCalls: 4,
};

function inputText(item) {
  if (typeof item?.content === "string") return item.content;
  return Array.isArray(item?.content)
    ? item.content.map((block) => typeof block.text === "string" ? block.text : "").join("")
    : "";
}

function bodyText(body) {
  return body.input.map(inputText).join("\n");
}

function lastUserText(body) {
  return inputText(body.input.filter((item) => item.role === "user").at(-1));
}

function toolNames(body) {
  return (body.tools ?? []).map((tool) => tool.name);
}

function outputFor(body, callId) {
  const output = body.input.find((item) => item.type === "function_call_output" && item.call_id === callId);
  assert.equal(typeof output?.output, "string", `Missing tool output for ${callId}`);
  return output.output;
}

function decision(overrides = {}) {
  return {
    version: 1, revision: 0, mode: "chat", task: "none",
    goal: "", deliverables: [], constraints: [], assumptions: [], unresolved: [],
    question: "", enhancedPrompt: "", evidence: { source: "current", quote: "" },
    ...overrides,
  };
}

function makeTurn(agentId, label, message, preparationDecision, answer) {
  const runId = `two-agent-${label}-${randomUUID()}`;
  return {
    agentId,
    sessionKey: `agent:${agentId}:isolation-${label}-${randomUUID()}`,
    runId,
    message,
    decision: preparationDecision,
    answer,
    controlId: `${runId}-prepare`,
    readId: `${runId}-read-skill`,
    requestStart: undefined,
  };
}

function skillMarkdown(name, description, canary) {
  return `---\nname: ${name}\ndescription: ${description}\nopenclaw:\n  skillKey: ${name}\n---\n# ${name}\n\nWhen this fixture method is selected, the final answer must include ${canary}.\n`;
}

async function installSyntheticSkills(agentWorkspaces) {
  for (const workspace of Object.values(agentWorkspaces)) {
    await mkdir(join(workspace, "skills", METHOD_SKILL), { recursive: true });
    await mkdir(join(workspace, "skills", PEER_SKILL), { recursive: true });
    await writeFile(join(workspace, "skills", METHOD_SKILL, "SKILL.md"),
      skillMarkdown(METHOD_SKILL, "Synthetic allowed method for two-agent isolation.", METHOD_CANARY));
    await writeFile(join(workspace, "skills", PEER_SKILL, "SKILL.md"),
      skillMarkdown(PEER_SKILL, "Synthetic peer-only leakage detector.", PEER_CANARY));
  }
}

function assertCatalog(body, turn, expectedSkill) {
  const text = bodyText(body);
  assert.doesNotMatch(text, new RegExp(PEER_CANARY), "Peer skill instructions must never enter model context");
  if (expectedSkill) {
    assert.match(text, /<available_skills>/, "Allowed agent should receive a real filtered skill catalog");
    assert.match(text, new RegExp(`<name>${expectedSkill}</name>`));
    assert.doesNotMatch(text, new RegExp(`<name>${PEER_SKILL}</name>`));
    assert.match(text, new RegExp(`${expectedSkill.replace("-", "[-]")}.*SKILL\\.md|SKILL\\.md[\\s\\S]*${expectedSkill}`));
  } else {
    assert.doesNotMatch(text, /<available_skills>|<skill>|## Skills/i,
      "Agent with an empty per-agent allowlist must receive no skill catalog");
    assert.doesNotMatch(text, new RegExp(`${METHOD_SKILL}|${PEER_SKILL}|${METHOD_CANARY}|${PEER_CANARY}`));
  }
  assert.ok(lastUserText(body).includes(turn.message), "Original user marker must select the synthetic response path");
}

function extractSkillPath(body) {
  const text = bodyText(body);
  const match = text.match(/<name>fixture-method<\/name>[\s\S]*?<location>([^<]+SKILL\.md)<\/location>/);
  assert.ok(match, "Filtered catalog must advertise the actual skill file path");
  const path = normalize(match[1]);
  assert.ok(isAbsolute(path), "The host Skill catalog must supply an absolute fixture path");
  return path;
}

async function send(gateway, turn) {
  turn.requestStart = gateway.responses.requests.length;
  const response = await gateway.chat.request("chat.send", {
    sessionKey: turn.sessionKey,
    agentId: turn.agentId,
    message: turn.message,
    thinking: "medium",
    idempotencyKey: turn.runId,
  }, { timeoutMs: 120000 });
  assert.equal(response?.status, "started");
  assert.equal(response?.runId, turn.runId);
}

async function waitForDurableSettle(gateway, turn) {
  const final = await gateway.waitForFinal(turn.sessionKey, turn.runId);
  const deadline = Date.now() + 120000;
  let stableSince;
  let previousSnapshot;
  for (;;) {
    gateway.assertTurnHealthy(turn.sessionKey, turn.runId);
    const bindings = await gateway.readDshBindings();
    const binding = bindings.find((entry) => entry.value.lastRunId === turn.runId);
    if (binding?.value.status === "blocked") throw new Error(`Native binding blocked for ${turn.runId}`);
    const history = await gateway.chat.request("chat.history", {
      sessionKey: turn.sessionKey,
      agentId: turn.agentId,
      limit: 20,
    }, { timeoutMs: 15000 });
    const assistant = history.messages?.find((message) => message.role === "assistant" &&
      (message.idempotencyKey ?? message.__openclaw?.idempotencyKey) === `dsh-native:${turn.runId}:assistant`);
    if (binding?.value.status === "ready" && assistant && !history.inFlightRun) {
      const snapshot = JSON.stringify([binding.value, history.messages, history.sessionInfo]);
      if (snapshot !== previousSnapshot || stableSince === undefined) {
        previousSnapshot = snapshot;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 500) return { final, binding, bindings, history };
    } else stableSince = undefined;
    assert.ok(Date.now() < deadline, `Timed out waiting for durable settle ${turn.agentId}/${turn.runId}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function assertDelivered(gateway, turn, final) {
  gateway.assertTurnHealthy(turn.sessionKey, turn.runId);
  const frames = gateway.eventsForRun(turn.sessionKey, turn.runId);
  assert.equal(frames.filter((frame) => frame.event === "chat" && frame.payload.state === "final").length, 1);
  assert.equal(messageText(final.payload.message), turn.answer);
  assert.equal(frames.some((frame) => frame.event === "agent" && frame.payload.stream === "assistant"), true);
  for (const frame of frames) {
    assert.equal(frame.payload?.sessionKey, turn.sessionKey);
    assert.equal(frame.payload?.runId, turn.runId);
  }
}

function assertHistory(history, turn) {
  assert.deepEqual(history.messages.filter((message) => message.role === "user").map(messageText), [turn.message]);
  assert.deepEqual(history.messages.filter((message) => message.role === "assistant").map(messageText), [turn.answer]);
  assert.equal(history.sessionInfo.modelProvider, "github-copilot");
  assert.equal(history.sessionInfo.model, "gpt-6-astra");
  assert.equal(history.sessionInfo.activeModelProvider, undefined);
  assert.equal(history.sessionInfo.activeModel, undefined);
}

test("shared Dashboard gateway keeps per-agent preparation skill catalogs isolated", { timeout: 720000 }, async () => {
  const turnsByMarker = new Map();
  const requestedSkillPaths = [];
  const gateway = await startDashboardGateway(async ({ body, tool, text, finish }) => {
    const turn = [...turnsByMarker.values()].reverse().find((candidate) => lastUserText(body).includes(candidate.message));
    assert.ok(turn, `Unexpected synthetic model request: ${lastUserText(body)}`);
    const step = turn.seenSteps ?? 0;
    turn.seenSteps = step + 1;
    assert.equal(body.model, "gpt-6-astra");
    assert.equal(body.store, false);
    assert.equal(body.reasoning.effort, "medium");
    assert.doesNotMatch(bodyText(body), /PEER-CANARY-MUST-NOT-LEAK-97634C/);
    const expectedSkill = turn.agentId === PRIMARY_AGENT ? METHOD_SKILL : undefined;
    if (step === 0) {
      assertCatalog(body, turn, expectedSkill);
      assert.deepEqual(toolNames(body), [CONTROL_TOOL]);
      tool(CONTROL_TOOL, turn.decision, turn.controlId);
    } else if (turn.agentId === PRIMARY_AGENT && step === 1) {
      assert.deepEqual(toolNames(body), ["read"]);
      assertCatalog(body, turn, METHOD_SKILL);
      const skillPath = extractSkillPath(body);
      requestedSkillPaths.push(skillPath);
      tool("read", { path: skillPath }, turn.readId);
    } else if (turn.agentId === PRIMARY_AGENT && step === 2) {
      assert.deepEqual(toolNames(body), ["read"]);
      assert.match(outputFor(body, turn.readId), new RegExp(METHOD_CANARY));
      assert.doesNotMatch(outputFor(body, turn.readId), new RegExp(PEER_CANARY));
      text(turn.answer);
    } else if (turn.agentId === PEER_AGENT && step === 1) {
      assert.deepEqual(toolNames(body), []);
      assertCatalog(body, turn, undefined);
      text(turn.answer);
    } else assert.fail(`Unexpected request step ${step} for ${turn.agentId}`);
    finish();
  }, {
    taskPreparation: TASK_PREPARATION,
    additionalAgentIds: [PEER_AGENT],
    setupWorkspaces: ({ agentWorkspaces }) => installSyntheticSkills(agentWorkspaces),
  });

  try {
    const config = JSON.parse(await readFile(gateway.configPath, "utf8"));
    assert.deepEqual(Object.keys(config.agents.entries).sort(), [PEER_AGENT, PRIMARY_AGENT].sort());
    assert.notEqual(config.agents.entries[PRIMARY_AGENT].workspace, config.agents.entries[PEER_AGENT].workspace);
    assert.notEqual(config.agents.entries[PRIMARY_AGENT].agentDir, config.agents.entries[PEER_AGENT].agentDir);
    assert.deepEqual(config.plugins.entries["dsh-native"].config.taskPreparation, TASK_PREPARATION);

    const primary = makeTurn(PRIMARY_AGENT, "primary",
      "PRIMARY-ISOLATION-MARKER: use the selected fixture method skill and report the canary.",
      decision({
        mode: "execute", task: "new", goal: "Read the selected fixture method skill.",
        deliverables: ["Final answer includes the method canary."],
        constraints: ["Use only the advertised fixture-method skill."],
        enhancedPrompt: "Read the advertised fixture-method SKILL.md, then report its canary.",
        evidence: { source: "current", quote: "selected fixture method skill" },
      }),
      `Primary read the allowed fixture method skill and observed ${METHOD_CANARY}.`);
    const peer = makeTurn(PEER_AGENT, "peer",
      "PEER-ISOLATION-MARKER: answer normally without any skill catalog.",
      decision({ evidence: { source: "current", quote: "answer normally" } }),
      "Peer answered without an advertised skill catalog.");
    turnsByMarker.set(primary.message, primary);
    turnsByMarker.set(peer.message, peer);

    await send(gateway, peer);
    const peerResult = await waitForDurableSettle(gateway, peer);
    const peerBindingBaseline = JSON.stringify(peerResult.binding.value);
    await send(gateway, primary);
    const primaryResult = await waitForDurableSettle(gateway, primary);

    assertDelivered(gateway, primary, primaryResult.final);
    assertDelivered(gateway, peer, peerResult.final);
    assertHistory(primaryResult.history, primary);
    assertHistory(peerResult.history, peer);
    assert.notEqual(primaryResult.binding.path, peerResult.binding.path);
    assert.notEqual(primaryResult.binding.value.sessionId, peerResult.binding.value.sessionId);
    assert.notEqual(primaryResult.history.sessionId, peerResult.history.sessionId);
    assert.equal(primary.seenSteps, 3, "Primary must prepare, read the method and answer");
    assert.equal(peer.seenSteps, 2, "Peer must prepare before its tool-free answer");
    const peerFingerprint = peerResult.binding.value.taskPreparation.policyFingerprint;
    assert.match(peerFingerprint, /^[a-f0-9]{64}$/);
    assert.notEqual(primaryResult.binding.value.taskPreparation.policyFingerprint, peerFingerprint);
    assert.equal(primaryResult.binding.value.taskPreparation.state.requestText, primary.message);
    assert.equal(peerResult.binding.value.taskPreparation.state.requestText, "");
    assert.equal(requestedSkillPaths.length, 1);
    assert.ok(requestedSkillPaths[0].includes(gateway.agentWorkspaces[PRIMARY_AGENT]));
    assert.ok(!requestedSkillPaths[0].includes(gateway.agentWorkspaces[PEER_AGENT]));

    const peerBindingAfterPrimary = (await gateway.readDshBindings())
      .find((entry) => entry.path === peerResult.binding.path);
    assert.equal(JSON.stringify(peerBindingAfterPrimary.value), peerBindingBaseline,
      "Primary agent execution must not mutate the peer agent binding or policy fingerprint");

    const parallelPrimary = makeTurn(PRIMARY_AGENT, "parallel-primary",
      "PRIMARY-PARALLEL-MARKER: use the selected fixture method skill and report the canary.",
      primary.decision, primary.answer);
    const parallelPeer = makeTurn(PEER_AGENT, "parallel-peer",
      "PEER-PARALLEL-MARKER: answer normally without any skill catalog.",
      peer.decision, peer.answer);
    turnsByMarker.set(parallelPrimary.message, parallelPrimary);
    turnsByMarker.set(parallelPeer.message, parallelPeer);
    await Promise.all([send(gateway, parallelPrimary), send(gateway, parallelPeer)]);
    const [parallelPrimaryResult, parallelPeerResult] = await Promise.all([
      waitForDurableSettle(gateway, parallelPrimary), waitForDurableSettle(gateway, parallelPeer),
    ]);
    for (const [turn, result] of [[parallelPrimary, parallelPrimaryResult], [parallelPeer, parallelPeerResult]]) {
      assertDelivered(gateway, turn, result.final);
      assertHistory(result.history, turn);
    }
    assert.notEqual(parallelPrimaryResult.binding.path, parallelPeerResult.binding.path);
    assert.equal(parallelPrimary.seenSteps, 3);
    assert.equal(parallelPeer.seenSteps, 2);
    assert.equal(parallelPeerResult.binding.value.taskPreparation.policyFingerprint, peerFingerprint);
    assert.equal(requestedSkillPaths.length, 2);
    for (const request of gateway.responses.requests) {
      assert.doesNotMatch(bodyText(request.body), /PEER-CANARY-MUST-NOT-LEAK-97634C/);
      if (lastUserText(request.body).includes("PEER-")) {
        assert.doesNotMatch(bodyText(request.body), new RegExp(`${METHOD_SKILL}|${METHOD_CANARY}|${PEER_SKILL}`));
      }
    }
    await gateway.assertHealthyLogs();
  } finally {
    await gateway.close();
  }
});
