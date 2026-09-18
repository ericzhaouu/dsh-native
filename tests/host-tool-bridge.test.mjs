import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import ts from "typescript";

const sourceModules = new Map(["native/host", "native/tool-bridge", "preparation"].map((name) => [
  new URL(`../dist/${name}.js`, import.meta.url).href,
  new URL(`../src/${name}.ts`, import.meta.url),
]));
const sourceHooks = registerHooks({
  resolve(specifier, context, next) {
    const url = context.parentURL && new URL(specifier, context.parentURL).href;
    return sourceModules.has(url) ? { url, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return sourceModules.has(url) ? { format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(sourceModules.get(url), "utf8"),
        { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText } : next(url, context);
  },
});
const { createNativeToolHost, projectNativeToolResult } = await import("../dist/native/host.js");
const { resolveHostToolAllowlist, buildHostToolNotices, renderHostToolNotices, snapshotHostToolSource } =
  await import("../dist/native/tool-bridge.js");
sourceHooks.deregister();

const schema = { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false };
const signal = () => new AbortController().signal;
const call = (name, callId = "one", args = { query: "test" }) => ({ name, callId, arguments: args });
const text = (value = "ok") => ({ content: [{ type: "text", text: value }] });
const tool = (name, fields = {}) => ({ name, label: name, description: name, parameters: schema,
  execute: async () => text(), ...fields });

function fixture(tools, toolAllowlist, options = {}) {
  const pluginMeta = new WeakMap(tools.filter((t) => t.plugin).map((t) => [t, t.plugin]));
  const channelMeta = new WeakMap(tools.filter((t) => t.channel).map((t) => [t, t.channel]));
  const replaySafe = new WeakSet(options.replaySafe ?? []);
  const wrapped = new WeakSet(options.alreadyWrapped ?? []);
  const adjusted = new Map();
  const blocked = new Set();
  const before = [];
  const after = [];
  const terminal = [];
  const results = [];
  const classified = [];
  const runtime = {
    getPluginToolMeta: (t) => pluginMeta.get(t),
    getChannelAgentToolMeta: (t) => channelMeta.get(t),
    isAgentToolReplaySafe: (t) => { classified.push(t); return replaySafe.has(t); },
    isToolWrappedWithBeforeToolCallHook: (t) => wrapped.has(t),
    isHostScopedAgentToolActive: (name) => options.hostScoped?.includes(name) ?? false,
    consumeAdjustedParamsForToolCall: (id) => { const args = adjusted.get(id); adjusted.delete(id); return args; },
    consumePreExecutionBlockedToolCall: (id) => blocked.delete(id),
    runAgentHarnessAfterToolCallHook: async (event) => { after.push(event); },
    isToolResultError: (result) => result?.isError === true || result?.details?.status === "error",
    formatToolExecutionErrorMessage: (error) => error.message,
    getBeforeToolCallFailureDisposition: (error) => error?.disposition,
  };
  let bound;
  const host = createNativeToolHost({
    tools, toolAllowlist, runtime, signal: signal(), assertActive() {}, cwd: process.cwd(),
    runId: "run", sessionId: "session",
    observeToolTerminal: (event) => terminal.push(event),
    onAgentToolResult: (event) => results.push(event),
    bindToolSurface(surface) {
      bound = surface.map((source) => {
        const result = { ...source, execute: async (id, args, abort) => {
          before.push({ name: source.name, plugin: runtime.getPluginToolMeta(result), channel: runtime.getChannelAgentToolMeta(result) });
          if (options.block) {
            blocked.add(id);
            return { ...text("host policy blocked"), isError: true };
          }
          const rewritten = options.rewrite ? options.rewrite(args, source) : args;
          adjusted.set(id, rewritten);
          return source.execute(id, rewritten, abort);
        } };
        if (pluginMeta.has(source)) pluginMeta.set(result, pluginMeta.get(source));
        if (channelMeta.has(source)) channelMeta.set(result, channelMeta.get(source));
        wrapped.add(result);
        return result;
      });
      return bound;
    },
    ...options.host,
  });
  return { host, runtime, before, after, terminal, results, classified, bound, pluginMeta, channelMeta };
}

test("generic core web callbacks are exact-selected; unlisted factories are never bound or instrumented", async () => {
  const search = tool("web_search");
  const fetch = tool("web_fetch");
  const exec = tool("exec");
  const originalExec = exec.execute;
  const originalFetch = fetch.execute;
  const f = fixture([search, fetch, exec], ["web_search"]);
  assert.deepEqual(f.host.tools.map((t) => t.name), ["web_search"]);
  assert.deepEqual(f.bound.map((t) => t.name), ["web_search"]);
  assert.equal(exec.execute, originalExec);
  assert.equal(fetch.execute, originalFetch);
  assert.deepEqual(f.host.toolNotices, []);
  assert.deepEqual(await f.host.executeTool(call("web_search"), signal()), { text: "ok", isError: false });
  await assert.rejects(f.host.executeTool(call("web_fetch", "not-listed"), signal()), /unavailable/);
  assert.deepEqual(f.classified, [search]);
  assert.deepEqual(f.host.getReplayState(), { hadPotentialSideEffects: true, replaySafe: false });
  await f.host.dispose();
});

test("real public SDK planner preserves web/plugin families and metadata-aware allow ceilings", async () => {
  const sdk = await import("openclaw/plugin-sdk/agent-harness-runtime");
  const web = sdk.resolveEmbeddedAttemptToolConstructionPlan({ toolsEnabled: true, toolsAllow: ["web_search", "web_fetch"] });
  assert.equal(web.constructTools, true);
  assert.equal(web.includeCoreTools, true);
  assert.deepEqual(web.codingToolConstructionPlan, {
    includeBaseCodingTools: false, includeShellTools: false, includeOpenClawTools: true,
    includePluginTools: false, includeChannelTools: false,
  });
  const plugin = sdk.resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow: ["lookup"] });
  assert.equal(plugin.includeCoreTools, false);
  assert.equal(plugin.codingToolConstructionPlan.includePluginTools, true);
  assert.equal(plugin.codingToolConstructionPlan.includeChannelTools, true);
  assert.equal(sdk.resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow: [] }).constructTools, false);
  const ordinary = tool("lookup", { plugin: { pluginId: "ordinary" } });
  const others = [tool("read"), tool("web_search"), ordinary];
  assert.deepEqual(sdk.applyEmbeddedAttemptToolsAllow(others, ["ordinary"], { toolMeta: (t) => t.plugin }), [ordinary]);
  assert.deepEqual(sdk.applyEmbeddedAttemptToolsAllow(others, ["group:plugins"], { toolMeta: (t) => t.plugin }), [ordinary]);
});

test("ordinary plugin and channel callbacks preserve instance metadata, raw results and exact-instance replay safety", async () => {
  const raw = { content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
    details: { private: "DETAIL-SECRET" }, structuredContent: { private: "STRUCTURED-SECRET" }, _meta: { token: "META-SECRET" } };
  const plugin = tool("lookup", { plugin: { pluginId: "ordinary", optional: true, replaySafe: true }, execute: async () => raw });
  const channel = tool("team_status", { channel: { channelId: "teams" } });
  const f = fixture([plugin, channel], ["lookup", "team_status"], { replaySafe: [plugin, channel],
    rewrite: () => ({ query: "rewritten" }) });
  const result = await f.host.executeTool(call("lookup"), signal());
  assert.deepEqual(result, { text: "first\nsecond", isError: false });
  assert.doesNotMatch(JSON.stringify(result), /SECRET|details|structuredContent|_meta/);
  assert.equal(f.results[0].result, raw);
  assert.equal(f.after[0].result, raw);
  assert.deepEqual(f.after[0].startArgs, { query: "rewritten" });
  assert.equal(f.before[0].plugin, plugin.plugin);
  await f.host.executeTool(call("team_status", "channel"), signal());
  assert.equal(f.before[1].channel, channel.channel);
  assert.deepEqual(f.classified, [plugin, channel]);
  assert.deepEqual(f.host.getToolCounts(), { startedCount: 2, completedCount: 2, activeCount: 0 });
  assert.deepEqual(f.host.getReplayState(), { hadPotentialSideEffects: false, replaySafe: true });
  await f.host.dispose();
});

test("execution ceiling hides generic tools before advertisement while empty DSH list grants nothing", async () => {
  const f = fixture([tool("web_search"), tool("lookup")], ["web_search", "lookup", "missing"], {
    host: { toolExecutionAllow: ["web_search"] },
  });
  assert.deepEqual(f.host.tools.map((t) => t.name), ["web_search"]);
  assert.deepEqual(f.host.toolNotices, [
    { name: "lookup", reason: "unavailable-or-denied" }, { name: "missing", reason: "unavailable-or-denied" },
  ]);
  await assert.rejects(f.host.executeTool(call("lookup"), signal()), /unavailable/);
  const none = fixture([tool("web_search")], []);
  assert.deepEqual(none.host.tools, []);
  assert.deepEqual(none.host.toolNotices, []);
  await f.host.dispose();
  await none.host.dispose();
});

test("legacy default remains core coding only and explicit lists never expand aliases or wildcards", () => {
  assert.throws(() => fixture([tool("web_search")], undefined), /Unsupported/);
  assert.throws(() => fixture([tool("lookup", { plugin: { pluginId: "ordinary" } })], undefined), /Unsupported/);
  const f = fixture([tool("web_search"), tool("lookup")], ["*", "group:web", "WEB_SEARCH", "ordinary"]);
  assert.deepEqual(f.host.tools, []);
  assert.equal(f.host.toolNotices.length, 4);
  assert.equal(f.host.toolNotices[0].reason, "unsupported");
  assert.deepEqual(resolveHostToolAllowlist(undefined, ["read", "write"]), undefined);
  assert.deepEqual(resolveHostToolAllowlist(undefined, ["read", "web_search"]), ["read", "web_search"]);
  assert.deepEqual(resolveHostToolAllowlist([], ["web_search"]), []);
  assert.deepEqual(resolveHostToolAllowlist(["lookup"], ["read"]), ["lookup"]);
});

test("unsupported context tools and unavailable names are omitted with bounded nonsecret notices", async () => {
  const names = ["message", "heartbeat_respond", "cron", "automations", "sessions_spawn", "sessions_send",
    "sessions_yield", "sessions", "steering", "subagents", "ask_user", "browser", "computer", "view_image",
    "image_generate", "tts", "pdf", "tool_search", "tool_search_code", "tool_call", "tool_describe",
    "tool_execute", "code_mode", "code_mode_exec", "wait"];
  const f = fixture([...names.map((name) => tool(name)), tool("ordinary")], [...names, "not_installed_or_denied", "ordinary"]);
  assert.deepEqual(f.host.tools.map((t) => t.name), ["ordinary"]);
  assert.deepEqual(f.host.toolNotices.filter((n) => n.reason === "unsupported").map((n) => n.name), names);
  assert.deepEqual(f.host.toolNotices.at(-1), { name: "not_installed_or_denied", reason: "unavailable-or-denied" });
  const bounded = buildHostToolNotices(["unsafe\nSECRET", ...Array.from({ length: 200 }, (_, i) => `tool_${i}`)], []);
  assert.equal(bounded.length, 64);
  assert.doesNotMatch(JSON.stringify(bounded), /SECRET/);
  const rendered = renderHostToolNotices([{ name: "feishu", reason: "unavailable-or-denied" }]);
  assert.match(rendered, /do not claim CLI or alternate dispatch is authorized/);
  assert.match(rendered, /existing host-authorized CLI/);
  assert.match(rendered, /explicit denial/);
  await f.host.dispose();
});

test("incompatible schemas and already-bound instances are omitted, never unwrapped", async () => {
  const cyclic = { type: "object" };
  cyclic.self = cyclic;
  const bad = [
    tool("string_schema", { parameters: { type: "string" } }),
    tool("async_schema", { parameters: { type: "object", $async: true } }),
    tool("cyclic_schema", { parameters: cyclic }),
    tool("function_schema", { parameters: { type: "object", default: () => "private" } }),
    tool("invalid_constraint", { parameters: { type: "object", properties: { query: { type: "string", minLength: "invalid" } } } }),
    tool("custom_router", { plugin: { pluginId: "router", kind: "code-mode" } }),
    tool("no_execute", { execute: undefined }),
    Object.freeze(tool("frozen")),
  ];
  const wrapped = tool("bound_lookup");
  const original = wrapped.execute;
  const all = [...bad, wrapped, tool("ordinary")];
  const f = fixture(all, all.map((t) => t.name), { alreadyWrapped: [wrapped] });
  assert.deepEqual(f.host.tools.map((t) => t.name), ["ordinary"]);
  assert.equal(wrapped.execute, original);
  assert.equal(f.host.toolNotices.length, bad.length + 1);
  assert.ok(f.host.toolNotices.every((n) => n.reason === "unsupported"));
  await f.host.dispose();
});

test("host-scoped ring-zero dispatchers cannot masquerade as ordinary policy-filtered tools", async () => {
  const f = fixture([tool("exec"), tool("lookup"), tool("web_search")], ["exec", "lookup", "web_search"],
    { hostScoped: ["exec", "lookup"] });
  assert.deepEqual(f.host.tools.map((t) => t.name), ["web_search"]);
  assert.deepEqual(f.host.toolNotices, [
    { name: "exec", reason: "unsupported" }, { name: "lookup", reason: "unsupported" },
  ]);
  await f.host.dispose();
});

test("duplicate names, duplicate MCP source IDs and coding-name plugin/channel shadows are ambiguous", async () => {
  const mcp = { serverName: "server", safeServerName: "server", toolName: "lookup", operation: "tool" };
  const tools = [
    tool("duplicate"), tool("duplicate", { plugin: { pluginId: "other" } }),
    tool("mcp_alias_a", { plugin: { pluginId: "mcp", mcp } }),
    tool("mcp_alias_b", { plugin: { pluginId: "mcp", mcp: { ...mcp } } }),
    tool("read", { plugin: { pluginId: "shadow" } }),
    tool("write", { channel: { channelId: "shadow" } }),
    tool("both", { plugin: { pluginId: "p" }, channel: { channelId: "c" } }),
    tool("ordinary"),
  ];
  const f = fixture(tools, tools.map((t) => t.name));
  assert.deepEqual(f.host.tools.map((t) => t.name), ["ordinary"]);
  assert.ok(f.host.toolNotices.every((n) => n.reason === "ambiguous"));
  const coreAndShadow = fixture([tool("read"), tool("read", { plugin: { pluginId: "shadow" } })], ["read"]);
  assert.deepEqual(coreAndShadow.host.tools, []);
  assert.deepEqual(coreAndShadow.host.toolNotices, [{ name: "read", reason: "ambiguous" }]);
  await f.host.dispose();
  await coreAndShadow.host.dispose();
});

test("an MCP-backed instance already supplied by the constructor uses only its existing execute callback", async () => {
  let invoked = 0;
  const live = tool("server__lookup", {
    plugin: { pluginId: "host-mcp", optional: true,
      mcp: { serverName: "server", safeServerName: "server", toolName: "lookup", operation: "tool" } },
    execute: async () => { invoked++; return text("host-owned result"); },
  });
  const f = fixture([live], ["server__lookup", "unmaterialized__lookup"]);
  assert.equal((await f.host.executeTool(call("server__lookup"), signal())).text, "host-owned result");
  assert.equal(invoked, 1);
  assert.deepEqual(f.host.toolNotices, [{ name: "unmaterialized__lookup", reason: "unavailable-or-denied" }]);
  await f.host.dispose();
});

test("generic arguments are strict before hooks and after rewrites; blocked calls never start", async () => {
  let executions = 0;
  const make = () => tool("lookup", { plugin: { pluginId: "p" }, execute: async () => { executions++; return text(); } });
  const f = fixture([make()], ["lookup"], { rewrite: () => ({ query: 1 }) });
  await assert.rejects(f.host.executeTool(call("lookup", "invalid", { query: 1 }), signal()), /Invalid arguments/);
  await assert.rejects(f.host.executeTool(call("lookup", "extra", { query: "x", other: true }), signal()), /Invalid arguments/);
  assert.equal(f.before.length, 0);
  const rewritten = await f.host.executeTool(call("lookup", "rewritten"), signal());
  assert.equal(rewritten.isError, true);
  assert.match(rewritten.text, /Invalid arguments/);
  assert.equal(f.terminal[0].executionStarted, false);
  const blocked = fixture([make()], ["lookup"], { block: true });
  assert.equal((await blocked.host.executeTool(call("lookup"), signal())).isError, true);
  assert.equal(blocked.before.length, 1);
  assert.equal(blocked.after.length, 1);
  assert.equal(executions, 0);
  assert.equal(blocked.host.getReplayState().replaySafe, true);
  await f.host.dispose();
  await blocked.host.dispose();
});

test("source identity and nested plugin metadata changes during hooks prevent actual dispatch", async () => {
  const changes = [
    (t) => { t.plugin.pluginId = "replacement"; },
    (t) => { t.plugin.replaySafe = true; },
    (t) => { t.plugin.mcp.toolName = "replacement"; },
    (t) => { t.name = "replacement"; },
    (t) => { t.channel.channelId = "replacement"; },
  ];
  for (const change of changes) {
    let executions = 0;
    const target = tool("lookup", {
      ...(change === changes.at(-1) ? { channel: { channelId: "channel" } } : { plugin: {
        pluginId: "p", replaySafe: false, mcp: { serverName: "server", toolName: "lookup", operation: "tool" },
      } }),
      execute: async () => { executions++; return text(); },
    });
    const f = fixture([target], ["lookup"], { rewrite: (args, source) => { change(source); return args; } });
    const result = await f.host.executeTool(call("lookup"), signal());
    assert.deepEqual(result, { text: "Host tool source identity changed", isError: true });
    assert.equal(executions, 0);
    assert.equal(f.host.getToolCounts().startedCount, 0);
    assert.equal(f.terminal[0].executionStarted, false);
    await f.host.dispose();
  }
});

test("saved pre-prompt source snapshots cannot be replaced by changed metadata at binding", () => {
  const original = tool("lookup", { plugin: { pluginId: "original" } });
  const runtime = { getPluginToolMeta: (t) => t.plugin, getChannelAgentToolMeta: () => undefined };
  const source = snapshotHostToolSource(original, runtime);
  original.plugin.pluginId = "changed-during-prompt";
  assert.throws(() => fixture([original], ["lookup"], { host: { toolSources: new Map([[original, source]]) } }), /source identity changed/);
});

test("replacing ownership metadata or adding plugin ownership to a core tool fails before hooks", async () => {
  for (const target of [tool("web_search"), tool("lookup", { plugin: { pluginId: "original" } })]) {
    const f = fixture([target], [target.name]);
    f.pluginMeta.set(target, target.plugin ? { ...target.plugin } : { pluginId: "replacement" });
    await assert.rejects(f.host.executeTool(call(target.name), signal()), /source identity changed/);
    assert.equal(f.before.length, 0);
    assert.equal(f.host.getToolCounts().startedCount, 0);
    await f.host.dispose();
  }
});

test("read is not assumed replay-safe and media errors preserve raw results without structured leaks", async () => {
  const raw = { content: [{ type: "text", text: "visible" }, { type: "image", data: "IMAGE-SECRET" }],
    details: { private: "DETAIL-SECRET" }, _meta: { private: "META-SECRET" } };
  const f = fixture([tool("read", { execute: async () => raw })], ["read"]);
  const result = await f.host.executeTool(call("read"), signal());
  assert.equal(result.isError, true);
  assert.match(result.text, /cannot deliver non-text/);
  assert.doesNotMatch(result.text, /SECRET/);
  assert.equal(f.results[0].result, raw);
  assert.equal(f.after[0].result, raw);
  assert.equal(f.host.getReplayState().hadPotentialSideEffects, true);
  assert.deepEqual(projectNativeToolResult({ structuredContent: { private: "SECRET" } }, false),
    { text: "Host tool returned an invalid result.", isError: true });
  await f.host.dispose();
});

test("generic cancellation propagates and cleanup drains pending original execution exactly once", async () => {
  let finish;
  let executionSignal;
  let cleanups = 0;
  const target = tool("lookup", { plugin: { pluginId: "p" }, execute: async (_id, _args, sig) => {
    executionSignal = sig;
    return new Promise((resolve) => { finish = resolve; });
  } });
  const f = fixture([target], ["lookup"], { replaySafe: [target],
    host: { cleanups: [async () => { cleanups++; }, async () => { cleanups++; }] } });
  const work = f.host.executeTool(call("lookup"), signal());
  const rejected = assert.rejects(work, /disposed/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.host.getReplayState().replaySafe, false);
  const disposal = f.host.dispose();
  assert.equal(f.host.dispose(), disposal);
  assert.equal(executionSignal.aborted, true);
  assert.equal(cleanups, 0);
  finish(text("completed-after-abort"));
  await rejected;
  await disposal;
  assert.equal(cleanups, 2);
  assert.equal(f.results[0].result.content[0].text, "completed-after-abort");
  assert.deepEqual(f.host.getToolCounts(), { startedCount: 1, completedCount: 1, activeCount: 0 });
  assert.equal(f.host.getReplayState().replaySafe, false);
});
