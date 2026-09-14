import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";

type Attempt = Parameters<AgentHarnessV2["runAttempt"]>[0];
type Result = Awaited<ReturnType<AgentHarnessV2["runAttempt"]>>;
type Assistant = NonNullable<Result["lastAssistant"]>;
type Message = Result["messagesSnapshot"][number];
type Recorder = NonNullable<Attempt["userTurnTranscriptRecorder"]>;
type User = NonNullable<Recorder["message"]>;
type Admission = NonNullable<ReturnType<Recorder["getAdmissionReceipt"]>>;
type BeforeWrite = typeof import("openclaw/plugin-sdk/agent-harness-runtime")["runAgentHarnessBeforeMessageWriteHook"];

type Scope = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath?: string;
  threadId?: string | number;
  expectedLifecycleRevision?: string;
  expectedWriterRunId?: string;
};

/** Local boundary for the public, JS-only OpenClaw 2026.9.2 transcript export. */
export interface NativeTranscriptTransport {
  readVisibleSessionTranscriptMessageEntries(scope: Scope): Promise<unknown>;
  appendSessionTranscriptMessageByIdentityStrict(params: Scope & {
    config?: Attempt["config"];
    cwd?: string;
    message: Assistant;
    idempotencyLookup: "scan";
    prepareMessageAfterIdempotencyCheck(message: Message): Message | undefined;
  }): Promise<unknown>;
  publishSessionTranscriptUpdateByIdentity(params: Scope & {
    update: { messageId: string; message: Message };
  }): Promise<void>;
  runAgentHarnessBeforeMessageWriteHook: BeforeWrite;
}

type Entry = {
  entryId: string;
  parentId: string | null;
  seq: number;
  role: string;
  message: Message;
  idempotencyKey?: string;
};
export interface NativeAssistantPersistence {
  owned: boolean;
  idempotencyKey?: string;
  message: Assistant | undefined;
  /** Deliberate omission is owned (no host fallback), but requires terminal failure, replaySafe: false and /new. */
  suppressed?: true;
}
const PREFIX = "dsh-native:";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function fail(reason: string): never {
  throw new Error(`DSH native transcript: ${reason}`);
}

function historyError(reason: string): never {
  return fail(`${reason}; DSH owns its history. Start a fresh session with /new.`);
}

function userText(message: unknown): string {
  if (!record(message) || message.role !== "user" || message.display === false || message.excludeFromContext === true) {
    return fail("unsupported canonical user message (hidden or non-user input)");
  }
  if (record(message.__openclaw) && (
    message.__openclaw.media !== undefined || message.__openclaw.mediaImageLayout !== undefined ||
    message.__openclaw.steerTargetRunId !== undefined
  )) return fail("media and steering user messages are unsupported");
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content) && message.content.length === 1) {
    const item: unknown = message.content[0];
    if (record(item) && item.type === "text" && typeof item.text === "string") return item.text;
  }
  return fail("canonical user input must be plain text or a single text block");
}

function assistantMessage(message: unknown): asserts message is Assistant {
  if (!record(message) || message.role !== "assistant" || !Array.isArray(message.content) ||
      message.content.some((item: unknown) => !record(item) || item.type !== "text" || typeof item.text !== "string") ||
      !nonblank(message.api) || !nonblank(message.provider) || !nonblank(message.model) ||
      !Number.isFinite(message.timestamp) || !record(message.usage) ||
      !["stop", "length"].includes(String(message.stopReason)) ||
      message.display === false || message.excludeFromContext === true) {
    fail("expected a canonical final text assistant message");
  }
}

function keyOf(message: Message): unknown {
  return Reflect.get(message, "idempotencyKey");
}

function resolveScope(p: Attempt): Scope {
  if (p.sessionPersistence === "detached") fail("detached persistence is unsupported");
  if (p.sessionManager !== undefined) fail("in-memory sessions are unsupported");
  const target = p.sessionTarget;
  if (target !== undefined && !record(target)) fail("ambiguous sessionTarget");
  if (target?.expectedWriterRunId !== undefined &&
      (!nonblank(target.expectedWriterRunId) || target.expectedWriterRunId !== p.runId)) {
    fail("sessionTarget expectedWriterRunId must match the attempt runId");
  }
  if (target?.expectedLifecycleRevision !== undefined &&
      (!nonblank(target.expectedLifecycleRevision) || target.expectedWriterRunId === undefined)) {
    fail("sessionTarget expectedLifecycleRevision must be nonblank and paired with a matching expectedWriterRunId");
  }
  if (target && Object.keys(target).some((key) =>
    !["agentId", "sessionId", "sessionKey", "storePath", "threadId", "expectedLifecycleRevision", "expectedWriterRunId"].includes(key))) {
    fail("unsupported sessionTarget scope");
  }
  for (const key of ["sessionId", "sessionKey", "agentId"] as const) {
    if (target?.[key] !== undefined && p[key] !== undefined && target[key] !== p[key]) {
      fail(`mismatched sessionTarget ${key}`);
    }
  }
  const sessionId = target?.sessionId ?? p.sessionId;
  const sessionKey = target?.sessionKey ?? p.sessionKey;
  const scopedAgent = typeof sessionKey === "string" ? /^agent:([^:]+):.+$/u.exec(sessionKey)?.[1] : undefined;
  const agentId = target?.agentId ?? p.agentId ?? scopedAgent;
  if (!nonblank(sessionId) || !nonblank(sessionKey) || !nonblank(agentId)) fail("ambiguous scoped session identity");
  if (scopedAgent && scopedAgent !== agentId) fail("session key and agent identity mismatch");
  if (target?.storePath !== undefined && (!nonblank(target.storePath) || /:memory:/iu.test(target.storePath))) {
    fail("ambiguous or in-memory store scope");
  }
  if (target?.threadId !== undefined && typeof target.threadId !== "string" && typeof target.threadId !== "number") {
    fail("unsupported thread scope");
  }
  return { agentId, sessionId, sessionKey, ...(target?.storePath !== undefined ? { storePath: target.storePath } : {}),
    ...(target?.threadId !== undefined ? { threadId: target.threadId } : {}),
    ...(target?.expectedLifecycleRevision !== undefined ? { expectedLifecycleRevision: target.expectedLifecycleRevision } : {}),
    ...(target?.expectedWriterRunId !== undefined ? { expectedWriterRunId: target.expectedWriterRunId } : {}) };
}

function checkedTransport(value: unknown): NativeTranscriptTransport {
  if (!record(value)) return fail("invalid public transcript transport");
  for (const name of [
    "readVisibleSessionTranscriptMessageEntries", "appendSessionTranscriptMessageByIdentityStrict",
    "publishSessionTranscriptUpdateByIdentity", "runAgentHarnessBeforeMessageWriteHook",
  ]) {
    if (typeof value[name] !== "function") fail(`public transcript transport is missing ${name}`);
  }
  return value as unknown as NativeTranscriptTransport;
}

async function loadTransport(): Promise<NativeTranscriptTransport> {
  const transcriptModule = "openclaw/plugin-sdk/session-transcript-runtime";
  const [transcript, harness] = await Promise.all([
    import(transcriptModule),
    import("openclaw/plugin-sdk/agent-harness-runtime"),
  ]);
  return checkedTransport({ ...transcript, runAgentHarnessBeforeMessageWriteHook: harness.runAgentHarnessBeforeMessageWriteHook });
}

function readEntries(value: unknown): Entry[] {
  if (!Array.isArray(value)) return fail("invalid visible transcript projection");
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (!record(entry) || !nonblank(entry.entryId) || ids.has(entry.entryId) ||
        !record(entry.message) || entry.message.role !== entry.role ||
        !Number.isSafeInteger(entry.seq) || typeof entry.parentId !== "string" && entry.parentId !== null ||
        entry.idempotencyKey !== undefined && entry.idempotencyKey !== entry.message.idempotencyKey) {
      return fail("invalid visible transcript entry");
    }
    ids.add(entry.entryId);
    return structuredClone(entry) as Entry;
  });
}

function verifyAdmission(value: unknown, scope: Scope, entries: Entry[], message: unknown): Admission {
  if (!record(value) || value.role !== "user" || value.sessionId !== scope.sessionId ||
      value.sessionKey !== scope.sessionKey || value.agentId !== scope.agentId ||
      !nonblank(value.entryId) || !nonblank(value.storePath) || !nonblank(value.generation) ||
      !nonblank(value.logicalTurnId) || !Number.isSafeInteger(value.rawSeq) ||
      !Number.isSafeInteger(value.activeMessagePosition)) {
    return fail("missing or mismatched user admission receipt");
  }
  const index = entries.findIndex((entry) => entry.entryId === value.entryId);
  const entry = entries[index];
  if (!entry || entry.role !== "user" || index !== value.activeMessagePosition ||
      value.effectiveParentId !== entry.parentId ||
      value.idempotencyKey !== undefined && value.idempotencyKey !== keyOf(entry.message) ||
      !isDeepStrictEqual(entry.message, message)) {
    return fail("user admission receipt does not match the scoped visible transcript");
  }
  // storePath in a receipt is the physical database, not necessarily the caller's store alias.
  return value as Admission;
}

function validateHistory(entries: Entry[], current: Admission | undefined, assistantKey: string): void {
  let pending: Entry | undefined;
  const keys = new Set<string>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.role === "user") {
      if (pending) historyError("earlier unresolved user turns cannot be imported");
      try { userText(entry.message); } catch { historyError("unsupported user history"); }
      pending = entry;
    } else if (entry.role === "assistant") {
      const key = keyOf(entry.message);
      if (!nonblank(key) || !key.startsWith(PREFIX) || !key.endsWith(":assistant") ||
          key.length <= PREFIX.length + ":assistant".length || keys.has(key)) {
        historyError("history contains a non-DSH assistant or ambiguous ownership");
      }
      try { assistantMessage(entry.message); } catch { historyError("unsupported assistant history"); }
      if (!pending) historyError("assistant history has no canonical user turn");
      if (key === assistantKey && pending.entryId !== current?.entryId) historyError("run id belongs to another user turn");
      if (pending.entryId === current?.entryId && (key !== assistantKey || index !== entries.length - 1)) {
        historyError("current user receipt is not the latest DSH turn");
      }
      keys.add(key);
      pending = undefined;
    } else {
      historyError("history originates outside dsh-native");
    }
  }
  if (pending && pending.entryId !== current?.entryId) historyError("earlier unresolved user turn");
}

/**
 * Mirrors canonical turns only; DshRuntime owns durable run history and uncertainty.
 * Rewritten user text is rejected, not silently replaced in the host-created prompt.
 */
export async function prepareNativeTranscript(
  p: Attempt,
  assertActive: () => void,
  transport?: NativeTranscriptTransport,
): Promise<{
  messages: Result["messagesSnapshot"];
  persistUser(): Promise<void>;
  markSentToProvider(): void;
  persistAssistant(message: Assistant): Promise<NativeAssistantPersistence>;
  getAssistantPersistence?(): NativeAssistantPersistence | undefined;
}> {
  const check = () => { p.abortSignal?.throwIfAborted(); assertActive(); };
  check();
  // The public SDK has no writer binder. Capture the exact inherited context, not a new claim or lock.
  const runInWriterScope = AsyncLocalStorage.snapshot();
  const scope = resolveScope(p);
  if (!nonblank(p.runId)) fail("an exact runId is required");
  const assistantKey = `${PREFIX}${p.runId}:assistant`;
  const recorder = p.userTurnTranscriptRecorder ?? fail("a host user transcript recorder is required");
  const allowed = () => {
    check();
    if (recorder.isBlocked()) fail("user message was blocked; provider submission is forbidden");
    if (recorder.hasRuntimePersistencePending() && !recorder.hasPersisted()) {
      fail("another runtime still owns pending user persistence");
    }
  };
  const expectedText = p.transcriptPrompt ?? p.prompt;
  const verifyText = (message: unknown) => {
    if (typeof expectedText !== "string" || userText(message) !== expectedText) {
      fail("rewritten user text differs from transcriptPrompt/prompt; provider submission is forbidden");
    }
  };
  allowed();
  verifyText(await recorder.resolveMessage());
  allowed();
  const sdk = transport === undefined ? await loadTransport() : checkedTransport(transport);
  allowed();
  const read = async () => {
    allowed();
    const entries = readEntries(await sdk.readVisibleSessionTranscriptMessageEntries({ ...scope }));
    allowed();
    return entries;
  };
  const currentAdmission = (entries: Entry[]) => {
    const receipt = recorder.getAdmissionReceipt();
    if (!receipt) {
      if (recorder.hasPersisted()) fail("persisted user has no authoritative admission receipt");
      return undefined;
    }
    const message = recorder.getPersistedMessage?.();
    verifyText(message);
    return verifyAdmission(receipt, scope, entries, message);
  };
  const initial = await read();
  validateHistory(initial, currentAdmission(initial), assistantKey);
  const messages: Result["messagesSnapshot"] = initial.map((entry) => structuredClone(entry.message));
  const snapshot = (entries: Entry[]) => {
    messages.length = 0;
    for (const entry of entries) messages.push(structuredClone(entry.message));
  };
  let userPromise: Promise<void> | undefined;
  let userCommitted = false;
  let sent = false;
  let admission: Admission | undefined;
  let persistedUser: User | undefined;
  let userUpdate: { messageId: string; message: Message } | undefined;
  let userPublication: Promise<void> | undefined;
  const publish = async (update: { messageId: string; message: Message }) => {
    allowed();
    await sdk.publishSessionTranscriptUpdateByIdentity({ ...scope, update: structuredClone(update) });
    allowed();
  };

  async function commitUser(): Promise<void> {
    allowed();
    verifyText(await recorder.resolveMessage());
    allowed();
    const before = await read();
    validateHistory(before, currentAdmission(before), assistantKey);
    const alreadyPersisted = recorder.hasPersisted();
    const result = await recorder.persistApproved({
      target: {
        ...scope,
        sessionEntry: undefined,
        expectedSessionId: scope.sessionId,
        config: p.config,
        cwd: p.workspaceDir,
        beforeMessageWrite: ({ message }) => {
          allowed();
          const next = sdk.runAgentHarnessBeforeMessageWriteHook({ message, agentId: scope.agentId, sessionKey: scope.sessionKey });
          allowed();
          if (next === null) recorder.markBlocked();
          return next;
        },
      },
      expectedSessionId: scope.sessionId,
      updateMode: "none",
      cwd: p.workspaceDir,
    });
    allowed();
    // Host persistence may return undefined or its cached original appended:true result.
    const receipt = result?.admission ?? recorder.getAdmissionReceipt();
    const message = result?.message ?? recorder.getPersistedMessage?.();
    if (!receipt || !message || !recorder.hasPersisted()) fail("user persistence failed without an authoritative receipt");
    verifyText(message);
    const after = await read();
    admission = structuredClone(verifyAdmission(receipt, scope, after, message));
    if (result && (result.messageId !== admission.entryId ||
        result.sessionEntry !== undefined && result.sessionEntry.sessionId !== scope.sessionId)) {
      fail("mismatched user persistence result");
    }
    const recorded = currentAdmission(after);
    if (!recorded || !isDeepStrictEqual(recorded, admission)) fail("mismatched recorder admission receipt");
    validateHistory(after, admission, assistantKey);
    persistedUser = structuredClone(message);
    snapshot(after);
    if (!alreadyPersisted && result?.appended === true) userUpdate = { messageId: result.messageId, message };
    userCommitted = true;
  }

  async function persistUser(): Promise<void> {
    allowed();
    userPromise ??= commitUser();
    await userPromise;
    if (userUpdate) {
      userPublication ??= publish(userUpdate).then(() => { userUpdate = undefined; });
      try { await userPublication; } finally { userPublication = undefined; }
    }
    allowed();
  }

  function markSentToProvider(): void {
    allowed();
    if (!userCommitted || userUpdate) fail("persistUser must complete before provider submission");
    if (!isDeepStrictEqual(recorder.getAdmissionReceipt(), admission) ||
        !isDeepStrictEqual(recorder.getPersistedMessage?.(), persistedUser)) {
      fail("user admission changed before provider submission");
    }
    if (!sent) {
      recorder.markSentToProvider?.();
      allowed();
      sent = true;
    }
  }

  let assistantPromise: Promise<void> | undefined;
  let decision: NativeAssistantPersistence | undefined;
  let assistantUpdate: { messageId: string; message: Message } | undefined;
  let publication: Promise<void> | undefined;
  async function commitAssistant(message: Assistant): Promise<void> {
    allowed();
    const before = await read();
    const current = currentAdmission(before);
    if (!isDeepStrictEqual(current, admission)) fail("user admission changed before assistant persistence");
    validateHistory(before, current, assistantKey);
    let hookSuppressed = false;
    // Stay in the host's async writer/mutation context; the public strict path enforces its inherited fence.
    const outcome = await sdk.appendSessionTranscriptMessageByIdentityStrict({
      ...scope,
      config: p.config,
      cwd: p.workspaceDir,
      idempotencyLookup: "scan",
      message: { ...structuredClone(message), idempotencyKey: assistantKey } as Assistant,
      prepareMessageAfterIdempotencyCheck: (candidate) => {
        allowed();
        const prepared = sdk.runAgentHarnessBeforeMessageWriteHook({
          message: candidate,
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          prepareAssistantTranscriptMessage: p.prepareAssistantTranscriptMessage,
        });
        allowed();
        if (prepared === null) {
          hookSuppressed = true;
          return undefined;
        }
        assistantMessage(prepared);
        return { ...prepared, idempotencyKey: assistantKey } as Assistant;
      },
    });
    allowed();
    if (!record(outcome)) fail("invalid strict assistant persistence outcome");
    if (outcome.kind === "rejected") fail(`assistant persistence rejected: ${String(outcome.reason)}`);
    if (outcome.kind === "suppressed") {
      if (!hookSuppressed) fail("assistant persistence suppressed without a true hook suppression decision");
      const after = await read();
      const currentAfter = currentAdmission(after);
      if (!isDeepStrictEqual(currentAfter, admission)) fail("user admission changed during assistant suppression");
      validateHistory(after, currentAfter, assistantKey);
      if (after.some((entry) => keyOf(entry.message) === assistantKey)) fail("suppression conflicts with a persisted assistant");
      snapshot(after);
      decision = { owned: true, message: undefined, suppressed: true };
      return;
    }
    if (outcome.kind !== "result" || hookSuppressed || !record(outcome.result)) fail("invalid strict assistant persistence result");
    const result = outcome.result;
    assistantMessage(result.message);
    if (!nonblank(result.messageId) || typeof result.appended !== "boolean" || keyOf(result.message) !== assistantKey) {
      fail("mismatched authoritative assistant persistence result");
    }
    const after = await read();
    const currentAfter = currentAdmission(after);
    if (!isDeepStrictEqual(currentAfter, admission)) fail("user admission changed during assistant persistence");
    validateHistory(after, currentAfter, assistantKey);
    const entry = after.find((item) => item.entryId === result.messageId);
    if (!entry || !isDeepStrictEqual(entry.message, result.message) || after.at(-1)?.entryId !== entry.entryId) {
      fail("assistant persistence result does not match the scoped visible transcript");
    }
    snapshot(after);
    decision = { owned: true, idempotencyKey: assistantKey, message: structuredClone(result.message) };
    if (result.appended) assistantUpdate = { messageId: result.messageId, message: result.message };
  }

  async function persistAssistant(message: Assistant): Promise<NativeAssistantPersistence> {
    allowed();
    if (!sent) fail("markSentToProvider must precede assistant persistence");
    assistantMessage(message);
    assistantPromise ??= commitAssistant(message);
    await assistantPromise;
    if (assistantUpdate) {
      // Retry only publication after a notification failure, never the authoritative decision.
      publication ??= publish(assistantUpdate).then(() => { assistantUpdate = undefined; });
      try { await publication; } finally { publication = undefined; }
    }
    allowed();
    return structuredClone(decision ?? fail("assistant persistence made no authoritative decision"));
  }

  return {
    messages,
    persistUser: () => runInWriterScope(persistUser),
    markSentToProvider: () => runInWriterScope(markSentToProvider),
    persistAssistant: (message) => runInWriterScope(persistAssistant, message),
    // A verified commit remains owned even if notification or a later active assertion fails.
    getAssistantPersistence: () => decision === undefined ? undefined : structuredClone(decision),
  };
}
