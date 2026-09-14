import { ToolCallId, type ContentBlock, type GenerateOptions, type ReplayEnvelope, type StreamChunk } from "@deepseek-ai/dsh-llm";

const COPILOT_PROVIDER = "github-copilot";
const REPLAY_RESPONSE_VERSION = 2;

type ToolIdBlock = Extract<ContentBlock, { type: "tool-call" | "tool-result" }>;
type ReplayBlockType = "text" | "reasoning" | "tool-call";

class ToolIdNormalizer {
  private readonly canonicalToOriginal = new Map<string, string>();

  canonicalize(id: string, label: string): string {
    if (typeof id !== "string" || !id) throw new Error(`Invalid Copilot ${label} id`);
    const pipe = id.indexOf("|");
    const canonical = pipe < 0 ? id : id.slice(0, pipe);
    if (!canonical || (pipe >= 0 && pipe === id.length - 1)) {
      throw new Error(`Malformed Copilot ${label} id`);
    }
    const seen = this.canonicalToOriginal.get(canonical);
    if (seen !== undefined && seen !== id) {
      throw new Error(`Colliding Copilot ${label} ids cannot be replayed safely`);
    }
    this.canonicalToOriginal.set(canonical, id);
    return canonical;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Copilot ${label}`);
  }
  return value as Record<string, unknown>;
}

function responseOf(replayState: unknown): Record<string, unknown> {
  return record(record(replayState, "replay state").response, "replay response");
}

function blocksOf(replayState: unknown): readonly unknown[] | undefined {
  const blocks = record(replayState, "replay state").blocks;
  if (blocks === undefined) return undefined;
  if (!Array.isArray(blocks)) throw new Error("Invalid Copilot replay blocks");
  return blocks;
}

function sanitizeResponse(response: Record<string, unknown>): {
  kind: "pi-ai"; version: 2; api: string; provider: string; model: string; stopReason: string;
} {
  if (response.kind !== "pi-ai") throw new Error("Invalid Copilot replay kind");
  if (response.version !== REPLAY_RESPONSE_VERSION) throw new Error("Invalid Copilot replay version");
  const { api, provider, model, stopReason } = response;
  if (typeof api !== "string" || !api || typeof provider !== "string" || !provider ||
      typeof model !== "string" || !model || typeof stopReason !== "string" || !stopReason) {
    throw new Error("Invalid Copilot replay response fields");
  }
  if (response.provider !== COPILOT_PROVIDER) throw new Error("Unexpected Copilot replay provider");
  if (response.api !== "openai-responses" || !["stop", "length", "toolUse", "error", "aborted"].includes(String(response.stopReason))) {
    throw new Error("Unexpected Copilot replay protocol or outcome");
  }
  return {
    kind: "pi-ai",
    version: REPLAY_RESPONSE_VERSION,
    api, provider, model, stopReason,
  };
}

function replayTypeFor(block: ContentBlock): ReplayBlockType {
  switch (block.type) {
    case "text": return "text";
    case "reasoning": return "reasoning";
    case "tool-call": return "tool-call";
    default: throw new Error(`Unsupported Copilot replay block type: ${block.type}`);
  }
}

function sanitizeToolIdBlock(block: ToolIdBlock, ids: ToolIdNormalizer, label: string): ToolIdBlock {
  if (block.type === "tool-call") {
    const id = ids.canonicalize(block.id, label);
    return id === block.id ? block : { ...block, id: ToolCallId(id) };
  }
  const toolCallId = ids.canonicalize(block.toolCallId, label);
  return toolCallId === block.toolCallId ? block : { ...block, toolCallId: ToolCallId(toolCallId) };
}

function sanitizeReplayEnvelope(replayState: unknown): ReplayEnvelope {
  const response = sanitizeResponse(responseOf(replayState));
  const blocks = blocksOf(replayState);
  return {
    response,
    ...(blocks === undefined ? {} : {
      blocks: blocks.map((block) => {
        const type = record(block, "replay block").type;
        if (type !== "text" && type !== "reasoning" && type !== "tool-call") {
          throw new Error("Unsupported Copilot replay block type");
        }
        return { type };
      }),
    }),
  };
}

export function assertCopilotReplaySafe(options: GenerateOptions): void {
  for (const message of options.messages) {
    for (const block of message.content) {
      if (block.type === "tool-call" && block.id.includes("|") ||
          block.type === "tool-result" && block.toolCallId.includes("|")) {
        throw new Error("Opaque Copilot tool history cannot be resumed; start a new session");
      }
    }
    if (message.role !== "assistant") continue;
    const source = message.source;
    if (source.kind !== "model" || source.provider !== COPILOT_PROVIDER || source.model !== options.model) {
      throw new Error("Foreign Copilot assistant history cannot be resumed");
    }
    const replay = source.replayState;
    if (replay === undefined) {
      if (message.content.some((block) => block.type === "reasoning")) {
        throw new Error("Reasoning history without a valid Copilot replay envelope is unsupported");
      }
      continue;
    }
    const response = responseOf(replay);
    sanitizeResponse(response);
    if (response.model !== source.model || Object.keys(response).some((key) =>
      !["kind", "version", "api", "provider", "model", "stopReason"].includes(key))) {
      throw new Error("Unsanitized Copilot response metadata cannot be resumed");
    }
    const blocks = blocksOf(replay);
    if (!blocks || blocks.length !== message.content.length) throw new Error("Invalid Copilot replay block alignment");
    blocks.forEach((value, index) => {
      const block = record(value, "replay block");
      const content = message.content[index];
      if (!content || block.type !== replayTypeFor(content) || Object.keys(block).some((key) => key !== "type")) {
        throw new Error("Unsanitized Copilot replay signature cannot be resumed");
      }
    });
  }
}

export async function* sanitizeCopilotStream(stream: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
  const ids = new ToolIdNormalizer();
  const pendingReasoningWhitespace = new Map<number, string>();
  const emittedReasoning = new Map<number, string>();
  for await (const chunk of stream) {
    if (chunk.type === "reasoning-delta") {
      // Copilot emits a summary-part separator that its completed reasoning item
      // may omit. Delay only trailing whitespace until the canonical block closes.
      const combined = (pendingReasoningWhitespace.get(chunk.index) ?? "") + chunk.text;
      const visible = combined.trimEnd();
      pendingReasoningWhitespace.set(chunk.index, combined.slice(visible.length));
      if (visible) {
        emittedReasoning.set(chunk.index, (emittedReasoning.get(chunk.index) ?? "") + visible);
        yield { ...chunk, text: visible };
      }
      continue;
    }
    if (chunk.type === "tool-call-delta") {
      const id = ids.canonicalize(chunk.id, "stream tool-call");
      yield id === chunk.id ? chunk : { ...chunk, id: ToolCallId(id) };
      continue;
    }
    if (chunk.type === "block-end") {
      const block = chunk.block;
      if (block.type === "reasoning") {
        const prefix = emittedReasoning.get(chunk.index) ?? "";
        if (!block.text.startsWith(prefix)) throw new Error("Copilot rewrote emitted reasoning content");
        pendingReasoningWhitespace.delete(chunk.index);
        emittedReasoning.delete(chunk.index);
      }
      if (block.type === "tool-call") {
        const sanitized = sanitizeToolIdBlock(block, ids, "stream tool-call");
        yield sanitized === block ? chunk : {
          ...chunk,
          block: sanitized,
        };
        continue;
      }
    }
    if (chunk.type === "finish") {
      for (const [index, text] of pendingReasoningWhitespace) {
        if (text) yield { type: "reasoning-delta", index, text };
      }
      pendingReasoningWhitespace.clear();
      emittedReasoning.clear();
      yield chunk.replayState === undefined ? chunk
        : { ...chunk, replayState: sanitizeReplayEnvelope(chunk.replayState) };
      continue;
    }
    yield chunk;
  }
}
