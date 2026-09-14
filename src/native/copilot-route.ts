import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import { COPILOT_ENDPOINTS, copilotHeaders } from "../copilot-policy.js";
import { normalizeBaseUrl } from "../config.js";
import { isRecord, RUNTIME_ID, type ReasoningEfforts, type ReasoningLevel } from "../protocol.js";
import type { DshAttempt, DshConfig } from "../runtime-types.js";

type Attempt = Parameters<AgentHarnessV2["runAttempt"]>[0];
type Support = Parameters<AgentHarnessV2["supports"]>[0];
type ReadTransport = typeof import("openclaw/plugin-sdk/agent-harness-runtime")["getModelProviderRequestTransport"];
export type CopilotRoute = Pick<DshAttempt, "provider" | "modelId" | "modelName" | "apiKey" |
  "baseUrl" | "contextWindow" | "maxTokens" | "thinking" | "reasoningEffort" | "reasoningEfforts" | "headers">;

const LEVELS: readonly ReasoningLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const AUTH_MODES = new Set(["token", "oauth", "api-key", "api_key"]);

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && LEVELS.some((level) => level === value);
}

function fail(message: string): never {
  throw new Error(`dsh-native Copilot: ${message}`);
}

function gptId(value: unknown): value is string {
  return typeof value === "string" && /^gpt-[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(value);
}

function requestHeaders(request: unknown): Record<string, string> {
  if (request === undefined) return {};
  if (!isRecord(request)) fail("unsupported provider request transport");
  for (const [key, value] of Object.entries(request)) {
    if (value === undefined || key === "headers") continue;
    if (key === "auth" && isRecord(value) && value.mode === "provider-default" &&
        Object.keys(value).every((name) => name === "mode" || value[name] === undefined)) continue;
    fail("custom auth, proxy, TLS, or private-network transport overrides are unsupported");
  }
  return copilotHeaders(request.headers);
}

function authoredHeaders(headers: unknown): void {
  const selected = copilotHeaders(headers);
  if (selected["User-Agent"] !== undefined) {
    fail("custom User-Agent is unsupported; DSH owns its product attribution");
  }
}

function compatibleRuntime(ids: readonly string[] | undefined): boolean {
  return ids === undefined || ids.includes(RUNTIME_ID);
}

export function supportsCopilot(ctx: Support): ReturnType<AgentHarnessV2["supports"]> {
  const provider = ctx.modelProvider;
  if (ctx.requestedRuntime !== RUNTIME_ID || ctx.provider !== "github-copilot" ||
      !gptId(ctx.modelId) || provider?.api !== "openai-responses") {
    return { supported: false, reason: "requires explicit github-copilot GPT / Responses selection" };
  }
  if (ctx.providerOwnerStatus === "ambiguous" || !compatibleRuntime(provider.runtimePolicy?.compatibleIds)) {
    return { supported: false, reason: "Copilot provider ownership or runtime policy is incompatible" };
  }
  if (provider.azureApiVersion !== undefined) return { supported: false, reason: "Azure transport is not a Copilot route" };
  const auth = provider.preparedAuth;
  if (auth && (auth.source === "none" || auth.source === "harness" ||
      auth.mode !== undefined && !AUTH_MODES.has(auth.mode))) {
    return { supported: false, reason: "requires host-prepared Copilot token authentication" };
  }
  try {
    if (typeof provider.baseUrl !== "string") fail("missing account endpoint");
    normalizeBaseUrl(provider.baseUrl);
    requestHeaders(provider.request);
  } catch (error) {
    return { supported: false, reason: error instanceof Error ? error.message : "Invalid Copilot route" };
  }
  return { supported: true, reason: "host-prepared Copilot GPT Responses; exact attempt policy remains enforced" };
}

function generationOverrides(params: unknown): void {
  if (params === undefined) return;
  if (!isRecord(params)) fail("invalid generation parameters");
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || key === "fastMode" && value === false) continue;
    fail(`unsupported generation parameter: ${key}`);
  }
}

function validateCompat(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) fail("invalid model compatibility metadata");
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (key === "supportsReasoningEffort" && typeof entry === "boolean") continue;
    if (key === "supportedReasoningEfforts" && Array.isArray(entry) &&
        entry.every((value) => typeof value === "string" && /^[a-z][a-z0-9_-]*$/.test(value))) continue;
    if (key === "reasoningEffortMap" && isRecord(entry)) continue;
    // A catalog suitability hint is not a request to activate host Code Mode.
    if (key === "codeMode" && (entry === "preferred" || entry === "capable")) continue;
    if (key === "supportsStore" && entry === false || key === "supportsUsageInStreaming" && entry === true ||
        key === "supportsStrictMode" && entry === false || key === "supportsDeveloperRole" && entry === true) continue;
    fail(`unsupported model compatibility setting: ${key}`);
  }
}

function modelEfforts(p: Attempt): { efforts: ReasoningEfforts | false; selected: ReasoningLevel } {
  const level = p.thinkLevel ?? "off";
  if (!isReasoningLevel(level)) fail("the requested reasoning level is unsupported");
  const selected = level;
  const compat: Record<string, unknown> = isRecord(p.model.compat) ? p.model.compat : {};
  const advertised = compat.supportedReasoningEfforts;
  const declared = Array.isArray(advertised) && advertised.every((value): value is string => typeof value === "string")
    ? advertised : undefined;
  const modelMap = p.model.thinkingLevelMap;
  const compatMap = isRecord(compat.reasoningEffortMap) ? compat.reasoningEffortMap : undefined;
  const mapped = modelMap ?? compatMap;
  const efforts: ReasoningEfforts = { off: null };
  if (p.model.reasoning && compat.supportsReasoningEffort !== false) {
    for (const key of LEVELS) {
      if (key === "off") continue;
      const wire = mapped?.[key] ?? (key === "minimal" && declared?.includes("low") && !declared.includes("minimal")
        ? "low" : key);
      if (!isReasoningLevel(wire) || wire === "off") {
        if (key === selected) fail("model reasoning mapping cannot be represented");
        continue;
      }
      if (declared && !declared.includes(wire)) continue;
      // Without a catalog declaration, only advertise the exact admitted level.
      if (!declared && !mapped && key !== selected) continue;
      efforts[key] = wire;
    }
  }
  if (selected !== "off" && efforts[selected] === undefined) fail("the selected model does not support this reasoning level");
  return { efforts: p.model.reasoning ? efforts : false, selected };
}

export function resolveCopilotRoute(p: Attempt, config: DshConfig, readTransport: ReadTransport): CopilotRoute {
  if (p.provider !== "github-copilot" || p.model.provider !== p.provider ||
      p.model.api !== "openai-responses" || !gptId(p.model.id)) fail("requires a concrete Copilot GPT Responses model");
  if (typeof p.resolvedApiKey !== "string" || !p.resolvedApiKey || /[\s\x00-\x1f\x7f]/u.test(p.resolvedApiKey) ||
      /^[{[]/.test(p.resolvedApiKey)) fail("requires the raw host-prepared Copilot token, not a login or credential envelope");
  const baseUrl = normalizeBaseUrl(p.model.baseUrl);
  if (!(config.allowedCopilotBaseUrls ?? COPILOT_ENDPOINTS).includes(baseUrl)) {
    fail("account endpoint is not in allowedCopilotBaseUrls");
  }
  const transport = readTransport(p.model);
  const headers = copilotHeaders(p.model.headers, requestHeaders(transport));
  if (p.model.authHeader === false) fail("bearer authentication cannot be disabled");
  validateCompat(p.model.compat);
  generationOverrides(p.model.params);
  for (const cfg of new Set([p.config, p.preparedModelRuntime?.config])) {
    const provider = cfg?.models?.providers?.[p.provider];
    if (provider) {
      authoredHeaders(provider.headers);
      authoredHeaders(requestHeaders(provider.request));
      // Tenant discovery belongs to OpenClaw. We use its resolved account endpoint.
      if (provider.params && Object.entries(provider.params).some(([key, value]) =>
        value !== undefined && (key !== "githubDomain" || typeof value !== "string"))) {
        fail("unsupported Copilot provider parameters");
      }
      if (provider.authHeader === false || provider.timeoutSeconds !== undefined ||
          provider.region !== undefined || provider.localService !== undefined ||
          provider.injectNumCtxForOpenAICompat !== undefined) fail("unsupported Copilot provider transport override");
      for (const model of provider.models ?? []) {
        if (model.id !== p.model.id && model.id !== p.modelId) continue;
        authoredHeaders(model.headers);
        generationOverrides(model.params);
        validateCompat(model.compat);
      }
    }
    generationOverrides(cfg?.agents?.defaults?.params);
    const agent = p.agentId ? cfg?.agents?.entries?.[p.agentId] ?? cfg?.agents?.list?.find((item) => item.id === p.agentId) : undefined;
    generationOverrides(agent?.params);
    for (const id of new Set([p.modelId, p.model.id])) {
      const ref = `${p.provider}/${id}`;
      for (const entry of [cfg?.agents?.defaults?.models?.[ref], agent?.models?.[ref]]) {
        generationOverrides(entry?.params);
        if (entry?.streaming === false) fail("non-streaming generation is unsupported");
      }
    }
  }
  const plan = p.runtimePlan;
  generationOverrides(plan?.transport?.extraParams);
  if (plan?.resolvedRef?.transport !== undefined && !["sse", "auto"].includes(plan.resolvedRef.transport)) {
    fail("only SSE Responses transport is supported");
  }
  if (plan?.auth?.harnessAuthProvider || plan?.auth?.deferredRouteSupport ||
      plan?.auth?.selectedAuthMode !== undefined && !AUTH_MODES.has(plan.auth.selectedAuthMode)) {
    fail("requires already-prepared host token authentication");
  }
  const route = plan?.auth?.modelRoute;
  if (route && (route.provider !== p.provider || route.modelId !== p.model.id ||
      route.api !== p.model.api || normalizeBaseUrl(route.baseUrl) !== baseUrl ||
      !compatibleRuntime(route.runtimePolicy?.compatibleIds))) fail("prepared account route differs from the selected model");
  for (const [key, value] of Object.entries(p.streamParams ?? {})) {
    if (key !== "maxTokens" && value !== undefined) fail(`unsupported stream parameter: ${key}`);
  }
  if (p.fastMode !== undefined && p.fastMode !== false || p.fastModeAuto || p.swarmOutputSchema !== undefined) {
    fail("fast mode and structured output are unsupported");
  }
  const budgets = [p.contextTokenBudget, p.authoredContextTokenCap, p.model.contextTokens, p.model.contextWindow]
    .filter((value): value is number => value !== undefined);
  if (budgets.length === 0 || budgets.some((value) => !Number.isSafeInteger(value) || value <= 0)) fail("missing model context capacity");
  const contextWindow = Math.min(...budgets);
  const maxTokens = p.streamParams?.maxTokens ?? p.model.maxTokens;
  if (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > contextWindow) {
    fail("invalid output token limit");
  }
  const reasoning = modelEfforts(p);
  return {
    provider: "github-copilot", modelId: p.model.id, modelName: p.model.name,
    apiKey: p.resolvedApiKey, baseUrl: p.model.baseUrl, headers,
    contextWindow, maxTokens, thinking: reasoning.selected === "off" ? "disabled" : "enabled",
    ...(reasoning.efforts === false ? {} : { reasoningEffort: reasoning.selected }),
    reasoningEfforts: reasoning.efforts,
  };
}
