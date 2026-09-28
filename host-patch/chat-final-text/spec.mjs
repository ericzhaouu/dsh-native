import { replaceExactly } from "../spec.mjs";

export const PATCH_ID = "openclaw-dsh-native-chat-final-text-v1";
export const HOST_VERSION = "2026.9.2";
export const SOURCE_COMMIT = "3928bad9badfcb6c7d140530435e806fb8092190";
export const stateName = ".dsh-native-chat-final-text-patch-v1";

const policy = `
	const dshTextPolicyKey = Symbol.for("openclaw.dshNative.chatFinalText.v1");
	const bindDshTextPolicy = (evt, chatLink, sessionKey) => {
		const clientRunId = chatLink?.clientRunId ?? evt.runId;
		const record = chatRunState.getOrCreate(clientRunId);
		const context = getAgentRunContext(evt.runId);
		const generation = getAgentEventLifecycleGeneration();
		let bound = record[dshTextPolicyKey];
		if (!bound) {
			const agentId = context?.agentId;
			const trusted = Boolean(agentId && context.sessionKey && context.lifecycleGeneration === generation &&
				evt.lifecycleGeneration === generation && sessionKey === context.sessionKey &&
				(!chatLink || chatLink.agentId === agentId && chatLink.sessionKey === context.sessionKey));
			let runtime;
			try { if (trusted) runtime = resolveAgentConfig(getRuntimeConfig(), agentId)?.runtime; } catch {}
			bound = record[dshTextPolicyKey] = {
				sourceRunId: evt.runId, context, agentId, sessionKey: context?.sessionKey,
				generation, chatLink, preserve: trusted && runtime?.type === "embedded" && runtime.harness === "dsh-native"
			};
		}
		if (bound.sourceRunId !== evt.runId || bound.generation !== generation ||
			evt.lifecycleGeneration !== bound.generation || sessionKey !== bound.sessionKey ||
			context && (context !== bound.context || context.agentId !== bound.agentId ||
				context.sessionKey !== bound.sessionKey || context.lifecycleGeneration !== bound.generation) ||
			chatLink && chatLink !== bound.chatLink) bound.preserve = false;
	};
	const normalizeDshChatText = (text, clientRunId, sourceRunId) => {
		const record = chatRunState.runs.get(clientRunId);
		const bound = record?.[dshTextPolicyKey];
		const context = getAgentRunContext(sourceRunId);
		const preserve = bound?.preserve && bound.sourceRunId === sourceRunId &&
			bound.generation === getAgentEventLifecycleGeneration() && record.bufferIsCurrent?.() !== false &&
			(!context || context === bound.context && context.agentId === bound.agentId &&
				context.sessionKey === bound.sessionKey && context.lifecycleGeneration === bound.generation);
		// Whitespace-only output remains invisible; ordinary body bytes are not normalization input.
		return preserve && text.trim() ? text : text.trim();
	};
`;

export const edits = [{
  file: "dist/server-chat-DhlqkrkS.js",
  sha256: "e2066a201f0eaaa729bd20ff3760e70cc9788c08e1bfe2f0b21ecd25a1f0089a",
  replacements: [{
    before: 'import { n as getRuntimeConfig } from "./io.runtime-B9iJRs3w.js";',
    after: 'import { n as getRuntimeConfig } from "./io.runtime-B9iJRs3w.js";\nimport { c as resolveAgentConfig } from "./agent-scope-config-DcbEhP0R.js";',
  }, {
    before: "\tconst shouldProcessOwnedEvent = (evt) => {",
    after: `${policy}\n\tconst shouldProcessOwnedEvent = (evt) => {`,
  }, {
    before: "\t\tconst eventRunId = chatLink?.clientRunId ?? evt.runId;\n\t\tconst eventForClients",
    after: "\t\tbindDshTextPolicy(evt, chatLink, sessionKey);\n\t\tconst eventRunId = chatLink?.clientRunId ?? evt.runId;\n\t\tconst eventForClients",
  }, {
    before: "text: chatRunState.resolveBuffer(clientRunId, { final: options?.final }).text.trim()",
    after: "text: normalizeDshChatText(chatRunState.resolveBuffer(clientRunId, { final: options?.final }).text, clientRunId, sourceRunId)",
  }, {
    before: "projectLiveAssistantBufferedText(normalizedHeartbeatText.text.trim(), { suppressLeadFragments: options?.suppressLeadFragments })",
    after: "projectLiveAssistantBufferedText(normalizeDshChatText(normalizedHeartbeatText.text, clientRunId, sourceRunId), { suppressLeadFragments: options?.suppressLeadFragments })",
  }, {
    before: "text: projected.text.trim(),",
    after: "text: normalizeDshChatText(projected.text, clientRunId, sourceRunId),",
  }, {
    before: "text: streamed.text.trim(),",
    after: "text: normalizeDshChatText(streamed.text, clientRunId, sourceRunId),",
  }],
}, {
  file: "dist/server-chat-state-CwKZZaYd.js",
  sha256: "2b37588ab622ed6c653036d7a0091c8da4fccdd76117aec64feff7d3569edef3",
  replacements: [{
    before: "\t\tdelete record.rawBuffer;",
    after: '\t\tdelete record[Symbol.for("openclaw.dshNative.chatFinalText.v1")];\n\t\tdelete record.rawBuffer;',
  }],
}];

export function transform(text, edit) {
  for (const { before, after } of edit.replacements) text = replaceExactly(text, before, after, edit.file);
  return text;
}
