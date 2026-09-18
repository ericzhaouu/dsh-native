export const PATCH_ID = "openclaw-compaction-auth-gap-v1";
export const HOST_VERSION = "2026.9.2";
export const SOURCE_COMMIT = "3928bad9badfcb6c7d140530435e806fb8092190";
export const stateName = ".dsh-native-compaction-auth-patch";

const compactionRuntimeAuthHelpers = `
function shouldPrepareDshNativeCopilotCompactionRuntimeAuth(params) {
\treturn params.provider === "github-copilot" && params.harness?.id === "dsh-native" &&
\t\t!(params.harness.authBootstrap === "harness" && !runtimePlanRequiresHostApiKey(params.runtimeAuthPlan));
}
async function prepareDshNativeCopilotCompactionRuntimeAuth(params) {
\tif (!shouldPrepareDshNativeCopilotCompactionRuntimeAuth(params)) return;
\tparams.signal?.throwIfAborted();
\tconst sourceApiKey = params.apiKey?.trim();
\tif (!sourceApiKey) return;
\tconst prepareRuntime = () => prepareProviderRuntimeAuth({
\t\t\tprovider: params.provider,
\t\t\tconfig: params.config,
\t\t\tworkspaceDir: params.workspaceDir,
\t\t\tenv: process.env,
\t\t\tcontext: {
\t\t\t\tconfig: params.config,
\t\t\t\tagentDir: params.agentDir,
\t\t\t\tworkspaceDir: params.workspaceDir,
\t\t\t\tenv: process.env,
\t\t\t\tprovider: params.provider,
\t\t\t\tmodelId: params.modelId,
\t\t\t\tmodel: params.model,
\t\t\t\tapiKey: unwrapSecretSentinelsForProviderEgress(sourceApiKey, "provider runtime auth exchange"),
\t\t\t\tauthMode: params.authMode,
\t\t\t\tprofileId: params.authProfileId ?? params.runtimeAuthPlan?.forwardedAuthProfileId
\t\t\t}
\t\t});
\tconst preparedAuth = protectPreparedProviderRuntimeAuth({
\t\tprovider: params.provider,
\t\tpreparedAuth: await withPluginRuntimeGenerationScope(params.preparedModelRuntime, prepareRuntime)
\t});
\tparams.signal?.throwIfAborted();
\tif (!preparedAuth) return;
\tconst runtimeModel = applyPreparedRuntimeAuthToModel(params.model, preparedAuth);
\tconst route = params.runtimeAuthPlan?.modelRoute;
\tconst runtimeAuthPlan = route && (route.api !== runtimeModel.api || route.baseUrl !== runtimeModel.baseUrl) ? {
\t\t...params.runtimeAuthPlan,
\t\tmodelRoute: {
\t\t\t...route,
\t\t\tapi: runtimeModel.api,
\t\t\tbaseUrl: runtimeModel.baseUrl
\t\t}
\t} : params.runtimeAuthPlan;
\treturn { runtimeModel, runtimeAuthPlan };
}
`;

export const edits = [
  {
    file: "dist/compaction-successor-D1lvjYXj.js",
    sha256: "ec3b9144411691b0e66cf89fb75b3cb8bc4d4f9444d7350cea81bd2d22ae8ef1",
    replacements: [{
      before: 'import { a as unwrapSecretSentinelsForProviderEgress, i as unwrapModelHeaderSentinelsForProviderEgress } from "./provider-secret-egress-C-JiHB7J.js";',
      after: 'import { a as unwrapSecretSentinelsForProviderEgress, i as unwrapModelHeaderSentinelsForProviderEgress, t as protectPreparedProviderRuntimeAuth } from "./provider-secret-egress-C-JiHB7J.js";',
    }, {
      before: 'import { r as prepareAgentRuntimeAuth, t as agentRuntimeAuthPlanMatchesTarget } from "./prepare-auth-Ci9igqt8.js";',
      after: 'import { r as prepareAgentRuntimeAuth, t as agentRuntimeAuthPlanMatchesTarget } from "./prepare-auth-Ci9igqt8.js";\nimport { t as applyPreparedRuntimeAuthToModel } from "./provider-request-config-DIOYidiO.js";\nimport { v as prepareProviderRuntimeAuth } from "./provider-runtime-BRJDPNgk.js";\nimport { n as withPluginRuntimeGenerationScope } from "./generation-scope-Cf83d_iq.js";',
    }, {
      before: 'function runtimePlanRequiresHostApiKey(plan) {\n\treturn plan?.modelRoute?.authRequirement === "api-key";\n}',
      after: `function runtimePlanRequiresHostApiKey(plan) {\n\treturn plan?.modelRoute?.authRequirement === "api-key";\n}\n${compactionRuntimeAuthHelpers}`,
    }, {
      before: '\t\t\t\t\tauth: { apiKey: auth.auth.apiKey?.trim() || void 0 }',
      after: '\t\t\t\t\tauth: { apiKey: auth.auth.apiKey?.trim() || void 0, mode: auth.auth.mode, profileId: auth.auth.profileId }',
    }, {
      before: '\treturn {\n\t\tharness,\n\t\tapiKey: resolved.auth.apiKey,\n\t\truntimeModel: resolved.model,\n\t\truntimeAuthPlan: resolved.plan\n\t};',
      after: `\tlet resolvedRuntimeModel = resolved.model;\n\tlet resolvedRuntimeAuthPlan = resolved.plan;\n\tconst preparedCompactionRuntimeAuth = await prepareDshNativeCopilotCompactionRuntimeAuth({\n\t\tagentDir,\n\t\tapiKey: resolved.auth.apiKey,\n\t\tauthMode: resolved.auth.mode ?? (resolved.plan.selectedAuthMode === "api_key" ? "api-key" : resolved.plan.selectedAuthMode),\n\t\tauthProfileId: resolved.auth.profileId ?? resolved.plan.forwardedAuthProfileId ?? compactParams.authProfileId,\n\t\tconfig: compactParams.config,\n\t\tharness,\n\t\tmodel: resolvedRuntimeModel,\n\t\tmodelId,\n\t\tprovider,\n\t\tpreparedModelRuntime: params.preparedModelRuntime,\n\t\truntimeAuthPlan: resolvedRuntimeAuthPlan,\n\t\tsignal: compactParams.abortSignal,\n\t\tworkspaceDir\n\t});\n\tif (preparedCompactionRuntimeAuth) {\n\t\tresolvedRuntimeModel = preparedCompactionRuntimeAuth.runtimeModel;\n\t\tresolvedRuntimeAuthPlan = preparedCompactionRuntimeAuth.runtimeAuthPlan;\n\t}\n\treturn {\n\t\tharness,\n\t\tapiKey: resolved.auth.apiKey,\n\t\truntimeModel: resolvedRuntimeModel,\n\t\truntimeAuthPlan: resolvedRuntimeAuthPlan\n\t};`,
    }],
  },
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
