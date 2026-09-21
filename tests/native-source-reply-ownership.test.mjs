import assert from "node:assert/strict";
import test from "node:test";
import { prepareSourceReplyOwnership } from "../dist/native/source-reply-ownership.js";

function fixture() {
  const p = { agentId: "main", sessionId: "session", sessionKey: "agent:main:chat:test", runId: "run" };
  const key = "dsh-native:reset:reset-one:run:assistant";
  const user = { role: "user", content: "Question", timestamp: 1 };
  const assistant = { role: "assistant", content: [{ type: "text", text: "Answer  \ncontinuation" }],
    idempotencyKey: key, provider: "deepseek", model: "model", api: "openai-completions",
    timestamp: 2, stopReason: "stop", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
  const entries = [
    { entryId: "user", parentId: "reset-one", seq: 2, role: "user", message: user },
    { entryId: "assistant", parentId: "user", seq: 3, role: "assistant", message: assistant, idempotencyKey: key },
  ];
  const reset = { type: "reset", id: "reset-one", parentId: null, context: "clear" };
  const transport = {
    readSessionTranscriptEvents: async () => [reset, ...entries.map((e) =>
      ({ type: "message", id: e.entryId, parentId: e.parentId, message: e.message }))],
    readVisibleSessionTranscriptMessageEntries: async () => entries,
    appendSessionTranscriptMessageByIdentityStrict: () => assert.fail("ownership proof must not write"),
    publishSessionTranscriptUpdateByIdentity: () => assert.fail("ownership proof must not publish"),
    runAgentHarnessBeforeMessageWriteHook: () => assert.fail("ownership proof must not invoke hooks"),
  };
  return { p, key, assistant, entries, reset, transport };
}
test("proof binds exact committed assistant, run and active reset without changing text", async () => {
  const f = fixture();
  const proof = await prepareSourceReplyOwnership(f.p, f.assistant, f.key, () => {}, f.transport);
  assert.equal(proof.nativeStateId, "session\0reset\0reset-one");
  assert.equal(proof.text, "Answer  \ncontinuation");
  assert.equal(proof.assistantKey, f.key);
  assert.ok(Object.isFrozen(proof));
  await proof.assertCurrent();
});
test("proof derives omitted agent identity from the same validated session scope", async () => {
  const f = fixture();
  delete f.p.agentId;
  assert.equal((await prepareSourceReplyOwnership(f.p, f.assistant, f.key, () => {}, f.transport)).agentId, "main");
});
test("same text is insufficient if the committed assistant identity differs", async () => {
  const f = fixture();
  for (const [assistant, key] of [[f.assistant, "dsh-native:reset:old:run:assistant"],
    [{ ...f.assistant, timestamp: 77 }, f.key]]) {
    await assert.rejects(prepareSourceReplyOwnership(f.p, assistant, key, () => {}, f.transport),
      { code: "openclaw_transcript_not_continuable" });
  }
});
test("later mutation or reset invalidates ownership before transport", async () => {
  const f = fixture();
  const proof = await prepareSourceReplyOwnership(f.p, f.assistant, f.key, () => {}, f.transport);
  f.assistant.content[0].text = "Changed";
  await assert.rejects(proof.assertCurrent(), /transcript changed/);
});
test("foreign assistant is still rejected rather than imported as a delivery owner", async () => {
  const f = fixture();
  f.entries.push({ entryId: "foreign", parentId: "assistant", seq: 4, role: "assistant",
    message: { ...f.assistant, idempotencyKey: "foreign", model: "delivery-mirror" } });
  await assert.rejects(prepareSourceReplyOwnership(f.p, f.assistant, f.key, () => {}, f.transport),
    /non-DSH assistant/);
});
