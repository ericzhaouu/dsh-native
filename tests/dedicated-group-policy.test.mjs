import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  assertDedicatedGroupApplied, assertDedicatedGroupsApplied, dedicatedGroupConfigPatch as singlePatch,
  dedicatedGroupsConfigPatch as groupPatches, dedicatedGroupRestorePatch,
  planDedicatedGroupReadOnly as makePlan, loadDedicatedGroupPolicyMatcher,
} from "../scripts/lib/dedicated-group-policy.mjs";

const host = join(dirname(dirname(fileURLToPath(import.meta.url))), "node_modules", "openclaw");
const matcher = await loadDedicatedGroupPolicyMatcher(host);
const { t: applyMergePatch, r: collectBaseArrayPaths } =
  await import(pathToFileURL(join(host, "dist", "merge-patch-DCMj2JVh.js")));
const planDedicatedGroupReadOnly = (config, identity) => makePlan(config, identity, matcher);
const dedicatedGroupConfigPatch = (config, plan, hash, patches) => singlePatch(config, plan, hash, patches, matcher);
const dedicatedGroupsConfigPatch = (config, plans, hash, patches) => groupPatches(config, plans, hash, patches, matcher);
const identity = { agentId: "ruibi", accountId: "ruibi", channel: "feishu", chatId: "oc_SYNTHETIC123",
  botAppId: "synthetic-app", botMemberId: "bot", creatorMemberId: "user",
  exactGroupMembershipVerified: true, userCount: 1, botCount: 1 };
const patches = ["openclaw-native-source-reply-owner-v1", "openclaw-dsh-group-readonly-v1"];
const fixture = () => ({ agents: { entries: { ruibi: {
  runtime: { type: "embedded", harness: "dsh-native" }, workspace: "/synthetic/workspace", tools: { alsoAllow: ["workboard"] },
} } }, channels: { feishu: { accounts: { ruibi: { appId: "synthetic-app" }, unrelated: { enabled: false } } } } });

test("plan and request narrow only the exact dedicated group, never Agent/global configuration", () => {
  const config = fixture(), old = structuredClone(config), plan = planDedicatedGroupReadOnly(config, identity);
  const request = dedicatedGroupConfigPatch(config, plan, "fresh-host-base-hash", patches);
  assert.deepEqual(config, old);
  assert.deepEqual(JSON.parse(request.raw), { channels: { feishu: { groups: {
    oc_SYNTHETIC123: { tools: { allow: ["read", "message"] } },
  } } } });
  assert.deepEqual(request.replacePaths, ["channels.feishu.groups.oc_SYNTHETIC123.tools.allow"]);
  const applied = structuredClone(config);
  applied.channels.feishu.groups = { oc_SYNTHETIC123: plan.after };
  assert.equal(assertDedicatedGroupApplied(config, applied, plan).otherConfigurationUnchanged, true);
  applied.channels.feishu.accounts.unrelated.enabled = true;
  assert.throws(() => assertDedicatedGroupApplied(config, applied, plan), /Changes exceeded/);
});
test("existing restrictions, disabled groups and wildcards cannot be broadened", () => {
  for (const group of [{ tools: { allow: ["read"] } }, { tools: { deny: ["message"] } },
    { tools: { alsoAllow: ["exec"] } }, { enabled: false }]) {
    const config = fixture();
    config.channels.feishu.groups = { [identity.chatId]: group };
    assert.throws(() => planDedicatedGroupReadOnly(config, identity));
  }
  const wildcard = fixture();
  wildcard.channels.feishu.groups = { "*": { tools: { deny: ["read"] } } };
  assert.throws(() => planDedicatedGroupReadOnly(wildcard, identity));
  assert.throws(() => planDedicatedGroupReadOnly(fixture(), { ...identity, chatId: "*" }));
});
test("missing verified group identity or wrong bot/account/harness is not authority", () => {
  for (const change of [{ botAppId: "other" }, { userCount: 2 }, { botCount: 2 },
    { accountId: "unrelated" }, { exactGroupMembershipVerified: false }]) {
    assert.throws(() => planDedicatedGroupReadOnly(fixture(), { ...identity, ...change }));
  }
  const config = fixture();
  config.agents.entries.ruibi.runtime.harness = "openclaw";
  assert.throws(() => planDedicatedGroupReadOnly(config, identity));
});
test("config drift or absent filesystem companion blocks the apply request", () => {
  const config = fixture(), plan = planDedicatedGroupReadOnly(config, identity);
  assert.throws(() => dedicatedGroupConfigPatch(config, plan, "base", [patches[0]]), /companions missing/);
  config.channels.feishu.accounts.unrelated.enabled = true;
  assert.throws(() => dedicatedGroupConfigPatch(config, plan, "base", patches), /Configuration changed/);
});
test("restore keeps unrelated changes but refuses to overwrite a changed owned policy", () => {
  const config = fixture();
  config.channels.feishu.groups = { [identity.chatId]: { requireMention: false } };
  const plan = planDedicatedGroupReadOnly(config, identity);
  config.channels.feishu.groups = { [identity.chatId]: { ...structuredClone(plan.after), requireMention: true } };
  config.channels.feishu.accounts.unrelated.enabled = true;
  const restore = dedicatedGroupRestorePatch(config, plan, "latest");
  assert.deepEqual(JSON.parse(restore.raw), { channels: { feishu: { groups: {
    [identity.chatId]: { tools: null },
  } } } });
  config.channels.feishu.groups[identity.chatId].tools.deny = ["message"];
  assert.throws(() => dedicatedGroupRestorePatch(config, plan, "latest"), /later operator edit/);
});
test("two dedicated group restrictions use one fresh host CAS without global permission changes", () => {
  const config = fixture();
  const plans = [planDedicatedGroupReadOnly(config, identity),
    planDedicatedGroupReadOnly(config, { ...identity, chatId: "oc_SECONDTEST" })];
  const request = dedicatedGroupsConfigPatch(config, plans, "fresh", patches);
  assert.equal(Object.keys(JSON.parse(request.raw).channels.feishu.groups).length, 2);
  assert.equal(request.replacePaths.length, 2);
  const after = structuredClone(config);
  after.channels.feishu.groups = Object.fromEntries(plans.map((plan) => [plan.identity.chatId, plan.after]));
  assert.equal(assertDedicatedGroupsApplied(config, after, plans).changedGroups, 2);
  assert.throws(() => dedicatedGroupsConfigPatch(config, [plans[0], plans[0]], "fresh", patches), /Duplicate/);
});
test("real host glob, group and normalized denials remain denied before an exact group override", () => {
  for (const deny of [["r*"], ["m*"], ["group:openclaw"], [" Read "], ["MESSAGE"], ["group:fs"]]) {
    const config = fixture();
    config.channels.feishu.groups = { "*": { tools: { deny } } };
    assert.ok(["read", "message"].some((name) => !matcher(name, { deny })));
    assert.throws(() => planDedicatedGroupReadOnly(config, identity), /effective group policy/);
  }
});
test("real merge-patch restoration deletes additions and declares exact affected arrays", () => {
  for (const previous of [undefined, { requireMention: false }, { tools: { deny: ["exec"] } },
    { tools: { allow: ["*"], deny: ["exec"] } }]) {
    const config = fixture();
    config.channels.feishu.groups = { "*": { tools: { deny: ["write", "exec"] } },
      ...(previous ? { [identity.chatId]: previous } : {}) };
    const plan = planDedicatedGroupReadOnly(config, identity);
    const request = dedicatedGroupConfigPatch(config, plan, "apply-hash", patches);
    const applied = applyMergePatch(config, JSON.parse(request.raw), {
      replaceArrayPaths: new Set(request.replacePaths),
    });
    assertDedicatedGroupApplied(config, applied, plan);
    const restore = dedicatedGroupRestorePatch(applied, plan, "restore-hash");
    for (const path of collectBaseArrayPaths(plan.after.tools, plan.path)) assert.ok(restore.replacePaths.includes(path));
    const restored = applyMergePatch(applied, JSON.parse(restore.raw), {
      replaceArrayPaths: new Set(restore.replacePaths),
    });
    assert.deepEqual(restored, config);
  }
});
test("a newly introduced group with concurrent fields cannot be deleted on rollback", () => {
  const config = fixture(), plan = planDedicatedGroupReadOnly(config, identity);
  config.channels.feishu.groups = { [identity.chatId]: { ...structuredClone(plan.after), requireMention: true } };
  assert.throws(() => dedicatedGroupRestorePatch(config, plan, "base"), /later changes/);
});
