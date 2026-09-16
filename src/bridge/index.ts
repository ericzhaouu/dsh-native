import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import { assembleContextFor, type Agent, type AgentHandle, type AgentOptions } from "@deepseek-ai/dsh-agent";
import { createUserMessage, HarnessError, ReasoningEffortId, type GenerateOptions, type ToolSchema } from "@deepseek-ai/dsh-llm";
import { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";
import { renderContextSnapshot, renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import type { ToolDefinition, ToolExecution, ToolExecutionResult, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { Ajv } from "ajv";
import { realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { normalize } from "node:path";
import type { Readable, Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { BRIDGE_VERSION, DSH_VERSION, type BridgeEvent, type BridgeResult, type BridgeRun, type BridgeTool } from "../protocol.js";
import {
  createPreparationTool, parsePreparationDecision, parsePreparationResolution, PREPARATION_TOOL_NAME,
  type PreparationDecision, type PreparationResolution,
} from "../preparation.js";
import { JsonRpcPeer } from "../rpc.js";
import { TurnTracker } from "./turn.js";
import { assertCopilotReplaySafe, sanitizeCopilotStream } from "./copilot-replay.js";
import { emptyParams, jsonObject, keys, parseRun, parseToolResult, positiveInteger, record } from "./validation.js";

export { createBridgePatch } from "./profile.js";
export const name = "openclaw-stdio-bridge";
export const inject = ["agents", "agentLoop", "sessions", "sessionPersistence", "tools", "systemPrompt", "llm"];

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error("DSH bridge failed", { cause: value });
}

function canonicalPath(path: string): string {
  return process.platform === "win32" ? normalize(path).toLowerCase() : normalize(path);
}

function providerRoute(provider: BridgeRun["provider"]): "deepseek-official" | "github-copilot" {
  switch (provider ?? "deepseek") {
    case "deepseek": return "deepseek-official";
    case "github-copilot": return "github-copilot";
    default: throw new Error(`Unsupported provider: ${String(provider)}`);
  }
}

function auditSchemas(actual: readonly ToolSchema[], expected: readonly ToolSchema[]): void {
  if (actual.length !== expected.length || new Set(actual.map((tool) => tool.name)).size !== actual.length) {
    throw new Error("DSH visible tool surface does not exactly match host callbacks");
  }
  for (const tool of actual) {
    const host = expected.find((candidate) => candidate.name === tool.name);
    if (!host || tool.description !== host.description || !isDeepStrictEqual(tool.parameters, host.parameters)) {
      throw new Error(`Unapproved DSH tool schema: ${tool.name}`);
    }
  }
}

interface ExpectedCall {
  readonly block: Readonly<{ id: string; name: string; arguments: string }>;
  seq?: number;
  token?: ToolExecution["token"];
  invoked?: boolean;
  result?: Readonly<ToolExecutionResult>;
  committed?: boolean;
}

interface PreparationStep {
  readonly turn: number;
  readonly step: number;
  readonly internal: boolean;
  readonly tools: readonly ToolSchema[];
  signal?: AbortSignal;
  calls?: readonly ExpectedCall[];
  ended: boolean;
}

/** Owns a single request and Agent handle; never changes the process workspace. */
export class BridgeWorker {
  readonly peer: JsonRpcPeer;
  private readonly creation = new AbortController();
  private handle?: AgentHandle;
  private agent?: Agent;
  private tracker?: TurnTracker;
  private runPromise?: Promise<BridgeResult>;
  private cleanupPromise?: Promise<void>;
  private stopping = false;
  private cancelled = false;
  private disconnected = false;
  private used = false;
  private initialized = false;
  private armed = false;
  private failure?: Error;
  private toolCalls = 0;
  private readonly callIds = new Set<string>();
  private readonly definitions = new Map<string, ToolDefinition>();
  private readonly hostDefinitions = new Map<string, ToolDefinition>();
  private readonly registrations = new Map<string, () => void>();
  private readonly writes = new Set<Promise<void>>();
  private request?: BridgeRun;
  private preparationTool?: BridgeTool;
  private controlStep?: PreparationStep;
  private activeStep?: PreparationStep;
  private preparation?: PreparationResolution;
  private preparationReady = false;

  constructor(
    private readonly ctx: Context,
    input: Readable,
    output: Writable,
    private readonly onStop: () => Promise<void>,
    private readonly onFatal: (error: Error) => void = (error) => ctx.logger(name).error(error),
  ) {
    this.peer = new JsonRpcPeer(input, output, {
      onRequest: (method, params) => this.onRequest(method, params),
      onNotification: (method, params) => {
        if (method !== "cancel") throw new Error(`Unsupported bridge notification: ${method}`);
        emptyParams(params);
        this.cancel();
      },
    });
    ctx.on("llm/stream", (options, next) => {
      try {
        this.auditRequest(options);
        if (options.provider !== "github-copilot") return next();
        // DSH freezes prepared requests. Validate their already-sanitized history;
        // the Responses serializer omits unsigned reasoning without exposing it as text.
        assertCopilotReplaySafe(options);
        return sanitizeCopilotStream(next());
      } catch (error) {
        this.fail(error);
        throw error;
      }
    }, { prepend: true });
    ctx.on("tools/change", () => {
      try {
        this.auditGlobal();
        if (this.armed) this.auditTools();
      } catch (error) {
        this.fail(error);
      }
    });
    ctx.on("agent/created", ({ agent }) => {
      if (agent !== this.agent) this.fail(new Error("Unexpected autonomous DSH agent"));
    });
    void this.peer.closed.then(async () => {
      this.disconnected = true;
      this.creation.abort(new Error("DSH bridge disconnected"));
      this.cancel();
      try { await this.cleanup(); } finally { await this.onStop(); }
    }).catch((error: unknown) => this.reportFatal(error));
  }

  async ready(): Promise<void> {
    await this.ctx.get("loader")?.await();
    this.assertHealthy();
    this.auditGlobal();
    if (this.ctx.agents.list().length) throw new Error("DSH started an autonomous agent");
    this.initialized = true;
    await this.peer.notify("event", { type: "ready", version: BRIDGE_VERSION, dshVersion: DSH_VERSION } satisfies BridgeEvent);
  }

  private reportFatal(error: unknown): void {
    this.onFatal(errorOf(error));
  }

  private fail(error: unknown): void {
    this.failure ??= errorOf(error);
    this.creation.abort(this.failure);
    this.agent?.cancel({ kind: "hook", reason: "Bridge safety or transport failure" });
  }

  private assertHealthy(): void {
    if (this.failure) throw this.failure;
  }

  private auditGlobal(): void {
    auditSchemas(this.ctx.tools.schemas(), []);
    if (this.ctx.get("sdkAppStartup") || this.ctx.get("sdkJsonrpcServer")) {
      throw new Error("Official SDK startup and JSONRPC stdout ownership must be disabled");
    }
  }

  private auditTools(): void {
    this.auditGlobal();
    const agent = this.agent;
    if (!agent) throw new Error("No owned DSH agent");
    auditSchemas(agent.ctx.tools.schemas(agent), this.activeSchemas());
    for (const [name, definition] of this.definitions) {
      if (agent.ctx.tools.get(name, agent) !== definition) {
        throw new Error(`DSH tool callback was replaced: ${name}`);
      }
    }
  }

  private activeSchemas(): ToolSchema[] {
    return [...this.definitions.keys()].map((name) => {
      const schema = name === PREPARATION_TOOL_NAME
        ? this.preparationTool : this.request?.tools.find((tool) => tool.name === name);
      if (!schema) throw new Error(`Unapproved DSH tool definition: ${name}`);
      return schema;
    });
  }

  private registerTool(definition: ToolDefinition): void {
    const agent = this.agent;
    if (!agent || this.definitions.has(definition.name)) throw new Error("Invalid DSH tool registration");
    // DSH emits tools/change synchronously after mutation. Stage the exact new
    // inventory first; every notification remains audited, including transitions.
    this.definitions.set(definition.name, definition);
    this.registrations.set(definition.name, agent.ctx.tools.register(definition));
    this.auditTools();
    this.assertHealthy();
  }

  private unregisterTool(name: string): void {
    const dispose = this.registrations.get(name);
    if (!dispose) throw new Error(`Missing owned DSH tool registration: ${name}`);
    this.definitions.delete(name);
    this.registrations.delete(name);
    dispose();
    this.auditTools();
    this.assertHealthy();
  }

  private auditRequest(options: GenerateOptions): void {
    this.assertHealthy();
    this.auditTools();
    const run = this.request;
    if (!run || !this.armed || options.sessionId !== run.sessionId ||
      options.provider !== providerRoute(run.provider) || options.model !== run.modelId || options.purpose !== undefined ||
      this.ctx.agents.currentInitiator() !== this.agent) {
      throw new Error("Unowned, auxiliary, or rerouted DSH model request");
    }
    if ((options.system ?? "") !== run.systemPrompt) throw new Error("DSH changed the host system prompt");
    if (run.taskPreparation) {
      const step = this.activeStep;
      if (!step || step.ended || step.calls || !step.signal || options.signal !== step.signal ||
        this.agent?.status !== "running" || this.cancelled || step.signal.aborted ||
        (step.internal ? this.preparationReady : !this.preparationReady)) {
        throw new Error("Unowned or out-of-phase DSH preparation model request");
      }
      auditSchemas(options.tools ?? [], step.tools);
      auditSchemas(options.tools ?? [], this.activeSchemas());
    } else {
      auditSchemas(options.tools ?? [], run.tools);
    }
  }

  private emit = (event: BridgeEvent): void => {
    if (this.disconnected) return;
    const write = this.peer.notify("event", event);
    this.writes.add(write);
    void write.then(() => this.writes.delete(write), (error: unknown) => {
      this.writes.delete(write);
      this.fail(error);
    });
  };

  cancel(): void {
    this.cancelled = true;
    this.agent?.cancel({ kind: "user" });
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    if (method === "run") {
      if (!this.initialized) throw new Error("DSH bridge is not ready");
      if (this.used || this.stopping) throw new Error("Only one run is permitted per bridge process");
      const run = parseRun(params);
      this.used = true;
      this.request = run;
      this.runPromise = this.run(run);
      return this.runPromise;
    }
    if (method === "shutdown") {
      emptyParams(params);
      if (this.stopping) throw new Error("Bridge shutdown already requested");
      this.stopping = true;
      try {
        await this.cleanup();
      } finally {
        // The RPC handler queues success/error in a microtask after we return.
        // Drain on the next macrotask before disposing the root.
        setImmediate(() => {
          void (async () => {
            try { await this.peer.drain(); } finally { await this.onStop(); }
            this.peer.close();
          })().catch((error: unknown) => {
            this.reportFatal(error);
            this.peer.close(errorOf(error));
          });
        });
      }
      return {};
    }
    throw new Error(`Unsupported bridge request: ${method}`);
  }

  private async setup(agentCtx: Context, run: BridgeRun, workspace: string): Promise<{ commit(): void }> {
    const agent = agentCtx.agent;
    if (!agent || agent.id !== run.sessionId || agent.session.id !== run.sessionId) {
      throw new Error("DSH created a mismatched session identity");
    }
    this.agent = agent;
    const storedWorkspace = agent.session.header.cwd;
    if (!storedWorkspace || canonicalPath(await realpath(storedWorkspace)) !== canonicalPath(workspace)) {
      throw new Error("DSH persisted workspace does not match the requested workspace");
    }
    if (agent.session.header.parentSession || agent.session.header.origin || agent.session.header.agentPreset) {
      throw new Error("Cannot resume a delegated or preset-owned DSH session");
    }
    agentCtx.tools.restrict({ allow: [] });
    agentCtx.tools.presentAs("native");
    agentCtx.systemPrompt.suppressRuntimeContext();
    agentCtx.systemPrompt.variable("openclaw_system_prompt", () => run.systemPrompt);
    agentCtx.systemPrompt.section({
      name: "openclaw:complete", order: 0, complete: true, text: "{{openclaw_system_prompt}}",
    });
    agentCtx.on("agent/request", async (event, next) => {
      await next();
      if (run.taskPreparation) {
        const step = this.activeStep;
        if (event.agent !== agent || !step || step.ended || step.turn !== event.turn || step.step !== event.step) {
          const error = new Error("Unowned DSH preparation request step");
          this.fail(error);
          throw error;
        }
        step.signal = event.signal;
      }
      // Resume otherwise inherits an earlier explicit reasoning effort. Missing
      // fields in this run must instead use the current adapter/profile defaults.
      const maxTokens = run.taskPreparation && this.activeStep?.internal
        ? Math.min(run.maxTokens ?? 8192, 8192) : run.maxTokens;
      return {
        provider: providerRoute(run.provider), model: run.modelId,
        ...(run.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(run.reasoningEffort) }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      };
    });
    const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false, ownProperties: true, addUsedSchema: false });
    for (const host of run.tools) {
      const validate = ajv.compile(host.parameters);
      const definition = Object.freeze<ToolDefinition>({
        ...host,
        parameters: structuredClone(host.parameters),
        output: {
          schema: { type: "string" },
          render: (_args, value) => {
            if (typeof value !== "string") throw new TypeError("Host tool output must be text");
            return [{ type: "text", text: value }];
          },
        },
        execute: async (args, execution) => {
          const parameters = jsonObject(args, `arguments for ${host.name}`);
          if (!validate(parameters)) throw new HarnessError(ajv.errorsText(validate.errors), "INVALID_ARGS");
          return this.callTool(host.name, parameters, execution);
        },
        finalizeContent: (_execution, result) => result.isError && result.error.info?.code === "HOST_TOOL_ERROR"
          ? [{ type: "text", text: result.error.message }] : undefined,
      });
      this.hostDefinitions.set(host.name, definition);
      if (!run.taskPreparation) this.registerTool(definition);
    }
    if (run.taskPreparation) {
      this.preparationTool = createPreparationTool(run.taskPreparation);
      this.registerTool(Object.freeze<ToolDefinition>({
        ...this.preparationTool,
        parameters: structuredClone(this.preparationTool.parameters),
        output: {
          schema: { type: "object" },
          render: (_args, value) => {
            const resolution = parsePreparationResolution(value);
            if (!isDeepStrictEqual(resolution, this.preparation)) throw new Error("Preparation output was replaced");
            // A normal tool-result data block, never a system prompt or deferred instruction.
            return [{ type: "text", text: JSON.stringify(resolution) }];
          },
        },
        execute: (args, execution) => this.prepareTask(args, execution),
      }));
      agentCtx.on("session/event", (session, event) => {
        if (session !== agent.session) return;
        try { this.observePreparation(event); } catch (error) { this.fail(error); }
      });
    }
    agentCtx.tools.guard((execution) => {
      try {
        this.assertHealthy();
        this.auditTools();
        if (execution.agent !== agent || execution.parent || !this.definitions.has(execution.name)) {
          throw new Error(`Unapproved DSH tool execution: ${execution.name}`);
        }
        if (run.taskPreparation) {
          const call = this.expectedExecution(execution);
          if (call.token) throw new Error("Duplicate DSH preparation execution");
          if (execution.signal !== this.activeStep?.signal) throw new Error("Unowned DSH tool cancellation identity");
          call.token = execution.token;
        }
      } catch (error) {
        this.fail(error);
        return errorOf(error).message;
      }
      return undefined;
    });
    agentCtx.on("tools/result", (execution, result) => {
      try {
        if (execution.agent !== agent || execution.parent || !this.definitions.has(execution.name)) {
          throw new Error(`Unapproved DSH tool execution: ${execution.name}`);
        }
        if (run.taskPreparation) this.observeToolResult(execution, result);
      } catch (error) { this.fail(error); }
      return undefined;
    });
    this.tracker = new TurnTracker(agentCtx, this.emit, run.taskPreparation ? {
      isInternalStep: (turn, step) => this.controlStep?.turn === turn && this.controlStep.step === step,
    } : {});
    const assembly = await agentCtx.systemPrompt.assemble(assembleContextFor(agent));
    if (renderPrompt(assembly) !== run.systemPrompt || renderContextSnapshot(assembly)) {
      throw new Error("DSH prompt assembly differs from the complete host prompt");
    }
    auditSchemas(assembly.tools, this.activeSchemas());
    return { commit: () => {
      this.assertHealthy();
      this.auditTools();
      if (this.ctx.agents.list().length) throw new Error("Unexpected preexisting DSH agent");
      this.armed = true;
    } };
  }

  private observePreparation(event: SessionEvent): void {
    if (event.type === "step/start") {
      if (this.activeStep && !this.activeStep.ended) throw new Error("Overlapping DSH preparation steps");
      if (this.controlStep && !this.preparationReady) throw new Error("Preparation control step did not commit");
      const step: PreparationStep = {
        turn: event.data.turn, step: event.data.step, internal: !this.controlStep,
        tools: Object.freeze(structuredClone(this.activeSchemas())), ended: false,
      };
      this.controlStep ??= step;
      this.activeStep = step;
      return;
    }
    if (event.type !== "assistant/message" && event.type !== "tool/call" &&
      event.type !== "tool/result" && event.type !== "step/end") return;
    const step = this.activeStep;
    if (!step || step.ended || event.data.turn !== step.turn || event.data.step !== step.step) {
      throw new Error("DSH preparation event outside its live step");
    }
    switch (event.type) {
      case "assistant/message": {
        if (step.calls) throw new Error("Duplicate DSH preparation assistant message");
        if (event.data.interrupted) return;
        const blocks = event.data.message.content.filter((block) => block.type === "tool-call");
        if (step.internal && (blocks.length !== 1 || blocks[0]?.name !== PREPARATION_TOOL_NAME)) {
          throw new Error("Preparation requires exactly one control call and no host siblings");
        }
        const ids = new Set<string>();
        for (const block of blocks) {
          if (!block.id || ids.has(block.id) || this.callIds.has(block.id) ||
            !step.tools.some((tool) => tool.name === block.name)) {
            throw new Error("Unapproved, duplicate, or unadvertised DSH preparation tool call");
          }
          ids.add(block.id);
        }
        step.calls = Object.freeze(blocks.map((block) => ({ block: Object.freeze({ ...block }) })));
        for (const id of ids) this.callIds.add(id);
        return;
      }
      case "tool/call": {
        const call = step.calls?.find((call) => call.block.id === event.data.callId);
        if (!call || call.seq !== undefined || call.block.name !== event.data.name ||
          call.block.arguments !== event.data.arguments) throw new Error("Unowned DSH preparation tool/call");
        call.seq = event.seq;
        return;
      }
      case "tool/result": {
        const block = event.data.message.content[0];
        const call = step.calls?.find((call) => call.block.id === block.toolCallId);
        if (!call || call.committed || call.seq === undefined ||
          !isDeepStrictEqual(event.sourceEventSeqs, [call.seq])) throw new Error("Unowned DSH preparation tool/result");
        if (call.result) {
          if (Boolean(block.isError) !== call.result.isError || !isDeepStrictEqual(block.content, call.result.content)) {
            throw new Error("DSH preparation tool result changed before commit");
          }
        } else if (!this.cancelled && !step.signal?.aborted) {
          throw new Error("DSH preparation tool result has no owned execution");
        }
        call.committed = true;
        return;
      }
      case "step/end": {
        step.ended = true;
        if (this.cancelled || step.signal?.aborted) return;
        this.assertHealthy();
        this.tracker?.assertHealthy();
        if (!step.calls || step.calls.some((call) => !call.committed)) {
          throw new Error("DSH preparation step has uncommitted calls");
        }
        if (step.internal) {
          const call = step.calls[0];
          if (!this.preparation || !call?.invoked || !call.result || call.result.isError || !call.committed) {
            throw new Error("Preparation control did not commit a successful result");
          }
          // The loop assembles its next request AFTER step/end. Never append a
          // session event here, and never register tools while the batch is live.
          this.unregisterTool(PREPARATION_TOOL_NAME);
          for (const name of this.preparation.allowedTools) {
            if (this.cancelled || step.signal?.aborted) return;
            const definition = this.hostDefinitions.get(name);
            if (!definition) throw new Error("Preparation selected an unknown host tool");
            this.registerTool(definition);
          }
          this.preparationReady = true;
        }
        return;
      }
    }
  }

  private expectedExecution(execution: ToolExecution): ExpectedCall {
    this.assertHealthy();
    this.tracker?.assertHealthy();
    this.auditTools();
    const step = this.activeStep;
    const call = step?.calls?.find((call) => call.block.id === execution.callId);
    if (!this.armed || !step || step.ended || !call || call.seq === undefined || call.committed ||
      execution.agent !== this.agent || execution.parent !== undefined || execution.rootCallId !== execution.callId ||
      this.ctx.agents.currentInitiator() !== this.agent || execution.name !== call.block.name ||
      !step.tools.some((tool) => tool.name === execution.name)) {
      throw new Error("Invalid or unowned DSH preparation execution identity");
    }
    // Validate against the committed call, not a mutable wrapper's arguments.
    if (!isDeepStrictEqual(execution.arguments, JSON.parse(call.block.arguments || "{}"))) {
      throw new Error("DSH preparation execution arguments changed");
    }
    if (step.internal ? this.preparationReady || execution.name !== PREPARATION_TOOL_NAME
      : !this.preparationReady || this.preparation?.decision.mode !== "execute" ||
        !this.preparation.allowedTools.includes(execution.name)) {
      throw new Error("DSH tool execution exceeds preparation authority");
    }
    return call;
  }

  private beginPreparedCall(execution: ToolExecution): ExpectedCall {
    const call = this.expectedExecution(execution);
    if (this.cancelled || execution.signal.aborted || call.token !== execution.token || call.invoked) {
      throw new Error("Cancelled, duplicate, or unguarded DSH preparation callback");
    }
    call.invoked = true;
    return call;
  }

  private observeToolResult(execution: ToolExecution, result: Readonly<ToolExecutionResult>): void {
    const call = this.expectedExecution(execution);
    if (call.result || (call.token !== undefined && call.token !== execution.token) ||
      (!result.isError && (!call.invoked || call.token !== execution.token))) {
      throw new Error("Duplicate or unowned DSH preparation execution result");
    }
    if (execution.name === PREPARATION_TOOL_NAME) {
      if (result.isError) {
        if (!this.cancelled && !execution.signal.aborted) throw new Error("Preparation control tool failed");
      } else if (!this.preparation || !isDeepStrictEqual(result.value, this.preparation) ||
        !isDeepStrictEqual(result.content, [{ type: "text", text: JSON.stringify(this.preparation) }]) ||
        result.concludesTurn || result.additionalContexts?.length) {
        throw new Error("Preparation control result was replaced or injected instructions");
      }
    }
    call.result = result;
  }

  private async prepareTask(value: unknown, execution: ToolRunContext): Promise<unknown> {
    try {
      const call = this.beginPreparedCall(execution);
      const request = this.request?.taskPreparation;
      if (!request || this.preparation || this.activeStep !== this.controlStep) {
        throw new Error("Unexpected or repeated preparation control");
      }
      const decision = parsePreparationDecision(value);
      if (decision.revision !== (request.previous?.revision ?? 0)) throw new Error("Stale preparation decision revision");
      // Await the parent even during cancellation; it owns the gate and settlement.
      const resolution = parsePreparationResolution(await this.peer.request("prepare", { decision }));
      this.validateResolution(decision, resolution);
      if (this.activeStep !== this.controlStep || this.activeStep?.ended || call.token !== execution.token) {
        throw new Error("Preparation settled outside its control execution");
      }
      this.preparation = resolution;
      return resolution;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  private validateResolution(decision: PreparationDecision, resolution: PreparationResolution): void {
    const request = this.request?.taskPreparation;
    if (!request) throw new Error("Unexpected preparation resolution");
    const effective = resolution.decision;
    const previous = request.previous;
    const evidenceText = effective.evidence.source === "current" ? request.userText : previous?.requestText;
    const turns = effective.task === "new" ? 0 : previous?.clarificationTurns ?? 0;
    if (effective.revision !== decision.revision || effective.task !== decision.task ||
      !isDeepStrictEqual(effective.evidence, decision.evidence) ||
      (effective.mode === "execute" && decision.mode !== "execute") ||
      (effective.task === "continue" && !previous?.goal.trim()) ||
      (effective.evidence.source === "previous" && !previous) ||
      (effective.evidence.quote && !evidenceText?.includes(effective.evidence.quote)) ||
      (previous && resolution.state.sourceRunId === previous.sourceRunId) ||
      resolution.state.requestText !== (effective.task === "new" ? request.userText : previous?.requestText ?? "") ||
      resolution.state.clarificationTurns !== turns + (effective.mode === "clarify" ? 1 : 0) ||
      (effective.mode === "clarify" && resolution.state.clarificationTurns > request.policy.maxClarificationTurns) ||
      resolution.allowedTools.some((name) => !this.hostDefinitions.has(name) || !request.policy.executionTools.includes(name)) ||
      (effective.mode !== "execute" && resolution.allowedTools.length > 0)) {
      throw new Error("Preparation resolution exceeds request bounds or tool ceiling");
    }
  }

  private async callTool(name: string, args: ReturnType<typeof jsonObject>, execution: ToolRunContext): Promise<string> {
    this.assertHealthy();
    this.auditTools();
    if (this.request?.taskPreparation) {
      try {
        if (execution.name !== name) throw new Error("DSH preparation callback name mismatch");
        this.beginPreparedCall(execution);
        if (this.toolCalls >= this.request.taskPreparation.policy.maxToolCalls) {
          throw new Error("Preparation host tool-call budget exhausted");
        }
      } catch (error) {
        this.fail(error);
        throw error;
      }
    } else if (execution.agent !== this.agent || execution.name !== name || execution.parent ||
      typeof execution.callId !== "string" || !execution.callId || this.callIds.has(execution.callId)) {
      const error = new Error("Invalid, duplicate, or unowned DSH callback identity");
      this.fail(error);
      throw error;
    }
    if (!this.request?.taskPreparation) this.callIds.add(execution.callId);
    this.toolCalls++;
    const pending = this.peer.request("tool", { callId: execution.callId, name, arguments: args });
    const cancel = () => this.emit({ type: "tool-cancel", callId: execution.callId });
    execution.signal.addEventListener("abort", cancel, { once: true });
    if (execution.signal.aborted) cancel();
    try {
      // Do not race this promise with abort. The host owns the real tool and
      // must settle its RPC before the DSH turn may quiesce.
      let result;
      try {
        result = parseToolResult(await pending);
      } catch (error) {
        this.fail(error);
        throw error;
      }
      if (result.isError) throw new HarnessError(result.text, "HOST_TOOL_ERROR");
      return result.text;
    } finally {
      execution.signal.removeEventListener("abort", cancel);
    }
  }

  private async run(run: BridgeRun): Promise<BridgeResult> {
    this.assertHealthy();
    this.auditGlobal();
    const workspace = await realpath(run.workspaceDir);
    if (!(await stat(workspace)).isDirectory()) throw new Error("workspaceDir is not a directory");
    const id = SessionId(run.sessionId);
    // The public factory rejects duplicate live ids, not necessarily durable
    // ones. Refuse a fresh create that could alias an existing persisted log.
    const persisted = (await this.ctx.sessionPersistence.list()).find((header) => canonicalPath(header.id) === canonicalPath(id));
    if (persisted && persisted.id !== id) throw new Error("DSH session identity differs in filename case");
    if (run.resume !== Boolean(persisted)) {
      throw new Error(run.resume ? "Cannot resume a missing DSH session" : "DSH session already exists; resume is required");
    }
    if (persisted && (!persisted.cwd || canonicalPath(await realpath(persisted.cwd)) !== canonicalPath(workspace))) {
      throw new Error("Persisted DSH session belongs to a different workspace");
    }
    const agentOptions: AgentOptions = {
      provider: providerRoute(run.provider), model: run.modelId,
      ...(run.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(run.reasoningEffort) }),
      ...(run.maxTokens === undefined ? {} : { maxTokens: run.maxTokens }),
    };
    // A host cancellation prevents driving, not identity publication. Otherwise
    // an aborted result could advertise a session that cannot be resumed.
    const setup = (agentCtx: Context) => this.setup(agentCtx, run, workspace);
    this.handle = await (run.resume
      ? this.ctx.agents.resume({ resumeSessionId: id, agentOptions, setup, signal: this.creation.signal })
      : this.ctx.agents.create({ sessionId: id, meta: { cwd: workspace }, agentOptions, setup, signal: this.creation.signal }));
    this.assertHealthy();
    this.auditTools();
    if (this.handle.agent !== this.agent || !this.tracker) throw new Error("DSH returned an unexpected agent handle");
    if (!this.cancelled) {
      this.agent.followup(createUserMessage({ content: [{ type: "text", text: run.prompt }], source: { kind: "user" } }));
    } else {
      this.agent.cancel({ kind: "user" });
    }
    await this.agent.whenIdle();
    await this.ctx.sessionPersistence.ensureMaterialized(this.agent.session);
    await this.flush();
    await Promise.all(this.writes);
    this.assertHealthy();
    const result = this.tracker.result(run.sessionId, this.cancelled, this.toolCalls);
    if (run.taskPreparation && result.stopReason !== "aborted" && !this.preparationReady) {
      throw new Error("Preparation control was not successfully committed");
    }
    return run.taskPreparation && this.preparationReady && this.preparation
      ? { ...result, preparation: structuredClone(this.preparation) } : result;
  }

  private async flush(): Promise<void> {
    if (this.handle && !await this.ctx.sessions.flush(this.handle.agent.session)) {
      throw new Error("DSH session has no active persistence flush listener");
    }
  }

  /** Unwind only our handle, after pending tool callbacks have actually settled. */
  cleanup(): Promise<void> {
    return this.cleanupPromise ??= this.performCleanup();
  }

  private async performCleanup(): Promise<void> {
    this.stopping = true;
    this.cancel();
    const failures: Error[] = [];
    if (this.runPromise) {
      try { await this.runPromise; } catch (error) {
        // The run RPC owns this rejection. Do not poison teardown with an
        // already reported request error or cache a permanently failed cleanup.
        this.ctx.logger(name).debug("Draining failed run", errorOf(error));
      }
    }
    if (this.handle) {
      try { await this.handle.agent.whenIdle(); await this.flush(); } catch (error) { failures.push(errorOf(error)); }
      this.armed = false;
      try { await this.handle.dispose(); } catch (error) { failures.push(errorOf(error)); }
      this.handle = undefined;
    }
    this.tracker?.dispose();
    if (failures.length) throw new AggregateError(failures, "DSH bridge cleanup failed");
  }
}

/** Cordis CLI entry; stdout belongs exclusively to the bridge's JSON-RPC peer. */
export function apply(ctx: Context, config: unknown): void {
  const options = record(config, "bridge config");
  keys(options, ["contextWindow"], "bridge config");
  positiveInteger(options.contextWindow, "contextWindow");
  const require = createRequire(import.meta.url);
  const installed = record(require("@deepseek-ai/dsh/package.json"), "DSH package");
  if (installed.version !== DSH_VERSION) throw new Error(`Bridge requires DSH ${DSH_VERSION}`);
  let stopping: Promise<void> | undefined;
  const stopRoot = (): Promise<void> => stopping ??= (async () => {
    process.stdin.pause();
    await ctx.root.fiber.dispose();
  })();
  const worker = new BridgeWorker(ctx, process.stdin, process.stdout, stopRoot, (error) => {
    process.exitCode = 1;
    ctx.logger(name).error(error);
  });
  ctx.effect(() => async () => {
    worker.cancel();
    try { await worker.cleanup(); } finally { worker.peer.close(); }
  });
  void worker.ready().catch((error: unknown) => {
    process.exitCode = 1;
    ctx.logger(name).error(errorOf(error));
    worker.peer.close(errorOf(error));
  });
}
