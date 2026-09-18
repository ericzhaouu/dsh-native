export const PATCH_ID = "openclaw-agent-harness-pin-v1";
export const HOST_VERSION = "2026.9.2";
export const SOURCE_COMMIT = "3928bad9badfcb6c7d140530435e806fb8092190";
export const stateName = ".dsh-agent-harness-patch";

const agentResolver = `
/** Agent-owned harness pin; model/provider/auth selection remains host-owned. */
function resolveAgentEmbeddedHarnessPolicy(params) {
\tif (!params.config) return;
\tconst scoped = Boolean(params.agentId?.trim() || params.sessionKey?.trim());
\tconst agentId = scoped ? resolveSessionAgentIds({
\t\tconfig: params.config, agentId: params.agentId, sessionKey: params.sessionKey
\t}).sessionAgentId : tryResolveLegacyCompatibilityAgentId(params.config);
\tif (!agentId) return;
\tconst entry = resolveAgentEntry(params.config, agentId);
\tconst runtime = entry?.runtime;
\tif (runtime?.type !== "embedded" || runtime.harness === void 0) return;
\tconst id = runtime.harness;
\tif (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(id) || id === "auto" || id === "default") {
\t\tthrow new Error("Invalid Agent runtime.harness pin; remove it to restore automatic selection.");
\t}
\treturn { policy: { id }, source: "agent" };
}
`;

export const edits = [
  {
    file: "dist/model-runtime-policy-BAKiaBCi.js",
    sha256: "f287c80fae10d4cf7673eb76333d32c1c1923647829961b5afc917553fdfade4",
    replacements: [{
      before: "/** Resolves the effective runtime policy for an agent/model/provider selection. */",
      after: agentResolver + "\n/** Resolves the effective runtime policy for an agent/model/provider selection. */",
    }, {
      before: "function resolveModelRuntimePolicy(params) {\n\tconst callerProvider",
      after: "function resolveModelRuntimePolicy(params) {\n\tconst agentPin = resolveAgentEmbeddedHarnessPolicy(params);\n\tif (agentPin) return agentPin;\n\tconst callerProvider",
    }],
  },
  {
    file: "dist/zod-schema.agent-runtime-BB0ECdB0.js",
    sha256: "99d4578c5cfba62e6883f80136555a582ecadbfA1327409485896168b82d8fe2".toLowerCase(),
    replacements: [{
      before: 'const AgentRuntimeSchema = union([object({ type: literal("embedded") }).strict(), object({',
      after: `const AgentRuntimeSchema = union([object({
\ttype: literal("embedded"),
\tharness: string().regex(/^[a-z][a-z0-9-]{0,63}$/).refine((id) => id !== "auto" && id !== "default", "Remove the Agent harness pin to restore automatic selection.").optional()
}).strict(), object({`,
    }],
  },
  {
    file: "dist/availability-DrQ2OOVX.js",
    sha256: "5a031d3e9a49b2a25f5a35d223445e0bf328d897afc270a62d9cdc5902957a6a",
    replacements: [{
      before: 'import { t as resolveAgentHarnessPolicy } from "./policy-D9i1QMuw.js";',
      after: 'import { t as resolveAgentHarnessPolicy } from "./policy-D9i1QMuw.js";\nimport { t as AgentHarnessPreflightError } from "./errors-70ml6R0Z.js";',
    }, {
      before: "\tconst runtimeOverride = pinnedHarnessId ?? normalizeOptionalAgentRuntimeId(params.agentHarnessRuntimeOverride);",
      after: `\tconst explicitOverride = normalizeOptionalAgentRuntimeId(params.agentHarnessRuntimeOverride);
\tconst agentPinned = configured.runtimeSource === "agent";
\tif (agentPinned && ((pinnedHarnessId && pinnedHarnessId !== configured.runtime) ||
\t\t(explicitOverride && explicitOverride !== "auto" && explicitOverride !== "default" && explicitOverride !== configured.runtime))) {
\t\tthrow new AgentHarnessPreflightError("The Agent is pinned to harness " + configured.runtime + "; an existing session or runtime override conflicts. Start a new session instead of changing execution ownership.");
\t}
\tconst runtimeOverride = pinnedHarnessId ?? explicitOverride;`,
    }, {
      before: '\t\truntimeSource: "model"\n\t} : configured;',
      after: '\t\truntimeSource: agentPinned ? "agent" : "model"\n\t} : configured;',
    }, {
      before: '\tif (pinnedHarnessId === policy.runtime && !params.preparedModelProvider) return {',
      after: '\tif (!agentPinned && pinnedHarnessId === policy.runtime && !params.preparedModelProvider) return {',
    }, {
      before: '\t\tif (implicit || support.fallbackRuntime === "openclaw") return {',
      after: '\t\tif (!agentPinned && (implicit || support.fallbackRuntime === "openclaw")) return {',
    }],
  },
  {
    file: "dist/model-fallback-attempt-hBQW6kuE.js",
    sha256: "028a78955fb8756cf7d0f840f7e19fac5ea28cba2d178c15882aca096d7f80a8",
    replacements: [{
      before: 'import { i as isAgentHarnessPreflightError, r as MissingAgentHarnessError } from "./errors-70ml6R0Z.js";',
      after: 'import { i as isAgentHarnessPreflightError, r as MissingAgentHarnessError, t as AgentHarnessPreflightError } from "./errors-70ml6R0Z.js";',
    }, {
      before: "\tif (getRegisteredAgentHarness(runtime)) return result(true);\n\tif (isCliAgentRuntime(runtime, params.cfg))",
      after: '\tif (getRegisteredAgentHarness(runtime)) return result(true);\n\tif (runtimeSource === "agent") throw new MissingAgentHarnessError(runtime);\n\tif (isCliAgentRuntime(runtime, params.cfg))',
    }, {
      before: '\treturn {\n\t\tagentHarnessRuntimeOverride,\n\t\texplicitAgentRuntime,\n\t\truntime: explicitAgentRuntime ?? harnessPolicy.runtime,',
      after: `\tif (harnessPolicy.runtimeSource === "agent") {
\t\tif (explicitAgentRuntime && explicitAgentRuntime !== harnessPolicy.runtime) {
\t\t\tthrow new AgentHarnessPreflightError("Fallback runtime override conflicts with Agent-pinned harness " + harnessPolicy.runtime + ".");
\t\t}
\t\treturn {
\t\t\tagentHarnessRuntimeOverride: harnessPolicy.runtime,
\t\t\texplicitAgentRuntime: harnessPolicy.runtime,
\t\t\truntime: harnessPolicy.runtime,
\t\t\truntimeSource: "agent"
\t\t};
\t}
\treturn {
\t\tagentHarnessRuntimeOverride,
\t\texplicitAgentRuntime,
\t\truntime: explicitAgentRuntime ?? harnessPolicy.runtime,`,
    }],
  },
  {
    file: "dist/selection-CgLPGlZh.js",
    sha256: "a1f0cfcadbbb3cf0e84deddd68c263f6b488b92f4a2695ba4893612ea6ff6678",
    replacements: [{
      before: "\t\tconst forced = pluginHarnesses.find((entry) => entry.id === runtime);\n\t\tif (forced) {",
      after: '\t\tconst forced = pluginHarnesses.find((entry) => entry.id === runtime);\n\t\tif (policy.runtimeSource === "agent" && !forced) throw new MissingAgentHarnessError(runtime);\n\t\tif (forced) {',
    }, {
      before: "\t\t\tconst support = availability.support;",
      after: `\t\t\tconst support = availability.support;
\t\t\tif (policy.runtimeSource === "agent" && support && !support.supported) {
\t\t\t\tthrow new AgentHarnessPreflightError("Agent-pinned harness " + runtime + " cannot run " + formatProviderModel(params) + (support.reason ? ": " + support.reason : "") + ". The model and harness were not substituted.");
\t\t\t}`,
    }],
  },
  ...[
    ["index.d.ts", "5767d9db048a8cb9e83995e3a26859c840a2c45e73cbed46e956e57a85497152"],
    ["install-security-scan.types-CwuFCGpV.d.ts", "07be08862769c727f10bb1f631722c3d54a0fd0b011c0b80f8430c40c5f3faa6"],
    ["plugin-entry-C8u6cSDu.d.ts", "3eec22c2639225f846221e5a980d6279ff675a91196af46c9a72f946a89b3985"],
    ["runtime-api-D4nuJwsj.d.ts", "021542920f0404a0278e7f2273e4f3e3e2a6d2b5f66abf46844e1ed907d69407"],
    ["types.openclaw-BC-OHYtd.d.ts", "30f78c3d62ad223976c6fd1687381c6f74513fae7cb52d89df760d1990b36a10"],
    ["types.openclaw-BdCLfP4c.d.ts", "e24608b63054c3ed865ee8b55fb59e568c080265104ae73b6915b95a2d3d0226"],
    ["types.openclaw-BMUxPS96.d.ts", "6f583901987eb54aa02732843cc6ddb292cb3b7a845b1b4a8fcb4d71b3bb02d4"],
  ].map(([name, sha256]) => ({
    file: `dist/${name}`,
    sha256,
    replacements: [{
      before: 'type AgentRuntimeConfig = {\n  type: "embedded";',
      after: 'type AgentRuntimeConfig = {\n  type: "embedded";\n  /** Fixed Agent harness; model/provider/auth selection remains independent. */\n  harness?: string;',
    }],
  })),
];

export function replaceExactly(text, before, after, file) {
  const start = text.indexOf(before);
  if (start < 0 || text.indexOf(before, start + before.length) >= 0) {
    throw new Error(`Expected one patch anchor in ${file}. This host build is unsupported.`);
  }
  return text.slice(0, start) + after + text.slice(start + before.length);
}

export function transform(text, edit) {
  let output = text;
  for (const replacement of edit.replacements) {
    output = replaceExactly(output, replacement.before, replacement.after, edit.file);
  }
  return output;
}
