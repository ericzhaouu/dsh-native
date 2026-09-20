import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { assertSourceReplySettled, beginSourceReplyJournal, deliveryJournalPaths } from "../dist/native/delivery-journal.js";

test("unknown source delivery survives process-local cleanup and blocks its epoch without exposing text", async (t) => {
  const root = resolve("artifacts", `delivery-journal-${randomUUID()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = await beginSourceReplyJournal(root, "old-epoch", "run-ack-lost");
  await journal.settle("unknown-after-started");
  await assert.rejects(assertSourceReplySettled(root, "old-epoch"), /unconfirmed.*No automatic resend/);
  await assert.rejects(beginSourceReplyJournal(root, "old-epoch", "next"), /already exists/);
  const receipt = JSON.parse(await readFile(deliveryJournalPaths(root, "old-epoch").receipt, "utf8"));
  assert.equal(receipt.state, "unknown-after-started");
  assert.equal(receipt.runId, "run-ack-lost");
  assert.equal(receipt.message, undefined);
  await assertSourceReplySettled(root, "fresh-reset-epoch");
});

for (const state of ["confirmed-delivered", "confirmed-not-delivered"]) {
  test(`${state} retains a durable receipt and releases only the matching owner`, async (t) => {
    const root = resolve("artifacts", `delivery-journal-${randomUUID()}`);
    t.after(() => rm(root, { recursive: true, force: true }));
    const journal = await beginSourceReplyJournal(root, "epoch", "run");
    await journal.settle(state);
    await assertSourceReplySettled(root, "epoch");
    const receipt = JSON.parse(await readFile(deliveryJournalPaths(root, "epoch").receipt, "utf8"));
    assert.equal(receipt.state, state);
    await assert.rejects(journal.settle(state), /already settled/);
  });
}
