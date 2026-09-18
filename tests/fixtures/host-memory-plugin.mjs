import { appendFileSync } from "node:fs";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_MEMORY_PLUGIN_ID = "dsh-host-memory-fixture";
export const MEMORY_PATH = "memory/fixture.md";
export const MEMORY_MARKER = "DSH-MEMORY-MAINTENANCE-FIXTURE";

export function registerHostMemoryPlugin(api) {
  const record = (event) => appendFileSync(join(dirname(fileURLToPath(import.meta.url)), "events.jsonl"),
    `${JSON.stringify(event)}\n`);
  api.registerMemoryCapability({
    flushPlanResolver: () => ({
      softThresholdTokens: 50000,
      forceFlushTranscriptBytes: Number.MAX_SAFE_INTEGER,
      reserveTokensFloor: 20000,
      relativePath: MEMORY_PATH,
      prompt: `${MEMORY_MARKER}: retain the fixture constraint using the exact append-only memory target; do not replay business actions. Finish with NO_REPLY.`,
      systemPrompt: "Private offline memory fixture. Use only host-authorized memory callbacks.",
    }),
  });
  api.on("after_tool_call", (event, context) => {
    record({ kind: "tool", name: event.toolName, args: event.params,
      runId: context.runId ?? event.runId, error: !!event.error });
  });
}

export async function createHostMemoryFixture(root, host) {
  const plugin = join(root, "host-memory-plugin");
  await mkdir(join(plugin, "node_modules"), { recursive: true });
  await symlink(host, join(plugin, "node_modules", "openclaw"), "junction");
  await cp(fileURLToPath(import.meta.url), join(plugin, "fixture.mjs"));
  await writeFile(join(plugin, "package.json"), JSON.stringify({
    name: HOST_MEMORY_PLUGIN_ID, version: "0.0.0", type: "module",
    openclaw: { extensions: ["./index.mjs"] },
  }));
  await writeFile(join(plugin, "openclaw.plugin.json"), JSON.stringify({
    id: HOST_MEMORY_PLUGIN_ID, kind: "memory", activation: { onStartup: true },
    configSchema: { type: "object", properties: {}, additionalProperties: false },
  }));
  await writeFile(join(plugin, "index.mjs"), `
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { HOST_MEMORY_PLUGIN_ID, registerHostMemoryPlugin } from "./fixture.mjs";
export default definePluginEntry({
  id: HOST_MEMORY_PLUGIN_ID, name: "Offline host memory fixture", kind: "memory",
  register: registerHostMemoryPlugin,
});
`);
  return {
    plugin,
    async readRecords() {
      let text;
      try { text = await readFile(join(plugin, "events.jsonl"), "utf8"); }
      catch (error) { if (error.code !== "ENOENT") throw error; return []; }
      return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}
