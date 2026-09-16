import type {
  BridgeEvent,
  BridgeResult,
  BridgeTool,
  BridgeToolCall,
  BridgeToolResult,
  ModelProvider,
  ReasoningEfforts,
} from "./protocol.js";
import type { PreparationPolicy, PreparationResolution, TaskPreparationConfig } from "./preparation.js";

export interface DshConfig {
  stateDir: string;
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
  streamIdleTimeoutMs: number;
  allowedBaseUrls: string[];
  allowedCopilotBaseUrls?: string[];
  taskPreparation?: TaskPreparationConfig;
}

export interface DshAttempt {
  provider?: ModelProvider;
  sessionId: string;
  runId: string;
  workspaceDir: string;
  prompt: string;
  systemPrompt: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
  contextWindow: number;
  maxTokens?: number;
  thinking: "enabled" | "disabled";
  reasoningEffort?: string;
  reasoningEfforts?: ReasoningEfforts | false;
  headers?: Record<string, string>;
  modelName?: string;
  tools: BridgeTool[];
  signal: AbortSignal;
  assertActive(): void;
  onEvent(event: BridgeEvent): void | Promise<void>;
  executeTool(call: BridgeToolCall, signal: AbortSignal): Promise<BridgeToolResult>;
  taskPreparation?: { policy: PreparationPolicy; userText: string };
  onPreparationDecision?(resolution: PreparationResolution): void | Promise<void>;
}

export interface DshRuntime {
  run(input: DshAttempt): Promise<BridgeResult>;
  dispose(): Promise<void>;
}
