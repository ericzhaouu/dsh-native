import { replaceExactly } from "../spec.mjs";

export const PATCH_ID = "openclaw-native-source-reply-owner-v1";
export const HOST_VERSION = "2026.9.2";
export const SOURCE_COMMIT = "3928bad9badfcb6c7d140530435e806fb8092190";
export const stateName = ".dsh-native-source-reply-owner-patch-v1";

export const ownershipHelper = `
function createNativeSourceReplyOwnershipBinding(options, agentId) {
	let registered = false;
	let pending;
	return {
		bind(proof) {
			const sessionKey = options?.runSessionKey ?? options?.agentSessionKey;
			if (registered || !proof || proof.version !== 1 || !agentId || !sessionKey ||
				!options?.sessionId || !options?.runId || options?.sourceReplyDeliveryMode !== "message_tool_only" ||
				proof.agentId !== agentId || proof.sessionKey !== sessionKey ||
				proof.sessionId !== options.sessionId || proof.runId !== options.runId ||
				typeof proof.text !== "string" || !proof.text.trim() || typeof proof.assertCurrent !== "function") {
				throw new Error("Invalid or duplicate native source reply ownership binding");
			}
			const resetPrefix = options.sessionId + "\\0reset\\0";
			const resetId = typeof proof.nativeStateId === "string" && proof.nativeStateId.startsWith(resetPrefix)
				? proof.nativeStateId.slice(resetPrefix.length) : void 0;
			const expected = resetId && !resetId.includes("\\0") ? "dsh-native:reset:" + resetId + ":" + options.runId + ":assistant"
				: proof.nativeStateId === options.sessionId ? "dsh-native:" + options.runId + ":assistant" : void 0;
			if (!expected || proof.assistantKey !== expected) throw new Error("Native source reply epoch or assistant identity mismatch");
			registered = true;
			pending = Object.freeze({ ...proof });
		},
		take(toolCallId, args) {
			if (!registered) return;
			const proof = pending;
			pending = void 0;
			if (!proof || toolCallId !== "dsh-source-reply:" + options.runId ||
				Object.keys(args).length !== 3 || args.action !== "send" || args.final !== true || args.message !== proof.text) {
				throw new Error("Native source reply ownership cannot authorize this tool invocation");
			}
			return async (route) => {
				if (route.agentId !== proof.agentId || route.sessionId !== proof.sessionId || route.runId !== proof.runId ||
					route.sessionKey !== proof.sessionKey || route.destinationSessionKey !== proof.sessionKey ||
					route.sourceReplyDeliveryMode !== "message_tool_only" || route.hasMedia || route.dryRun) {
					throw new Error("Native source reply ownership cannot cross its committed source route");
				}
				await proof.assertCurrent();
				return proof.assistantKey;
			};
		}
	};
}
`;

const toolReplacements = [
  { before: "function createMessageTool(options) {", after: `${ownershipHelper}\nfunction createMessageTool(options) {` },
  { before: '\tconst pollEchoSessionKey = rawPollEchoSessionKey && resolvedAgentId ? `${resolvedAgentId}\\0${rawPollEchoSessionKey}` : void 0;',
    after: '\tconst nativeSourceReplyOwnership = createNativeSourceReplyOwnershipBinding(options, resolvedAgentId);\n\tconst pollEchoSessionKey = rawPollEchoSessionKey && resolvedAgentId ? `${resolvedAgentId}\\0${rawPollEchoSessionKey}` : void 0;' },
  { before: '\t\tlabel: "Message",\n\t\tname: "message",',
    after: '\t\tlabel: "Message",\n\t\tname: "message",\n\t\tbindNativeSourceReplyOwnership: nativeSourceReplyOwnership.bind,' },
  { before: '\t\t\tif (signal?.aborted) throw createAbortError("Message send aborted");\n\t\t\tconst params = { ...args };',
    after: '\t\t\tif (signal?.aborted) throw createAbortError("Message send aborted");\n\t\t\tconst assertNativeSourceReplyOwnership = nativeSourceReplyOwnership.take(toolCallId, args);\n\t\t\tconst params = { ...args };' },
  { before: '\t\t\t\tresult = await runMessageActionForTool({\n\t\t\t\t\tcfg,',
    after: '\t\t\t\tresult = await runMessageActionForTool({\n\t\t\t\t\tassertNativeSourceReplyOwnership,\n\t\t\t\t\tcfg,' },
];

const runnerReplacements = [
  {
    before: '\tconst gatewayPluginAction = requiresCoreDelivery ? null : await executeGatewayAction({',
    after: `\tlet nativeSourceReplyOwned = false;
\tif (input.assertNativeSourceReplyOwnership) {
\t\tif (input.transcriptMirror || (Boolean(gateway) && (channelPlugin?.actions?.resolveExecutionMode?.({ action }) === "gateway" || channelPlugin?.outbound?.deliveryMode === "gateway"))) {
\t\t\tthrow new Error("Native source reply ownership requires local current-source delivery");
\t\t}
\t\tawait input.assertNativeSourceReplyOwnership({
\t\t\tagentId, sessionId: input.sessionId, runId: input.runId,
\t\t\tsessionKey: input.sourceReplySessionKey ?? input.sessionKey,
\t\t\tdestinationSessionKey: outboundRoute?.sessionKey,
\t\t\tsourceReplyDeliveryMode: input.sourceReplyDeliveryMode,
\t\t\thasMedia: Boolean(sendPayload.mediaUrl || sendPayload.mediaUrls?.length), dryRun
\t\t});
\t\tnativeSourceReplyOwned = true;
\t}
\tconst gatewayPluginAction = requiresCoreDelivery ? null : await executeGatewayAction({`,
  },
  { before: '\t\t\tmirror: !dryRun && input.transcriptMirror ? {',
    after: '\t\t\tmirror: nativeSourceReplyOwned ? void 0 : !dryRun && input.transcriptMirror ? {' },
  {
    before: '\tif (!dryRun && input.sessionId) {\n\t\tconst sessionKey = input.sourceReplySessionKey ?? input.sessionKey;',
    after: `\tif (input.assertNativeSourceReplyOwnership) {
\t\tpersistedIdempotencyKey = await input.assertNativeSourceReplyOwnership({
\t\t\tagentId, sessionId: input.sessionId, runId: input.runId,
\t\t\tsessionKey: input.sourceReplySessionKey ?? input.sessionKey,
\t\t\tdestinationSessionKey: input.sourceReplySessionKey ?? input.sessionKey,
\t\t\tsourceReplyDeliveryMode: input.sourceReplyDeliveryMode,
\t\t\thasMedia: sourceReplyMediaUrls.length > 0, dryRun
\t\t});
\t\tpersistedTranscriptOwner = true;
\t} else if (!dryRun && input.sessionId) {
\t\tconst sessionKey = input.sourceReplySessionKey ?? input.sessionKey;`,
  },
];

export const edits = [
  { file: "dist/openclaw-tools-CNOZOjlX.js", sha256: "a7f39614782b5cd960f16517fa4e35ac04b1ddfdb25c3b18a105698b95535f7f", replacements: toolReplacements },
  { file: "dist/message-action-runner-D-2Vw1B0.js", sha256: "8d071f34a6ff15c7b980e806a66d5a74048a8e85073e7315f3824a7e683f46ad", replacements: runnerReplacements },
];

export function transform(text, edit) {
  for (const { before, after } of edit.replacements) text = replaceExactly(text, before, after, edit.file);
  return text;
}
