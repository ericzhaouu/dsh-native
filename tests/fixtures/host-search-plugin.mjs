import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_SEARCH_PLUGIN_ID = "dsh-host-search-fixture";
export const HOST_SEARCH_PROVIDER_ID = "dsh-fixture-search";
export const HOST_SEARCH_URL = "https://example.com/dsh-host-search";
export const LOOKUP_TOOL = "fixture_lookup";

export const HOST_SEARCH_MANIFEST = {
  id: HOST_SEARCH_PLUGIN_ID,
  activation: { onStartup: true },
  contracts: { webSearchProviders: [HOST_SEARCH_PROVIDER_ID], tools: [LOOKUP_TOOL] },
  toolMetadata: {
    [LOOKUP_TOOL]: { profiles: ["coding"], replaySafe: true, sideEffecting: false },
  },
  configSchema: {
    type: "object",
    additionalProperties: false,
    required: ["apiKey", "detailsToken"],
    properties: { apiKey: { type: "string" }, detailsToken: { type: "string" } },
  },
};

function pluginConfig(config) {
  return config?.plugins?.entries?.[HOST_SEARCH_PLUGIN_ID]?.config;
}

function answerFor(kind, input) {
  return `HOST-${kind}-ANSWER-${createHash("sha256").update(input).digest("hex").slice(0, 16)}`;
}

// Loaded only by the genuine Gateway plugin loader, never called by the model fixture.
export function registerHostSearchPlugin(api) {
  const config = api.pluginConfig;
  assert.equal(typeof config?.apiKey, "string");
  assert.equal(typeof config?.detailsToken, "string");
  const record = (event) => appendFileSync(join(dirname(fileURLToPath(import.meta.url)), "host-events.jsonl"),
    `${JSON.stringify({ ...event, pid: process.pid })}\n`);
  const credentialPath = `plugins.entries.${HOST_SEARCH_PLUGIN_ID}.config.apiKey`;
  const credentialMatches = (hostConfig) => pluginConfig(hostConfig)?.apiKey === config.apiKey;

  api.registerWebSearchProvider({
    id: HOST_SEARCH_PROVIDER_ID,
    label: "Offline host search fixture",
    hint: "Synthetic public results; no network",
    requiresCredential: true,
    envVars: [],
    placeholder: "fixture-only credential",
    signupUrl: "https://example.com/",
    credentialPath,
    inactiveSecretPaths: [credentialPath],
    getCredentialValue: (searchConfig) => searchConfig?.apiKey,
    setCredentialValue: (searchConfig, value) => { searchConfig.apiKey = value; },
    getConfiguredCredentialValue: (hostConfig) => pluginConfig(hostConfig)?.apiKey,
    setConfiguredCredentialValue: (hostConfig, value) => { pluginConfig(hostConfig).apiKey = value; },
    createTool(context) {
      record({ kind: "search-create", agentDir: context.agentDir,
        credentialAvailable: credentialMatches(context.config),
        selectedProvider: context.runtimeMetadata?.selectedProvider });
      return {
        description: "Look up a synthetic public reference without network access.",
        parameters: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string" },
            count: { type: "number", minimum: 1, maximum: 10 },
          },
          additionalProperties: false,
        },
        async execute(args, executionContext) {
          executionContext?.signal?.throwIfAborted();
          assert.ok(credentialMatches(context.config), "Search credentials must resolve inside the host");
          assert.equal(typeof args.query, "string");
          assert.ok(args.query.length > 0);
          assert.equal(args.count, 1);
          const answer = answerFor("SEARCH", args.query);
          record({ kind: "search-execute", args, answer, agentDir: context.agentDir,
            credentialAvailable: true, signalAvailable: !!executionContext?.signal });
          // Core web_search, not this provider, adds kind/externalContent and wraps untrusted prose.
          return { results: [{ title: "Fixture public reference", url: HOST_SEARCH_URL, snippet: answer }] };
        },
      };
    },
  });

  api.registerTool((context) => {
    const tool = {
      name: LOOKUP_TOOL,
      label: "Fixture lookup",
      description: "Read a synthetic fixture record by key.",
      parameters: {
        type: "object", required: ["key"], additionalProperties: false,
        properties: { key: { type: "string", minLength: 1 } },
      },
      async execute(callId, args, signal) {
        signal?.throwIfAborted();
        const { getPluginToolMeta } = await import("openclaw/plugin-sdk/agent-harness-runtime");
        assert.ok(credentialMatches(context.config), "Plugin factory must receive the host config");
        const answer = answerFor("LOOKUP", args.key);
        record({ kind: "lookup-execute", callId, args, answer,
          agentId: context.agentId, sessionId: context.sessionId, sessionKey: context.sessionKey,
          workspaceDir: context.workspaceDir, agentDir: context.agentDir,
          senderIsOwner: context.senderIsOwner, metadata: getPluginToolMeta(tool),
          credentialAvailable: true, signalAvailable: !!signal });
        return {
          content: [{ type: "text", text: answer }],
          details: { privateMarker: config.detailsToken, credential: config.apiKey },
        };
      },
    };
    return tool;
  }, { name: LOOKUP_TOOL });

  for (const phase of ["before_tool_call", "after_tool_call"]) {
    api.on(phase, (event, context) => {
      if (!["web_search", LOOKUP_TOOL].includes(event.toolName)) return;
      record({ kind: phase, toolName: event.toolName, callId: event.toolCallId ?? context.toolCallId,
        args: event.params, agentId: context.agentId, sessionKey: context.sessionKey,
        sessionId: context.sessionId, runId: context.runId ?? event.runId,
        toolKind: context.toolKind, requester: context.requester,
        ...(phase === "after_tool_call" ? {
          failed: !!event.error,
          sawPrivateDetails: event.result?.details?.privateMarker === config.detailsToken,
        } : {}) });
    });
  }
  record({ kind: "registered", pluginId: api.id, providerId: HOST_SEARCH_PROVIDER_ID,
    toolNames: [LOOKUP_TOOL] });
}

export async function createHostSearchFixture(root, host) {
  const plugin = join(root, "host-search-plugin");
  await mkdir(join(plugin, "node_modules"), { recursive: true });
  await symlink(host, join(plugin, "node_modules", "openclaw"), "junction");
  await cp(fileURLToPath(import.meta.url), join(plugin, "fixture.mjs"));
  await writeFile(join(plugin, "package.json"), JSON.stringify({
    name: HOST_SEARCH_PLUGIN_ID, version: "0.0.0", type: "module",
    openclaw: { extensions: ["./index.mjs"] },
  }));
  await writeFile(join(plugin, "openclaw.plugin.json"), JSON.stringify(HOST_SEARCH_MANIFEST));
  await writeFile(join(plugin, "index.mjs"), `
import { buildJsonPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { HOST_SEARCH_PLUGIN_ID, HOST_SEARCH_MANIFEST, registerHostSearchPlugin } from "./fixture.mjs";
export default definePluginEntry({
  id: HOST_SEARCH_PLUGIN_ID,
  name: "Private Dashboard search fixture",
  description: "Offline provider and ordinary tool for host integration tests.",
  configSchema: buildJsonPluginConfigSchema(HOST_SEARCH_MANIFEST.configSchema),
  register: registerHostSearchPlugin,
});
`);
  const apiKey = `fixture-only-search-secret-${randomUUID()}`;
  const detailsToken = `fixture-only-details-secret-${randomUUID()}`;
  return {
    plugin,
    config: { apiKey, detailsToken },
    async readRecords() {
      const contents = await readFile(join(plugin, "host-events.jsonl"), "utf8").catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return "";
      });
      return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}
