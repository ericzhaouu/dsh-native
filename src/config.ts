import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isRecord, type OperationalBudget } from "./protocol.js";
import type { DshConfig } from "./runtime-types.js";
import { COPILOT_ENDPOINTS } from "./copilot-policy.js";
import { parseTaskPreparationConfig, parseToolAllowlist } from "./preparation.js";

const KEYS = new Set([
  "stateDir", "startupTimeoutMs", "shutdownTimeoutMs", "streamIdleTimeoutMs", "allowedBaseUrls", "allowedCopilotBaseUrls",
  "taskPreparation",
  "toolAllowlist",
  "maxConcurrentRuns",
  "operationalBudget", "operationalBudgetByAgent",
]);

const BUDGET_KEYS = ["maxModelRequests", "maxInputTokens", "maxOutputTokens", "maxToolCalls", "maxDurationMs"] as const;

function budgetConfigError(message: string): never {
  throw Object.assign(new TypeError(message), { code: "DSH_BUDGET_EXCEEDED" });
}

function budgetRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return budgetConfigError(`${label} must be a plain object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !("value" in descriptors[key]!))) {
    return budgetConfigError(`${label} must contain only data properties.`);
  }
  return value;
}

export function parseOperationalBudget(value: unknown): OperationalBudget {
  const input = budgetRecord(value, "operationalBudget");
  if (Reflect.ownKeys(input).length !== BUDGET_KEYS.length ||
      BUDGET_KEYS.some((key) => !Object.hasOwn(input, key) ||
        typeof input[key] !== "number" || !Number.isSafeInteger(input[key]) || input[key] <= 0)) {
    return budgetConfigError("operationalBudget requires all five positive safe integer limits and no extra fields.");
  }
  return Object.fromEntries(BUDGET_KEYS.map((key) => [key, input[key]])) as unknown as OperationalBudget;
}

function parseAgentBudgets(value: unknown): Record<string, OperationalBudget> {
  const input = budgetRecord(value, "operationalBudgetByAgent");
  const agents = Object.getOwnPropertyNames(input);
  if (agents.length > 64 ||
      agents.some((key) => !/^[a-z][a-z0-9_-]{0,63}$/.test(key))) {
    return budgetConfigError("operationalBudgetByAgent requires at most 64 exact Agent identifiers.");
  }
  return Object.fromEntries(agents.map((agent) => [agent, parseOperationalBudget(input[agent])]));
}

/** Global, exact-Agent and trusted per-attempt caps can only narrow one another. */
export function resolveOperationalBudget(
  config: Pick<DshConfig, "operationalBudget" | "operationalBudgetByAgent">,
  agentId?: string,
  attemptCap?: OperationalBudget,
): OperationalBudget | undefined {
  const byAgent = config.operationalBudgetByAgent === undefined ? undefined : parseAgentBudgets(config.operationalBudgetByAgent);
  const selected = agentId && byAgent && Object.hasOwn(byAgent, agentId) ? byAgent[agentId] : undefined;
  const caps = [config.operationalBudget, selected, attemptCap]
    .filter((cap) => cap !== undefined).map(parseOperationalBudget);
  if (!caps.length) return undefined;
  return Object.fromEntries(BUDGET_KEYS.map((key) => [key, Math.min(...caps.map((cap) => cap[key]))])) as unknown as OperationalBudget;
}

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("DSH base URL must not contain credentials, query parameters, or a fragment.");
  }
  if (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) {
    throw new Error("DSH requires HTTPS, except for an explicitly allowed loopback development endpoint.");
  }
  return url.href.replace(/\/+$/, "");
}

export function parseDshConfig(value: unknown): DshConfig {
  const input = value ?? {};
  if (!isRecord(input)) throw new Error("dsh-native configuration must be an object.");
  for (const key of Object.keys(input)) {
    if (!KEYS.has(key)) throw new Error(`Unknown dsh-native configuration field: ${key}`);
  }
  const stateDir = input.stateDir ?? join(homedir(), ".openclaw", "dsh-native");
  if (typeof stateDir !== "string" || !isAbsolute(stateDir)) {
    throw new Error("dsh-native stateDir must be an absolute path.");
  }
  const urls = input.allowedBaseUrls ?? ["https://api.deepseek.com"];
  if (!Array.isArray(urls) || urls.length === 0 || urls.some((url) => typeof url !== "string")) {
    throw new Error("allowedBaseUrls must be a nonempty array of exact endpoint URLs.");
  }
  const copilotUrls = input.allowedCopilotBaseUrls ?? [...COPILOT_ENDPOINTS];
  if (!Array.isArray(copilotUrls) || copilotUrls.length === 0 || copilotUrls.some((url) => typeof url !== "string")) {
    throw new Error("allowedCopilotBaseUrls must be a nonempty array of exact endpoint URLs.");
  }
  const toolAllowlist = input.toolAllowlist === undefined ? undefined : parseToolAllowlist(input.toolAllowlist);
  let taskPreparation = input.taskPreparation === undefined ? undefined : parseTaskPreparationConfig(input.taskPreparation);
  if (toolAllowlist && taskPreparation) {
    const nested = isRecord(input.taskPreparation) && Object.hasOwn(input.taskPreparation, "executionTools");
    if (nested && (taskPreparation.executionTools.length !== toolAllowlist.length ||
        taskPreparation.executionTools.some((name) => !toolAllowlist.includes(name)))) {
      throw new Error("toolAllowlist conflicts with taskPreparation.executionTools; configure one narrowing list.");
    }
    taskPreparation = { ...taskPreparation, executionTools: [...toolAllowlist] };
  }
  return {
    stateDir,
    startupTimeoutMs: timeout(input.startupTimeoutMs, 60_000, "startupTimeoutMs"),
    shutdownTimeoutMs: timeout(input.shutdownTimeoutMs, 15_000, "shutdownTimeoutMs"),
    streamIdleTimeoutMs: timeout(input.streamIdleTimeoutMs, 120_000, "streamIdleTimeoutMs"),
    maxConcurrentRuns: concurrency(input.maxConcurrentRuns),
    allowedBaseUrls: urls.map((url: string) => normalizeBaseUrl(url)),
    allowedCopilotBaseUrls: copilotUrls.map((url: string) => normalizeBaseUrl(url)),
    ...(taskPreparation ? { taskPreparation } : {}),
    ...(toolAllowlist ? { toolAllowlist } : {}),
    ...(input.operationalBudget === undefined ? {} : { operationalBudget: parseOperationalBudget(input.operationalBudget) }),
    ...(input.operationalBudgetByAgent === undefined ? {} : { operationalBudgetByAgent: parseAgentBudgets(input.operationalBudgetByAgent) }),
  };
}

function concurrency(value: unknown): number {
  if (value === undefined) return 8;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw new Error("maxConcurrentRuns must be an integer between 1 and 64.");
  }
  return value;
}

function timeout(value: unknown, fallback: number, key: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 100 || value > 3_600_000) {
    throw new Error(`${key} must be an integer between 100 and 3600000 milliseconds.`);
  }
  return value;
}
