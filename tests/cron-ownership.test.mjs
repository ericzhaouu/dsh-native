import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { edits, transform } from "../host-patch/spec.mjs";
import {
  applyCronOwnershipPlan, checkCronOwnershipPlan, digest, planCronOwnership,
} from "../scripts/cron-ownership.mjs";

const hostTestProjectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hostTestOpenClawRoot = join(hostTestProjectRoot, "node_modules", "openclaw");
const hostTestDistPath = (name) => join(hostTestOpenClawRoot, "dist", name);
const hostTestDistUrl = (name) => pathToFileURL(hostTestDistPath(name)).href;
const hostTestCopilotPluginPath = join(hostTestOpenClawRoot, "dist", "extensions", "github-copilot", "openclaw.plugin.json");
const hostTestCopilotPlugin = JSON.parse(await readFile(hostTestCopilotPluginPath, "utf8"));

async function hostTestLoadDist(name) {
  return import(hostTestDistUrl(name));
}

async function hostTestStateRoot(t, name) {
  const root = join(hostTestProjectRoot, ".test-state", `${name}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function hostTestCreatePatchedHostRoot(t, name) {
  const root = await hostTestStateRoot(t, name);
  const hostRoot = join(root, "openclaw");
  await mkdir(hostRoot, { recursive: true });
  await symlink(dirname(await realpath(hostTestOpenClawRoot)), join(hostRoot, "node_modules"), "junction");
  await cp(join(hostTestOpenClawRoot, "package.json"), join(hostRoot, "package.json"));
  await mkdir(join(hostRoot, "dist"));
  for (const entry of await readdir(join(hostTestOpenClawRoot, "dist"), { withFileTypes: true })) {
    const from = join(hostTestOpenClawRoot, "dist", entry.name);
    const to = join(hostRoot, "dist", entry.name);
    if (entry.isDirectory()) await symlink(from, to, process.platform === "win32" ? "junction" : "dir");
    else await cp(from, to);
  }
  await Promise.all(edits.filter((edit) => edit.file.startsWith("dist/")).map(async (edit) => {
    const sourcePath = join(hostTestOpenClawRoot, ...edit.file.split("/"));
    const targetPath = join(hostRoot, ...edit.file.split("/"));
    await writeFile(targetPath, transform(await readFile(sourcePath, "utf8"), edit));
  }));
  return hostRoot;
}

function hostTestSliceExact(source, start, endInclusive) {
  const from = source.indexOf(start);
  const to = source.indexOf(endInclusive, from);
  assert.ok(from >= 0 && to >= from, `missing host source anchor: ${start}`);
  assert.equal(source.indexOf(start, from + start.length), -1, `non-unique host source anchor: ${start}`);
  return source.slice(from, to + endInclusive.length);
}

async function hostTestLoadIsolatedSessionDeriver() {
  const source = await readFile(hostTestDistPath("isolated-agent-Dg96HjvK.js"), "utf8");
  const identitySlice = hostTestSliceExact(
    source,
    "const baseSessionKey =",
    'const hookExternalContentSource = (input.job.payload.kind === "agentTurn" ? input.job.payload.externalContentSource : void 0) ?? resolveHookExternalContentSource(baseSessionKey);',
  );
  const sessionSlice = hostTestSliceExact(
    source,
    "const cronSession = resolveCronSession({",
    "\t});",
  );
  const runKeySlice = hostTestSliceExact(
    source,
    "const runSessionId = cronSession.sessionEntry.sessionId;",
    "const runSessionKey = usesExactRunSession ? `${agentSessionKey}:run:${runSessionId}` : agentSessionKey;",
  );
  const [
    { t: resolveCronAgentSessionKey },
    { n: isDetachedCronSessionTarget },
    { w: isCronSessionKey },
    { r: resolveHookExternalContentSource },
  ] = await Promise.all([
    hostTestLoadDist("session-key-VAvgVMk2.js"),
    hostTestLoadDist("session-target-DJsUULzX.js"),
    hostTestLoadDist("session-key-BnWWjqNc.js"),
    hostTestLoadDist("external-content-source-DI01uOKv.js"),
  ]);
  let capturedCronSessionArgs;
  const derive = new Function(
    "resolveCronAgentSessionKey",
    "isDetachedCronSessionTarget",
    "isCronSessionKey",
    "resolveHookExternalContentSource",
    "resolveCreatorSandbox",
    "resolveCronSession",
    `return function hostTestDeriveCronSession(params) {
      const input = params.input;
      const agentId = params.agentId;
      const runtimeCfg = params.runtimeCfg ?? {};
      ${identitySlice}
      const now = 1234;
      ${sessionSlice}
      ${runKeySlice}
      return {
        agentSessionKey,
        resolvedBaseSessionKey,
        sourceSessionKey,
        usesDetachedRunSession,
        cronExecutionSessionKey,
        runSessionKey
      };
    };`,
  )(
    resolveCronAgentSessionKey,
    isDetachedCronSessionTarget,
    isCronSessionKey,
    resolveHookExternalContentSource,
    () => undefined,
    (args) => {
      capturedCronSessionArgs = structuredClone(args);
      return {
        store: {},
        sessionEntry: { sessionId: "session-abc" },
        initialSessionEntry: undefined,
        lifecycleRevision: 1,
      };
    },
  );
  return (params) => {
    capturedCronSessionArgs = undefined;
    return { ...derive(params), cronSessionArgs: capturedCronSessionArgs };
  };
}

test("host patch keeps scheduled builtin ownership and foreground Agent pins authoritative across adversarial host defaults", async (t) => {
  const hostRoot = await hostTestCreatePatchedHostRoot(t, "cron-ownership-host-patch");
  const script = `
    import { pathToFileURL } from "node:url";
    import { join } from "node:path";
    const root = ${JSON.stringify(hostRoot)};
    const load = (name) => import(pathToFileURL(join(root, "dist", name)).href);
    const [{ t: resolveAgentHarnessPolicy }, { t: resolveAgentHarnessAvailabilityDecision }, { c: selectAgentHarness }, { t: createRegistry }, runtime] = await Promise.all([
      load("policy-D9i1QMuw.js"),
      load("availability-DrQ2OOVX.js"),
      load("selection-CgLPGlZh.js"),
      load("registry-empty-55wlVNzO.js"),
      load("runtime-BL4wZfTq.js"),
    ]);
    const captureError = (run) => {
      try {
        run();
        return null;
      } catch (error) {
        return { name: error.name, message: error.message };
      }
    };
    const registry = createRegistry();
    runtime.O(registry, "hostTestCronOwnership");
    const config = {
      agents: {
        ownership: "explicit",
        defaults: {
            model: { primary: "github-copilot/gpt-5.6-sol" },
            models: { "github-copilot/gpt-5.6-sol": { agentRuntime: { id: "copilot" } } },
        },
        entries: {
          foreground: { runtime: { type: "embedded", harness: "dsh-native" } },
          scheduled: { runtime: { type: "embedded", harness: "openclaw" } },
        },
      },
      models: { providers: { "microsoft-foundry": { agentRuntime: { id: "dsh-native" } } } },
    };
    const scheduledCopilot = resolveAgentHarnessPolicy({
      config,
      agentId: "scheduled",
      provider: "github-copilot",
      modelId: "gpt-5.6-sol",
    });
    const scheduledFoundry = resolveAgentHarnessPolicy({
      config,
      agentId: "scheduled",
      provider: "microsoft-foundry",
      modelId: "gpt-5.6-sol",
    });
    const foregroundCopilot = resolveAgentHarnessPolicy({
      config,
      agentId: "foreground",
      provider: "github-copilot",
      modelId: "gpt-6-astra",
    });
    const scheduledSelection = selectAgentHarness({
      config,
      agentId: "scheduled",
      provider: "github-copilot",
      modelId: "gpt-5.6-sol",
    });
    const sessionConflict = captureError(() => resolveAgentHarnessAvailabilityDecision({
      config,
      agentId: "foreground",
      provider: "github-copilot",
      modelId: "gpt-6-astra",
      agentHarnessId: "openclaw",
    }));
    const explicitOverrideConflict = captureError(() => resolveAgentHarnessAvailabilityDecision({
      config,
      agentId: "foreground",
      provider: "github-copilot",
      modelId: "gpt-6-astra",
      agentHarnessRuntimeOverride: "copilot",
    }));
    const missingPinnedPlugin = captureError(() => selectAgentHarness({
      config,
      agentId: "foreground",
      provider: "github-copilot",
      modelId: "gpt-6-astra",
    }));
    console.log(JSON.stringify({
      scheduledCopilot,
      scheduledFoundry,
      foregroundCopilot,
      scheduledSelection: {
        id: scheduledSelection.id,
        label: scheduledSelection.label,
        pluginId: scheduledSelection.pluginId ?? null,
      },
      sessionConflict,
      explicitOverrideConflict,
      missingPinnedPlugin,
    }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: hostTestProjectRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const probe = JSON.parse(result.stdout.trim());
  assert.deepEqual(probe.scheduledCopilot, { runtime: "openclaw", runtimeSource: "agent" });
  assert.deepEqual(probe.scheduledFoundry, { runtime: "openclaw", runtimeSource: "agent" });
  assert.deepEqual(probe.foregroundCopilot, { runtime: "dsh-native", runtimeSource: "agent" });
  assert.equal(probe.scheduledSelection.id, "openclaw");
  assert.equal(probe.scheduledSelection.pluginId, null);
  assert.match(probe.scheduledSelection.label, /embedded agent/i);
  assert.equal(probe.sessionConflict?.name, "AgentHarnessPreflightError");
  assert.match(probe.sessionConflict?.message ?? "", /pinned to harness dsh-native|Start a new session/u);
  assert.equal(probe.explicitOverrideConflict?.name, "AgentHarnessPreflightError");
  assert.match(probe.explicitOverrideConflict?.message ?? "", /pinned to harness dsh-native|Start a new session/u);
  assert.equal(probe.missingPinnedPlugin?.name, "MissingAgentHarnessError");
  assert.match(probe.missingPinnedPlugin?.message ?? "", /"dsh-native".*not registered/u);
});

test("host source keeps github-copilot gpt-5.6-sol on the real openai-responses catalog route", async () => {
  const { a: resolveStaticCopilotModelOverride, i: resolveCopilotTransportApi } = await hostTestLoadDist("model-metadata-Ds3TNF-l.js");
  const provider = hostTestCopilotPlugin.modelCatalog.providers["github-copilot"];
  const listed = provider.models.find((model) => model.id === "gpt-5.6-sol");
  assert.ok(listed, "static catalog must include gpt-5.6-sol");
  assert.equal(provider.api, "openai-responses");
  assert.equal(listed.api ?? provider.api, "openai-responses");
  assert.equal(resolveCopilotTransportApi("gpt-5.6-sol"), "openai-responses");
  const override = resolveStaticCopilotModelOverride("gpt-5.6-sol");
  assert.equal(override.id, "gpt-5.6-sol");
  assert.equal(override.compat.codeMode, "capable");
  assert.ok(override.compat.supportedReasoningEfforts.includes("max"));
});

test("host source copilot runtime auth uses injected fetch only and fails closed on bad responses", async () => {
  const { DEFAULT_COPILOT_API_BASE_URL, resolveCopilotRuntimeAuth } = await import(
    pathToFileURL(join(hostTestOpenClawRoot, "dist", "extensions", "github-copilot", "runtime-auth.js")).href
  );
  const hostTestToken = "synthetic-copilot-token";
  let seenRequest;
  const resolved = await resolveCopilotRuntimeAuth({
    githubToken: hostTestToken,
    githubDomain: "tenant.ghe.com",
    fetchImpl: async (url, init) => {
      seenRequest = { url, init };
      return new Response(JSON.stringify({ endpoints: { api: "https://copilot-api.tenant.ghe.com/" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(seenRequest.url, "https://api.tenant.ghe.com/copilot_internal/user");
  assert.equal(seenRequest.init.method, "GET");
  assert.equal(seenRequest.init.headers.Authorization, `Bearer ${hostTestToken}`);
  assert.equal(seenRequest.init.headers.Accept, "application/json");
  assert.equal(resolved.apiKey, hostTestToken);
  assert.equal(resolved.baseUrl, "https://copilot-api.tenant.ghe.com");
  assert.match(resolved.source, /validated:https:\/\/api\.tenant\.ghe\.com\/copilot_internal\/user/u);
  const fallback = await resolveCopilotRuntimeAuth({
    githubToken: hostTestToken,
    fetchImpl: async () => new Response(JSON.stringify({ endpoints: { api: "" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.equal(fallback.baseUrl, DEFAULT_COPILOT_API_BASE_URL);
  await assert.rejects(resolveCopilotRuntimeAuth({
    githubToken: hostTestToken,
    fetchImpl: async () => new Response("denied", { status: 403 }),
  }), (error) => {
    assert.equal(error.reason, "http_error");
    assert.equal(error.status, 403);
    return true;
  });
  await assert.rejects(resolveCopilotRuntimeAuth({
    githubToken: hostTestToken,
    githubDomain: "tenant.ghe.com",
    fetchImpl: async () => new Response(JSON.stringify({ endpoints: { api: "https://attacker.example" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  }), /untrusted endpoints\.api URL/u);
});

test("host source keeps deny authoritative even when a trusted cron cap also allows the tool", async () => {
  const { n: createTrustedCronScheduledToolPolicy, s: resolveCronScheduledToolPolicy } = await hostTestLoadDist("scheduled-tool-policy-WcH3cpLk.js");
  const { n: resolveScheduledToolPolicyContext } = await hostTestLoadDist("scheduled-tool-policy-CkIMk4GS.js");
  const { d: toolPolicyRestrictsTools } = await hostTestLoadDist("tool-policy-Wi0C45cX.js");
  const { r: resolveConversationToolPolicies, t: buildConversationToolPolicyPipelineSteps } = await hostTestLoadDist("conversation-tool-policy-pipeline-BzM9yFTb.js");
  const { t: applyToolPolicyPipeline } = await hostTestLoadDist("tool-policy-pipeline-BwOD5Xc9.js");
  const { t: applyEmbeddedAttemptToolsAllow } = await hostTestLoadDist("attempt-tool-construction-plan-CRC43c_k.js");
  const trusted = resolveCronScheduledToolPolicy({
    toolsAllow: ["message", "exec"],
    scheduledToolPolicy: createTrustedCronScheduledToolPolicy(),
  });
  assert.equal(trusted.mode, "trusted");
  const trustedContext = resolveScheduledToolPolicyContext({
    toolsAllow: ["message", "exec"],
    scheduledToolPolicy: trusted,
  });
  assert.equal(trustedContext.mode, "trusted");
  assert.equal(toolPolicyRestrictsTools({ deny: ["message"] }), true);
  const runtimeScoped = applyEmbeddedAttemptToolsAllow([
    { name: "message" },
    { name: "read" },
    { name: "exec" },
  ], ["message", "exec"]);
  assert.deepEqual(runtimeScoped.map((tool) => tool.name), ["message", "exec"]);
  const capabilityProfile = { policy: {
    profile: "coding",
    providerProfile: undefined,
    agentId: "scheduled",
    profileAlsoAllow: [],
    providerProfileAlsoAllow: [],
    profilePolicy: undefined,
    providerProfilePolicy: undefined,
    globalPolicy: undefined,
    globalProviderPolicy: undefined,
    agentPolicy: { deny: ["message"] },
    agentProviderPolicy: undefined,
    groupPolicy: undefined,
    senderPolicy: undefined,
    sandboxPolicy: undefined,
    subagentPolicy: undefined,
    runtimeToolPolicyForInheritance: { allow: ["message", "exec"] },
    inheritedToolPolicy: undefined,
  } };
  const policies = resolveConversationToolPolicies({
    capabilityProfile,
    additionalProfileAllow: [],
    additionalPolicyAllow: [],
  });
  const filtered = applyToolPolicyPipeline({
    tools: runtimeScoped,
    toolMeta: () => undefined,
    warn: () => {},
    steps: buildConversationToolPolicyPipelineSteps({
      capabilityProfile,
      policies,
      includeRuntimeToolPolicy: true,
    }),
  });
  assert.deepEqual(filtered.map((tool) => tool.name), ["exec"]);
});

test("host source cron patch preserves trusted tool ownership facts when only agent and session binding change", async () => {
  const { i: createJob, r: applyJobPatch, w: createCronServiceState } = await hostTestLoadDist("list-snapshot-revision-DIucIOZa.js");
  const { n: createTrustedCronScheduledToolPolicy } = await hostTestLoadDist("scheduled-tool-policy-WcH3cpLk.js");
  const hostTestState = createCronServiceState({
    nowMs: () => 1000,
    storePath: join(hostTestProjectRoot, ".test-state", "cron-ownership-host-source.sqlite"),
    defaultAgentId: "main",
  });
  const job = createJob(hostTestState, {
    name: "host-source-cron-job",
    schedule: { kind: "at", at: new Date(61000).toISOString() },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "keep the existing cap", toolsAllow: ["message", "exec"] },
  }, {
    scheduledToolPolicy: createTrustedCronScheduledToolPolicy(),
  });
  const beforeState = structuredClone(job.state);
  const beforePolicy = structuredClone(job.scheduledToolPolicy);
  const beforeToolsAllow = structuredClone(job.payload.toolsAllow);
  applyJobPatch(job, {
    agentId: "newagent",
    sessionKey: null,
  }, {});
  assert.equal(job.agentId, "newagent");
  assert.equal(job.sessionKey, undefined);
  assert.equal(job.owner, undefined);
  assert.deepEqual(job.scheduledToolPolicy, beforePolicy);
  assert.deepEqual(job.payload.toolsAllow, beforeToolsAllow);
  assert.deepEqual(job.state, beforeState);
});

test("host source isolated cron session identity canonicalizes to agent:newagent:cron:<jobid> and ignores stored thread keys for run identity", async () => {
  const { t: resolveCronAgentSessionKey } = await hostTestLoadDist("session-key-VAvgVMk2.js");
  const derive = await hostTestLoadIsolatedSessionDeriver();
  const jobId = "job-42";
  assert.equal(resolveCronAgentSessionKey({
    sessionKey: `cron:${jobId}:trigger`,
    agentId: "newagent",
    cfg: {},
    mainKey: undefined,
  }), `agent:newagent:cron:${jobId}:trigger`);
  const derived = derive({
    agentId: "newagent",
    input: {
      job: {
        id: jobId,
        sessionTarget: "isolated",
        sessionKey: "preserve-this-thread",
        payload: { kind: "agentTurn" },
      },
    },
  });
  assert.equal(derived.usesDetachedRunSession, true);
  assert.equal(derived.cronExecutionSessionKey, `cron:${jobId}`);
  assert.equal(derived.agentSessionKey, `agent:newagent:cron:${jobId}`);
  assert.equal(derived.runSessionKey, `agent:newagent:cron:${jobId}:run:session-abc`);
  assert.equal(derived.sourceSessionKey, undefined);
  assert.equal(derived.cronSessionArgs.forceNew, true);
  assert.equal(derived.cronSessionArgs.sessionKey, `agent:newagent:cron:${jobId}`);
  assert.equal(derived.agentSessionKey.includes("preserve-this-thread"), false);
  assert.equal(derived.runSessionKey.includes("preserve-this-thread"), false);
});

test("host source current-bound cron session keeps the original source session while forcing a detached cron run", async () => {
  const derive = await hostTestLoadIsolatedSessionDeriver();
  const derived = derive({
    agentId: "newagent",
    input: {
      job: {
        id: "job-current",
        sessionTarget: "current",
        sessionKey: "agent:newagent:signal:group:KeepCasePeer",
        payload: { kind: "agentTurn" },
      },
    },
  });
  assert.equal(derived.usesDetachedRunSession, true);
  assert.equal(derived.agentSessionKey, "agent:newagent:cron:job-current");
  assert.equal(derived.sourceSessionKey, "agent:newagent:signal:group:KeepCasePeer");
  assert.equal(derived.runSessionKey, "agent:newagent:cron:job-current:run:session-abc");
  assert.equal(derived.cronSessionArgs.forceNew, true);
  assert.equal(derived.cronSessionArgs.sessionKey, "agent:newagent:cron:job-current");
  assert.equal(derived.cronSessionArgs.sourceSessionKey, "agent:newagent:signal:group:KeepCasePeer");
});

test("host source rejects duplicate agentDir ownership before shared auth and session state can collide", async (t) => {
  const root = await hostTestStateRoot(t, "cron-ownership-agent-dir");
  const shared = join(root, "shared-agent");
  await mkdir(shared, { recursive: true });
  const equivalent = join(shared, "..", "shared-agent");
  const { g: validateConfigObject } = await hostTestLoadDist("io.types-BUCjdS5v.js");
  const result = validateConfigObject({
    agents: {
      ownership: "explicit",
      entries: {
        main: { agentDir: shared },
        scheduled: { agentDir: equivalent },
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].path, "agents.entries");
  assert.match(result.issues[0].message, /Duplicate agentDir detected/u);
  assert.match(result.issues[0].message, /Each agent must have a unique agentDir/u);
});

const plannerNow = 1_790_000_000_000;
const { r: hostApplyJobPatch } = await hostTestLoadDist("list-snapshot-revision-DIucIOZa.js");
const { t: hostJobRevision } = await hostTestLoadDist("config-revision-CExLxl38.js");
const { n: hostJobReadView } = await hostTestLoadDist("job-read-view-CpyaDeBp.js");

function plannerInput() {
  const config = {
    agents: {
      ownership: "explicit",
      defaults: { model: { primary: "github-copilot/gpt-5.6-sol" }, heartbeat: { every: "30m" } },
      entries: Object.fromEntries(["daily_assistant", "think_partner"].map((id) => [id, {
        workspace: `/srv/workspace/${id}`,
        agentDir: `/srv/agents/${id}/agent`,
        runtime: { type: "embedded", harness: "dsh-native" },
        modelPolicy: { allow: ["github-copilot/gpt-5.6-sol"] },
        tools: { allow: ["read", "exec"], deny: ["message"] },
        sandbox: { mode: "all", scope: "agent" },
      }])),
    },
    models: { providers: { "github-copilot": { apiKey: "synthetic-private-config-key" } } },
    bindings: [{ agentId: "daily_assistant", match: { channel: "test" } }],
  };
  const jobs = Array.from({ length: 13 }, (_, index) => {
    const agentId = index < 11 ? "daily_assistant" : "think_partner";
    const job = {
      id: `job-${index + 1}`,
      agentId,
      name: `synthetic-${index + 1}`,
      enabled: true,
      sessionTarget: "isolated",
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      wakeMode: "now",
      createdAtMs: plannerNow - 1000,
      updatedAtMs: plannerNow - 100,
      payload: {
        kind: "agentTurn", message: "synthetic-private-job-prompt",
        model: "github-copilot/gpt-5.6-sol", toolsAllow: ["read", "exec"],
      },
      scheduledToolPolicy: { version: 1, mode: "trusted" },
      delivery: { mode: "announce", channel: "test", to: "synthetic-private-delivery-target" },
      state: { nextRunAtMs: plannerNow + 3_600_000, lastRunAtMs: plannerNow - 100_000, lastStatus: "ok" },
      ...(index < 9 ? { sessionKey: `agent:${agentId}:private-thread-${index}` } : {}),
    };
    return { ...job, configRevision: hostJobRevision(job) };
  });
  const mapping = ["daily_assistant", "think_partner"].map((fromAgentId) => ({
    fromAgentId,
    toAgentId: `${fromAgentId}_scheduled`,
    agentDir: `/srv/agents/${fromAgentId}_scheduled/agent`,
    jobIds: jobs.filter((job) => job.agentId === fromAgentId).map((job) => job.id),
    sessionBinding: "clear-explicit-isolated",
  }));
  return {
    configSnapshot: { config, hash: "host-cas-config-hash-before", readAtMs: plannerNow },
    jobsSnapshot: { jobs, complete: true, authorityComplete: true, stateComplete: true, readAtMs: plannerNow },
    mapping,
    approval: { reference: "operator-074", mappingSha256: digest(mapping) },
  };
}

const plannerPlan = (input = plannerInput()) => planCronOwnership(input, { nowMs: plannerNow });

function approveMapping(input) {
  input.approval.mappingSha256 = digest(input.mapping);
  return input;
}

function plannerProof(plan) {
  return {
    planId: plan.planId, hostVersion: "2026.9.2",
    agentPinPatchVerified: true, candidateConfigValid: true,
    routes: plan.mapping.map(({ fromAgentId, toAgentId }) => ({
      fromAgentId, toAgentId, runtime: "openclaw", runtimeSource: "agent", foregroundRuntime: "dsh-native",
      uniqueAgentDir: true, authContextEquivalent: true, modelEntitlementVerified: true,
    })),
    jobs: plan.jobOperations.map(({ params, beforeSha256, afterSha256 }) => ({
      id: params.id, beforeSha256, afterSha256, permissionScopeEquivalent: true,
      deliveryScopeEquivalent: true, executionUserScopeEquivalent: true, freshSessionNamespace: true,
    })),
  };
}

function plannerAdapter(input, proof = plannerProof) {
  const state = structuredClone(input);
  const calls = [];
  const adapter = {
    snapshot: async () => structuredClone(state),
    validateCandidate: async ({ plan }) => proof(plan),
    request: async (method, params) => {
      calls.push({ method, params: structuredClone(params) });
      if (method === "config.patch") {
        assert.equal(params.baseHash, state.configSnapshot.hash);
        const patch = JSON.parse(params.raw);
        assert.deepEqual(Object.keys(patch), ["agents"]);
        Object.assign(state.configSnapshot.config.agents.entries, patch.agents.entries);
        state.configSnapshot.hash = "host-cas-config-hash-after";
        return { ok: true };
      }
      assert.equal(method, "cron.update", "only supported config/cron update RPCs may be sent");
      const job = state.jobsSnapshot.jobs.find((entry) => entry.id === params.id);
      assert.equal(params.expectedConfigRevision, job.configRevision);
      delete job.configRevision;
      hostApplyJobPatch(job, params.patch, {});
      job.updatedAtMs = plannerNow + 1;
      const response = hostJobReadView(job);
      job.configRevision = hostJobRevision(job);
      return response;
    },
  };
  return { state, calls, adapter };
}

test("planner maps all 13 approved jobs, clears exactly nine bindings, and never changes foreground or leaks job content", () => {
  const input = plannerInput();
  const before = structuredClone(input);
  const plan = plannerPlan(input);
  assert.equal(plan.jobOperations.length, 13);
  assert.equal(plan.jobOperations.filter((op) => Object.hasOwn(op.params.patch, "sessionKey")).length, 9);
  assert.equal(plan.configOperation.method, "config.patch");
  assert.equal(plan.configOperation.baseHash, input.configSnapshot.hash);
  for (const target of Object.values(plan.configOperation.patch.agents.entries)) {
    assert.deepEqual(target.runtime, { type: "embedded", harness: "openclaw" });
    assert.deepEqual(target.tools, { allow: ["read", "exec"], deny: ["message"] });
    assert.deepEqual(target.heartbeat, { every: "0m" });
  }
  assert.equal(Object.keys(plan.configOperation.patch.agents.entries).length, 2);
  for (const operation of plan.jobOperations) {
    assert.deepEqual(Object.keys(operation.params.patch).filter((key) => key !== "sessionKey"), ["agentId"]);
    assert.match(operation.paths[0].path, /^\/jobs\/\d+\/agentId$/);
    assert.match(operation.newSessionBase, /^agent:.*_scheduled:cron:job-/);
  }
  const serialized = JSON.stringify(plan);
  for (const privateText of ["synthetic-private", "private-thread-", "apiKey"]) assert.equal(serialized.includes(privateText), false);
  assert.deepEqual(input, before);
  assert.equal(checkCronOwnershipPlan(plan, input, { nowMs: plannerNow }).planId, plan.planId);
});

test("planner supports an explicitly approved subset rather than inventing a global migration", () => {
  const input = plannerInput();
  input.mapping = [input.mapping[1]];
  const plan = plannerPlan(approveMapping(input));
  assert.equal(plan.jobOperations.length, 2);
  assert.deepEqual(Object.keys(plan.configOperation.patch.agents.entries), ["think_partner_scheduled"]);
});

test("planner preserves host-home paths and permits host-default agentDirs without local-user expansion", () => {
  const input = plannerInput();
  input.configSnapshot.config.agents.entries.daily_assistant.workspace = "~/shared-workspace";
  delete input.configSnapshot.config.agents.entries.daily_assistant.agentDir;
  input.mapping[0].agentDir = "~/agents/daily_assistant_scheduled/agent";
  const plan = plannerPlan(approveMapping(input));
  const target = plan.configOperation.patch.agents.entries.daily_assistant_scheduled;
  assert.equal(target.workspace, "~/shared-workspace");
  assert.equal(target.agentDir, "~/agents/daily_assistant_scheduled/agent");
  assert.ok(plan.validationRequired.includes("candidate-config-valid-and-agentDirs-unique-including-realpaths"));
  delete input.configSnapshot.config.agents.entries.daily_assistant.workspace;
  input.configSnapshot.resolvedAgentPaths = { daily_assistant: { workspace: "/host/default-source-workspace" } };
  assert.equal(plannerPlan(input).configOperation.patch.agents.entries.daily_assistant_scheduled.workspace, "/host/default-source-workspace");
});

test("planner fails closed on missing approval, stale/redacted/public snapshots and conflicting directories", () => {
  for (const [change, code] of [
    [(i) => { delete i.approval; }, "OPERATOR_MAPPING_APPROVAL_REQUIRED"],
    [(i) => { i.approval.mappingSha256 = "wrong"; }, "OPERATOR_MAPPING_APPROVAL_REQUIRED"],
    [(i) => { i.configSnapshot.readAtMs -= 300_001; }, "FRESH_HOST_SNAPSHOT_REQUIRED"],
    [(i) => { i.jobsSnapshot.readAtMs += 1; }, "FRESH_HOST_SNAPSHOT_REQUIRED"],
    [(i) => { i.configSnapshot.hash = ""; }, "HOST_CONFIG_HASH_REQUIRED"],
    [(i) => { i.configSnapshot.redacted = true; }, "FULL_PRIVATE_SNAPSHOT_REQUIRED"],
    [(i) => { i.jobsSnapshot.complete = false; }, "ALL_CRON_LIST_PAGES_REQUIRED"],
    [(i) => { delete i.jobsSnapshot.authorityComplete; }, "PUBLIC_CRON_VIEW_CANNOT_PROVE_AUTHORITY_ABSENCE"],
    [(i) => { delete i.jobsSnapshot.stateComplete; }, "PRIVATE_SCHEDULER_STATE_REQUIRED"],
    [(i) => { i.mapping[0].agentDir = "/srv/agents/daily_assistant/agent"; approveMapping(i); }, "DUPLICATE_AGENT_DIR"],
    [(i) => { i.mapping[1].agentDir = i.mapping[0].agentDir; approveMapping(i); }, "DUPLICATE_AGENT_DIR"],
    [(i) => { i.mapping[0].agentDir = "relative"; approveMapping(i); }, "ABSOLUTE_AGENT_PATH_REQUIRED"],
    [(i) => { i.configSnapshot.config.agents.entries.daily_assistant.tools.env = { TOKEN: "secret" }; }, "PRIVATE_AGENT_MATERIAL_REQUIRES_HOST_MANAGED_REFERENCE"],
    [(i) => { i.configSnapshot.config.agents.entries.daily_assistant.runtime.harness = "openclaw"; }, "SOURCE_DSH_PIN_REQUIRED"],
    [(i) => { i.configSnapshot.config.agents.entries.daily_assistant_scheduled = {}; }, "TARGET_AGENT_MUST_BE_NEW"],
    [(i) => { i.mapping[0].runtime = "openclaw"; approveMapping(i); }, "UNKNOWN_MAPPING_FIELD"],
    [(i) => { i.mapping[0].sessionBinding = "reuse"; approveMapping(i); }, "SESSION_BINDING_DECISION_REQUIRED"],
  ]) {
    const input = plannerInput();
    change(input);
    assert.throws(() => plannerPlan(input), (error) => error.code === code, code);
  }
});

test("planner refuses unproven re-authority, active jobs, owner changes and non-isolated execution", () => {
  for (const [change, code] of [
    [(j) => { j.owner = { sessionKey: "owner-session", accountId: "owner-account" }; }, "ACCOUNT_OWNER_MIGRATION_REQUIRES_OWNER_BOUND_REAUTHORIZATION"],
    [(j) => { j.scheduledToolPolicy = { version: 2, mode: "trusted" }; }, "TRUSTED_V1_POLICY_REQUIRED_REAUTHORIZE_OTHER_CASES"],
    [(j) => { delete j.scheduledToolPolicy; }, "TRUSTED_V1_POLICY_REQUIRED_REAUTHORIZE_OTHER_CASES"],
    [(j) => { j.runtimeAuthority = { runtimeId: "dsh-native" }; }, "CAPTURED_RUNTIME_AUTHORITY_REQUIRES_REAUTHORIZATION"],
    [(j) => { j.runtimeAuthorityRecoveryRequired = true; }, "RUNTIME_AUTHORITY_RECOVERY_REQUIRES_REAUTHORIZATION"],
    [(j) => { j.state.runningAtMs = plannerNow; }, "JOB_ACTIVE"],
    [(j) => { j.state.queuedAtMs = plannerNow; }, "JOB_ACTIVE"],
    [(j) => { delete j.state.nextRunAtMs; }, "PRESERVABLE_NEXT_RUN_REQUIRED"],
    [(j) => { delete j.configRevision; }, "HOST_JOB_CONFIG_REVISION_REQUIRED"],
    [(j) => { delete j.payload.toolsAllow; }, "EXPLICIT_TOOLS_CAP_REQUIRED"],
    [(j) => { j.sessionTarget = "main"; }, "ONLY_EXPLICIT_ISOLATED_AGENT_TURNS_SUPPORTED"],
    [(j) => { delete j.enabled; }, "ONLY_EXPLICIT_ISOLATED_AGENT_TURNS_SUPPORTED"],
    [(j) => { j.enabled = "false"; }, "ONLY_EXPLICIT_ISOLATED_AGENT_TURNS_SUPPORTED"],
    [(j) => { j.enabled = false; }, "PAUSED_JOB_MUST_HAVE_NO_NEXT_RUN"],
    [(j) => { delete j.state; }, "PRIVATE_JOB_STATE_REQUIRED"],
    [(j) => { j.schedule = { kind: "every", everyMs: 1000 }; }, "STABLE_SCHEDULE_ANCHOR_REQUIRED"],
  ]) {
    const input = plannerInput();
    change(input.jobsSnapshot.jobs[0]);
    assert.throws(() => plannerPlan(input), (error) => error.code === code, code);
  }
});

test("checker rejects plan edits and fresh-but-changed job content/state/config", () => {
  const input = plannerInput();
  const plan = plannerPlan(input);
  const tampered = structuredClone(plan);
  tampered.jobOperations[0].params.patch.enabled = false;
  assert.throws(() => checkCronOwnershipPlan(tampered, input, { nowMs: plannerNow }), /PLAN_TAMPERED/);
  for (const mutate of [
    (i) => { i.configSnapshot.hash += "-changed"; },
    (i) => { i.jobsSnapshot.jobs[0].payload.message += " edited"; },
    (i) => { i.jobsSnapshot.jobs[0].state.nextRunAtMs += 1; },
    (i) => { i.jobsSnapshot.jobs[0].enabled = false; delete i.jobsSnapshot.jobs[0].state.nextRunAtMs; },
    (i) => { i.configSnapshot.config.agents.entries.daily_assistant.tools.deny = []; },
  ]) {
    const fresh = structuredClone(input);
    mutate(fresh);
    assert.throws(() => checkCronOwnershipPlan(plan, fresh, { nowMs: plannerNow }), /SNAPSHOT_DRIFT/);
  }
});

test("apply uses config CAS then genuine cron patches, verifies private postconditions, and never runs jobs", async () => {
  const input = plannerInput();
  input.jobsSnapshot.jobs[0].skillLibrarySelections = { syntheticPrivateSelection: "preserved" };
  delete input.jobsSnapshot.jobs[0].configRevision;
  input.jobsSnapshot.jobs[0].configRevision = hostJobRevision(input.jobsSnapshot.jobs[0]);
  const plan = plannerPlan(input);
  const { adapter, calls, state } = plannerAdapter(input);
  const receipt = await applyCronOwnershipPlan(plan, { adapter, approvedPlanId: plan.planId, now: () => plannerNow });
  assert.equal(receipt.status, "verified", JSON.stringify(receipt));
  assert.equal(receipt.updatedJobIds.length, 13);
  assert.deepEqual(calls.map((call) => call.method), ["config.patch", ...Array(13).fill("cron.update")]);
  for (const [index, original] of input.jobsSnapshot.jobs.entries()) {
    const updated = state.jobsSnapshot.jobs[index];
    for (const key of Object.keys(original).filter((key) => !["agentId", "sessionKey", "configRevision", "updatedAtMs"].includes(key))) {
      assert.deepEqual(updated[key], original[key], key);
    }
  }
  for (const source of ["daily_assistant", "think_partner"]) {
    assert.deepEqual(state.configSnapshot.config.agents.entries[source], input.configSnapshot.config.agents.entries[source]);
  }
});

function pausePlannerJob(job) {
  job.enabled = false;
  delete job.state.nextRunAtMs;
  job.configRevision = hostJobRevision(job);
}

test("planner and genuine host patches preserve paused and mixed job sets without enabling or running them", async () => {
  for (const pausedCount of [13, 3]) {
    const input = plannerInput();
    input.jobsSnapshot.jobs.slice(0, pausedCount).forEach(pausePlannerJob);
    const plan = plannerPlan(input);
    const { adapter, calls, state } = plannerAdapter(input);
    const receipt = await applyCronOwnershipPlan(plan, { adapter, approvedPlanId: plan.planId, now: () => plannerNow });
    assert.equal(receipt.status, "verified", JSON.stringify(receipt));
    assert.equal(receipt.updatedJobIds.length, 13);
    assert.deepEqual(calls.map(({ method }) => method), ["config.patch", ...Array(13).fill("cron.update")]);
    for (const { params } of calls.filter(({ method }) => method === "cron.update")) {
      assert.equal(Object.hasOwn(params.patch, "enabled"), false);
      assert.equal(Object.hasOwn(params.patch, "schedule"), false);
    }
    for (const [index, original] of input.jobsSnapshot.jobs.entries()) {
      const actual = state.jobsSnapshot.jobs[index];
      assert.equal(actual.enabled, original.enabled);
      assert.deepEqual(actual.state, original.state);
      assert.deepEqual(actual.schedule, original.schedule);
      assert.deepEqual(actual.payload, original.payload);
      assert.deepEqual(actual.delivery, original.delivery);
    }
  }
});

test("paused jobs still reject running, queued, or inconsistent next-run state", () => {
  for (const [change, code] of [
    [(job) => { job.state.runningAtMs = plannerNow; }, "JOB_ACTIVE"],
    [(job) => { job.state.queuedAtMs = plannerNow; }, "JOB_ACTIVE"],
    [(job) => { job.state.nextRunAtMs = null; }, "PAUSED_JOB_MUST_HAVE_NO_NEXT_RUN"],
    [(job) => { job.state.nextRunAtMs = plannerNow - 1; }, "PAUSED_JOB_MUST_HAVE_NO_NEXT_RUN"],
  ]) {
    const input = plannerInput();
    pausePlannerJob(input.jobsSnapshot.jobs[0]);
    change(input.jobsSnapshot.jobs[0]);
    assert.throws(() => plannerPlan(input), (error) => error.code === code, code);
  }
});

test("pause after planning or validation invalidates the plan without writing anything", async () => {
  for (const afterValidation of [false, true]) {
    const input = plannerInput();
    const plan = plannerPlan(input);
    const { adapter, calls, state } = plannerAdapter(input);
    if (afterValidation) {
      adapter.validateCandidate = async ({ plan: candidate }) => {
        pausePlannerJob(state.jobsSnapshot.jobs[0]);
        return plannerProof(candidate);
      };
    } else pausePlannerJob(state.jobsSnapshot.jobs[0]);
    const receipt = await applyCronOwnershipPlan(plan, { adapter, approvedPlanId: plan.planId, now: () => plannerNow });
    assert.equal(receipt.status, "blocked-no-writes");
    assert.equal(receipt.errorCode, "SNAPSHOT_DRIFT_REPLAN_REQUIRED");
    assert.equal(calls.length, 0);
    assert.equal(state.jobsSnapshot.jobs[0].enabled, false);
  }
});

test("concurrent pause or resume after config apply stops before any job write", async () => {
  for (const resume of [false, true]) {
    const input = plannerInput();
    if (resume) input.jobsSnapshot.jobs.forEach(pausePlannerJob);
    const plan = plannerPlan(input);
    const { adapter, calls, state } = plannerAdapter(input);
    const request = adapter.request;
    adapter.request = async (method, params) => {
      const result = await request(method, params);
      if (method === "config.patch") {
        const job = state.jobsSnapshot.jobs[0];
        if (resume) {
          job.enabled = true;
          job.state.nextRunAtMs = plannerNow + 3_600_000;
          job.configRevision = hostJobRevision(job);
        } else pausePlannerJob(job);
      }
      return result;
    };
    const receipt = await applyCronOwnershipPlan(plan, { adapter, approvedPlanId: plan.planId, now: () => plannerNow });
    assert.equal(receipt.status, "partial-or-uncertain-stop-and-reconcile");
    assert.equal(receipt.errorCode, "JOB_POSTCONDITION_OR_STATE_DRIFT");
    assert.deepEqual(calls.map(({ method }) => method), ["config.patch"]);
    assert.deepEqual(receipt.updatedJobIds, []);
    assert.equal(state.jobsSnapshot.jobs[0].enabled, resume);
  }
});

test("apply snapshots approval before awaiting and never follows caller plan mutations", async (t) => {
  for (const boundary of ["snapshot", "config.patch", "cron.update"]) {
    for (const mutation of ["owner", "enabled", "operations"]) {
      await t.test(`${boundary}: ${mutation}`, async () => {
        const input = plannerInput();
        input.jobsSnapshot.jobs.forEach(pausePlannerJob);
        const plan = plannerPlan(input);
        const approved = structuredClone(plan);
        const { adapter, calls, state } = plannerAdapter(input);
        const entered = Promise.withResolvers();
        const released = Promise.withResolvers();
        let held = false;
        const hold = async (operation) => {
          if (!held && operation === boundary) {
            held = true;
            entered.resolve();
            await released.promise;
          }
        };
        const snapshot = adapter.snapshot;
        adapter.snapshot = async () => { await hold("snapshot"); return snapshot(); };
        const request = adapter.request;
        adapter.request = async (method, params) => { await hold(method); return request(method, params); };
        const applying = applyCronOwnershipPlan(plan, {
          adapter, approvedPlanId: approved.planId, now: () => plannerNow,
        });
        await entered.promise;
        if (mutation === "owner") plan.jobOperations[0].params.patch.agentId = "think_partner_scheduled";
        else if (mutation === "enabled") plan.jobOperations[0].params.patch.enabled = true;
        else plan.jobOperations.pop();
        released.resolve();
        const receipt = await applying;
        assert.equal(receipt.status, "verified", JSON.stringify(receipt));
        assert.equal(receipt.planId, approved.planId);
        assert.deepEqual(calls.filter(({ method }) => method === "cron.update").map(({ params }) => params),
          approved.jobOperations.map(({ params }) => params));
        for (const operation of approved.jobOperations) {
          const job = state.jobsSnapshot.jobs.find(({ id }) => id === operation.params.id);
          assert.equal(job.agentId, operation.params.patch.agentId);
          assert.equal(job.enabled, false);
          assert.equal(job.state.nextRunAtMs, undefined);
        }
      });
    }
  }
});

test("retained validation and initial snapshot objects cannot rewrite approved postconditions", async () => {
  const input = plannerInput();
  input.jobsSnapshot.jobs.forEach(pausePlannerJob);
  const plan = plannerPlan(input);
  const { adapter, calls, state } = plannerAdapter(input);
  const snapshot = adapter.snapshot;
  let firstSnapshot;
  adapter.snapshot = async () => {
    const result = await snapshot();
    firstSnapshot ??= result;
    return result;
  };
  let validation;
  adapter.validateCandidate = async (candidate) => {
    validation = candidate;
    return plannerProof(candidate.plan);
  };
  const request = adapter.request;
  adapter.request = async (method, params) => {
    if (method === "config.patch") {
      firstSnapshot.jobsSnapshot.jobs[0].enabled = true;
      validation.before.jobsSnapshot.jobs[1].agentId = "think_partner_scheduled";
      validation.candidateConfig.agents.entries.daily_assistant_scheduled.tools.deny = [];
      validation.candidateConfig.agents.entries.daily_assistant.tools.deny = [];
      validation.plan.jobOperations[0].params.patch.enabled = true;
    }
    return request(method, params);
  };
  const receipt = await applyCronOwnershipPlan(plan, { adapter, approvedPlanId: plan.planId, now: () => plannerNow });
  assert.equal(receipt.status, "verified", JSON.stringify(receipt));
  assert.deepEqual(calls.filter(({ method }) => method === "cron.update").map(({ params }) => params),
    plan.jobOperations.map(({ params }) => params));
  assert.ok(state.jobsSnapshot.jobs.every(({ enabled }) => enabled === false));
  assert.deepEqual(state.configSnapshot.config.agents.entries.daily_assistant.tools.deny, ["message"]);
  assert.deepEqual(state.configSnapshot.config.agents.entries.daily_assistant_scheduled.tools.deny, ["message"]);
});

test("apply blocks before writes on missing real auth/scope/selection proof or a due job", async () => {
  const input = plannerInput();
  const plan = plannerPlan(input);
  for (const key of ["authContextEquivalent", "modelEntitlementVerified", "permissionScopeEquivalent",
    "deliveryScopeEquivalent", "executionUserScopeEquivalent", "freshSessionNamespace", "uniqueAgentDir"]) {
    const { adapter, calls } = plannerAdapter(input, (candidate) => {
      const proof = plannerProof(candidate);
      if (Object.hasOwn(proof.routes[0], key)) proof.routes[0][key] = false;
      else proof.jobs[0][key] = false;
      return proof;
    });
    const receipt = await applyCronOwnershipPlan(plan, { adapter, approvedPlanId: plan.planId, now: () => plannerNow });
    assert.equal(receipt.status, "blocked-no-writes");
    assert.equal(receipt.errorCode, `VALIDATION_REQUIRED_${key}`);
    assert.equal(calls.length, 0);
  }
  const near = plannerInput();
  near.jobsSnapshot.jobs[0].state.nextRunAtMs = plannerNow + 50_000;
  const nearPlan = plannerPlan(near);
  const { adapter, calls } = plannerAdapter(near);
  const receipt = await applyCronOwnershipPlan(nearPlan, { adapter, approvedPlanId: nearPlan.planId, now: () => plannerNow });
  assert.equal(receipt.errorCode, "IDLE_APPLY_WINDOW_REQUIRED");
  assert.equal(calls.length, 0);
});

test("apply rechecks after validation and refuses drift without touching config", async () => {
  const input = plannerInput();
  const plan = plannerPlan(input);
  const { adapter, calls, state } = plannerAdapter(input);
  adapter.validateCandidate = async ({ plan: candidate }) => {
    state.jobsSnapshot.jobs[0].payload.toolsAllow.push("message");
    return plannerProof(candidate);
  };
  const receipt = await applyCronOwnershipPlan(plan, { adapter, approvedPlanId: plan.planId, now: () => plannerNow });
  assert.equal(receipt.errorCode, "SNAPSHOT_DRIFT_REPLAN_REQUIRED");
  assert.equal(calls.length, 0);
});

test("apply requires evidence for every exact job rather than a representative route", async () => {
  const input = plannerInput();
  const plan = plannerPlan(input);
  for (const mutate of [
    (proof) => { proof.jobs.pop(); },
    (proof) => { proof.jobs[1] = proof.jobs[0]; },
    (proof) => { proof.jobs[0].afterSha256 = "stale-proof"; },
  ]) {
    const { adapter, calls } = plannerAdapter(input, (candidate) => {
      const proof = plannerProof(candidate);
      mutate(proof);
      return proof;
    });
    const receipt = await applyCronOwnershipPlan(plan, { adapter, approvedPlanId: plan.planId, now: () => plannerNow });
    assert.equal(receipt.errorCode, "PER_JOB_VALIDATION_REQUIRED");
    assert.equal(calls.length, 0);
  }
});

test("apply stops on a host mutation/postcondition error with an auditable partial receipt and no rollback or secret logs", async () => {
  const input = plannerInput();
  const plan = plannerPlan(input);
  const { adapter, calls } = plannerAdapter(input);
  const request = adapter.request;
  adapter.request = async (method, params) => {
    if (method === "cron.update" && params.id === "job-2") throw new Error("synthetic-private-token-and-prompt");
    return request(method, params);
  };
  const receipt = await applyCronOwnershipPlan(plan, { adapter, approvedPlanId: plan.planId, now: () => plannerNow });
  assert.equal(receipt.status, "partial-or-uncertain-stop-and-reconcile");
  assert.deepEqual(receipt.updatedJobIds, ["job-1"]);
  assert.equal(receipt.attemptedJobId, "job-2");
  assert.equal(receipt.errorCode, "HOST_OPERATION_FAILED");
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(receipt).includes("synthetic-private"), false);
});

test("apply detects scheduler-state drift even though host definition revision deliberately excludes it", async () => {
  const input = plannerInput();
  const plan = plannerPlan(input);
  const { adapter, calls, state } = plannerAdapter(input);
  const request = adapter.request;
  adapter.request = async (method, params) => {
    const result = await request(method, params);
    if (method === "cron.update") state.jobsSnapshot.jobs[0].state.nextRunAtMs += 1;
    return result;
  };
  const receipt = await applyCronOwnershipPlan(plan, { adapter, approvedPlanId: plan.planId, now: () => plannerNow });
  assert.equal(receipt.status, "partial-or-uncertain-stop-and-reconcile");
  assert.equal(receipt.errorCode, "JOB_POSTCONDITION_OR_STATE_DRIFT");
  assert.equal(calls.length, 2);
  assert.deepEqual(receipt.updatedJobIds, []);
  assert.equal(receipt.attemptedJobId, "job-1");
});

test("planner CLI has no production apply command and does not overwrite an existing plan", async (t) => {
  const root = await hostTestStateRoot(t, "cron-ownership-cli");
  const inputPath = join(root, "private-input.json");
  const outputPath = join(root, "plan.json");
  const input = plannerInput();
  input.configSnapshot.readAtMs = Date.now();
  input.jobsSnapshot.readAtMs = input.configSnapshot.readAtMs;
  await writeFile(inputPath, JSON.stringify(input));
  const run = (...args) => spawnSync(process.execPath, [join(hostTestProjectRoot, "scripts", "cron-ownership.mjs"), ...args], { encoding: "utf8" });
  assert.equal(run("plan", inputPath, outputPath).status, 0);
  assert.equal(run("check", inputPath, outputPath).status, 0);
  assert.equal(run("plan", inputPath, outputPath).status, 1);
  assert.equal(run("apply", inputPath, outputPath).status, 1);
  assert.equal(JSON.stringify(JSON.parse(await readFile(outputPath, "utf8"))).includes("synthetic-private"), false);
});
