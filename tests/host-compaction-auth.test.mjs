import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspectHost, patchHost } from "../host-patch/compact-auth/apply.mjs";
import { edits, PATCH_ID, replaceExactly, stateName, transform } from "../host-patch/compact-auth/spec.mjs";
import { patchHost as patchAgentPin } from "../host-patch/apply.mjs";
import { edits as pinEdits } from "../host-patch/spec.mjs";

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const genuineHost = join(project, "node_modules", "openclaw");
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const root = join(project, ".test-state", `dsh-compaction-auth-${randomUUID()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.9.2" }));
  for (const edit of edits) {
    const dest = join(root, ...edit.file.split("/"));
    await mkdir(dirname(dest), { recursive: true });
    await cp(join(genuineHost, ...edit.file.split("/")), dest);
  }
  return root;
}

async function loadCompactionAuthHelpers() {
  const edit = edits[0];
  const original = await readFile(join(genuineHost, ...edit.file.split("/")), "utf8");
  const patched = transform(original, edit);
  const start = patched.indexOf("function runtimePlanRequiresHostApiKey");
  const end = patched.indexOf("function resolveHarnessCompactIdentity");
  assert.ok(start >= 0 && end > start, "patched helper slice should exist");
  const helperSource = patched.slice(start, end);
  return (mocks) => new Function(
    "prepareProviderRuntimeAuth",
    "protectPreparedProviderRuntimeAuth",
    "applyPreparedRuntimeAuthToModel",
    "unwrapSecretSentinelsForProviderEgress",
    `${helperSource}
return { shouldPrepareDshNativeCopilotCompactionRuntimeAuth, prepareDshNativeCopilotCompactionRuntimeAuth };`,
  )(
    mocks.prepareProviderRuntimeAuth,
    mocks.protectPreparedProviderRuntimeAuth,
    mocks.applyPreparedRuntimeAuthToModel,
    mocks.unwrapSecretSentinelsForProviderEgress,
  );
}

function baseParams(overrides = {}) {
  return {
    agentDir: "C:\\agent",
    apiKey: "source-gh-token",
    authProfileId: "resolved-profile",
    authMode: "token",
    config: { models: { providers: {} } },
    harness: { id: "dsh-native" },
    model: {
      id: "gpt-6-astra",
      provider: "github-copilot",
      api: "responses",
      baseUrl: "https://api.githubcopilot.com",
      headers: { "x-existing": "kept" },
    },
    modelId: "gpt-6-astra",
    provider: "github-copilot",
    runtimeAuthPlan: {
      providerForAuth: "github-copilot",
      modelId: "gpt-6-astra",
      forwardedAuthProfileId: "forwarded-profile",
      forwardedAuthProfileSource: "user",
      selectedAuthMode: "oauth",
      modelRoute: {
        provider: "github-copilot",
        modelId: "gpt-6-astra",
        api: "responses",
        baseUrl: "https://api.githubcopilot.com",
        authRequirement: "api-key",
        runtimePolicy: { compatibleIds: ["dsh-native"] },
      },
    },
    workspaceDir: "C:\\workspace",
    ...overrides,
  };
}

test("compaction auth patch checks, applies, restores, and uses an independent receipt", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, ".dsh-agent-harness-patch"), { recursive: true });
  await writeFile(join(root, ".dsh-agent-harness-patch", "receipt.json"), JSON.stringify({ patchId: "existing-agent-pin" }));
  assert.equal((await patchHost(root)).status, "unpatched");
  await assert.rejects(patchHost(root, { action: "apply" }), /offline-confirmed/);
  assert.equal((await patchHost(root, { action: "apply", offlineConfirmed: true })).status, "applied");
  assert.equal((await patchHost(root, { action: "apply", offlineConfirmed: true })).status, "applied");
  const receipt = JSON.parse(await readFile(join(root, stateName, "receipt.json"), "utf8"));
  assert.equal(receipt.patchId, PATCH_ID);
  assert.equal(JSON.parse(await readFile(join(root, ".dsh-agent-harness-patch", "receipt.json"), "utf8")).patchId, "existing-agent-pin");
  assert.equal((await patchHost(root, { action: "restore", offlineConfirmed: true })).status, "unpatched");
  assert.equal(hash(await readFile(join(root, ...edits[0].file.split("/")))), edits[0].sha256);
});

test("compaction auth patch rejects unsupported versions, tampering, corrupt backups, and junction state", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.9.3" }));
  await assert.rejects(patchHost(root, { action: "apply", offlineConfirmed: true }), /exact OpenClaw/);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.9.2" }));
  const target = join(root, ...edits[0].file.split("/"));
  await writeFile(target, `${await readFile(target, "utf8")}\n// tamper\n`);
  await assert.rejects(patchHost(root, { action: "apply", offlineConfirmed: true }), /local changes/);

  const restoredRoot = await fixture(t);
  await patchHost(restoredRoot, { action: "apply", offlineConfirmed: true });
  const patchedTarget = join(restoredRoot, ...edits[0].file.split("/"));
  await writeFile(patchedTarget, `${await readFile(patchedTarget, "utf8")}\n// later edit\n`);
  await assert.rejects(patchHost(restoredRoot, { action: "restore", offlineConfirmed: true }), /local changes/);
  await writeFile(patchedTarget, transform(await readFile(join(genuineHost, ...edits[0].file.split("/")), "utf8"), edits[0]));
  await writeFile(join(restoredRoot, stateName, ...edits[0].file.split("/")), "bad backup");
  await assert.rejects(inspectHost(restoredRoot), /backup is corrupt/);

  const linkRoot = await fixture(t);
  const outside = join(project, ".test-state", `dsh-compaction-auth-outside-${randomUUID()}`);
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(linkRoot, stateName), "junction");
  await assert.rejects(patchHost(linkRoot, { action: "apply", offlineConfirmed: true }), /real directory/);
});

test("compaction companion and the genuine installed Agent-pin patch can be restored independently", async (t) => {
  const root = await fixture(t);
  for (const edit of pinEdits) {
    const destination = join(root, ...edit.file.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(genuineHost, ...edit.file.split("/")), destination);
  }
  await patchAgentPin(root, { action: "apply", offlineConfirmed: true });
  const pinReceiptPath = join(root, ".dsh-agent-harness-patch", "receipt.json");
  const pinReceipt = await readFile(pinReceiptPath, "utf8");
  await patchHost(root, { action: "apply", offlineConfirmed: true });
  assert.equal((await patchAgentPin(root)).status, "applied");
  assert.equal(await readFile(pinReceiptPath, "utf8"), pinReceipt);
  await patchHost(root, { action: "restore", offlineConfirmed: true });
  assert.equal((await patchAgentPin(root)).status, "applied");
  assert.equal(await readFile(pinReceiptPath, "utf8"), pinReceipt);
  await patchHost(root, { action: "apply", offlineConfirmed: true });
  await patchAgentPin(root, { action: "restore", offlineConfirmed: true });
  assert.equal((await patchHost(root)).status, "applied");
  await patchHost(root, { action: "restore", offlineConfirmed: true });
  assert.equal((await patchHost(root)).status, "unpatched");
  for (const edit of [...pinEdits, ...edits]) {
    assert.equal(hash(await readFile(join(root, ...edit.file.split("/")))), edit.sha256);
  }
});

test("transformed compaction successor syntax is valid and anchors are exact", async () => {
  const original = await readFile(join(genuineHost, ...edits[0].file.split("/")), "utf8");
  const patched = transform(original, edits[0]);
  assert.match(patched, /prepareDshNativeCopilotCompactionRuntimeAuth/);
  assert.match(patched, /apiKey: resolved\.auth\.apiKey/);
  assert.doesNotMatch(patched, /apiKey:\s*preparedAuth\.apiKey/);
  const syntax = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: patched, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.throws(() => replaceExactly("x x", "x", "y", "fixture"), /one patch anchor/);
  assert.throws(() => replaceExactly("x", "missing", "y", "fixture"), /one patch anchor/);
});

test("dsh-native Copilot compaction prepares runtime route without forwarding the derived key", async () => {
  const makeHelpers = await loadCompactionAuthHelpers();
  const calls = [];
  let derived = 0;
  const helpers = makeHelpers({
    prepareProviderRuntimeAuth: async (params) => {
      calls.push(params);
      assert.equal(params.provider, "github-copilot");
      assert.equal(params.context.provider, "github-copilot");
      assert.equal(params.context.modelId, "gpt-6-astra");
      assert.equal(params.context.model.baseUrl, "https://api.githubcopilot.com");
      assert.equal(params.context.apiKey, "source-gh-token");
      assert.equal(params.context.authMode, "token");
      assert.equal(params.context.profileId, "resolved-profile");
      return {
        apiKey: `derived-runtime-${++derived}`,
        baseUrl: "https://enterprise.githubcopilot.com",
        request: { headers: { "x-copilot-enterprise": "account-a" } },
      };
    },
    protectPreparedProviderRuntimeAuth: ({ preparedAuth }) => ({ ...preparedAuth, apiKey: `protected:${preparedAuth.apiKey}` }),
    applyPreparedRuntimeAuthToModel: (model, preparedAuth) => ({
      ...model,
      baseUrl: preparedAuth.baseUrl,
      headers: { ...model.headers, ...preparedAuth.request.headers },
    }),
    unwrapSecretSentinelsForProviderEgress: (value) => value,
  });
  const first = await helpers.prepareDshNativeCopilotCompactionRuntimeAuth(baseParams());
  const second = await helpers.prepareDshNativeCopilotCompactionRuntimeAuth(baseParams());
  assert.equal(calls.length, 2);
  assert.equal(calls[0].context.apiKey, calls[1].context.apiKey, "source credential remains the stable handoff key");
  assert.equal(first.runtimeModel.baseUrl, "https://enterprise.githubcopilot.com");
  assert.equal(first.runtimeAuthPlan.modelRoute.baseUrl, first.runtimeModel.baseUrl);
  assert.equal(first.runtimeAuthPlan.modelRoute.api, first.runtimeModel.api);
  assert.equal(first.runtimeModel.id, "gpt-6-astra");
  assert.equal(first.runtimeModel.provider, "github-copilot");
  assert.equal(derived, 2);
  assert.deepEqual(first.runtimeModel, second.runtimeModel, "Derived credential refresh must not change the source-bound handoff");
  assert.equal(JSON.stringify([first, second]).includes("derived-runtime-"), false);
});

test("runtime prep is skipped for non-targets and unavailable hooks, and throws/cancels fail closed", async () => {
  const makeHelpers = await loadCompactionAuthHelpers();
  let prepareCalls = 0;
  const helpers = makeHelpers({
    prepareProviderRuntimeAuth: async () => { prepareCalls++; },
    protectPreparedProviderRuntimeAuth: ({ preparedAuth }) => preparedAuth,
    applyPreparedRuntimeAuthToModel: (model) => model,
    unwrapSecretSentinelsForProviderEgress: (value) => value,
  });
  assert.equal(await helpers.prepareDshNativeCopilotCompactionRuntimeAuth(baseParams({ harness: { id: "other" } })), undefined);
  assert.equal(await helpers.prepareDshNativeCopilotCompactionRuntimeAuth(baseParams({ provider: "deepseek" })), undefined);
  assert.equal(await helpers.prepareDshNativeCopilotCompactionRuntimeAuth(baseParams({
    harness: { id: "dsh-native", authBootstrap: "harness" },
    runtimeAuthPlan: { modelRoute: { authRequirement: "provider-default" } },
  })), undefined);
  assert.equal(prepareCalls, 0);
  assert.equal(await helpers.prepareDshNativeCopilotCompactionRuntimeAuth(baseParams({
    harness: { id: "other" }, signal: AbortSignal.abort(new Error("non-target abort")),
  })), undefined, "The companion must not change non-target cancellation behavior");
  assert.equal(await helpers.prepareDshNativeCopilotCompactionRuntimeAuth(baseParams()), undefined);
  assert.equal(prepareCalls, 1);

  const throwing = makeHelpers({
    prepareProviderRuntimeAuth: async () => { throw new Error("runtime hook failed"); },
    protectPreparedProviderRuntimeAuth: ({ preparedAuth }) => preparedAuth,
    applyPreparedRuntimeAuthToModel: (model) => model,
    unwrapSecretSentinelsForProviderEgress: (value) => value,
  });
  await assert.rejects(throwing.prepareDshNativeCopilotCompactionRuntimeAuth(baseParams()), /runtime hook failed/);

  const cancelled = makeHelpers({
    prepareProviderRuntimeAuth: async () => ({ apiKey: "derived" }),
    protectPreparedProviderRuntimeAuth: ({ preparedAuth }) => preparedAuth,
    applyPreparedRuntimeAuthToModel: (model) => model,
    unwrapSecretSentinelsForProviderEgress: (value) => value,
  });
  await assert.rejects(cancelled.prepareDshNativeCopilotCompactionRuntimeAuth(baseParams({
    signal: { throwIfAborted: () => { throw new Error("aborted"); } },
  })), /aborted/);
  const controller = new AbortController();
  const aborting = makeHelpers({
    prepareProviderRuntimeAuth: async () => { controller.abort(new Error("revoked during preparation")); return { apiKey: "derived" }; },
    protectPreparedProviderRuntimeAuth: ({ preparedAuth }) => preparedAuth,
    applyPreparedRuntimeAuthToModel: () => assert.fail("Revoked preparation must not reach model handoff"),
    unwrapSecretSentinelsForProviderEgress: (value) => value,
  });
  await assert.rejects(aborting.prepareDshNativeCopilotCompactionRuntimeAuth(baseParams({ signal: controller.signal })),
    /revoked during preparation/u);
});
