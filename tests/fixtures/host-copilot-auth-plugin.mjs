import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_COPILOT_AUTH_PLUGIN_ID = "github-copilot";
export const HOST_COPILOT_AUTH_PROVIDER_ID = "github-copilot";
export const HOST_COPILOT_AUTH_SOURCE_KEY = "fixture-source-key";

export const HOST_COPILOT_AUTH_HEADERS = {
  "Copilot-Integration-Id": "copilot-developer-cli",
  "Editor-Version": "dsh-native-fixture/0.0.0",
};

export const HOST_COPILOT_AUTH_MANIFEST = {
  id: HOST_COPILOT_AUTH_PLUGIN_ID,
  activation: { onStartup: true },
  providers: [HOST_COPILOT_AUTH_PROVIDER_ID],
  configSchema: {
    type: "object",
    additionalProperties: false,
    required: ["accountBaseUrl", "configuredBaseUrl", "authProfile"],
    properties: {
      accountBaseUrl: { type: "string" },
      configuredBaseUrl: { type: "string" },
      authProfile: { type: "string" },
    },
  },
};

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function record(event) {
  appendFileSync(join(dirname(fileURLToPath(import.meta.url)), "host-copilot-auth-events.jsonl"),
    `${JSON.stringify({ ...event, pid: process.pid })}\n`);
}

export function registerHostCopilotAuthPlugin(api) {
  const config = api.pluginConfig;
  assert.equal(typeof config?.accountBaseUrl, "string");
  assert.equal(typeof config?.configuredBaseUrl, "string");
  assert.equal(typeof config?.authProfile, "string");

  api.registerProvider({
    id: HOST_COPILOT_AUTH_PROVIDER_ID,
    label: "Offline Copilot auth fixture",
    envVars: [],
    auth: [{
      id: "fixture-token",
      label: "Fixture source token",
      hint: "Offline source credential only",
      kind: "token",
      starterModel: "gpt-6-astra",
      run: async () => ({
        provider: HOST_COPILOT_AUTH_PROVIDER_ID,
        mode: "token",
        token: HOST_COPILOT_AUTH_SOURCE_KEY,
      }),
    }],
    prepareRuntimeAuth: async (ctx) => {
      assert.equal(ctx.provider, HOST_COPILOT_AUTH_PROVIDER_ID);
      assert.equal(ctx.apiKey, HOST_COPILOT_AUTH_SOURCE_KEY);
      assert.equal(ctx.model?.baseUrl, config.configuredBaseUrl);
      const derived = `fixture-derived-runtime-${randomUUID()}`;
      record({
        kind: "prepare-runtime-auth",
        provider: ctx.provider,
        modelId: ctx.modelId,
        modelBaseUrl: ctx.model?.baseUrl,
        accountBaseUrl: config.accountBaseUrl,
        configuredBaseUrl: config.configuredBaseUrl,
        authMode: ctx.authMode,
        profileId: ctx.profileId,
        fixtureAuthProfile: config.authProfile,
        agentDirHash: ctx.agentDir ? hash(ctx.agentDir) : undefined,
        workspaceDirHash: ctx.workspaceDir ? hash(ctx.workspaceDir) : undefined,
        sourceKeyHash: hash(ctx.apiKey),
        derivedKeyHash: hash(derived),
      });
      return {
        apiKey: derived,
        baseUrl: config.accountBaseUrl,
        request: { headers: HOST_COPILOT_AUTH_HEADERS },
        expiresAt: Date.now() + 3_600_000,
      };
    },
  });

  record({ kind: "registered", pluginId: api.id, providerId: HOST_COPILOT_AUTH_PROVIDER_ID });
}

export async function createHostCopilotAuthFixture(root, host, { accountBaseUrl, configuredBaseUrl } = {}) {
  assert.equal(typeof accountBaseUrl, "string");
  assert.equal(typeof configuredBaseUrl, "string");
  assert.notEqual(accountBaseUrl, configuredBaseUrl);
  const plugin = join(root, "host-copilot-auth-plugin");
  await mkdir(join(plugin, "node_modules"), { recursive: true });
  await symlink(host, join(plugin, "node_modules", "openclaw"), "junction");
  await cp(fileURLToPath(import.meta.url), join(plugin, "fixture.mjs"));
  await writeFile(join(plugin, "package.json"), JSON.stringify({
    name: HOST_COPILOT_AUTH_PLUGIN_ID, version: "0.0.0", type: "module",
    openclaw: { extensions: ["./index.mjs"] },
  }));
  await writeFile(join(plugin, "openclaw.plugin.json"), JSON.stringify(HOST_COPILOT_AUTH_MANIFEST));
  await writeFile(join(plugin, "index.mjs"), `
import { buildJsonPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { HOST_COPILOT_AUTH_PLUGIN_ID, HOST_COPILOT_AUTH_MANIFEST, registerHostCopilotAuthPlugin } from "./fixture.mjs";
export default definePluginEntry({
  id: HOST_COPILOT_AUTH_PLUGIN_ID,
  name: "Dashboard Copilot auth fixture",
  description: "Offline GitHub Copilot provider prepareRuntimeAuth fixture.",
  configSchema: buildJsonPluginConfigSchema(HOST_COPILOT_AUTH_MANIFEST.configSchema),
  register: registerHostCopilotAuthPlugin,
});
`);
  return {
    plugin,
    config: {
      accountBaseUrl,
      configuredBaseUrl,
      authProfile: "fixture-copilot-profile",
    },
    sourceKey: HOST_COPILOT_AUTH_SOURCE_KEY,
    sourceKeyHash: hash(HOST_COPILOT_AUTH_SOURCE_KEY),
    headers: HOST_COPILOT_AUTH_HEADERS,
    async readRecords() {
      const contents = await readFile(join(plugin, "host-copilot-auth-events.jsonl"), "utf8").catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return "";
      });
      return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}
