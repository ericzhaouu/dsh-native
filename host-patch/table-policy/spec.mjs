export const PATCH_ID = "openclaw-dsh-native-table-policy-v1";
export const HOST_VERSION = "2026.9.2";
export const SOURCE_COMMIT = "3928bad9badfcb6c7d140530435e806fb8092190";
export const stateName = ".dsh-native-table-policy-patch-v1";

const scopedTableGuidance = `\tconst tableMode = getLoadedChannelPluginForRead(channelId)?.messaging?.defaultMarkdownTableMode;
\tconst agentRuntime = params.cfg && params.agentId ? resolveAgentConfig(params.cfg, params.agentId)?.runtime : void 0;
\tlet tableGuidance = tableMode === "block" || tableMode === "off" ? "" : " Avoid Markdown tables.";
\tif (agentRuntime?.type === "embedded" && agentRuntime.harness === "dsh-native") {
\t\t// A default table mode is not proof of native block-table capability.
\t\tconst effectiveTableMode = resolveMarkdownTableMode({
\t\t\tcfg: params.cfg,
\t\t\tchannel: channelId,
\t\t\taccountId: params.sessionCtx.AccountId
\t\t});
\t\ttableGuidance = " Prefer concise prose by default, but honor an explicit user format request within the channel's capabilities.";
\t\tif (effectiveTableMode === "off") tableGuidance += " When the user requests a table, provide the requested Markdown table with its rows and columns as plain-text Markdown. Table conversion is off; this does not guarantee a rendered table. Do not silently substitute bullets or prose.";
\t\telse if (effectiveTableMode === "code") tableGuidance += " When the user requests a table, provide a compact code-block text table preserving the requested rows and columns. If rendered Markdown was requested, briefly explain this text-table fallback; do not claim native table rendering.";
\t\telse if (effectiveTableMode === "bullets") tableGuidance += " This channel is configured to convert Markdown tables to bullets. When the user requests a table, briefly explain that limitation and provide a labeled list preserving all requested column values for each row, rather than claiming to deliver a rendered table.";
\t\telse tableGuidance += " Table rendering capability is not established. If a table is requested, briefly explain the limitation and provide a labeled list preserving the requested rows and column values; do not claim native table rendering.";
\t}`;

export const edits = [{
  file: "dist/get-reply-DsCSrfQ0.js",
  sha256: "51f917b5d5432abaa9de9ea1cc855ef72ba6e8d679614481be8d8eb45b1c2892",
  replacements: [{
    before: 'import { r as getLoadedChannelPluginForRead } from "./registry-loaded-Bh7xuMJh.js";',
    after: 'import { r as getLoadedChannelPluginForRead } from "./registry-loaded-Bh7xuMJh.js";\nimport { t as resolveMarkdownTableMode } from "./markdown-tables-BI-3mmWv.js";',
  }, {
    before: '\tconst tableMode = getLoadedChannelPluginForRead(channelId)?.messaging?.defaultMarkdownTableMode;\n\tconst tableGuidance = tableMode === "block" || tableMode === "off" ? "" : " Avoid Markdown tables.";',
    after: scopedTableGuidance,
  }, {
    before: '\t\treturn isGroupChat ? buildGroupChatContext({\n\t\t\tsessionCtx: promptSessionCtx,',
    after: '\t\treturn isGroupChat ? buildGroupChatContext({\n\t\t\tcfg,\n\t\t\tagentId,\n\t\t\tsessionCtx: promptSessionCtx,',
  }],
}];

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
