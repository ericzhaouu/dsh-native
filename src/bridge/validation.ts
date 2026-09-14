import { isAbsolute } from "node:path";
import {
  isRecord, type BridgeRun, type BridgeTool, type BridgeToolResult, type Json, type JsonObject, type ModelProvider,
} from "../protocol.js";

const deepSeekEfforts = ["off", "low", "high", "max"] as const;
const copilotEfforts = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

export function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`Unexpected ${label} field: ${key}`);
  }
}

function string(value: unknown, label: string, nonempty = false): string {
  if (typeof value !== "string" || (nonempty && !value.trim()) || value.includes("\0")) {
    throw new TypeError(`${label} must be ${nonempty ? "a nonempty" : "a"} string without NUL`);
  }
  return value;
}

function provider(value: unknown, label: string): ModelProvider {
  const parsed = string(value, label, true);
  if (parsed !== "deepseek" && parsed !== "github-copilot") throw new TypeError(`${label} must be deepseek or github-copilot`);
  return parsed;
}

export function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function json(value: unknown, depth: number): Json {
  if (depth > 64) throw new TypeError("JSON nesting exceeds 64 levels");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Array.from(value, (item: unknown) => json(item, depth + 1));
  const source = record(value, "JSON value");
  return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, json(item, depth + 1)]));
}

export function jsonObject(value: unknown, label: string): JsonObject {
  record(value, label);
  const parsed = json(value, 0);
  if (!isRecord(parsed)) throw new TypeError(`${label} must be an object`);
  return parsed;
}

export function emptyParams(value: unknown): void {
  keys(record(value, "params"), [], "params");
}

export function parseToolResult(value: unknown): BridgeToolResult {
  const result = record(value, "tool result");
  keys(result, ["text", "isError"], "tool result");
  if (typeof result.isError !== "boolean") throw new TypeError("tool result.isError must be boolean");
  if (typeof result.text !== "string") throw new TypeError("tool result.text must be a string");
  return { text: result.text, isError: result.isError };
}

export function parseRun(value: unknown): BridgeRun {
  const run = record(value, "run");
  keys(run, [
    "provider", "sessionId", "resume", "workspaceDir", "systemPrompt", "prompt", "modelId",
    "reasoningEffort", "maxTokens", "tools",
  ], "run");
  const selectedProvider = run.provider === undefined ? "deepseek" : provider(run.provider, "provider");
  const sessionId = string(run.sessionId, "sessionId", true);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(sessionId)) {
    throw new TypeError("sessionId must be a safe, non-device filename identifier");
  }
  if (typeof run.resume !== "boolean") throw new TypeError("resume must be boolean");
  const workspaceDir = string(run.workspaceDir, "workspaceDir", true);
  if (!isAbsolute(workspaceDir)) throw new TypeError("workspaceDir must be absolute");
  const modelId = string(run.modelId, "modelId", true);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(modelId)) throw new TypeError("Invalid modelId");
  const reasoningEffort = run.reasoningEffort === undefined ? undefined : string(run.reasoningEffort, "reasoningEffort", true);
  const supportedEfforts = selectedProvider === "github-copilot" ? copilotEfforts : deepSeekEfforts;
  if (reasoningEffort !== undefined && !(supportedEfforts as readonly string[]).includes(reasoningEffort)) {
    throw new TypeError(`reasoningEffort must be ${supportedEfforts.join(", ").replace(/, ([^,]+)$/u, ", or $1")}`);
  }
  const maxTokens = run.maxTokens === undefined ? undefined : positiveInteger(run.maxTokens, "maxTokens");
  if (!Array.isArray(run.tools)) throw new TypeError("tools must be an array");
  const names = new Set<string>();
  const tools: BridgeTool[] = Array.from(run.tools, (value: unknown) => {
    const tool = record(value, "tool");
    keys(tool, ["name", "description", "parameters"], "tool");
    const name = string(tool.name, "tool.name", true);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || name === "run_code" || names.has(name)) {
      throw new TypeError(`Invalid, duplicate, or reserved host tool name: ${name}`);
    }
    names.add(name);
    const parameters = jsonObject(tool.parameters, `tool ${name} parameters`);
    if (parameters.type !== "object") throw new TypeError(`tool ${name} parameters must have type object`);
    return { name, description: string(tool.description, "tool.description"), parameters };
  });
  return {
    ...(run.provider === undefined ? {} : { provider: selectedProvider }),
    sessionId, resume: run.resume, workspaceDir, modelId, tools,
    systemPrompt: string(run.systemPrompt, "systemPrompt"),
    prompt: string(run.prompt, "prompt", true),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}
