import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import { isRecord, RUNTIME_ID } from "../protocol.js";
import type { DshConfig } from "../runtime-types.js";
import { resolveCopilotRoute, supportsCopilot, type CopilotRoute } from "./copilot-route.js";

type Attempt = Parameters<AgentHarnessV2["runAttempt"]>[0];
export type NativeRouteInput = Pick<Attempt,
  "provider" | "model" | "modelId" | "resolvedApiKey" | "thinkLevel" | "config" | "agentId" |
  "preparedModelRuntime" | "runtimePlan" | "streamParams" | "fastMode" | "fastModeAuto" |
  "clientTools" | "images" | "imageOrder" | "media" | "sandbox" | "execOverrides" |
  "swarmOutputSchema" | "contextTokenBudget" | "authoredContextTokenCap"> & {
    runtimeAuthPlan?: Parameters<NonNullable<AgentHarnessV2["compact"]>>[0]["runtimeAuthPlan"];
  };
type SupportContext = Parameters<AgentHarnessV2["supports"]>[0];
type ReadTransport = typeof import("openclaw/plugin-sdk/agent-harness-runtime")["getModelProviderRequestTransport"];
type NativeRoute = {
  modelId: string;
  apiKey: string;
  baseUrl: string;
  contextWindow: number;
  maxTokens?: number;
  thinking: "enabled" | "disabled";
  reasoningEffort?: string;
};

function fail(reason: string): never {
  throw new Error(`${RUNTIME_ID}: ${reason}`);
}

function concreteId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    !/[\s\x00-\x1f\x7f]/u.test(value) && !/^(auto|default|\*)$/iu.test(value);
}

function parseBaseUrl(value: unknown): URL {
  if (typeof value !== "string" || !/^https?:\/\//iu.test(value) ||
      /[\s\\\x00-\x1f\x7f]/u.test(value)) {
    fail("baseUrl must be an explicit HTTP(S) URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("baseUrl must be a valid HTTP(S) URL");
  }
  if (url.username || url.password || value.includes("?") || value.includes("#")) {
    fail("baseUrl cannot contain credentials, a query, or a fragment");
  }
  if (url.hostname.replace(/\.$/u, "") === "api.deepseek.com" && url.protocol !== "https:") {
    fail("the DeepSeek endpoint requires HTTPS");
  }
  return url;
}

function hasValues(value: unknown): boolean {
  return value !== undefined && (!isRecord(value) ||
    Object.values(value).some((entry) => entry !== undefined));
}

function rejectValues(value: unknown, label: string): void {
  if (hasValues(value)) fail(`${label} cannot be reproduced by the native bridge`);
}

function validateTransport(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) fail("unsupported provider request transport");
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (key === "headers" && !hasValues(entry)) continue;
    if (key === "auth" && isRecord(entry) && entry.mode === "provider-default" &&
        Object.keys(entry).every((field) => field === "mode" || entry[field] === undefined)) continue;
    fail("provider request headers/auth/proxy/TLS/private-network overrides are unsupported");
  }
}

export const nativeSupports: AgentHarnessV2["supports"] = (ctx: SupportContext) => {
  if (ctx.provider === "github-copilot") return supportsCopilot(ctx);
  if (ctx.requestedRuntime !== RUNTIME_ID) {
    return { supported: false, reason: "dsh-native requires explicit runtime selection" };
  }
  if (ctx.provider !== "deepseek" || !concreteId(ctx.modelId) ||
      ctx.modelProvider?.api !== "openai-completions") {
    return { supported: false, reason: "requires a concrete DeepSeek provider Chat Completions route" };
  }
  if (ctx.providerOwnerStatus === "ambiguous") {
    return { supported: false, reason: "DeepSeek provider ownership is ambiguous" };
  }
  const provider = ctx.modelProvider;
  // Normal DeepSeek providers need not advertise compatibility with third-party harnesses.
  const compatibleIds = provider.runtimePolicy?.compatibleIds;
  if (compatibleIds !== undefined &&
      (!Array.isArray(compatibleIds) || !compatibleIds.includes(RUNTIME_ID))) {
    return { supported: false, reason: "provider runtime policy excludes dsh-native" };
  }
  if (provider.requestTransportOverrides === "present" || provider.azureApiVersion !== undefined) {
    return { supported: false, reason: "prepared provider transport overrides are unsupported" };
  }
  const auth = provider.preparedAuth;
  if (auth && (auth.source === "none" || auth.source === "harness" ||
      (auth.requirement !== undefined && auth.requirement !== "api-key") ||
      (auth.mode !== undefined && auth.mode !== "api-key" && auth.mode !== "api_key"))) {
    return { supported: false, reason: "requires host-prepared DeepSeek API-key authentication" };
  }
  try {
    parseBaseUrl(provider.baseUrl);
    validateTransport(provider.request);
  } catch (error) {
    return { supported: false, reason: (error as Error).message };
  }
  return {
    supported: true,
    reason: "explicit DeepSeek Chat Completions route; URL allowlist and concrete attempt validation required",
  };
};

const nativeCompat: Readonly<Record<string, unknown>> = {
  thinkingFormat: "deepseek",
  maxTokensField: "max_tokens",
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  supportsStrictMode: false,
  requiresThinkingAsText: false,
  requiresAssistantAfterToolResult: false,
  requiresToolResultName: false,
  requiresReasoningContentOnAssistantMessages: true,
  sendSessionAffinityHeaders: false,
  supportsPromptCacheKey: false,
  zaiToolStream: false,
};

function defaultEffort(level: string): string | undefined {
  switch (level) {
    case "minimal":
    case "low":
    case "medium":
    case "high": return "high";
    case "xhigh":
    case "max": return "max";
    default: return undefined;
  }
}

function validateThinkingMap(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) fail("unsupported thinking level map");
  for (const [level, effort] of Object.entries(value)) {
    if (effort === undefined) continue;
    if ((level === "off" && effort === "off") ||
        (defaultEffort(level) !== undefined && effort === defaultEffort(level))) continue;
    fail("thinking level overrides cannot be reproduced by the native bridge");
  }
}

function validateCompat(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) fail("unsupported provider compatibility overrides");
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (key === "reasoningEffortMap") {
      validateThinkingMap(entry);
    } else if (!Object.hasOwn(nativeCompat, key) || nativeCompat[key] !== entry) {
      fail("provider compatibility overrides cannot be reproduced by the native bridge");
    }
  }
}

function validateConfig(p: NativeRouteInput, cfg: Attempt["config"]): void {
  if (!cfg) return;
  const provider = cfg.models?.providers?.[p.provider];
  if (provider) {
    rejectValues(provider.headers, "provider headers");
    validateTransport(provider.request);
    rejectValues(provider.params, "provider generation parameters");
    if ((provider.auth !== undefined && provider.auth !== "api-key") ||
        provider.authHeader === false) fail("provider authentication overrides are unsupported");
    if (provider.timeoutSeconds !== undefined || provider.region !== undefined ||
        provider.injectNumCtxForOpenAICompat !== undefined || provider.localService !== undefined) {
      fail("provider runtime overrides cannot be reproduced by the native bridge");
    }
    for (const model of provider.models ?? []) {
      if (model.id !== p.model.id && model.id !== p.modelId) continue;
      rejectValues(model.headers, "configured model headers");
      rejectValues(model.params, "configured model generation parameters");
      validateCompat(model.compat);
      validateThinkingMap(model.thinkingLevelMap);
    }
  }
  const defaults = cfg.agents?.defaults;
  rejectValues(defaults?.params, "default generation parameters");
  const agent = p.agentId ? cfg.agents?.entries?.[p.agentId] ??
    cfg.agents?.list?.find((entry) => entry.id === p.agentId) : undefined;
  rejectValues(agent?.params, "agent generation parameters");
  for (const modelId of new Set([p.modelId, p.model.id])) {
    const ref = `${p.provider}/${modelId}`;
    for (const entry of [defaults?.models?.[ref], agent?.models?.[ref]]) {
      rejectValues(entry?.params, "per-model generation parameters");
      if (entry?.streaming === false) fail("non-streaming generation is unsupported");
    }
  }
}

function validateRuntimePlan(p: NativeRouteInput): void {
  const plan = p.runtimePlan;
  const preparedParams = plan?.transport?.extraParams;
  if (preparedParams !== undefined) {
    if (!isRecord(preparedParams)) fail("unsupported prepared generation parameters");
    for (const [key, value] of Object.entries(preparedParams)) {
      if (value === undefined || key === "fastMode" && value === false) continue;
      fail("prepared generation parameters cannot be reproduced by the native bridge");
    }
  }
  if (plan?.resolvedRef?.transport !== undefined && plan.resolvedRef.transport !== "sse" &&
       plan.resolvedRef.transport !== "auto") fail("non-SSE model transport is unsupported");
  const auth = p.runtimeAuthPlan ?? plan?.auth;
  if (auth?.deferredRouteSupport || auth?.harnessAuthProvider ||
      (auth?.selectedAuthMode !== undefined && auth.selectedAuthMode !== "api_key" &&
        auth.selectedAuthMode !== "api-key")) {
    fail("native/deferred authentication is unsupported; host API-key auth is required");
  }
  const route = auth?.modelRoute;
  if (!route) return;
  if (route.provider !== p.provider || route.modelId !== p.model.id ||
      route.api !== p.model.api || route.baseUrl !== p.model.baseUrl ||
      route.authRequirement !== "api-key") {
    fail("prepared authentication route does not match the concrete DeepSeek model");
  }
  if (route.requestTransportOverrides === "present") fail("prepared transport overrides are unsupported");
  const compatibleIds = route.runtimePolicy?.compatibleIds;
  if (compatibleIds !== undefined && !compatibleIds.includes(RUNTIME_ID)) {
    fail("prepared provider runtime policy excludes dsh-native");
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive safe integer`);
  }
  return value;
}

export function resolveNativeRoute(p: NativeRouteInput, config: DshConfig, getModelProviderRequestTransport: ReadTransport): NativeRoute | CopilotRoute {
  if (p.provider === "github-copilot") return resolveCopilotRoute(p, config, getModelProviderRequestTransport);
  if (p.provider !== "deepseek" || p.model.provider !== "deepseek" ||
      p.model.api !== "openai-completions" || !concreteId(p.model.id)) {
    fail("requires a concrete DeepSeek provider Chat Completions model");
  }
  const apiKey = p.resolvedApiKey;
  if (typeof apiKey !== "string" || !apiKey.trim() || /[\x00-\x1f\x7f]/u.test(apiKey)) {
    fail("a host-resolved API key is required; native login and default credentials are never used");
  }
  const url = parseBaseUrl(p.model.baseUrl);
  // Compare whole endpoints, not prefixes or host suffixes; a path grant is not an origin grant.
  const endpoint = (candidate: URL) => candidate.href.replace(/\/+$/u, "");
  if (!config.allowedBaseUrls.some((allowed) => {
    try {
      return endpoint(parseBaseUrl(allowed)) === endpoint(url);
    } catch {
      return false;
    }
  })) fail("baseUrl is not allowed; endpoints require an exact allowedBaseUrls entry");

  rejectValues(p.model.headers, "model headers");
  if (p.model.authHeader === false) fail("model authentication overrides are unsupported");
  // Transport metadata lives on an SDK-owned symbol, not a public `model.request` property.
  validateTransport(getModelProviderRequestTransport(p.model));
  validateCompat(p.model.compat);
  validateThinkingMap(p.model.thinkingLevelMap);
  rejectValues(p.model.params, "model generation parameters");
  validateConfig(p, p.config);
  if (p.preparedModelRuntime?.config !== p.config) validateConfig(p, p.preparedModelRuntime?.config);
  validateRuntimePlan(p);
  for (const [key, value] of Object.entries(p.streamParams ?? {})) {
    if (key !== "maxTokens" && value !== undefined) fail("unsupported generation stream parameters");
  }
  if ((p.fastMode !== undefined && p.fastMode !== false) || p.fastModeAuto) {
    fail("fast-mode generation overrides are unsupported");
  }
  if (p.clientTools?.length) fail("client-provided tools are unsupported");
  if (p.images?.length || p.imageOrder?.length || p.media?.length) fail("media input is unsupported");
  if (p.sandbox?.enabled || p.sandbox?.required || p.execOverrides?.host === "node") {
    fail("sandboxed or remote execution is unsupported");
  }
  if (p.swarmOutputSchema !== undefined) fail("structured generation output is unsupported");

  const budgets = [p.contextTokenBudget, p.authoredContextTokenCap,
    p.model.contextTokens, p.model.contextWindow].filter((value) => value !== undefined);
  if (!budgets.length) fail("a concrete context window is required");
  const contextWindow = Math.min(...budgets.map((value) => positiveInteger(value, "context window")));
  const requestedMaxTokens = p.streamParams?.maxTokens;
  const maxTokens = positiveInteger(
    requestedMaxTokens === undefined ? p.model.maxTokens : requestedMaxTokens, "maxTokens");
  if (maxTokens > contextWindow) fail("maxTokens exceeds the resolved context window");
  const thinking = p.thinkLevel === "off" ? "disabled" : "enabled";
  const reasoningEffort = defaultEffort(p.thinkLevel);
  if (thinking === "enabled" && (!p.model.reasoning || reasoningEffort === undefined)) {
    fail("the requested thinking level cannot be reproduced by the native bridge");
  }
  return {
    modelId: p.model.id,
    apiKey,
    baseUrl: p.model.baseUrl,
    contextWindow,
    maxTokens,
    thinking,
    ...(thinking === "enabled" ? { reasoningEffort } : {}),
  };
}
