import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import { messageText, startDashboardGateway } from "./fixtures/dashboard-gateway.mjs";

const TIMEOUT = 900000;
const EFFECT_PATH = "fixture-effect.json";
const PRIMARY_CONSTRAINT = `PRIMARY-CONSTRAINT-${randomUUID()}`;
const SIDE_EFFECT_ID = `SIDE-EFFECT-${randomUUID()}`;
const WORK_IDS = Array.from({ length: 3 }, (_, index) => `WORK-DONE-${index + 1}-${randomUUID()}`);
const FINAL_ANSWER = `COMPACTION-RETAINED ${PRIMARY_CONSTRAINT} ${SIDE_EFFECT_ID} ${WORK_IDS.join(" ")}`;

function serialized(value) {
  return JSON.stringify(value);
}

function requestText(item) {
  if (typeof item?.content === "string") return item.content;
  return (item?.content ?? []).filter((block) => typeof block.text === "string").map((block) => block.text).join("");
}

function isCompactionRequest(body) {
  return /You are now acting as a compaction engine|Output EXACTLY the Markdown structure/iu.test(serialized(body.input));
}

function compactSummary(completedTurns, input) {
  const retained = [PRIMARY_CONSTRAINT, SIDE_EFFECT_ID, ...completedTurns.map((turn) => turn.workId)]
    .filter((marker) => input.includes(marker));
  return [
    "## Primary Request and Intent",
    "- Retain observed constraints and completed actions; continue without repeating actions.",
    "",
    "## Key Technical Concepts",
    "- Dashboard Gateway sessions.compact semantic compaction; dsh-native embedded session continuity.",
    "",
    "## Files and Code",
    ...(retained.includes(SIDE_EFFECT_ID) ? [`- ${EFFECT_PATH}: already created for ${SIDE_EFFECT_ID}; do not write it again.`] : []),
    "",
    "## Errors and Fixes",
    "- (none)",
    "",
    "## Pending Jobs",
    "- Continue the same host session and answer from retained facts only.",
    "",
    "## Current Work",
    ...completedTurns.filter((turn) => retained.includes(turn.workId)).map((turn) => `- ${turn.workId}: completed.`),
    "",
    "## Next Step",
    "- Answer the next user request without replaying old side-effecting tools.",
    "",
    "## Critical Context",
    `- Negative constraints: no Git SSH, no production/model accounts, no maxLines truncation.`,
    `- Observed identifiers: ${retained.join("; ")}.`,
  ].join("\n");
}

function assertNoFallback(gateway, sessionKey, runId, final, history) {
  const frames = gateway.eventsForRun(sessionKey, runId);
  assert.deepEqual(frames.filter((frame) => frame.event === "agent" && frame.payload.stream === "lifecycle" &&
    ["fallback", "fallback_cleared"].includes(frame.payload.data?.phase)), []);
  assert.equal(messageText(final.payload.message).length > 0, true, "Final frame must be actual assistant content");
  assert.doesNotMatch(serialized([final, history, frames]), /model fallback|selected model unavailable/i);
}

function readDurableEvents(gateway, sessionId) {
  const path = join(gateway.root, "state", "agents", gateway.agentId, "agent", "openclaw-agent.sqlite");
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
      .all(sessionId).map((row) => JSON.parse(row.event_json));
  } finally {
    database.close();
  }
}

async function readNativeEvents(root, sessionId) {
  const results = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.name.endsWith(".jsonl")) {
        const rows = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
        if (rows.some((row) => row.type === "session" && row.id === sessionId)) results.push(...rows);
      }
    }
  }
  await walk(root);
  assert.ok(results.length > 0, "Exact native session JSONL must exist");
  return results;
}

async function assertNativeCompactionEvidence(gateway, state, minimum) {
  const events = await readNativeEvents(gateway.dshState, state.nativeSessionId);
  const summaries = events.filter((event) => event.type === "compaction/summary");
  assert.ok(summaries.length >= minimum, "Each cycle requires its own durable native summary");
  assert.equal(new Set(summaries.map((event) => event.data.compactionId)).size, summaries.length);
  for (const summary of summaries) {
    const start = events.find((event) => event.type === "compaction/start" && event.data.compactionId === summary.data.compactionId);
    const end = events.find((event) => event.type === "compaction/end" && event.data.compactionId === summary.data.compactionId);
    assert.ok(start && end && !end.data.error, "Checkpoint requires a matching successful transaction");
    assert.ok(start.seq < summary.seq && summary.seq < end.seq);
    assert.ok(summary.data.shadowedSeqs.length > 0);
    assert.equal(events.find((event) => event.seq === summary.seq + 1)?.type, "user/message");
    for (const seq of summary.data.shadowedSeqs) {
      assert.ok(events.some((event) => event.seq === seq), "Compacted original events must remain durable");
    }
  }
  return events;
}

async function runTurn(gateway, state, turn) {
  state.active = { ...turn, step: 0 };
  const start = gateway.responses.requests.length;
  const response = await gateway.chat.request("chat.send", {
    sessionKey: state.sessionKey,
    agentId: gateway.agentId,
    message: turn.prompt,
    thinking: "medium",
    idempotencyKey: turn.runId,
  }, { timeoutMs: 180000 });
  assert.equal(response?.status, "started");
  assert.equal(response?.runId, turn.runId);
  const final = await gateway.waitForFinal(state.sessionKey, turn.runId, 180000);
  assert.equal(messageText(final.payload.message), turn.answer);
  const settled = await gateway.waitForDurableSettle(state.sessionKey, turn.runId, 180000);
  assertNoFallback(gateway, state.sessionKey, turn.runId, final, settled.history);
  assert.equal(settled.history.sessionId, state.hostSessionId ?? settled.history.sessionId);
  assert.equal(settled.binding.value.sessionId, state.nativeSessionId ?? settled.binding.value.sessionId);
  state.hostSessionId ??= settled.history.sessionId;
  state.nativeSessionId ??= settled.binding.value.sessionId;
  state.bindingPath ??= settled.binding.path;
  assert.equal(settled.binding.path, state.bindingPath);
  const requests = gateway.responses.requests.slice(start);
  assert.ok(requests.length >= 1, "A real model request must occur for each turn");
  for (const dropped of turn.droppedLabels ?? []) {
    assert.equal(requests.some((request) => serialized(request.body).includes(dropped)), false,
      `Compacted model context must not retain irrelevant bulk pad ${dropped}`);
  }
  state.active = undefined;
  return { final, settled, requests };
}

async function compactManually(gateway, state, index) {
  const before = readDurableEvents(gateway, state.hostSessionId);
  state.compacting = true;
  const result = await gateway.chat.request("sessions.compact", {
    key: state.sessionKey,
    agentId: gateway.agentId,
  }, { timeoutMs: 240000 }).finally(() => {
    state.compacting = false;
  });
  assert.equal(result?.ok, true, `Manual semantic compaction RPC must succeed: ${serialized(result)}`);
  assert.equal(result.key, state.sessionKey);
  assert.equal(result.compacted, true, `Manual semantic compaction must report a real compaction: ${serialized(result)}`);
  assert.equal(Object.hasOwn(result, "kept"), false, "This regression must not use maxLines transcript truncation");
  const after = readDurableEvents(gateway, state.hostSessionId);
  assert.deepEqual(after.slice(0, before.length), before,
    "Semantic compaction must not delete or rewrite the host's old human transcript events");
  const events = serialized(after);
  assert.ok(events.includes(PRIMARY_CONSTRAINT));
  assert.ok(events.includes(SIDE_EFFECT_ID));
  const evidence = await assertNativeCompactionEvidence(gateway, state, index);
  const history = await gateway.chat.request("chat.history", {
    sessionKey: state.sessionKey,
    agentId: gateway.agentId,
    limit: 100,
  }, { timeoutMs: 15000 });
  assert.equal(history.sessionId, state.hostSessionId, "Manual compaction must retain the same host session id");
  return { result, evidence, history };
}

test("host preflight pressure invokes native compaction before continuing without /new", { timeout: TIMEOUT }, async () => {
  const constraint = `PREFLIGHT-${randomUUID()}`;
  let foreground = 0;
  let summaries = 0;
  const summaryInputs = [];
  const gateway = await startDashboardGateway(({ body, text, finish }) => {
    if (isCompactionRequest(body)) {
      summaries++;
      summaryInputs.push(serialized(body.input).length);
      assert.deepEqual(body.tools ?? [], []);
      assert.ok(serialized(body.input).includes(constraint));
      text(`## Primary Request and Intent\n- Preserve ${constraint}.\n\n## Key Technical Concepts\n- Native preflight.\n\n## Files and Code\n- None.\n\n## Errors and Fixes\n- None.\n\n## Pending Jobs\n- Continue.\n\n## Current Work\n- Summary.\n\n## Next Step\n- Reply.\n\n## Critical Context\n- ${constraint}.`);
      finish();
      return;
    }
    foreground++;
    assert.ok(serialized(body.input).includes(constraint));
    if (foreground === 2) assert.ok(serialized(body.input).includes("<compacted-summary>"));
    text(foreground === 1 ? "PREFLIGHT-SEEDED" : "PREFLIGHT-CONTINUED");
    const input = foreground === 1 ? 60000 : 1000;
    finish({ input_tokens: input, output_tokens: 10, total_tokens: input + 10,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } });
  }, { modelContextWindow: 65536, hostTools: [], compaction: { enabled: true } });
  try {
    const sessionKey = `agent:${gateway.agentId}:preflight-${randomUUID()}`;
    let first;
    for (let index = 0; index < 2; index++) {
      const runId = randomUUID();
      await gateway.chat.request("chat.send", { sessionKey, agentId: gateway.agentId, idempotencyKey: runId,
        thinking: "medium", message: index === 0 ? `Keep ${constraint}. ${"irrelevant ".repeat(4000)}End historical padding.` :
          "Recall the original constraint and continue without tools." }, { timeoutMs: 180000 });
      const final = await gateway.waitForFinal(sessionKey, runId, 180000);
      assert.equal(messageText(final.payload.message), index === 0 ? "PREFLIGHT-SEEDED" : "PREFLIGHT-CONTINUED");
      const settled = await gateway.waitForDurableSettle(sessionKey, runId);
      if (index === 0) first = settled;
      else {
        assert.equal(settled.history.sessionId, first.history.sessionId);
        assert.equal(settled.binding.value.sessionId, first.binding.value.sessionId);
        assert.equal(settled.binding.value.consumedRunIds.length, 2);
        assert.equal(settled.history.messages.filter((message) => message.role === "user").length, 2);
      }
    }
    assert.equal(summaries, 1, "Native automatic compaction must not redundantly summarize the host checkpoint");
    const rawEvents = await readNativeEvents(gateway.dshState, first.binding.value.sessionId);
    assert.equal(rawEvents.filter((event) => event.type === "compaction/summary").length, summaries,
      JSON.stringify({ summaryInputs, lifecycle: rawEvents.filter((event) => event.type.startsWith("compaction/"))
        .map((event) => ({ type: event.type, seq: event.seq, turn: event.data.turn,
          error: event.data.error, range: event.data.shadowedRange, trigger: event.data.trigger })) }));
    const events = await assertNativeCompactionEvidence(gateway, { nativeSessionId: first.binding.value.sessionId }, summaries);
    assert.equal(events.filter((event) => event.type === "compaction/summary").length, summaries,
      "Each summary request must commit a distinct native checkpoint, not be a hidden failed retry");
    assert.ok(events.some((event) => event.type === "compaction/start" && event.data.sourceCommandId),
      "At least one checkpoint must come from the actual host compaction operation");
    await gateway.assertHealthyLogs();
  } finally { await gateway.close(); }
});

test("Dashboard sessions.compact performs three genuine native compactions while retaining host and binding continuity",
  { timeout: TIMEOUT }, async () => {
    const state = {
      sessionKey: `agent:dashboard-fixture:compaction-${randomUUID()}`,
      active: undefined,
      completedTurns: [],
      writeCalls: 0,
      compactionRequests: 0,
    };
    const padLabels = WORK_IDS.map((id, index) => `IRRELEVANT-BULK-PAD-${index + 1}-${id}`);
    const effect = `${JSON.stringify({ id: SIDE_EFFECT_ID, constraint: PRIMARY_CONSTRAINT })}\n`;
    const gateway = await startDashboardGateway(async ({ body, tool, text, finish }) => {
      if (isCompactionRequest(body) || (state.compacting && (body.tools ?? []).length === 0)) {
        state.compactionRequests++;
        assert.deepEqual(body.tools ?? [], [], "Compaction summary calls must not receive callable host tools");
        assert.match(serialized(body.input), /compact|checkpoint|condens|summar|DSH callback-only host/iu);
        text(compactSummary(state.completedTurns, serialized(body.input)));
        finish();
        return;
      }
      assert.ok(state.active, `Unexpected non-compaction model request: ${serialized(body)}`);
      const turn = state.active;
      for (const label of turn.droppedLabels ?? []) assert.equal(serialized(body).includes(label), false);
      if (turn.requireRetained) {
        for (const marker of [PRIMARY_CONSTRAINT, SIDE_EFFECT_ID, ...WORK_IDS.slice(0, turn.requireRetained)]) {
          assert.ok(serialized(body).includes(marker), `Retained compacted context missing ${marker}`);
        }
      }
      assert.equal(body.model, "gpt-6-astra");
      assert.equal(body.store, false);
      assert.equal(body.reasoning.effort, "medium");
      const users = body.input.filter((item) => item.role === "user").map(requestText);
      assert.ok(users.at(-1)?.includes(turn.prompt.slice(0, 80)));
      if (turn.kind === "write" && turn.step === 0) {
        state.writeCalls++;
        tool("write", { path: EFFECT_PATH, content: effect }, "compaction_effect_write");
      } else if (turn.kind === "write" && turn.step === 1) {
        const output = body.input.find((item) =>
          item.type === "function_call_output" && item.call_id === "compaction_effect_write");
        assert.ok(output, "The real host write result must be returned before final answer");
        text(turn.answer);
      } else if (turn.kind === "plain" && turn.step === 0) {
        text(turn.answer);
      } else {
        throw new Error(`Unexpected provider step for ${turn.runId}: ${turn.step}`);
      }
      turn.step++;
      finish();
    }, {
      modelContextWindow: 65536,
      compaction: { enabled: true },
    });

    try {
      const turns = WORK_IDS.map((workId, index) => ({
        runId: `compaction-cycle-${index + 1}-${randomUUID()}`,
        workId,
        kind: index === 0 ? "write" : "plain",
        prompt: [
          `${padLabels[index]} ${"not-relevant ".repeat(3000)}`,
          index === 0 ? `Remember ${PRIMARY_CONSTRAINT}, ${SIDE_EFFECT_ID}, and ${workId}.` : `Record completed id ${workId}.`,
          index === 0 ? `Write ${EFFECT_PATH} exactly once, then reply ${workId}.`
            : `Continue without tools and reply ${workId}.`,
        ].join("\n"),
        answer: workId,
        droppedLabels: padLabels.slice(0, Math.max(0, index - 1)),
        requireRetained: index,
      }));

      let effectHash;
      for (const [index, turn] of turns.entries()) {
        const { settled } = await runTurn(gateway, state, turn);
        state.completedTurns.push({ runId: turn.runId, workId: turn.workId });
        assert.equal(settled.binding.value.sessionId, state.nativeSessionId);
        if (index === 0) {
          const bytes = await readFile(join(gateway.workspace, EFFECT_PATH), "utf8");
          assert.equal(bytes, effect);
          effectHash = createHash("sha256").update(bytes).digest("hex");
        }
        await compactManually(gateway, state, index + 1);
        assert.equal(createHash("sha256").update(await readFile(join(gateway.workspace, EFFECT_PATH), "utf8")).digest("hex"),
          effectHash, "Compaction/resume must not replay the side-effecting write");
      }

      const finalTurn = {
        runId: `compaction-final-${randomUUID()}`,
        kind: "plain",
        prompt: "Recall the original constraint, the side-effect identifier, and all three completed work identifiers. Do not use tools.",
        answer: FINAL_ANSWER,
        droppedLabels: padLabels.slice(0, 2),
        requireRetained: WORK_IDS.length,
      };
      await runTurn(gateway, state, finalTurn);
      assert.equal(state.writeCalls, 1, "The model may ask for the host write exactly once");
      assert.ok(state.compactionRequests >= 3, "The fixture must observe at least three real summary model calls");
      assert.equal(createHash("sha256").update(await readFile(join(gateway.workspace, EFFECT_PATH), "utf8")).digest("hex"),
        effectHash);
      await gateway.assertHealthyLogs();
    } finally {
      await gateway.close();
    }
  });

