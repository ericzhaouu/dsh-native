import { replaceExactly } from "../spec.mjs";

export const PATCH_ID = "openclaw-dsh-group-readonly-v1";
export const HOST_VERSION = "2026.9.2";
export const SOURCE_COMMIT = "3928bad9badfcb6c7d140530435e806fb8092190";
export const stateName = ".dsh-native-group-readonly-patch-v1";

export const helper = `
function isDshReadOnlyGroup(options, profile) {
\tconst policy = profile.policy;
\tconst runtime = options?.config && policy.agentId ? resolveDshReadOnlyAgentConfig(options.config, policy.agentId)?.runtime : void 0;
\tif (runtime?.type !== "embedded" || runtime.harness !== "dsh-native" ||
\t\toptions?.messageProvider !== "feishu" || !dshSessionNamesGroup(options.runSessionKey ?? options.sessionKey)) return false;
\tconst group = policy.groupPolicy;
\tconst safe = (name) => name === "read" || name === "message";
\treturn Array.isArray(group?.allow) && group.allow.length > 0 &&
\t\tgroup.allow.every(safe) && (group.alsoAllow === void 0 ||
\t\tArray.isArray(group.alsoAllow) && group.alsoAllow.every(safe));
}
`;

export const edits = [{
  file: "dist/agent-tools-By64BZu5.js",
  sha256: "95bc6a05e6cbf4801e00b1646219b649048e16a838062d4f33dd723b7faf4140",
  replacements: [{
    before: 'import { _ as resolveSessionAgentId } from "./agent-scope-DbtJyKUL.js";',
    after: 'import { _ as resolveSessionAgentId } from "./agent-scope-DbtJyKUL.js";\nimport { c as resolveDshReadOnlyAgentConfig } from "./agent-scope-config-DcbEhP0R.js";\nimport { s as dshSessionNamesGroup } from "./agent-tools.policy-NF_9Y4S4.js";',
  }, {
    before: "function createOpenClawCodingToolsInternal(options) {",
    after: `${helper}\nfunction createOpenClawCodingToolsInternal(options) {`,
  }, {
    before: "\tconst workspaceOnly = isMemoryFlushRun || (sessionCoreToolPolicy?.workspaceOnly ?? fsConfig.workspaceOnly === true);",
    after: "\tconst dshReadOnlyGroup = isDshReadOnlyGroup(options, capabilityProfile);\n\tconst workspaceOnly = dshReadOnlyGroup || isMemoryFlushRun || (sessionCoreToolPolicy?.workspaceOnly ?? fsConfig.workspaceOnly === true);",
  }, {
    before: "\tconst readOnly = sessionCoreToolPolicy?.readOnly ?? false;",
    after: "\tconst readOnly = dshReadOnlyGroup || (sessionCoreToolPolicy?.readOnly ?? false);",
  }],
}];

export function transform(text, edit) {
  for (const { before, after } of edit.replacements) text = replaceExactly(text, before, after, edit.file);
  return text;
}
