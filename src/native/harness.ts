import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import { randomUUID } from "node:crypto";
import type { BridgeContextUsage, BridgeEvent, BridgeResult, BridgeUsage } from "../protocol.js";
import { RUNTIME_ID } from "../protocol.js";
import type { DshConfig, DshRuntime } from "../runtime-types.js";
import { prepareNativeHost, type NativeHost } from "./host.js";
import { nativeSupports, resolveNativeRoute } from "./route.js";
import { prepareNativeTranscript, readNativeMaintenanceContext } from "./transcript.js";
import { prepareNativeContinuity } from "./continuity.js";
import { resolvePreparationPolicy } from "../preparation.js";
import { createPreparationGate } from "./preparation.js";
import {
  isNativeMemoryAttempt, renderMemoryPrompt, MEMORY_OUTPUT_TOKENS, MEMORY_TIMEOUT_MS, MEMORY_TOOL_LIMIT,
} from "./memory.js";
import { createIsolatedCompletion, type IsolatedCompletion } from "./isolated.js";

type Attempt = Parameters<AgentHarnessV2["runAttempt"]>[0];
type Result = Awaited<ReturnType<AgentHarnessV2["runAttempt"]>>;
type CompactParams = Parameters<NonNullable<AgentHarnessV2["compact"]>>[0];
type CompactResult = Awaited<ReturnType<NonNullable<AgentHarnessV2["compact"]>>>;
type Terminal = Extract<Result, { terminal: unknown }>["terminal"];
type Assistant = NonNullable<Result["lastAssistant"]>;
type Sdk = typeof import("openclaw/plugin-sdk/agent-harness-runtime");
type LifecycleSdk = Pick<Sdk, "setActiveEmbeddedRun" | "clearActiveEmbeddedRun" |
  "getModelProviderRequestTransport" | "emitAgentEvent" | "resolveSessionAgentIds" |
  "runAgentHarnessLlmInputHook" | "runAgentHarnessLlmOutputHook" |
  "awaitAgentHarnessAgentEndHook" | "runAgentHarnessBeforeAgentFinalizeHook">;

export interface NativeHarnessDependencies {
  loadSdk(): Promise<LifecycleSdk>;
  prepareHost: typeof prepareNativeHost;
  prepareTranscript: typeof prepareNativeTranscript;
  prepareContinuity?: typeof prepareNativeContinuity;
  readMaintenanceContext?: typeof readNativeMaintenanceContext;
}

const defaults: NativeHarnessDependencies = {
  loadSdk: () => import("openclaw/plugin-sdk/agent-harness-runtime"),
  prepareHost: prepareNativeHost,
  prepareTranscript: prepareNativeTranscript,
  prepareContinuity: prepareNativeContinuity,
  readMaintenanceContext: readNativeMaintenanceContext,
};

function failure(message: string): never {
  throw new Error(`dsh-native: ${message}`);
}

export function assertNativeAttemptSupported(p: Attempt, hostToolAllowlist?: readonly string[]): void {
  isNativeMemoryAttempt(p);
  if (p.hostCapabilities?.kind !== "agent-harness-host-capability" || p.hostCapabilities.version !== 1) {
    failure("requires a versioned, host-prepared AgentHarnessV2 capability");
  }
  if (p.pluginHarnessToolPolicyRestricted && hostToolAllowlist === undefined) {
    failure("this explicit tool-policy restriction is not supported; retain the policy and use the built-in runtime");
  }
  const selected = p.agentHarnessRuntimeOverride ?? p.agentHarnessId ?? p.runtimePlan?.resolvedRef.harnessId;
  if (selected !== RUNTIME_ID) failure("requires explicit dsh-native selection");
  if (p.agentHarnessId && p.agentHarnessId !== RUNTIME_ID ||
      p.runtimePlan?.resolvedRef.harnessId && p.runtimePlan.resolvedRef.harnessId !== RUNTIME_ID) {
    failure("prepared harness identity differs from dsh-native");
  }
  if (!p.sessionId || !p.runId || !p.sessionFile || !p.workspaceDir) failure("missing prepared run identity");
  if (!Number.isSafeInteger(p.timeoutMs) || p.timeoutMs <= 0 || p.timeoutMs > 2_147_483_647) {
    failure("requires a bounded positive attempt timeout");
  }
  if (p.contextEngine && (p.contextEngine.info.id !== "legacy" || p.contextEngine.info.ownsCompaction ||
      Object.keys(p.contextEngine.info.hostRequirements ?? {}).length)) {
    failure("custom context-engine assembly/compaction is unsupported; use the legacy engine and /new");
  }
  if (p.expectedSessionRuntimeOwnership || p.expectedRuntimeArtifact || p.captureRuntimeArtifact) {
    failure("native model/auth ownership or artifact pinning is unsupported");
  }
  if (p.operation && p.operation !== "attempt" || p.skipPreparedUserTurnMessage ||
      p.suppressNextUserMessagePersistence || p.suppressTranscriptOnlyAssistantPersistence ||
      p.suppressAssistantErrorPersistence) {
    failure("internal continuations or transcript-suppression modes are unsupported");
  }
  if (p.conversationRecall || p.internalEvents?.length ||
      p.execApprovalContinuationPromptRange || p.execApprovalContinuationTranscriptPromptRange) {
    failure("out-of-band recall, maintenance, or approval-continuation context is unsupported");
  }
  if (p.permissionChange?.notice || p.enforceFinalTag) failure("live permission changes or final-tag output mode is unsupported");
}

export function createNativeAssistant(p: Attempt, output: BridgeResult, now = Date.now()): Assistant {
  for (const value of Object.values(output.usage)) {
    if (!Number.isSafeInteger(value) || value < 0) failure("runtime returned invalid token usage");
  }
  if (output.stopReason === "aborted") failure("an aborted native turn is not a completed assistant");
  const totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
  if (!Number.isSafeInteger(totalTokens)) failure("runtime token usage overflow");
  return {
    role: "assistant",
    content: [{ type: "text", text: output.text }],
    api: p.model.api,
    provider: p.provider,
    model: p.model.id,
    usage: {
      ...output.usage, totalTokens,
      ...(output.contextUsage ? { contextUsage: structuredClone(output.contextUsage) } : {}),
      // DSH reports tokens, not authoritative billing. Zero is explicitly unpriced, not a free request.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: output.stopReason,
    timestamp: now,
    ...{ dshNative: { billing: "unpriced",
      ...(output.summaryUsage ? { summaryUsage: { ...output.summaryUsage } } : {}),
      ...(output.lastCallUsage ? { lastCallUsage: { ...output.lastCallUsage } } : {}),
      ...(output.preparation ? { preparation: {
        mode: output.preparation.decision.mode,
        revision: output.preparation.state.revision,
        clarificationTurns: output.preparation.state.clarificationTurns,
      } } : {}),
    } },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function attributeAssistant(
  message: Assistant | undefined,
  model: { provider: string; model: string } | undefined,
): Assistant | undefined {
  if (!message || !model || message.provider === model.provider && message.model === model.model) return message;
  // Keep the host-approved content and billing fields, not its redacted routing identity.
  return { ...message, provider: model.provider, model: model.model };
}

export function createNativeHarness(
  config: DshConfig,
  runtime: DshRuntime,
  dependencies: NativeHarnessDependencies = defaults,
): AgentHarnessV2 {
  const active = new Map<string, { controller: AbortController; done: Promise<void>; sessionKey?: string }>();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let isolated: IsolatedCompletion | undefined;

  async function runAttempt(p: Attempt): Promise<Result> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      ...(p.abortSignal ? [p.abortSignal] : []),
      ...(p.replyOperation ? [p.replyOperation.abortSignal] : []),
    ]);
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    const owner = { controller, done, sessionKey: p.sessionKey };
    let claimed = false;
    let sdk: LifecycleSdk | undefined;
    let host: NativeHost | undefined;
    let transcript: Awaited<ReturnType<typeof prepareNativeTranscript>> | undefined;
    let maintenance: Awaited<ReturnType<typeof readNativeMaintenanceContext>> | undefined;
    let memory = false;
    let registered = false;
    let attached = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let runtimeEntered = false;
    let runtimeSettled = false;
    let emittedVisibleOutput = false;
    let streaming = false;
    let stopped = false;
    let settled = false;
    let terminal: Terminal = { kind: "ok" };
    let assistant: Assistant | undefined;
    let completedAssistant: Assistant | undefined;
    let executedModel: { provider: string; model: string } | undefined;
    let owned = false;
    let idempotencyKey: string | undefined;
    let usage: BridgeUsage | undefined;
    let finalContextUsage: BridgeContextUsage | undefined;
    let streamedText = "";
    let streamedReasoning = "";
    let startedAssistant = false;
    const toolMetas: Result["toolMetas"] = [];
    let hookContext: Parameters<LifecycleSdk["awaitAgentHarnessAgentEndHook"]>[0]["ctx"] | undefined;
    let assertContinuity: (() => void) | undefined;
    const assertActive = () => {
      signal.throwIfAborted();
      if (disposed || stopped || !claimed || active.get(p.sessionId) !== owner) failure("run authority is no longer current");
      p.hostCapabilities.assertActive();
    };
    const cancel = (reason?: string) => {
      if (settled || signal.aborted) return;
      controller.abort(new Error(`DSH native run cancelled: ${reason ?? "user_abort"}`));
      try { p.onAttemptAbort?.(); } catch { /* Cancellation already owns the outcome. */ }
    };
    const handle: Parameters<LifecycleSdk["setActiveEmbeddedRun"]>[1] & { kind: "embedded"; cancel: typeof cancel } = {
      kind: "embedded", runId: p.runId, startedAtMs: p.startedAtMs ?? startedAt,
      toolAuthorityFingerprint: p.toolAuthorityFingerprint,
      sourceReplyDeliveryMode: p.sourceReplyDeliveryMode,
      taskSuggestionDeliveryMode: p.taskSuggestionDeliveryMode,
      supportsQueueMessageImages: false,
      messageInjection: {
        isAvailable: () => false,
        queueMessage: async () => failure("live steering is unsupported; queue a new turn after completion"),
      },
      queueMessage: async (_text, options) => {
        options?.onQueueAccepted?.(false);
        failure("live steering is unsupported; queue a new turn after completion");
      },
      isStreaming: () => streaming && !signal.aborted,
      isStopped: () => stopped,
      isAborted: () => signal.aborted,
      isAbortable: () => !stopped && !signal.aborted,
      ownsLiveness: () => runtimeEntered && !runtimeSettled && !signal.aborted,
      isCompacting: () => false,
      abort: cancel, cancel,
    };
    const classifyFailure = (error: unknown): Terminal => {
      if (timedOut) return {
        kind: "timeout", source: "runtime",
        phase: host?.getToolCounts().activeCount ? "tool_execution" : "prompt",
        aborted: true, failure: { source: "prompt", error },
      };
      if (signal.aborted) return {
        kind: "aborted",
        source: p.abortSignal?.aborted || p.replyOperation?.abortSignal.aborted ? "external" : "runtime",
        failure: { source: runtimeEntered ? "prompt" : "precheck", error },
      };
      return { kind: "failed", source: runtimeEntered ? "prompt" : "precheck", error };
    };
    const onEvent = async (event: BridgeEvent) => {
      assertActive();
      p.replyOperation?.recordActivity();
      p.onRunProgress?.({ reason: `dsh:${event.type}`, provider: p.provider, model: p.model.id, backend: RUNTIME_ID });
      if (event.type === "text" || event.type === "reasoning") {
        if (!startedAssistant) {
          startedAssistant = true;
          await p.onAssistantMessageStart?.();
          assertActive();
        }
        streaming = true;
      }
      if (event.type === "text") {
        streamedText += event.text;
        if (!p.suppressLiveStreamOutput && !p.silentExpected && event.text) {
          emittedVisibleOutput = true;
          await p.onPartialReply?.({ text: streamedText, delta: event.text });
        }
      } else if (event.type === "reasoning") {
        streamedReasoning += event.text;
        if (!p.suppressLiveStreamOutput && !p.silentExpected && (p.reasoningLevel === "on" || p.reasoningLevel === "stream")) {
          await p.onReasoningStream?.({
            text: streamedReasoning, isReasoning: true, isReasoningSnapshot: true,
          });
        }
      } else if (event.type === "usage") {
        usage = {
          input: (usage?.input ?? 0) + event.usage.input,
          output: (usage?.output ?? 0) + event.usage.output,
          cacheRead: (usage?.cacheRead ?? 0) + event.usage.cacheRead,
          cacheWrite: (usage?.cacheWrite ?? 0) + event.usage.cacheWrite,
        };
        p.hostCapabilities.reportOutputTokens?.(event.usage.output);
      } else if (event.type === "status") {
        await p.onAgentEvent?.({ stream: "dsh-native", data: { status: event.status }, sessionKey: p.sessionKey });
      }
      assertActive();
    };

    try {
      try {
        assertNativeAttemptSupported(p, config.toolAllowlist);
        memory = isNativeMemoryAttempt(p);
        if (disposed) failure("harness is disposed");
        if (active.has(p.sessionId)) failure("another DSH native attempt owns this session");
        active.set(p.sessionId, owner);
        claimed = true;
        assertActive();
        const deadlineAtMs = startedAt + (memory ? Math.min(p.timeoutMs, MEMORY_TIMEOUT_MS) : p.timeoutMs);
        const expire = () => {
          if (settled || signal.aborted) return;
          timedOut = true;
          const reason = new Error("DSH native attempt deadline exceeded");
          controller.abort(reason);
          // Callback errors must not escape the timer or replace the cancellation cause.
          try { p.onAttemptTimeout?.(reason); } catch { /* Cancellation already owns the outcome. */ }
        };
        timer = setTimeout(expire, Math.max(0, deadlineAtMs - Date.now()));
        p.onAttemptDeadlineChanged?.({ kind: "bounded", deadlineAtMs });
        p.onAttemptTimeoutArmed?.();
        sdk = await dependencies.loadSdk();
        assertActive();
        if (config.taskPreparation && !p.agentId) {
          const { sessionAgentId } = sdk.resolveSessionAgentIds({ config: p.config, sessionKey: p.sessionKey });
          p = { ...p, agentId: sessionAgentId };
        }
        const route = resolveNativeRoute(p, config, sdk.getModelProviderRequestTransport);
        if (memory) route.maxTokens = Math.min(route.maxTokens ?? MEMORY_OUTPUT_TOKENS, MEMORY_OUTPUT_TOKENS);
        executedModel = { provider: p.provider, model: route.modelId };
        const preparationPolicy = memory ? undefined : resolvePreparationPolicy(config.taskPreparation, p.agentId ?? "");
        if (preparationPolicy && p.inputProvenance && p.inputProvenance.kind !== "external_user") {
          failure("adaptive task preparation requires an ordinary foreground user turn");
        }
        const preparationGate = preparationPolicy ? createPreparationGate(preparationPolicy) : undefined;
        hookContext = {
          runId: p.runId, agentId: p.agentId, sessionId: p.sessionId, sessionKey: p.sessionKey,
          workspaceDir: p.workspaceDir, modelProviderId: p.provider, modelId: p.model.id,
          config: p.config, messageProvider: p.messageProvider, channelId: p.chatId ?? p.currentChannelId,
          channel: p.messageChannel, channelContext: p.channelContext, accountId: p.agentAccountId,
          senderId: p.senderId ?? undefined, chatId: p.chatId, trigger: p.trigger, jobId: p.jobId,
        };
        sdk.setActiveEmbeddedRun(p.sessionId, handle, p.sessionKey, p.sessionFile, p.agentId);
        registered = true;
        p.replyOperation?.attachBackend(handle);
        attached = !!p.replyOperation;
        p.replyOperation?.setPhase("running");
        assertActive();
        if (memory) {
          maintenance = await (dependencies.readMaintenanceContext ?? readNativeMaintenanceContext)(p, assertActive);
        } else {
          transcript = await dependencies.prepareTranscript(p, assertActive);
          await runtime.recoverCompaction?.({
            ...route, sessionId: p.sessionId, nativeStateId: transcript.nativeStateId,
            runId: p.runId, workspaceDir: p.cwd ?? p.workspaceDir, signal, assertActive,
          });
        }
        assertActive();
        assertContinuity = transcript && dependencies.prepareContinuity?.(
          config, p, transcript.contextMessages, transcript.nativeStateId, transcript.assistantKeyPrefix,
        );
        assertContinuity?.();
        const history = transcript?.contextMessages ?? maintenance?.contextMessages ?? [];
        host = await dependencies.prepareHost(p, signal, assertActive, history,
          preparationPolicy && preparationGate ? { policy: preparationPolicy, gate: preparationGate } : undefined,
          memory ? (config.toolAllowlist ?? ["read", "write"]).filter((name) => name === "read" || name === "write") : config.toolAllowlist);
        assertActive();
        if (memory) {
          if (host.tools.some((tool) => tool.name !== "read" && tool.name !== "write")) {
            failure("memory maintenance received a non-memory host tool");
          }
          host = { ...host, prompt: renderMemoryPrompt(host, history, route.contextWindow, route.maxTokens ?? MEMORY_OUTPUT_TOKENS) };
          await maintenance?.assertCurrent();
        } else {
          await transcript!.persistUser();
        }
        assertActive();
        assertContinuity?.();
        sdk.runAgentHarnessLlmInputHook({
          ctx: hookContext,
          event: {
            runId: p.runId, sessionId: p.sessionId, provider: p.provider, model: route.modelId,
            systemPrompt: host.systemPrompt, prompt: host.prompt,
            historyMessages: memory ? [] : transcript!.contextMessages.slice(0, -1), imagesCount: 0, tools: host.tools,
          },
        });
        assertActive();
        transcript?.markSentToProvider();
        runtimeEntered = true;
        p.onExecutionStarted?.({ lifecycleGeneration: p.lifecycleGeneration });
        p.onExecutionPhase?.({ phase: "model_call_started", provider: p.provider, model: route.modelId,
          backend: RUNTIME_ID, firstModelCallStarted: true });
        assertActive();
        const output = await runtime.run({
          ...route, sessionId: p.sessionId, runId: p.runId,
          nativeStateId: memory ? `${maintenance!.nativeStateId}\0memory\0${p.runId}` : transcript!.nativeStateId,
          workspaceDir: p.cwd ?? p.workspaceDir, prompt: host.prompt, systemPrompt: host.systemPrompt,
          tools: host.tools, signal,
          assertActive: () => { assertActive(); assertContinuity?.(); },
          onEvent,
          ...(preparationPolicy && preparationGate ? {
            taskPreparation: { policy: preparationPolicy, userText: p.transcriptPrompt ?? p.prompt },
            onPreparationDecision: (resolution) => {
              assertActive();
              preparationGate.resolve(resolution);
            },
          } satisfies Pick<Parameters<DshRuntime["run"]>[0], "taskPreparation" | "onPreparationDecision"> : {}),
          executeTool: async (call, toolSignal) => {
            assertActive();
            if (memory) {
              await maintenance!.assertCurrent();
              if (toolMetas.length >= MEMORY_TOOL_LIMIT) failure("memory maintenance exceeded its bounded host-tool budget");
            }
            await p.onToolStreamBoundary?.();
            const meta: Result["toolMetas"][number] = { toolName: call.name, toolCallId: call.callId };
            toolMetas.push(meta);
            try {
              const result = await host!.executeTool(call, toolSignal);
              meta.isError = result.isError;
              return result;
            } catch (error) {
              meta.isError = true;
              throw error;
            }
          },
        });
        runtimeSettled = true;
        assertActive();
        assertContinuity?.();
        await maintenance?.assertCurrent();
        usage = output.usage;
        finalContextUsage = memory ? { state: "unavailable" } : output.contextUsage;
        if (output.stopReason === "aborted") {
          controller.abort(new Error("DSH runtime aborted its turn"));
          signal.throwIfAborted();
        }
        assistant = createNativeAssistant(p, { ...output, contextUsage: finalContextUsage });
        sdk.runAgentHarnessLlmOutputHook({
          ctx: hookContext, event: {
            runId: p.runId, sessionId: p.sessionId, provider: p.provider, model: route.modelId,
            resolvedRef: `${p.provider}/${route.modelId}`, harnessId: RUNTIME_ID,
            prompt: host.prompt, assistantTexts: output.text ? [output.text] : [],
            lastAssistant: assistant, usage: { ...output.usage, total: assistant.usage.totalTokens },
            contextTokenBudget: route.contextWindow,
          },
        });
        const finalization = await sdk.runAgentHarnessBeforeAgentFinalizeHook({
          ctx: hookContext, event: {
            runId: p.runId, sessionId: p.sessionId, sessionKey: p.sessionKey,
            provider: p.provider, model: route.modelId, cwd: p.cwd ?? p.workspaceDir,
            stopHookActive: false, lastAssistantMessage: output.text,
            messages: [...(transcript?.contextMessages ?? []), assistant],
          },
        });
        assertActive();
        if (finalization.action === "revise") failure("before_agent_finalize requested a revision; native revision continuations are unsupported");
        if (memory) {
          // The completion is durable only in the isolated maintenance binding.
          // Do not append an internal user/assistant pair to the foreground mirror.
          owned = true;
        } else {
          const persisted = await transcript!.persistAssistant(assistant);
          owned = persisted.owned;
          idempotencyKey = persisted.idempotencyKey;
          assistant = persisted.message;
          assertActive();
          if (persisted.suppressed) failure("assistant transcript hook suppressed the native mirror; start a fresh session with /new");
        }
        completedAssistant = assistant;
        if (streamedReasoning) await p.onReasoningEnd?.();
        assertActive();
      } catch (error) {
        const committed = transcript?.getAssistantPersistence?.();
        if (committed?.owned) {
          owned = true;
          idempotencyKey = committed.idempotencyKey;
          assistant = committed.message;
        }
        terminal = classifyFailure(error);
        completedAssistant = undefined;
      } finally {
        stopped = true;
        streaming = false;
        const cleanup = async (run: () => void | Promise<void>) => {
          try { await run(); } catch (error) {
            if (terminal.kind === "ok") terminal = { kind: "failed", source: "prompt", error };
          }
        };
        if (host) await cleanup(() => host!.dispose());
        if (attached) await cleanup(() => p.replyOperation!.detachBackend(handle));
        if (registered) await cleanup(() => sdk!.clearActiveEmbeddedRun(p.sessionId, handle, p.sessionKey, p.sessionFile, "dsh-native-settled"));
      }
      const replay = host?.getReplayState() ?? {
        hadPotentialSideEffects: p.initialReplayState?.hadPotentialSideEffects === true,
        replaySafe: !p.initialReplayState?.hadPotentialSideEffects && !p.initialReplayState?.replayInvalid,
      };
      // DSH consumes the native turn durably; automatic replay cannot safely use the mirror as history.
      if (runtimeEntered || emittedVisibleOutput) replay.replaySafe = false;
      const result: Result = {
        terminal, sessionIdUsed: p.sessionId, sessionFileUsed: p.sessionFile, agentHarnessId: RUNTIME_ID,
        messagesSnapshot: transcript?.messages ?? maintenance?.messages ?? [], assistantTexts: completedAssistant
          ? completedAssistant.content.filter((block) => block.type === "text").map((block) => block.text) : [],
        lastAssistant: assistant, currentAttemptAssistant: attributeAssistant(assistant, executedModel),
        currentAttemptCompletedAssistant: attributeAssistant(completedAssistant, executedModel),
        toolMetas, didSendViaMessagingTool: false,
        messagingToolSentTexts: [], messagingToolSentMediaUrls: [], messagingToolSentTargets: [],
        cloudCodeAssistFormatError: false, replayMetadata: replay,
        itemLifecycle: host?.getToolCounts() ?? { startedCount: 0, completedCount: 0, activeCount: 0 },
        ...(owned ? { assistantTranscriptOwned: true, assistantTranscriptIdempotencyKey: idempotencyKey } : {}),
        ...(usage ? { attemptUsage: {
          ...usage,
          total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
          ...(finalContextUsage ? { contextUsage: structuredClone(finalContextUsage) } : {}),
        } } : {}),
      };
      if (sdk && hookContext) {
        try {
          await sdk.awaitAgentHarnessAgentEndHook({
            ctx: hookContext, event: {
              runId: p.runId, messages: transcript?.contextMessages ?? [], success: terminal.kind === "ok",
              durationMs: Date.now() - startedAt,
              ...(terminal.kind === "failed" ? { error: describe(terminal.error) } :
                terminal.kind === "ok" ? {} : { error: terminal.kind }),
            },
          });
        } catch (error) {
          if (terminal.kind === "ok") result.terminal = { kind: "failed", source: "prompt", error };
        }
      }
      const assertPublishable = () => {
        signal.throwIfAborted();
        if (disposed || active.get(p.sessionId) !== owner) failure("final reply authority is no longer current");
        p.hostCapabilities.assertActive();
      };
      if (result.terminal.kind === "ok") {
        try { assertPublishable(); }
        catch (error) { result.terminal = classifyFailure(error); }
      }
      if (result.terminal.kind === "ok" && sdk && completedAssistant && !p.silentExpected &&
          Reflect.get(completedAssistant, "display") !== false &&
          [undefined, "final_answer"].includes(Reflect.get(completedAssistant, "phase"))) {
        const text = result.assistantTexts.join("\n");
        if (text.trim()) {
          try {
            assertPublishable();
            const event = {
              stream: "assistant",
              sessionKey: p.sessionKey,
              data: { text, delta: "", phase: "final_answer", itemId: `dsh-native:${p.runId}:assistant` },
            };
            // Publish only the committed, rewritten/redacted final snapshot. Raw partial
            // callbacks stay separate; the Gateway cannot build its final from history.
            await p.onAgentEvent?.(event);
            assertPublishable();
            sdk.emitAgentEvent({
              ...event, runId: p.runId, sessionId: p.sessionId,
              agentId: p.agentId, lifecycleGeneration: p.lifecycleGeneration,
            });
          } catch (error) {
            result.terminal = classifyFailure(error);
          }
        }
      }
      if (result.terminal.kind !== "ok") {
        result.assistantTexts = [];
        result.currentAttemptCompletedAssistant = undefined;
      }
      return result;
    } finally {
      settled = true;
      if (timer) clearTimeout(timer);
      if (claimed && active.get(p.sessionId) === owner) active.delete(p.sessionId);
      release();
    }
  }

  async function compact(p: CompactParams): Promise<CompactResult> {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      ...(p.abortSignal ? [p.abortSignal] : []),
    ]);
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    const owner = { controller, done, sessionKey: p.sessionKey };
    let claimed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      signal.throwIfAborted();
      if (disposed) failure("harness is disposed");
      if (!p.sessionId || !p.sessionFile || !p.workspaceDir) failure("missing prepared compaction identity");
      if (active.has(p.sessionId)) failure("another DSH native operation owns this session");
      if (p.agentHarnessId && p.agentHarnessId !== RUNTIME_ID) failure("prepared harness identity differs from dsh-native");
      const model = p.runtimeModel ?? failure("native compaction requires the host-resolved runtime model");
      const provider = p.provider ?? model.provider;
      if (provider !== "deepseek" && provider !== "github-copilot") failure("unsupported native compaction provider");
      if (provider !== model.provider) failure("native compaction provider does not match the runtime model");
      if (p.cliSessionId || p.cliSessionBinding) failure("CLI bindings cannot select native DSH history");
      const runId = p.runId ?? p.sessionTarget?.expectedWriterRunId ?? `compact-${randomUUID()}`;
      if (!runId.trim() || runId.trim() !== runId) failure("invalid native compaction run identity");
      active.set(p.sessionId, owner);
      claimed = true;
      timer = setTimeout(() => controller.abort(new Error("DSH native compaction deadline exceeded")), 120_000);
      const assertActive = () => {
        signal.throwIfAborted();
        if (disposed || !claimed || active.get(p.sessionId) !== owner) failure("compaction authority is no longer current");
      };
      const sdk = await dependencies.loadSdk();
      assertActive();
      const context = await (dependencies.readMaintenanceContext ?? readNativeMaintenanceContext)({ ...p, runId }, assertActive);
      const route = resolveNativeRoute({
        ...p,
        provider,
        model,
        modelId: p.model ?? model.id,
        resolvedApiKey: p.resolvedApiKey,
        thinkLevel: p.thinkLevel ?? "off",
        config: p.config,
      }, config, sdk.getModelProviderRequestTransport);
      await context.assertCurrent();
      const output = await runtime.compact({
        ...route,
        provider,
        sessionId: p.sessionId,
        nativeStateId: context.nativeStateId,
        runId,
        workspaceDir: p.cwd ?? p.workspaceDir,
        signal,
        assertActive: () => {
          assertActive();
          p.compactionTimeoutReset?.();
        },
      });
      await context.assertCurrent();
      return {
        ok: true,
        compacted: output.compacted,
        compactionKind: "native-harness",
        reason: output.compacted ? undefined : "no compactable native history range",
        result: {
          summary: output.summary,
          tokensBefore: output.tokensBefore ?? p.currentTokenCount ?? 0,
          tokensAfter: output.tokensAfter,
          details: { ...output.details,
            ...(output.summaryUsage ? { summaryUsage: output.summaryUsage, billing: "unpriced" } : {}),
          },
          sessionId: p.sessionId,
          sessionFile: p.sessionFile,
        },
      };
    } catch (error) {
      const message = describe(error);
      return {
        ok: false,
        compacted: false,
        compactionKind: "native-harness",
        reason: message,
        failure: { reason: message },
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (claimed && active.get(p.sessionId) === owner) active.delete(p.sessionId);
      release();
    }
  }

  return {
    id: RUNTIME_ID, label: "DeepSeek Harness (native, opt-in)", pluginId: RUNTIME_ID,
    autoSelection: { providerIds: [] }, deliveryDefaults: { visibleReplies: "automatic" },
    // The host requires exact enforcement before honoring safe-deny declarations.
    // Only absent session controls qualify as exceptions. Explicit host narrowing
    // enforces other restrictions through host construction and bound dispatch.
    conversationToolPolicySupport: "exact",
    conversationToolPolicySafeDenyTools: Object.freeze([
      "sessions_list", "sessions_history", "sessions_send", "session_status",
    ]),
    supports: nativeSupports, runAttempt, compact,
    async runIsolatedCompletionV2(p) {
      if (disposed) failure("harness is disposed");
      const sdk = await dependencies.loadSdk();
      if (disposed) failure("harness is disposed");
      isolated ??= createIsolatedCompletion(config, (input, settings) => resolveNativeRoute({
        ...input, thinkLevel: input.thinkLevel ?? "off",
      }, settings, sdk.getModelProviderRequestTransport));
      return isolated.run(p);
    },
    async reset(params) {
      for (const [sessionId, run] of active) {
        if (params.sessionId === sessionId || params.sessionKey && params.sessionKey === run.sessionKey) {
          run.controller.abort(new Error("DSH session reset"));
          await run.done;
        }
      }
      // Old state is retained; a new host identity or clear-reset epoch starts fresh native history.
    },
    dispose() {
      disposal ??= (async () => {
        disposed = true;
        for (const run of active.values()) run.controller.abort(new Error("DSH harness disposed"));
        try {
          const outcomes = await Promise.allSettled([runtime.dispose(), isolated?.dispose()]);
          const errors = outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.reason);
          if (errors.length) throw new AggregateError(errors, "DSH harness disposal failed");
        }
        finally { await Promise.all([...active.values()].map((run) => run.done)); }
      })();
      return disposal;
    },
  };
}
