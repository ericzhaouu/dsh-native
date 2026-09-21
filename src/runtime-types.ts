import type {
  BridgeEvent,
  BridgeCompactResult,
  BridgeResult,
  BridgeTool,
  BridgeToolCall,
  BridgeToolResult,
  ModelProvider,
  OperationalBudget,
  ReasoningEfforts,
} from "./protocol.js";
import type { PreparationPolicy, PreparationResolution, TaskPreparationConfig } from "./preparation.js";

export interface DshConfig {
  stateDir: string;
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
  streamIdleTimeoutMs: number;
  maxConcurrentRuns?: number;
  allowedBaseUrls: string[];
  allowedCopilotBaseUrls?: string[];
  taskPreparation?: TaskPreparationConfig;
  toolAllowlist?: string[];
  operationalBudget?: OperationalBudget;
  operationalBudgetByAgent?: Record<string, OperationalBudget>;
}

export interface DshAttempt {
  agentId?: string;
  /** Trusted host cap; intersects configured ceilings, never read from tool arguments. */
  operationalBudget?: OperationalBudget;
  provider?: ModelProvider;
  sessionId: string;
  nativeStateId?: string;
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

export interface DshCompactAttempt {
  agentId?: string;
  operationalBudget?: OperationalBudget;
  recoverOnly?: boolean;
  provider?: ModelProvider;
  sessionId: string;
  nativeStateId?: string;
  runId: string;
  workspaceDir: string;
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
  signal: AbortSignal;
  assertActive(): void;
}

export interface DshRuntime {
  run(input: DshAttempt): Promise<BridgeResult>;
  compact(input: DshCompactAttempt): Promise<BridgeCompactResult>;
  recoverCompaction?(input: DshCompactAttempt): Promise<BridgeCompactResult>;
  dispose(): Promise<void>;
}
