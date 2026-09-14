import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import { BRIDGE_VERSION, DSH_VERSION, isRecord } from "../protocol.js";
import type { DshConfig } from "../runtime-types.js";

type Attempt = Parameters<AgentHarnessV2["runAttempt"]>[0];
type Messages = Awaited<ReturnType<AgentHarnessV2["runAttempt"]>>["messagesSnapshot"];

/**
 * Read-only cross-store guard. The runtime alone creates, locks and mutates bindings;
 * this seam prevents a retained OpenClaw mirror from silently starting empty native history.
 */
export function prepareNativeContinuity(config: DshConfig, p: Attempt, messages: Messages): () => void {
  const previousAssistant = messages.findLast((message) => message.role === "assistant");
  const key: unknown = previousAssistant && Reflect.get(previousAssistant, "idempotencyKey");
  const previousRunId = typeof key === "string" && key.startsWith("dsh-native:") && key.endsWith(":assistant")
    ? key.slice("dsh-native:".length, -":assistant".length) : undefined;
  const bindingPath = join(config.stateDir, createHash("sha256").update(p.sessionId).digest("hex"), "binding.json");
  let nativeSessionId: string | undefined;
  let currentRunObserved = false;
  const fail = (): never => {
    throw new Error("dsh-native: OpenClaw mirror and native history no longer agree; restore the original native state or start /new");
  };
  if (previousAssistant && !previousRunId) fail();
  const read = () => {
    try {
      const binding: unknown = JSON.parse(readFileSync(bindingPath, "utf8"));
      if (!isRecord(binding) || binding.version !== BRIDGE_VERSION || binding.dshVersion !== DSH_VERSION ||
          typeof binding.sessionId !== "string" || !binding.sessionId ||
          binding.workspaceDir !== (p.cwd ?? p.workspaceDir)) return fail();
      return binding;
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return undefined;
      return fail();
    }
  };
  const initial = read();
  if (previousRunId) {
    const prior = initial ?? fail();
    if (prior.status !== "ready" || prior.lastRunId !== previousRunId) fail();
    nativeSessionId = prior.sessionId as string;
  } else if (initial) {
    // A cleared/branched mirror is not permission to reuse an unrelated native thread.
    fail();
  }
  return () => {
    const binding = read();
    if (!binding) {
      if (nativeSessionId || previousRunId || currentRunObserved) fail();
      return;
    }
    if (nativeSessionId && binding.sessionId !== nativeSessionId) fail();
    if (binding.lastRunId === p.runId && (binding.status === "running" || binding.status === "ready")) {
      currentRunObserved = true;
      nativeSessionId = binding.sessionId as string;
      return;
    }
    if (!currentRunObserved && previousRunId && binding.lastRunId === previousRunId && binding.status === "ready") return;
    fail();
  };
}
