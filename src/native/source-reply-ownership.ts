import { isDeepStrictEqual } from "node:util";
import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import { readNativeMaintenanceContext, type NativeTranscriptTransport } from "./transcript.js";
import { NativeTranscriptError } from "./reset-boundary.js";

type Attempt = Parameters<AgentHarnessV2["runAttempt"]>[0];
type Assistant = NonNullable<Awaited<ReturnType<AgentHarnessV2["runAttempt"]>>["lastAssistant"]>;

export interface NativeSourceReplyOwnership {
  version: 1;
  agentId: string;
  sessionId: string;
  sessionKey: string;
  runId: string;
  nativeStateId: string;
  assistantKey: string;
  text: string;
  assertCurrent(): Promise<void>;
}

export async function prepareSourceReplyOwnership(
  p: Attempt, assistant: Assistant, assistantKey: string | undefined, assertActive: () => void,
  transport?: NativeTranscriptTransport,
): Promise<NativeSourceReplyOwnership> {
  assertActive();
  const context = await readNativeMaintenanceContext(p, assertActive, transport);
  const expected = `${context.assistantKeyPrefix}${p.runId}:assistant`;
  const current = context.contextMessages.at(-1);
  const sessionKey = p.sessionTarget?.sessionKey ?? p.sessionKey;
  const agentId = p.sessionTarget?.agentId ?? p.agentId ?? /^agent:([^:]+):.+$/u.exec(sessionKey ?? "")?.[1];
  if (!agentId || !sessionKey || assistantKey !== expected ||
      !isDeepStrictEqual(current, assistant)) {
    throw new NativeTranscriptError("Committed source reply does not match the current native transcript owner");
  }
  return Object.freeze({
    version: 1, agentId, sessionId: p.sessionId, sessionKey,
    runId: p.runId, nativeStateId: context.nativeStateId, assistantKey,
    text: assistant.content.filter((block) => block.type === "text").map((block) => block.text).join(""),
    assertCurrent: context.assertCurrent,
  });
}
