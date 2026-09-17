import { Ajv, type ValidateFunction } from "ajv";
import { isDeepStrictEqual } from "node:util";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import type { BridgeTool, JsonObject } from "../protocol.js";

type Runtime = Pick<typeof import("openclaw/plugin-sdk/agent-harness-runtime"),
  "getPluginToolMeta" | "getChannelAgentToolMeta" | "isAgentToolReplaySafe" | "isToolWrappedWithBeforeToolCallHook"> &
  Partial<Pick<typeof import("openclaw/plugin-sdk/agent-harness-runtime"), "isHostScopedAgentToolActive">>;

export const LEGACY_CODING_TOOLS: ReadonlySet<string> = new Set([
  "read", "edit", "write", "apply_patch", "exec", "process", "grep", "glob", "find", "ls",
]);

// These controls require authority, routing, or media handling this text bridge does not implement.
const CONTEXT_TOOLS = new Set([
  "message", "heartbeat_respond", "cron", "automations", "sessions", "sessions_spawn", "sessions_send",
  "sessions_yield", "sessions_steer", "steering", "steer", "subagents", "agents_wait",
  "conversations_send", "conversations_turn", "ask_user", "structured_output", "skill_workshop",
  "suggest_task", "code_mode", "code-mode", "code_mode_exec", "code_mode_wait", "run_code", "wait",
  "tool_search", "tool_search_code", "tool_describe", "tool_call", "tool_search_regex", "tool_search_bm25",
  "tool_execute", "execute_tool",
  "browser", "computer", "screen", "mobile_ui", "image", "view_image", "image_generate",
  "video", "video_generate", "audio", "music_generate", "tts", "pdf", "nodes",
  "show_widget", "progress_card", "dsh_prepare_task",
]);
const EXACT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NOTICES = 64;

export interface HostToolNotice {
  name: string;
  reason: "unavailable-or-denied" | "unsupported" | "ambiguous";
}

export interface HostToolSourceSnapshot {
  readonly name: string;
  readonly kind: "core" | "plugin" | "channel";
  readonly key: string;
  assertUnchanged(): void;
}

export interface HostToolEntry {
  tool: AnyAgentTool;
  source: HostToolSourceSnapshot;
  definition: BridgeTool;
  validator: ValidateFunction;
  replaySafe: boolean;
}

export function resolveHostToolAllowlist(explicit?: readonly string[], legacy?: readonly string[]): string[] | undefined {
  if (explicit !== undefined) return [...explicit];
  return legacy?.some((name) => !LEGACY_CODING_TOOLS.has(name)) ? [...legacy] : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Snapshot only the public metadata on this instance, never a registry or configuration. */
export function snapshotHostToolSource(tool: AnyAgentTool, sdk: Runtime): HostToolSourceSnapshot {
  const name = tool.name;
  const pluginIdentity = sdk.getPluginToolMeta(tool);
  const channelIdentity = sdk.getChannelAgentToolMeta(tool);
  const plugin = structuredClone(pluginIdentity);
  const channel = structuredClone(channelIdentity);
  if (plugin && channel || plugin && !plugin.pluginId || channel && !channel.channelId) {
    throw new Error("Ambiguous host tool ownership");
  }
  const kind = plugin ? "plugin" : channel ? "channel" : "core";
  const key = JSON.stringify(plugin?.mcp
    ? ["mcp", plugin.pluginId, plugin.mcp.serverName, plugin.mcp.toolName, plugin.mcp.operation, plugin.mcp.node?.id]
    : [kind, plugin?.pluginId ?? channel?.channelId, name]);
  return Object.freeze({
    name, kind, key,
    assertUnchanged() {
      const currentPlugin = sdk.getPluginToolMeta(tool);
      const currentChannel = sdk.getChannelAgentToolMeta(tool);
      if (tool.name !== name || pluginIdentity !== currentPlugin || channelIdentity !== currentChannel ||
          !isDeepStrictEqual(plugin, currentPlugin) || !isDeepStrictEqual(channel, currentChannel)) {
        throw new Error("Host tool source identity changed");
      }
    },
  });
}

export function buildHostToolNotices(requested: readonly string[], available: readonly string[],
  previous: readonly HostToolNotice[] = []): HostToolNotice[] {
  const present = new Set(available);
  const reasons = new Map(previous.map((notice) => [notice.name, notice.reason]));
  return [...new Set(requested)].filter((name) => !present.has(name)).slice(0, MAX_NOTICES).map((name) => ({
    name: EXACT_NAME.test(name) ? name : "(invalid-name)",
    reason: CONTEXT_TOOLS.has(name) || !EXACT_NAME.test(name) ? "unsupported" : reasons.get(name) ?? "unavailable-or-denied",
  }));
}

export function renderHostToolNotices(notices: readonly HostToolNotice[]): string {
  if (!notices.length) return "";
  return [
    "## Host tool availability",
    ...notices.slice(0, MAX_NOTICES).map(({ name, reason }) => `${name}: ${reason}.`),
    "Unavailable-or-denied does not distinguish installation, authentication, or policy status.",
    "Do not repeatedly request clarification for missing tools or use exec, another dispatcher, or an alternate provider to work around their absence. Explain the limitation and continue only with available capabilities.",
  ].join("\n");
}

function schemaFor(tool: AnyAgentTool): JsonObject {
  // TypeBox symbols are harmless, but silently dropping functions or cyclic/non-JSON values is not.
  const json = JSON.stringify(tool.parameters, (_key, value: unknown) => {
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" ||
        value === undefined || typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("Nonserializable host tool schema");
    }
    return value;
  });
  const schema: unknown = JSON.parse(json);
  if (!record(schema) || schema.type !== "object" || schema.$async) throw new Error("Invalid host tool schema");
  return schema as JsonObject;
}

/** Admission narrows already policy-constructed tools; it never resolves providers or opens MCP connections. */
export function selectHostTools(options: {
  tools: AnyAgentTool[];
  runtime: Runtime;
  toolAllowlist?: readonly string[];
  toolExecutionAllow?: readonly string[];
  sources?: ReadonlyMap<AnyAgentTool, HostToolSourceSnapshot>;
  notices?: readonly HostToolNotice[];
}): { entries: HostToolEntry[]; toolNotices: HostToolNotice[] } {
  const sdk = options.runtime;
  const generic = options.toolAllowlist !== undefined;
  const requested = generic ? new Set(options.toolAllowlist) : undefined;
  const execution = options.toolExecutionAllow === undefined ? undefined : new Set(options.toolExecutionAllow);
  const notices: HostToolNotice[] = [...options.notices ?? []];
  const candidates: Array<{ tool: AnyAgentTool; source: HostToolSourceSnapshot }> = [];
  const names = new Map<string, number>();
  const keys = new Map<string, number>();
  for (const tool of options.tools) {
    if (requested && !requested.has(tool.name)) continue;
    names.set(tool.name, (names.get(tool.name) ?? 0) + 1);
    if (!generic && (!LEGACY_CODING_TOOLS.has(tool.name) || sdk.getPluginToolMeta(tool) || sdk.getChannelAgentToolMeta(tool))) {
      throw new Error(`Unsupported non-core coding tool: ${tool.name}`);
    }
    const saved = options.sources?.get(tool);
    saved?.assertUnchanged();
    let source: HostToolSourceSnapshot;
    try {
      source = saved ?? snapshotHostToolSource(tool, sdk);
    } catch {
      if (!generic) throw new Error("Invalid host tool ownership");
      notices.push({ name: tool.name, reason: "ambiguous" });
      continue;
    }
    keys.set(source.key, (keys.get(source.key) ?? 0) + 1);
    candidates.push({ tool, source });
  }
  const ajv = new Ajv({ allErrors: true, strict: true, strictSchema: false, validateFormats: true,
    coerceTypes: false, useDefaults: false, removeAdditional: false, addUsedSchema: false, logger: false });
  const entries: HostToolEntry[] = [];
  for (const { tool, source } of candidates) {
    if (names.get(tool.name)! > 1 || keys.get(source.key)! > 1 ||
        source.kind !== "core" && LEGACY_CODING_TOOLS.has(tool.name)) {
      if (!generic) throw new Error(`Duplicate host tool: ${tool.name}`);
      notices.push({ name: tool.name, reason: "ambiguous" });
      continue;
    }
    const kind: unknown = sdk.getPluginToolMeta(tool)?.kind;
    if (generic && (CONTEXT_TOOLS.has(tool.name) || !EXACT_NAME.test(tool.name) ||
        sdk.isHostScopedAgentToolActive?.(tool.name) ||
        kind === "code-mode" || kind === "code_mode" ||
        Array.isArray(kind) && (kind.includes("code-mode") || kind.includes("code_mode")))) {
      notices.push({ name: tool.name, reason: "unsupported" });
      continue;
    }
    if (generic && sdk.getPluginToolMeta(tool)?.mcp?.deniedBySession) continue;
    if (generic && execution && !execution.has(tool.name)) continue;
    if (sdk.isToolWrappedWithBeforeToolCallHook(tool)) {
      if (!generic) throw new Error("Host dispatch instrumentation requires unwrapped core tools");
      notices.push({ name: tool.name, reason: "unsupported" });
      continue;
    }
    try {
      const parameters = schemaFor(tool);
      const validator = ajv.compile(parameters);
      if (typeof tool.execute !== "function" || typeof tool.description !== "string") throw new Error("Invalid host tool");
      const descriptor = Object.getOwnPropertyDescriptor(tool, "execute");
      if (descriptor ? !descriptor.writable : !Object.isExtensible(tool)) throw new Error("Immutable host tool");
      entries.push({ tool, source, validator, replaySafe: sdk.isAgentToolReplaySafe(tool),
        definition: { name: source.name, description: tool.description, parameters } });
    } catch (error) {
      if (!generic) throw error;
      notices.push({ name: tool.name, reason: "unsupported" });
    }
  }
  return { entries, toolNotices: buildHostToolNotices(options.toolAllowlist ?? [], entries.map(({ source }) => source.name), notices) };
}
