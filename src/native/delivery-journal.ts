import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createDurableOwnership, writeDurableJson } from "../durable-state.js";
import type { NativeSourceReplyReceiptState } from "./source-reply.js";

export function deliveryJournalPaths(stateDir: string, nativeStateId: string) {
  const directory = join(stateDir, createHash("sha256").update(nativeStateId).digest("hex"));
  return { directory, lock: join(directory, "source-reply.lock"), receipt: join(directory, "source-reply-receipt.json") };
}

export async function assertSourceReplySettled(stateDir: string, nativeStateId: string): Promise<void> {
  const { lock } = deliveryJournalPaths(stateDir, nativeStateId);
  try { await readFile(lock, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error("Previous source reply settlement is unconfirmed; inspect its receipt before continuing. No automatic resend or unlock is permitted.");
}

export async function beginSourceReplyJournal(stateDir: string, nativeStateId: string, runId: string) {
  const paths = deliveryJournalPaths(stateDir, nativeStateId);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const owner = await createDurableOwnership(paths.lock, { runId, operation: "run", stateKey: nativeStateId });
  const identity = { version: 1, runId, privateCallId: `dsh-source-reply:${runId}` };
  try {
    await writeDurableJson(paths.receipt, { ...identity, state: "prepared", updatedAt: new Date().toISOString() });
  } catch (error) {
    await owner.handle.close();
    throw error;
  }
  let closed = false;
  return {
    async settle(receiptState: NativeSourceReplyReceiptState) {
      if (closed) throw new Error("Source reply journal already settled");
      try {
        await writeDurableJson(paths.receipt, { ...identity, state: receiptState, updatedAt: new Date().toISOString() });
        // Unknown receipt state retains its durable ownership fence across plugin reloads.
        if (receiptState !== "unknown-after-started") await owner.release();
      } finally {
        closed = true;
        await owner.handle.close();
      }
    },
  };
}
