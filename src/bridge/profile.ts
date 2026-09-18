import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PatchOptions } from "@deepseek-ai/cordis-plugin-include";
import type { Config as SpineConfig } from "@deepseek-ai/dsh-agent-spine-demo";
import type { Config as DeepSeekConfig } from "@deepseek-ai/dsh-llm-deepseek";
import { copilotHeaders } from "../copilot-policy.js";
import type { ModelProvider, ReasoningEfforts, ReasoningLevel } from "../protocol.js";

// These are sdk-minimal row IDs, not tool names. It does not include dsh-base.
const disabledRows = [
  "sdk-app-startup",
  "sdk-jsonrpc-server",
  "deepseek-llm-api-extensions",
  "session-log-deepseek",
  "plugin-package-inventory-deepseek",
  "persistent-bash",
  "persistent-pwsh",
  "str-replace-editor",
  "sandbox",
  "sandbox-policy",
  "subprocess",
  "pty",
  "terminal-bash",
  "terminal-pwsh",
  "fs-local",
] as const;
const deepSeekEfforts = ["off", "low", "high", "max"] as const;
const copilotEfforts = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ReasoningLevel[];

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function provider(value: ModelProvider | undefined): ModelProvider {
  if (value === undefined || value === "deepseek" || value === "github-copilot") return value ?? "deepseek";
  throw new TypeError(`Unsupported provider: ${String(value)}`);
}

function validateReasoningEfforts(
  value: ReasoningEfforts | false | undefined,
): ReasoningEfforts | false | undefined {
  if (value === undefined || value === false) return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("reasoningEfforts must be false or a plain object");
  }
  const result: ReasoningEfforts = {};
  for (const [level, wire] of Object.entries(value)) {
    if (!(copilotEfforts as readonly string[]).includes(level)) {
      throw new TypeError(`Unsupported Copilot reasoning level: ${level}`);
    }
    if (wire === null) {
      if (level !== "off") throw new TypeError(`Copilot reasoningEfforts.${level} must be a non-empty string`);
      result[level as ReasoningLevel] = null;
      continue;
    }
    if (typeof wire !== "string" || !wire.trim()) {
      throw new TypeError(`Copilot reasoningEfforts.${level} must be a non-empty string`);
    }
    result[level as ReasoningLevel] = wire;
  }
  if (Object.keys(result).length === 0) throw new TypeError("reasoningEfforts must not be empty");
  return result;
}

/**
 * Invocation overlays for DSH 0.1.2-alpha.2's shipped sdk-minimal profile.
 * The launcher must own DSH_HOME (including its profile/home patches) and cwd:
 * Cordis has no wildcard exclusion or external-plugin autoload denylist.
 */
export function createBridgePatch(options: {
  bridgePath: string;
  compactionPath?: string;
  baseUrl: string;
  thinking: "enabled" | "disabled";
  reasoningEffort?: string;
  maxTokens?: number;
  contextWindow: number;
  streamIdleTimeoutMs: number;
  provider?: ModelProvider;
  modelId?: string;
  modelName?: string;
  headers?: Record<string, string>;
  reasoningEfforts?: ReasoningEfforts | false;
}): object[] {
  if (!isAbsolute(options.bridgePath)) {
    throw new TypeError("bridgePath must be an absolute filesystem path");
  }
  const compactionPath = options.compactionPath ?? fileURLToPath(new URL("./compaction.js", import.meta.url));
  if (!isAbsolute(compactionPath)) {
    throw new TypeError("compactionPath must be an absolute filesystem path");
  }
  const endpoint = new URL(options.baseUrl);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash
  ) {
    throw new TypeError("baseUrl must be an HTTP(S) endpoint without credentials, query, or fragment");
  }
  if (options.thinking !== "enabled" && options.thinking !== "disabled") {
    throw new TypeError('thinking must be "enabled" or "disabled"');
  }
  const selectedProvider = provider(options.provider);
  const effort = options.reasoningEffort;
  const supportedEfforts = selectedProvider === "github-copilot" ? copilotEfforts : deepSeekEfforts;
  if (effort !== undefined && !(supportedEfforts as readonly string[]).includes(effort)) {
    throw new TypeError(`reasoningEffort must be ${supportedEfforts.join(", ").replace(/, ([^,]+)$/u, ", or $1")}`);
  }
  if (options.thinking === "disabled" && effort !== undefined && effort !== "off") {
    throw new TypeError('thinking disabled only supports reasoningEffort "off"');
  }
  positiveInteger(options.contextWindow, "contextWindow");
  if (options.maxTokens !== undefined) positiveInteger(options.maxTokens, "maxTokens");
  if (
    !Number.isFinite(options.streamIdleTimeoutMs) ||
    options.streamIdleTimeoutMs <= 0 ||
    options.streamIdleTimeoutMs > 2_147_483_647
  ) {
    throw new RangeError("streamIdleTimeoutMs must be positive and at most 2147483647");
  }

  // Cordis replaces the entire config; partial nested patches restore unsafe defaults.
  const spine: SpineConfig = {
    agents: [],
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
    persona: "",
    workspaceContext: false,
    skills: { enabled: false },
    goals: false,
    toolBash: false,
    toolJobs: false,
    tools: { mode: "native" },
  };
  const adapter: DeepSeekConfig = {
    apiKeyEnv: "OPENCLAW_DSH_MODEL_KEY",
    baseURL: options.baseUrl,
    thinking: options.thinking,
    ...(effort !== undefined ? { reasoningEffort: effort as DeepSeekConfig["reasoningEffort"] } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    defaultContextWindow: options.contextWindow,
    // Host-selected capacity must not be replaced by DSH's advisory model catalog.
    models: [],
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
  };
  if (selectedProvider === "deepseek") {
    return [
      ...disabledRows.map((id) => ({ id, disabled: true })),
      { id: "agent-spine", config: spine },
      { id: "llm-deepseek", config: adapter },
      {
        insert: [{
          id: "dsh-token-meter",
          name: "@deepseek-ai/dsh-token-meter",
          config: {},
        }, {
          id: "dsh-compaction-basic",
          name: pathToFileURL(compactionPath).href,
          config: { auto: true },
        }, {
           id: "openclaw-bridge",
           // Native Windows paths are not ESM specifiers; encode spaces/#/% as well.
           name: pathToFileURL(options.bridgePath).href,
           config: {},
        }],
      },
    ] satisfies PatchOptions[];
  }
  if (!options.modelId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.modelId)) {
    throw new TypeError("Copilot modelId is required and must be a valid model identifier");
  }
  const reasoningEfforts = validateReasoningEfforts(options.reasoningEfforts);
  if (reasoningEfforts === undefined || options.maxTokens === undefined) {
    throw new TypeError("Copilot requires host-prepared reasoning capabilities and an output token limit");
  }
  const headers = copilotHeaders(options.headers);
  const piAi = {
    providers: {
      "github-copilot": {
        apiKeyEnv: "OPENCLAW_DSH_MODEL_KEY",
        api: "openai-responses",
        baseURL: options.baseUrl,
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        models: [{
          id: options.modelId,
          name: options.modelName ?? options.modelId,
          contextWindow: options.contextWindow,
          maxTokens: options.maxTokens,
          input: ["text"],
          reasoningEfforts,
        }],
        streamIdleTimeoutMs: options.streamIdleTimeoutMs,
      },
    },
  };

  return [
    // There is no row-deletion patch; disabled rows are not imported or activated.
    ...disabledRows.map((id) => ({ id, disabled: true })),
    { id: "llm-deepseek", disabled: true },
    { id: "agent-spine", config: spine },
    {
      insert: [
        { id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai", config: piAi },
        {
          id: "dsh-token-meter",
          name: "@deepseek-ai/dsh-token-meter",
          config: {},
        },
        {
          id: "dsh-compaction-basic",
          name: pathToFileURL(compactionPath).href,
          config: { auto: true },
        },
        {
          id: "openclaw-bridge",
          // Native Windows paths are not ESM specifiers; encode spaces/#/% as well.
          name: pathToFileURL(options.bridgePath).href,
          config: {},
        },
      ],
    },
  ] satisfies PatchOptions[];
}
