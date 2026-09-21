import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { patchHost } from "../host-patch/group-readonly/apply.mjs";
import { edits, helper, transform } from "../host-patch/group-readonly/spec.mjs";

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const host = join(project, "node_modules", "openclaw");
const edit = edits[0];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const decide = new Function("resolveDshReadOnlyAgentConfig", "dshSessionNamesGroup", `${helper}; return isDshReadOnlyGroup;`)(
  (config, id) => config.agents.entries[id],
  (sessionKey) => sessionKey?.includes(":feishu:group:") === true,
);
const options = { config: { agents: { entries: { scoped: { runtime: { type: "embedded", harness: "dsh-native" } } } } },
  messageProvider: "feishu", sessionKey: "agent:scoped:feishu:group:test-room" };
const profile = { policy: { agentId: "scoped", trustedGroup: { groupId: "test-room", dropped: false },
  groupPolicy: { allow: ["read", "message"] } } };

test("only an existing trusted exact read/private-reply group ceiling selects extra containment", () => {
  assert.equal(decide(options, profile), true);
  for (const allow of [undefined, [], ["*"], ["read", "exec"], ["read", "write"]]) {
    assert.equal(decide(options, { policy: { ...profile.policy, groupPolicy: { allow } } }), false);
  }
  assert.equal(decide(options, { policy: { ...profile.policy, groupPolicy: { allow: ["read"], alsoAllow: ["exec"] } } }), false);
  assert.equal(decide(options, { policy: { ...profile.policy, trustedGroup: {} } }), true);
  assert.equal(decide({ ...options, sessionKey: "agent:scoped:main" }, profile), false);
  assert.equal(decide({ ...options, messageProvider: "webchat" }, profile), false);
  assert.equal(decide({ ...options, config: { agents: { entries: { scoped: { runtime: { type: "embedded", harness: "openclaw" } } } } } }, profile), false);
});

test("exact companion apply/restore is reversible and preserves the installed SDK", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dsh-readonly-patch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.9.2" }));
  await cp(join(host, ...edit.file.split("/")), join(root, ...edit.file.split("/")));
  assert.equal((await patchHost(root)).status, "unpatched");
  await assert.rejects(patchHost(root, { action: "apply" }), /offline-confirmed/);
  assert.equal((await patchHost(root, { action: "apply", offlineConfirmed: true })).status, "applied");
  assert.equal((await patchHost(root, { action: "restore", offlineConfirmed: true })).status, "unpatched");
  assert.equal(hash(await readFile(join(root, ...edit.file.split("/")))), edit.sha256);
  assert.equal(hash(await readFile(join(host, ...edit.file.split("/")))), edit.sha256);
});

test("genuine core construction enforces group workspace reads before execution", { timeout: 120000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dsh-group-readonly-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const insideFile = join(workspace, "inside.txt"), outsideFile = join(root, "outside.txt");
  await writeFile(insideFile, "SYNTHETIC-IN-WORKSPACE");
  await writeFile(outsideFile, "SYNTHETIC-OUTSIDE");
  const envBefore = {};
  for (const [key, value] of Object.entries({
    OPENCLAW_STATE_DIR: join(root, "state"), OPENCLAW_CONFIG_PATH: join(root, "absent.json"),
    OPENCLAW_LOG_LEVEL: "silent",
  })) {
    envBefore[key] = process.env[key]; process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(envBefore)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const moduleUrl = pathToFileURL(realpathSync(join(host, ...edit.file.split("/")))).href;
  const hooks = registerHooks({ load(url, context, next) {
    if (url !== moduleUrl) return next(url, context);
    const text = readFileSync(new URL(url), "utf8");
    assert.equal(hash(text), edit.sha256);
    return { format: "module", shortCircuit: true, source: transform(text, edit) };
  } });
  t.after(() => hooks.deregister());
  const { createOpenClawCodingTools } = await import("openclaw/plugin-sdk/agent-harness");
  const load = (file) => import(pathToFileURL(join(host, "dist", file)));
  const [{ t: empty }, registry] = await Promise.all([load("registry-empty-55wlVNzO.js"), load("runtime-BL4wZfTq.js")]);
  const previous = registry.n();
  const plugins = empty();
  plugins.channels.push({ pluginId: "fixture-feishu", plugin: {
    id: "feishu", meta: { label: "Isolated fixture" },
    groups: { resolveToolPolicy: ({ cfg, groupId }) => cfg.channels.feishu.groups[groupId]?.tools },
  } });
  registry.k(plugins, "dsh-group-readonly-fixture", "default", project);
  t.after(() => registry.E(previous));
  const config = { agents: { defaults: { workspace }, entries: {
    scoped: { workspace, runtime: { type: "embedded", harness: "dsh-native" } },
  } }, channels: { feishu: { groups: { "test-room": { tools: { allow: ["read", "message"] } } } } } };
  const base = { config, agentId: "scoped", policyAgentId: "scoped", workspaceDir: workspace, cwd: workspace,
    messageProvider: "feishu", chatType: "group", sessionId: "synthetic-session", runId: "synthetic-run",
    sessionKey: "agent:scoped:feishu:group:test-room", groupId: "test-room", disableMessageTool: true,
    includePluginTools: false, wrapBeforeToolCallHook: false,
    toolConstructionPlan: { includeBaseCodingTools: true, includeShellTools: false, includeOpenClawTools: false,
      includeChannelTools: false, includePluginTools: false } };
  const tools = createOpenClawCodingTools(base);
  assert.deepEqual(tools.map((tool) => tool.name), ["read"]);
  const read = tools[0];
  const result = await read.execute("inside", { path: insideFile });
  assert.ok(JSON.stringify(result).includes("SYNTHETIC-IN-WORKSPACE"));
  await assert.rejects(read.execute("outside", { path: outsideFile }), /workspace|outside|escape|sandbox/i);
  await assert.rejects(read.execute("traversal", { path: "../outside.txt" }), /workspace|outside|escape|sandbox/i);
  const inferred = createOpenClawCodingTools({ ...base, groupId: undefined });
  assert.deepEqual(inferred.map((tool) => tool.name), ["read"]);
  await assert.rejects(inferred[0].execute("inferred-outside", { path: outsideFile }), /workspace|outside|escape|sandbox/i);
  const other = createOpenClawCodingTools({ ...base,
    sessionKey: "agent:scoped:feishu:group:other-room", groupId: "other-room" });
  assert.ok(other.some((tool) => tool.name === "write"));
  const outside = await other.find((tool) => tool.name === "read").execute("unrestricted", { path: outsideFile });
  assert.ok(JSON.stringify(outside).includes("SYNTHETIC-OUTSIDE"));
});
