import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import sqlite from "node:sqlite";
import { Ajv } from "ajv";

test("OpenClaw 2026.9.2 public SDK release smoke", { concurrency: false }, async (t) => {
  const root = fileURLToPath(new URL(`./.native-sdk-${process.pid}-${randomUUID()}/`, import.meta.url));
  const workspaceDir = join(root, "workspace");
  const agentDir = join(root, "agent");
  const stateDir = join(root, "state");
  const configPath = join(root, "openclaw.json");
  const agentId = "sdk-smoke";
  const instruction = "SDK fixture instruction: describe only the supplied project fixture.";
  const fixtureText = "Read through the genuine OpenClaw policy-wrapped coding tool.\n";
  const config = {
    agents: {
      defaults: { sandbox: { mode: "off" }, contextInjection: "always" },
      entries: { [agentId]: { workspace: workspaceDir, agentDir } },
    },
    tools: { profile: "coding", fs: { workspaceOnly: true }, exec: { host: "gateway" } },
    plugins: { enabled: false },
    logging: { level: "silent", consoleLevel: "silent", file: join(root, "sdk.log") },
    diagnostics: { enabled: false },
  };
  const environment = {
    OPENCLAW_HOME: join(root, "home"),
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_LOG_LEVEL: "silent",
  };
  const previousEnvironment = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  const guards = [];
  const databases = new Set();
  let databaseConstructor;

  await mkdir(root);
  try {
    await Promise.all([workspaceDir, agentDir, stateDir, environment.OPENCLAW_HOME].map((dir) => mkdir(dir)));
    await Promise.all([
      writeFile(join(workspaceDir, "AGENTS.md"), instruction, "utf8"),
      writeFile(join(workspaceDir, "sdk-read.txt"), fixtureText, "utf8"),
      writeFile(configPath, JSON.stringify(config), "utf8"),
    ]);
    Object.assign(process.env, environment);

    // Bootstrap inspection retains a real SQLite connection. Confine it and release
    // the public Node handle before deleting the fixture, including on Windows.
    databaseConstructor = t.mock.method(sqlite, "DatabaseSync", new Proxy(sqlite.DatabaseSync, {
      construct(Constructor, args, newTarget) {
        if (args[0] !== ":memory:") {
          const fromRoot = relative(root, args[0]);
          assert.ok(!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`),
            "SDK databases must stay inside the project-owned fixture");
        }
        const database = Reflect.construct(Constructor, args, newTarget);
        databases.add(database);
        return database;
      },
    }));

    // Guard side-effect sinks, not SDK imports, tool definitions, or the DSH runtime.
    for (const [target, names] of [
      [childProcess, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]],
      [http, ["request", "get"]],
      [https, ["request", "get"]],
      [net, ["connect", "createConnection"]],
      [tls, ["connect"]],
      [globalThis, ["fetch"]],
    ]) {
      for (const name of names) {
        guards.push(t.mock.method(target, name, () => {
          throw new Error(`SDK smoke must not perform process/network I/O: ${name}`);
        }));
      }
    }
    syncBuiltinESMExports();

    // Import after scoping paths: SDK module initialization must not use user state.
    const [sdk, scope, coding, transcript, { prepareNativeHost, assertNativeHostSupported }, { default: entry }] =
      await Promise.all([
        import("openclaw/plugin-sdk/agent-harness-runtime"),
        import("openclaw/plugin-sdk/agent-scope-runtime"),
        import("openclaw/plugin-sdk/agent-harness"),
        import("openclaw/plugin-sdk/session-transcript-runtime"),
        import("../dist/native/host.js"),
        import("../dist/index.js"),
      ]);

    await t.test("loads genuine public exports, including JS-only transcript helpers", () => {
      assert.equal(sdk.OPENCLAW_VERSION, "2026.9.2");
      assert.equal(typeof coding.createOpenClawCodingTools, "function");
      for (const name of [
        "wrapToolWithBeforeToolCallHook",
        "isToolWrappedWithBeforeToolCallHook",
        "resolveBootstrapContextForRun",
        "resolveAgentHarnessBeforePromptBuildResult",
        "runAgentHarnessBeforeMessageWriteHook",
      ]) assert.equal(typeof sdk[name], "function", name);
      // Transcript reads can open SQLite; test the public surface without opening a store.
      for (const name of [
        "readVisibleSessionTranscriptMessageEntries",
        "appendSessionTranscriptMessageByIdentityStrict",
        "publishSessionTranscriptUpdateByIdentity",
      ]) assert.equal(typeof transcript[name], "function", name);
      const key = transcript.formatSessionTranscriptMemoryHitKey({ agentId, sessionId: "sdk-session" });
      assert.equal(key, "transcript:sdk-smoke:sdk-session");
      assert.deepEqual(transcript.parseSessionTranscriptMemoryHitKey(key), { agentId, sessionId: "sdk-session", key });
      assert.equal(transcript.parseSessionTranscriptMemoryHitKey("not-a-transcript-key"), null);
      const message = { role: "user", content: "fixture", timestamp: 1 };
      assert.equal(sdk.projectAgentHarnessTranscriptMessageForDisplay({ message, hidden: false }), message);
      assert.deepEqual(sdk.projectAgentHarnessTranscriptMessageForDisplay({ message, hidden: true }), {
        ...message, display: false,
      });
      assert.equal(Object.hasOwn(message, "display"), false);
    });

    function makeAttempt(overrides = {}) {
      const controller = new AbortController();
      const binding = [];
      const terminals = [];
      const runId = randomUUID();
      const sessionId = randomUUID();
      const sessionKey = `agent:${agentId}:sdk-smoke`;
      const assertActive = () => controller.signal.throwIfAborted();
      const hookContext = { config, agentId, runId, sessionId, sessionKey, workspaceDir, cwd: workspaceDir };
      const capability = {
        kind: "agent-harness-host-capability",
        version: 1,
        assertActive,
        bindToolSurface(tools, options) {
          assertActive();
          assert.equal(options.cwd, workspaceDir);
          const wrapped = tools.map((tool) => {
            assert.equal(sdk.isToolWrappedWithBeforeToolCallHook(tool), false, tool.name);
            return sdk.wrapToolWithBeforeToolCallHook(tool, hookContext, { emitDiagnostics: false });
          });
          assert.ok(wrapped.every((tool) => sdk.isToolWrappedWithBeforeToolCallHook(tool)));
          binding.push({ tools, wrapped });
          return wrapped;
        },
        runBeforeToolCall: (request) => sdk.runBeforeToolCallHook({ ...request, ctx: hookContext }),
        requestApproval: async () => assert.fail("No approval should be requested for the fixture read"),
        waitForApproval: async () => assert.fail("No approval should be awaited for the fixture read"),
      };
      const attempt = {
        agentId, agentDir, config, runId, sessionId, sessionKey, workspaceDir,
        sessionFile: join(agentDir, `${sessionId}.jsonl`),
        agentHarnessId: "dsh-native",
        prompt: "Read sdk-read.txt without changing any files.",
        provider: "deepseek",
        modelId: "deepseek-chat",
        model: {
          id: "deepseek-chat", name: "SDK fixture", provider: "deepseek", api: "openai-completions",
          baseUrl: "https://api.deepseek.com", reasoning: false, input: ["text"],
          contextWindow: 131072, maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        authProfileStore: {
          version: 1,
          profiles: { "deepseek:sdk-smoke": { type: "api_key", provider: "deepseek", key: "fixture-not-a-credential" } },
        },
        toolsAllow: ["read", "edit", "write", "exec"],
        toolExecutionAllow: ["read"],
        timeoutMs: 10000,
        hostCapabilities: capability,
        observeToolTerminal: (event) => terminals.push(event),
        ...overrides,
      };
      hookContext.config = attempt.config;
      return { attempt, binding, terminals, assertActive, signal: controller.signal };
    }

    await t.test("resolves canonical agents.entries and rejects agent-specific unsupported placement", () => {
      assert.deepEqual(scope.listAgentIds(config), [agentId]);
      assert.equal(scope.resolveAgentConfig(config, agentId).workspace, workspaceDir);
      assert.equal(scope.resolveAgentDir(config, agentId), agentDir);
      assert.equal(sdk.resolveSessionAgentIds({ config, sessionKey: `agent:${agentId}:sdk-smoke` }).sessionAgentId, agentId);
      const { attempt } = makeAttempt();
      assert.doesNotThrow(() => assertNativeHostSupported(attempt));
      assert.doesNotThrow(() => assertNativeHostSupported({ ...attempt, sessionRoot: workspaceDir }));
      for (const policy of [{ sandbox: { mode: "all" } }, { tools: { exec: { host: "node" } } }]) {
        assert.throws(() => assertNativeHostSupported({
          ...attempt,
          config: { ...config, agents: { ...config.agents, entries: { [agentId]: {
            ...config.agents.entries[agentId], ...policy,
          } } } },
        }), /does not support/);
      }
    });

    for (const explicitRoot of [false, true]) {
      await t.test(`prepares real schemas, AGENTS prompt and wrapped read (${explicitRoot ? "canonical" : "default"} session root)`, async () => {
        const f = makeAttempt(explicitRoot ? { sessionRoot: workspaceDir } : {});
        const host = await prepareNativeHost(f.attempt, f.signal, f.assertActive);
        try {
          assert.equal(host.prompt, f.attempt.prompt);
          assert.ok(host.systemPrompt.includes(instruction));
          assert.ok(host.systemPrompt.includes(workspaceDir));
          assert.match(host.systemPrompt, /AGENTS\.md/);
          assert.equal(f.binding.length, 1);
          const names = host.tools.map((tool) => tool.name);
          for (const name of ["read", "edit", "write", "exec"]) assert.ok(names.includes(name), name);
          assert.ok(names.every((name) => ["read", "edit", "write", "exec", "apply_patch"].includes(name)));
          const examples = {
            read: { path: "sdk-read.txt" },
            edit: { path: "sdk-read.txt", edits: [{ oldText: "unused", newText: "never executed" }] },
            write: { path: "never-created.txt", content: "never executed" },
            exec: { command: "never executed" },
            apply_patch: { input: "*** Begin Patch\n*** End Patch" },
          };
          const ajv = new Ajv({ strict: true, strictSchema: false, allErrors: true, addUsedSchema: false });
          for (const definition of host.tools) {
            const original = f.binding[0].tools.find((tool) => tool.name === definition.name);
            assert.deepEqual(definition.parameters, JSON.parse(JSON.stringify(original.parameters)));
            assert.ok(definition.description.trim());
            const validate = ajv.compile(definition.parameters);
            assert.equal(validate(examples[definition.name]), true, `${definition.name}: ${ajv.errorsText(validate.errors)}`);
            assert.equal(validate({}), false, `${definition.name} must require usable arguments`);
          }
          await assert.rejects(host.executeTool({
            name: "read", callId: "invalid-read", arguments: { path: 42 },
          }, f.signal), /Invalid arguments/);
          assert.equal(host.getToolCounts().startedCount, 0);
          const result = await host.executeTool({
            name: "read", callId: "fixture-read", arguments: examples.read,
          }, f.signal);
          assert.equal(result.isError, false, result.text);
          assert.ok(result.text.includes(fixtureText.trim()), result.text);
          assert.deepEqual(host.getToolCounts(), { startedCount: 1, completedCount: 1, activeCount: 0 });
          assert.deepEqual(host.getReplayState(), { hadPotentialSideEffects: false, replaySafe: true });
          assert.equal(f.terminals.length, 1);
          assert.equal(f.terminals[0].executionStarted, true);
          assert.equal(f.terminals[0].outcome, "success");
          assert.equal(existsSync(join(workspaceDir, "never-created.txt")), false);
        } finally {
          await host.dispose();
        }
        await assert.rejects(host.executeTool({
          name: "read", callId: "after-dispose", arguments: { path: "sdk-read.txt" },
        }, f.signal), /disposed/i);
      });
    }

    await t.test("built public entry parses actual configuration and defers the real runtime child", async () => {
      assert.equal(entry.id, "dsh-native");
      const runtimeStateDir = join(root, "dsh-runtime-not-started");
      const pluginConfig = {
        stateDir: runtimeStateDir,
        startupTimeoutMs: 100,
        shutdownTimeoutMs: 3600000,
        streamIdleTimeoutMs: 1000,
        allowedBaseUrls: ["http://127.0.0.1:4321/v1/"],
      };
      const copilotEndpoints = [
        "https://api.individual.githubcopilot.com", "https://api.business.githubcopilot.com",
        "https://api.enterprise.githubcopilot.com", "https://api.githubcopilot.com",
      ];
      assert.deepEqual(entry.configSchema.parse(pluginConfig), {
        ...pluginConfig, allowedBaseUrls: ["http://127.0.0.1:4321/v1"],
        allowedCopilotBaseUrls: copilotEndpoints,
      });
      const defaults = entry.configSchema.parse({ stateDir: runtimeStateDir });
      assert.deepEqual(defaults, {
        stateDir: runtimeStateDir, startupTimeoutMs: 60000, shutdownTimeoutMs: 15000,
        streamIdleTimeoutMs: 120000, allowedBaseUrls: ["https://api.deepseek.com"],
        allowedCopilotBaseUrls: copilotEndpoints,
      });
      assert.deepEqual(entry.configSchema.parse(null), entry.configSchema.parse(undefined));
      for (const invalid of [
        [], "invalid", { apiKey: "not-supported" }, { stateDir: "relative" },
        { startupTimeoutMs: 99 }, { shutdownTimeoutMs: 3600001 }, { streamIdleTimeoutMs: 1.5 },
        { allowedBaseUrls: [] }, { allowedBaseUrls: ["http://example.com"] },
        { allowedCopilotBaseUrls: [] }, { allowedCopilotBaseUrls: ["http://example.com"] },
      ]) assert.throws(() => entry.configSchema.parse(invalid));
      const harnesses = [];
      const lifecycles = [];
      entry.register({
        pluginConfig,
        registerAgentHarness: (harness) => harnesses.push(harness),
        lifecycle: { registerRuntimeLifecycle: (lifecycle) => lifecycles.push(lifecycle) },
      });
      assert.equal(harnesses.length, 1);
      assert.equal(lifecycles.length, 1);
      const [harness] = harnesses;
      const [lifecycle] = lifecycles;
      assert.equal(harness.id, "dsh-native");
      assert.equal(harness.pluginId, "dsh-native");
      assert.deepEqual(harness.autoSelection, { providerIds: [] });
      assert.equal(typeof harness.runAttempt, "function");
      assert.equal(lifecycle.id, "dsh-native-runtime");
      const reset = t.mock.method(harness, "reset");
      const dispose = t.mock.method(harness, "dispose");
      try {
        await lifecycle.cleanup({ reason: "reset" });
        assert.equal(reset.mock.callCount(), 0);
        const sessionKey = `agent:${agentId}:sdk-smoke`;
        await lifecycle.cleanup({ reason: "delete", sessionKey });
        await lifecycle.cleanup({ reason: "reset", sessionKey });
        assert.deepEqual(reset.mock.calls.map((call) => call.arguments), [
          [{ sessionKey, reason: "deleted" }], [{ sessionKey, reason: "reset" }],
        ]);
        await lifecycle.cleanup({ reason: "disable" });
        await lifecycle.cleanup({ reason: "restart" });
        assert.equal(dispose.mock.callCount(), 2);
        assert.equal(existsSync(runtimeStateDir), false, "Registration/idle cleanup must not create runtime state");
      } finally {
        await harness.dispose();
      }
    });

    for (const guard of guards) assert.equal(guard.mock.callCount(), 0, "No child process or network request is permitted");
    assert.deepEqual(await readdir(agentDir), [], "No auth/session store should be provisioned");
  } finally {
    for (const database of databases) if (database.isOpen) database.close();
    databaseConstructor?.mock.restore();
    for (const guard of guards) guard.mock.restore();
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    assert.equal(existsSync(root), false, "The project-owned fixture must be removed");
  }
});
