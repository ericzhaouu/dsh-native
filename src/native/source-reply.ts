import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness";
import { isSilentReplyPayloadText } from "openclaw/plugin-sdk/reply-chunking";
import type { JsonObject } from "../protocol.js";

type Attempt = Parameters<AgentHarnessV2["runAttempt"]>[0];
type Runtime = Pick<typeof import("openclaw/plugin-sdk/agent-harness-runtime"),
  "extractMessagingToolSend" | "extractMessagingToolSendResult" | "isDeliveredMessageToolOnlySourceReplyResult">;

export interface NativeSourceReplyDelivery {
  didSendViaMessagingTool: true;
  didDeliverSourceReplyViaMessageTool: true;
  sourceReplyDelivered: true;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: ReturnType<Runtime["extractMessagingToolSendResult"]>[];
  messagingToolSourceReplyPayloads?: Array<Record<string, unknown>>;
}

export class SourceReplyDeliveryError extends Error {
  readonly delivery: NativeSourceReplyDelivery;
  readonly originalError: unknown;
  constructor(error: unknown, delivery: NativeSourceReplyDelivery) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "SourceReplyDeliveryError";
    this.originalError = error;
    this.delivery = delivery;
  }
}

const EXPLICIT_ROUTE_KEYS = new Set(["channel", "target", "to", "channelId", "provider", "targets"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readDetails(result: unknown): Record<string, unknown> | undefined {
  const details = record(result) ? result.details : undefined;
  return record(details) ? details : undefined;
}

export function createPrivateSourceReplyArgs(text: string): JsonObject {
  return { action: "send", message: text, final: true };
}

export function isSilentSourceReply(attempt: Attempt, text: string): boolean {
  return attempt.runtimePlan?.delivery?.isSilentPayload({ text }) ?? isSilentReplyPayloadText(text);
}

export function assertPrivateSourceReplyArgs(args: unknown, expectedText: string): asserts args is Record<string, unknown> {
  if (!record(args)) throw new Error("Private source reply args must be an object");
  const keys = Object.keys(args);
  if (keys.some((key) => EXPLICIT_ROUTE_KEYS.has(key))) {
    throw new Error("Private source reply cannot use an explicit message route");
  }
  if (keys.some((key) => !["action", "message", "final"].includes(key))) {
    throw new Error("Private source reply args contain unsupported fields");
  }
  if (args.action !== "send") {
    throw new Error("Private source reply must use the canonical current-source send action");
  }
  if (args.message !== expectedText || args.final !== true) {
    throw new Error("Private source reply args were rewritten away from the committed final text");
  }
}

function extractSourceReplyPayload(result: unknown): Record<string, unknown> | undefined {
  const details = readDetails(result);
  if (!details || details.sourceReplySink !== "internal-ui") return undefined;
  const status = typeof details.deliveryStatus === "string" ? details.deliveryStatus.trim().toLowerCase() : undefined;
  if (status && status !== "sent") return undefined;
  const sourceReply = record(details.sourceReply) ? details.sourceReply : details;
  const payload: Record<string, unknown> = {};
  const text = stringValue(sourceReply.text) ?? stringValue(details.message);
  if (text) payload.text = text;
  const mediaUrl = stringValue(sourceReply.mediaUrl) ?? stringValue(details.mediaUrl);
  if (mediaUrl) payload.mediaUrl = mediaUrl;
  const mediaUrls = (Array.isArray(sourceReply.mediaUrls) ? sourceReply.mediaUrls :
    Array.isArray(details.mediaUrls) ? details.mediaUrls : []).filter((value): value is string => typeof value === "string");
  if (mediaUrls.length) payload.mediaUrls = mediaUrls;
  if (typeof sourceReply.trustedLocalMedia === "boolean") payload.trustedLocalMedia = sourceReply.trustedLocalMedia;
  if (sourceReply.audioAsVoice === true || details.audioAsVoice === true) payload.audioAsVoice = true;
  const idempotencyKey = stringValue(sourceReply.idempotencyKey) ?? stringValue(details.idempotencyKey);
  if (idempotencyKey) payload.idempotencyKey = idempotencyKey;
  if (details.sourceReplyTranscriptOwner === true) payload.transcriptOwner = true;
  return Object.keys(payload).length ? { ...payload, sourceReplyFinal: true } : undefined;
}

export function buildSourceReplyDeliveryEvidence(params: {
  sdk: Runtime;
  attempt: Attempt;
  args: Record<string, unknown>;
  result: unknown;
  isError: boolean;
}): NativeSourceReplyDelivery | undefined {
  const delivered = params.sdk.isDeliveredMessageToolOnlySourceReplyResult({
    sourceReplyDeliveryMode: params.attempt.sourceReplyDeliveryMode,
    toolName: "message",
    args: params.args,
    result: params.result,
    isError: params.isError,
  });
  if (!delivered) return undefined;
  const pending = params.sdk.extractMessagingToolSend("message", params.args, {
    config: params.attempt.config,
    currentChannelId: params.attempt.currentChannelId,
    currentMessagingTarget: params.attempt.currentMessagingTarget,
    currentThreadId: params.attempt.currentThreadTs,
    currentMessageId: params.attempt.currentMessageId,
    replyToMode: params.attempt.replyToMode,
  });
  const sent = pending ? params.sdk.extractMessagingToolSendResult(pending, params.result) : undefined;
  const payload = extractSourceReplyPayload(params.result);
  // The host capability can own an implicit route absent from the attempt's target hints.
  // Preserve its verified outcome without inventing a recipient.
  const text = sent?.text ?? stringValue(readDetails(params.result)?.deliveredText) ??
    stringValue(payload?.text) ?? stringValue(params.args.message);
  return {
    didSendViaMessagingTool: true,
    didDeliverSourceReplyViaMessageTool: true,
    sourceReplyDelivered: true,
    messagingToolSentTargets: sent ? [sent] : [],
    messagingToolSentTexts: text ? [text] : [],
    messagingToolSentMediaUrls: sent?.mediaUrls ?? [],
    ...(payload ? { messagingToolSourceReplyPayloads: [payload] } : {}),
  };
}
