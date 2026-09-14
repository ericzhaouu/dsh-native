export const BRIDGE_VERSION = 1;
export const RUNTIME_ID = "dsh-native";
export const DSH_VERSION = "0.1.2-alpha.2";
export type ModelProvider = "deepseek" | "github-copilot";
export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ReasoningEfforts = Partial<Record<ReasoningLevel, string | null>>;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface BridgeTool {
  name: string;
  description: string;
  parameters: JsonObject;
}

export interface BridgeRun {
  provider?: ModelProvider;
  sessionId: string;
  resume: boolean;
  workspaceDir: string;
  systemPrompt: string;
  prompt: string;
  modelId: string;
  reasoningEffort?: string;
  maxTokens?: number;
  tools: BridgeTool[];
}

export interface BridgeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface BridgeResult {
  text: string;
  reasoning?: string;
  usage: BridgeUsage;
  stopReason: "stop" | "length" | "aborted";
  sessionId: string;
  toolCalls: number;
}

export interface BridgeToolCall {
  callId: string;
  name: string;
  arguments: JsonObject;
}

export interface BridgeToolResult {
  text: string;
  isError: boolean;
}

export type BridgeEvent =
  | { type: "ready"; version: number; dshVersion: string }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "usage"; usage: BridgeUsage }
  | { type: "status"; status: string }
  | { type: "tool-cancel"; callId: string };

export interface RpcRequest {
  id: number;
  method: string;
  params: unknown;
}

export interface RpcResponse {
  id: number;
  result?: unknown;
  error?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
