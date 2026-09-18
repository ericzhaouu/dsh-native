import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import type { BridgeContextUsage, BridgeEvent, BridgeResult, BridgeUsage, ModelProvider } from "../protocol.js";
import type { DshAttempt, DshConfig, DshRuntime } from "../runtime-types.js";

type IsolatedRun = NonNullable<AgentHarnessV2["runIsolatedCompletionV2"]>;
type IsolatedParams = Parameters<IsolatedRun>[0];
type IsolatedResult = Awaited<ReturnType<IsolatedRun>>;
type Assistant = IsolatedResult["assistant"];
type HostAuthorization = Extract<IsolatedParams["authorization"], { owner: "host" }>;
type HostIsolatedParams = IsolatedParams & {
  authorization: HostAuthorization;
  assertCurrent: () => void;
  provider: ModelProvider;
};
type Route = Pick<DshAttempt, "provider" | "modelId" | "modelName" | "apiKey" | "baseUrl" |
  "contextWindow" | "maxTokens" | "thinking" | "reasoningEffort" | "reasoningEfforts" | "headers">;

export type IsolatedRouteInput = {
  provider: ModelProvider;
  modelId: string;
  model: HostAuthorization["model"];
  resolvedApiKey: string;
  config: IsolatedParams["config"];
  agentId: string;
  thinkLevel?: IsolatedParams["thinkLevel"];
  streamParams?: IsolatedParams["streamParams"];
  contextTokenBudget?: number;
  authoredContextTokenCap?: number;
};

export type IsolatedResolveRoute = (params: IsolatedRouteInput, config: DshConfig) => Route;

export interface IsolatedCompletionOptions {
  runtimeFactory?: (config: DshConfig) => DshRuntime | Promise<DshRuntime>;
  parentSignal?: AbortSignal;
  onEvent?: (event: BridgeEvent) => void | Promise<void>;
  now?: () => number;
  maxRequestBytes?: number;
}

export interface IsolatedCompletion {
  run: IsolatedRun;
  dispose(): Promise<void>;
}

const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;

function fail(message: string): never {
  throw new Error(`dsh-native isolated completion: ${message}`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} is required`);
  return value;
}

function assertProvider(value: string): asserts value is ModelProvider {
  if (value !== "deepseek" && value !== "github-copilot") {
    fail("requires a supported host-prepared provider route");
  }
}

function concreteModelId(value: string): boolean {
  return value.length > 0 && !/[\s\x00-\x1f\x7f]/u.test(value) && !/^(auto|default|\*)$/iu.test(value);
}

function assertPreparedModel(p: IsolatedParams): asserts p is HostIsolatedParams {
  const authorization = p.authorization;
  if (authorization.owner !== "host") fail("harness-owned authentication plans are unsupported");
  const model = authorization.model;
  const provider = requireString(p.provider, "provider");
  assertProvider(provider);
  if (model.provider !== provider || p.modelId !== model.id) {
    fail("logical provider/model must match the host-prepared model");
  }
  if (!concreteModelId(model.id)) fail("requires a concrete host-prepared model id");
  if (provider === "deepseek" && model.api !== "openai-completions") {
    fail("DeepSeek isolated completion requires Chat Completions");
  }
  if (provider === "github-copilot" && (model.api !== "openai-responses" || !/^gpt-[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/u.test(model.id))) {
    fail("Copilot isolated completion requires a GPT Responses route");
  }
  if (typeof p.assertCurrent !== "function") fail("host authority assertion is required");
  if (!Number.isSafeInteger(p.timeoutMs) || p.timeoutMs <= 0 || p.timeoutMs > 2_147_483_647) {
    fail("requires a bounded positive timeout");
  }
  if (p.outputTextPolicy !== undefined && p.outputTextPolicy !== "strict-visible") {
    fail("requires strict visible text output policy");
  }
  if (p.streamParams?.temperature !== undefined) fail("generation temperature overrides are unsupported");
}

function resolvedApiKey(p: IsolatedParams): string {
  const authorization = p.authorization;
  if (authorization.owner !== "host") fail("harness-owned authentication plans are unsupported");
  const auth = authorization.auth;
  if (auth.source === "harness" || auth.source === "none") fail("requires host-resolved provider authentication");
  const provider = requireString(p.provider, "provider");
  if (provider === "deepseek" && auth.mode !== "api-key") fail("DeepSeek isolated completion requires API-key auth");
  if (provider === "github-copilot" && !["api-key", "token", "oauth"].includes(auth.mode)) {
    fail("Copilot isolated completion requires a host token");
  }
  const apiKey = auth.apiKey;
  if (typeof apiKey !== "string" || !apiKey || /[\x00-\x1f\x7f]/u.test(apiKey)) {
    fail("host-resolved credential is required");
  }
  return apiKey;
}

function validateUsage(usage: BridgeUsage, label: string): void {
  for (const [key, value] of Object.entries(usage)) {
    if (!Number.isSafeInteger(value) || value < 0) fail(`runtime returned invalid ${label} token usage`);
    if (!["input", "output", "cacheRead", "cacheWrite"].includes(key)) fail(`runtime returned invalid ${label} token usage`);
  }
}

function validateContextUsage(value: BridgeContextUsage | undefined): void {
  if (value === undefined || value.state === "unavailable") return;
  if (value.state !== "available" || !Number.isSafeInteger(value.promptTokens) ||
      !Number.isSafeInteger(value.totalTokens) || value.promptTokens < 0 || value.totalTokens < 0) {
    fail("runtime returned invalid context usage");
  }
}

function validateRoute(route: Route): void {
  if (!Number.isSafeInteger(route.contextWindow) || route.contextWindow <= 0) fail("resolved route has invalid context window");
  if (route.maxTokens !== undefined &&
      (!Number.isSafeInteger(route.maxTokens) || route.maxTokens <= 0 || route.maxTokens > route.contextWindow)) {
    fail("resolved route has invalid maxTokens");
  }
}

function createAssistant(p: IsolatedParams, output: BridgeResult, now: number): Assistant {
  if (typeof output.text !== "string") fail("runtime returned non-text output");
  validateUsage(output.usage, "completion");
  if (output.lastCallUsage) validateUsage(output.lastCallUsage, "last-call");
  validateContextUsage(output.contextUsage);
  if (output.toolCalls !== 0) fail("runtime attempted to use tools during isolated completion");
  if (output.stopReason !== "stop" && output.stopReason !== "length") {
    fail("runtime did not complete the isolated completion");
  }
  const totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
  if (!Number.isSafeInteger(totalTokens)) fail("runtime token usage overflow");
  const model = p.authorization.owner === "host" ? p.authorization.model : fail("missing host authorization");
  return {
    role: "assistant",
    content: [{ type: "text", text: output.text }],
    api: model.api,
    provider: p.provider,
    model: model.id,
    usage: {
      ...output.usage,
      totalTokens,
      ...(output.contextUsage ? { contextUsage: structuredClone(output.contextUsage) } : {}),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: output.stopReason,
    timestamp: now,
    ...{ dshNative: {
      billing: "unpriced",
      isolated: true,
      ...(output.lastCallUsage ? { lastCallUsage: { ...output.lastCallUsage } } : {}),
    } },
  };
}

function signalList(signals: Array<AbortSignal | undefined>): AbortSignal[] {
  return signals.filter((signal): signal is AbortSignal => signal !== undefined);
}

async function createDefaultRuntime(config: DshConfig): Promise<DshRuntime> {
  return (await import("../runtime.js")).createDshRuntime(config);
}

export function createIsolatedCompletion(
  config: DshConfig,
  resolveRoute: IsolatedResolveRoute,
  options: IsolatedCompletionOptions = {},
): IsolatedCompletion {
  const activeControllers = new Set<AbortController>();
  const pending = new Set<Promise<void>>();
  let disposed = false;

  const run: IsolatedRun = async (p) => {
    if (disposed) fail("service is disposed");
    assertPreparedModel(p);
    const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    const requestBytes = new TextEncoder().encode(`${p.systemPrompt}\n${p.prompt}`).byteLength;
    if (requestBytes > maxRequestBytes) fail("prompt payload exceeds the isolated completion request limit");
    p.assertCurrent();
    const apiKey = resolvedApiKey(p);
    p.assertCurrent();
    const controller = new AbortController();
    activeControllers.add(controller);
    const signal = AbortSignal.any(signalList([controller.signal, p.abortSignal, options.parentSignal]));
    let succeeded = false;
    let forbiddenToolAttempt = false;
    let privateStateDir: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    let runtime: DshRuntime | undefined;
    const operation = (async (): Promise<IsolatedResult> => {
      try {
        timer = setTimeout(() => controller.abort(new Error("isolated completion deadline exceeded")), p.timeoutMs);
        signal.throwIfAborted();
        await mkdir(config.stateDir, { recursive: true });
        signal.throwIfAborted();
        privateStateDir = await mkdtemp(join(config.stateDir, "isolated-"));
        signal.throwIfAborted();
        const privateConfig: DshConfig = { ...config, stateDir: privateStateDir };
        const route = resolveRoute({
          provider: p.provider,
          modelId: p.modelId,
          model: p.authorization.model,
          resolvedApiKey: apiKey,
          config: p.config,
          agentId: p.agentId,
          thinkLevel: p.thinkLevel,
          streamParams: p.streamParams,
        }, privateConfig);
        validateRoute(route);
        p.assertCurrent();
        if (route.modelId !== p.authorization.model.id || route.baseUrl !== p.authorization.model.baseUrl ||
            route.apiKey !== apiKey || route.provider !== undefined && route.provider !== p.provider) {
          fail("resolved route differs from the host-prepared authorization");
        }
        runtime = options.runtimeFactory
          ? await options.runtimeFactory(privateConfig)
          : await createDefaultRuntime(privateConfig);
        p.assertCurrent();
        signal.throwIfAborted();
        const output = await runtime.run({
          ...route,
          provider: p.provider,
          sessionId: `isolated-${randomUUID()}`,
          nativeStateId: `isolated-state-${randomUUID()}`,
          runId: `isolated-run-${randomUUID()}`,
          workspaceDir: p.workspaceDir,
          systemPrompt: p.systemPrompt,
          prompt: p.prompt,
          tools: [],
          signal,
          assertActive: () => {
            p.assertCurrent?.();
            signal.throwIfAborted();
          },
          onEvent: async (event) => {
            if (event.type === "tool-cancel") {
              forbiddenToolAttempt = true;
              fail("runtime attempted to use tools during isolated completion");
            }
            await options.onEvent?.(event);
          },
          executeTool: async () => {
            forbiddenToolAttempt = true;
            fail("isolated completion has no tool surface");
          },
        });
        signal.throwIfAborted();
        if (forbiddenToolAttempt) fail("runtime attempted to use tools during isolated completion");
        p.assertCurrent();
        const result = { assistant: createAssistant(p, output, options.now?.() ?? Date.now()) };
        succeeded = true;
        return result;
      } finally {
        if (timer) clearTimeout(timer);
        try {
          if (runtime) await runtime.dispose();
          if (succeeded && privateStateDir) await rm(privateStateDir, { recursive: true, force: true });
        } finally {
          activeControllers.delete(controller);
        }
      }
    })();
    const drain = operation.then(() => undefined, () => undefined);
    pending.add(drain);
    drain.finally(() => pending.delete(drain));
    return operation;
  };

  return {
    run,
    async dispose() {
      disposed = true;
      for (const controller of activeControllers) controller.abort(new Error("isolated completion service disposed"));
      await Promise.allSettled([...pending]);
    },
  };
}
