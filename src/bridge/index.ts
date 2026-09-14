import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import { assembleContextFor, type Agent, type AgentHandle, type AgentOptions } from "@deepseek-ai/dsh-agent";
import { createUserMessage, HarnessError, ReasoningEffortId, type GenerateOptions, type ToolSchema } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";
import { renderContextSnapshot, renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { Ajv } from "ajv";
import { realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { normalize } from "node:path";
import type { Readable, Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { BRIDGE_VERSION, DSH_VERSION, type BridgeEvent, type BridgeResult, type BridgeRun } from "../protocol.js";
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
  private readonly writes = new Set<Promise<void>>();
  private request?: BridgeRun;

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
    auditSchemas(agent.ctx.tools.schemas(agent), [...this.definitions.values()]);
    for (const [name, definition] of this.definitions) {
      if (agent.ctx.tools.get(name, agent) !== definition) {
        throw new Error(`DSH tool callback was replaced: ${name}`);
      }
    }
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
    auditSchemas(options.tools ?? [], run.tools);
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
    agentCtx.on("agent/request", async (_event, next) => {
      await next();
      // Resume otherwise inherits an earlier explicit reasoning effort. Missing
      // fields in this run must instead use the current adapter/profile defaults.
      return {
        provider: providerRoute(run.provider), model: run.modelId,
        ...(run.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(run.reasoningEffort) }),
        ...(run.maxTokens === undefined ? {} : { maxTokens: run.maxTokens }),
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
      this.definitions.set(host.name, definition);
      agentCtx.tools.register(definition);
    }
    agentCtx.tools.guard((execution) => {
      try {
        this.assertHealthy();
        this.auditTools();
        if (execution.agent !== agent || execution.parent || !this.definitions.has(execution.name)) {
          throw new Error(`Unapproved DSH tool execution: ${execution.name}`);
        }
      } catch (error) {
        this.fail(error);
        return errorOf(error).message;
      }
      return undefined;
    });
    agentCtx.on("tools/result", (execution) => {
      if (execution.agent !== agent || execution.parent || !this.definitions.has(execution.name)) {
        this.fail(new Error(`Unapproved DSH tool execution: ${execution.name}`));
      }
      return undefined;
    });
    this.tracker = new TurnTracker(agentCtx, this.emit);
    const assembly = await agentCtx.systemPrompt.assemble(assembleContextFor(agent));
    if (renderPrompt(assembly) !== run.systemPrompt || renderContextSnapshot(assembly)) {
      throw new Error("DSH prompt assembly differs from the complete host prompt");
    }
    auditSchemas(assembly.tools, run.tools);
    return { commit: () => {
      this.assertHealthy();
      this.auditTools();
      if (this.ctx.agents.list().length) throw new Error("Unexpected preexisting DSH agent");
      this.armed = true;
    } };
  }

  private async callTool(name: string, args: ReturnType<typeof jsonObject>, execution: ToolRunContext): Promise<string> {
    this.assertHealthy();
    this.auditTools();
    if (execution.agent !== this.agent || execution.name !== name || execution.parent ||
      typeof execution.callId !== "string" || !execution.callId || this.callIds.has(execution.callId)) {
      const error = new Error("Invalid, duplicate, or unowned DSH callback identity");
      this.fail(error);
      throw error;
    }
    this.callIds.add(execution.callId);
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
    return this.tracker.result(run.sessionId, this.cancelled, this.toolCalls);
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
