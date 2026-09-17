import assert from "node:assert/strict";
import test from "node:test";
import { resolveActiveResetBoundary } from "../src/native/reset-boundary.ts";

const message = (id, parentId, role = "user") => ({
  type: "message", id, parentId, timestamp: 1,
  message: { role, content: [{ type: "text", text: id }] },
});
const reset = (id, parentId) => ({ type: "reset", id, parentId, timestamp: 2, reason: "new" });
const compact = (id, parentId) => ({
  type: "compaction", id, parentId, timestamp: 1, firstKeptEntryId: parentId, summary: "old context",
});

test("explicit clear reset recovers a previously compacted foreign conversation", () => {
  const events = [message("old-user", null), message("old-assistant", "old-user", "assistant")];
  let parent = "old-assistant";
  for (let index = 0; index < 6; index++) {
    const id = `old-compaction-${index}`;
    events.push(compact(id, parent));
    parent = id;
  }
  events.push(reset("clear", parent), message("new-user", "clear"));
  const boundary = resolveActiveResetBoundary(events, "canonical");
  assert.equal(boundary.kind, "clear");
  assert.equal(boundary.resetId, "clear");
  assert.deepEqual([...boundary.messageIds], ["new-user"]);
});

test("compaction after the current reset remains unsupported", () => {
  assert.throws(() => resolveActiveResetBoundary([
    reset("clear", null), message("new-user", "clear"), compact("new-compaction", "new-user"),
  ], "canonical"), /compaction/);
});

test("branch summaries are rejected only in current model context", () => {
  const summary = { type: "branch_summary", id: "summary", parentId: null, summary: "foreign branch" };
  assert.throws(() => resolveActiveResetBoundary([
    reset("clear", null), { ...summary, parentId: "clear" }, message("current", "summary"),
  ], "canonical"), /branch summary/);
  const boundary = resolveActiveResetBoundary([
    summary, reset("clear", "summary"), message("current", "clear"),
  ], "canonical");
  assert.equal(boundary.kind, "clear");
  assert.deepEqual([...boundary.messageIds], ["current"]);
});

for (const [name, events] of [
  ["duplicate reset identity", [reset("same", null), message("first", "same"), reset("same", "first")]],
  ["dangling reset ancestry", [reset("clear", "missing"), message("current", "clear")]],
  ["cycle", [reset("clear", "current"), message("current", "clear")]],
  ["dangling leaf target", [reset("clear", null), { type: "leaf", id: "leaf", parentId: "clear", targetId: "missing" }]],
]) {
  test(`invalid host reset graph fails closed: ${name}`, () => {
    assert.throws(() => resolveActiveResetBoundary(events, "canonical"));
  });
}
