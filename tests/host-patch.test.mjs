import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspectHost, patchHost } from "../host-patch/apply.mjs";
import { edits, PATCH_ID, replaceExactly, transform } from "../host-patch/spec.mjs";

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const genuineHost = join(project, "node_modules", "openclaw");
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "dsh-host-patch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.9.2" }));
  for (const edit of edits) {
    const dest = join(root, ...edit.file.split("/"));
    await mkdir(dirname(dest), { recursive: true });
    await cp(join(genuineHost, ...edit.file.split("/")), dest);
  }
  return root;
}

test("checks the exact host artifact without writes, then applies and restores reversibly", async (t) => {
  const root = await fixture(t);
  assert.equal((await patchHost(root)).status, "unpatched");
  await assert.rejects(patchHost(root, { action: "apply" }), /offline-confirmed/);
  assert.equal((await patchHost(root, { action: "apply", offlineConfirmed: true })).status, "applied");
  assert.equal((await patchHost(root)).status, "applied");
  assert.equal((await patchHost(root, { action: "apply", offlineConfirmed: true })).status, "applied");
  assert.equal((await patchHost(root, { action: "restore", offlineConfirmed: true })).status, "unpatched");
  for (const edit of edits) assert.equal(hash(await readFile(join(root, ...edit.file.split("/")))), edit.sha256);
});

test("refuses unsupported versions or modified files before writing any patch", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.9.3" }));
  await assert.rejects(patchHost(root, { action: "apply", offlineConfirmed: true }), /exact OpenClaw/);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.9.2" }));
  const changed = join(root, ...edits.at(-1).file.split("/"));
  await writeFile(changed, (await readFile(changed)) + "\n// local change\n");
  await assert.rejects(patchHost(root, { action: "apply", offlineConfirmed: true }), /local changes/);
  assert.equal(hash(await readFile(join(root, ...edits[0].file.split("/")))), edits[0].sha256);
});

test("refuses restoration over later edits and detects backup corruption", async (t) => {
  const root = await fixture(t);
  await patchHost(root, { action: "apply", offlineConfirmed: true });
  const first = join(root, ...edits[0].file.split("/"));
  const expected = await readFile(first);
  await writeFile(first, Buffer.concat([expected, Buffer.from("\n// subsequent change\n")]));
  await assert.rejects(patchHost(root, { action: "restore", offlineConfirmed: true }), /local changes/);
  await writeFile(first, expected);
  const backup = join(root, ".dsh-agent-harness-patch", ...edits[0].file.split("/"));
  await writeFile(backup, "bad backup");
  await assert.rejects(inspectHost(root), /backup is corrupt/);
});

test("transforms are exact and reject ambiguous anchors", () => {
  assert.throws(() => replaceExactly("a a", "a", "b", "fixture"), /one patch anchor/);
  assert.throws(() => replaceExactly("a", "missing", "b", "fixture"), /one patch anchor/);
});

test("refuses a backup-directory junction instead of writing outside the host", async (t) => {
  const root = await fixture(t);
  const elsewhere = await mkdtemp(join(tmpdir(), "dsh-host-outside-"));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  await symlink(elsewhere, join(root, ".dsh-agent-harness-patch"), "junction");
  await assert.rejects(patchHost(root, { action: "apply", offlineConfirmed: true }), /real directory/);
});

test("recovers a confirmed dead owner but never steals a live patch lock", async (t) => {
  const root = await fixture(t);
  const lock = join(root, ".dsh-agent-harness-patch.lock");
  await writeFile(lock, JSON.stringify({ pid: process.pid, hostname: hostname(), patchId: PATCH_ID }));
  await assert.rejects(patchHost(root, { action: "apply", offlineConfirmed: true, recoverStaleLock: true }), /still alive/);
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  await writeFile(lock, JSON.stringify({ pid: child.pid, hostname: hostname(), patchId: PATCH_ID }));
  await assert.rejects(patchHost(root, { action: "apply", offlineConfirmed: true }), /lock exists/);
  assert.equal((await patchHost(root, { action: "apply", offlineConfirmed: true, recoverStaleLock: true })).status, "applied");
  assert.equal((await patchHost(root, { action: "restore", offlineConfirmed: true })).status, "unpatched");
});

test("an interrupted transaction with mixed known file states can be restored", async (t) => {
  const root = await fixture(t);
  await patchHost(root, { action: "apply", offlineConfirmed: true });
  const first = edits[0];
  await cp(join(root, ".dsh-agent-harness-patch", ...first.file.split("/")), join(root, ...first.file.split("/")));
  assert.equal((await patchHost(root)).status, "partial");
  assert.equal((await patchHost(root, { action: "restore", offlineConfirmed: true })).status, "unpatched");
});

test("Agent policy wins across models/providers but leaves other Agents and default model untouched", async () => {
  const edit = edits.find((entry) => entry.file.includes("model-runtime-policy-"));
  const original = await readFile(join(genuineHost, ...edit.file.split("/")), "utf8");
  const patched = transform(original, edit).replace(/^import .*;\n/gm, "").replace(/^export .*;\n?/gm, "");
  // Dependency seams are pure identity/catalog operations; execute the real
  // transformed policy function, not a second policy implementation.
  const resolve = new Function("resolveAgentEntry", "resolveSessionAgentIds", "tryResolveLegacyCompatibilityAgentId",
    "normalizeProviderId", "parseModelCatalogRef", `${patched}\nreturn resolveModelRuntimePolicy;`)(
    (cfg, id) => cfg.agents.entries[id],
    (p) => {
      const fromKey = p.sessionKey?.split(":")[1];
      if (fromKey && p.agentId && fromKey !== p.agentId) throw new Error("mismatched agent identity");
      return { sessionAgentId: p.agentId ?? fromKey };
    },
    () => "main",
    (id) => id.toLowerCase(),
    (ref) => ref.includes("/") ? { provider: ref.slice(0, ref.indexOf("/")), modelId: ref.slice(ref.indexOf("/") + 1) } : undefined,
  );
  const config = {
    agents: {
      defaults: {
        model: { primary: "github-copilot/gpt-6-astra", fallbacks: ["microsoft-foundry/gpt-5.6-sol"] },
        models: { "github-copilot/gpt-6-astra": { agentRuntime: { id: "copilot" } } },
      },
      entries: {
        main: {},
        "dsh-experiment": {
          runtime: { type: "embedded", harness: "dsh-native" },
          models: { "deepseek/deepseek-v4-pro": { agentRuntime: { id: "openclaw" } } },
        },
      },
    },
    models: { providers: { "microsoft-foundry": { agentRuntime: { id: "openclaw" } } } },
  };
  const before = structuredClone(config);
  for (const [provider, modelId] of [
    ["github-copilot", "gpt-6-astra"], ["github-copilot", "gpt-5.6-sol"],
    ["deepseek", "deepseek-v4-pro"], ["microsoft-foundry", "gpt-5.6-sol"],
    ["new-provider", "new-model"],
  ]) {
    assert.deepEqual(resolve({ config, agentId: "dsh-experiment", provider, modelId }),
      { policy: { id: "dsh-native" }, source: "agent" });
  }
  assert.equal(resolve({ config, agentId: "main", provider: "github-copilot", modelId: "gpt-6-astra" }).policy.id, "copilot");
  assert.deepEqual(resolve({ config, agentId: "main", provider: "new-provider", modelId: "new-model" }), {});
  assert.deepEqual(config, before);
  assert.throws(() => resolve({ config, agentId: "main", sessionKey: "agent:dsh-experiment:one" }), /mismatched/);
});
