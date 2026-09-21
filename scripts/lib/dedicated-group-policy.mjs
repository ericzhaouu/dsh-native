import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const TOOLS = Object.freeze(["read", "message"]);
const COMPANIONS = Object.freeze(["openclaw-native-source-reply-owner-v1", "openclaw-dsh-group-readonly-v1"]);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const policyPins = {
  "tool-policy-match-TnFxBs5z.js": "ec36bf800a6abf56b7657be76853b550693987ea7301a9730cdeae65e7f47678",
  "tool-policy-shared-DIyS0iQC.js": "89ae1175ba02a184d7799f2a43ceb85ce49a3838b42e1473a18d34eb47e28d69",
  "glob-pattern-DFVWJ-hh.js": "7e6bbeaffda846ce1af6d0a00f0cd8f0aa391bbced638a21c9714bc0e0506957",
  "tool-catalog-79RBtNnN.js": "7903c26535f06cd48906466bc28ac0d7662d9ea561a4301d1b503644e3f4560d",
};

export async function loadDedicatedGroupPolicyMatcher(hostRoot) {
  const pkg = JSON.parse(await readFile(join(hostRoot, "package.json"), "utf8"));
  assert.equal(pkg.name, "openclaw");
  assert.equal(pkg.version, "2026.9.2");
  for (const [file, expected] of Object.entries(policyPins)) {
    const bytes = await readFile(join(hostRoot, "dist", file));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, "Host policy helper changed");
  }
  const { o: isToolAllowedByPolicyName } = await import(pathToFileURL(join(hostRoot, "dist", "tool-policy-match-TnFxBs5z.js")));
  assert.equal(typeof isToolAllowedByPolicyName, "function");
  return isToolAllowedByPolicyName;
}

function assertUnrestrictedOrSafe(policy, matchesPolicy) {
  if (policy === undefined) return;
  assert.ok(record(policy), "Invalid existing group tool policy");
  assert.ok(policy.allow === undefined || Array.isArray(policy.allow), "Invalid existing allowlist");
  assert.ok(policy.deny === undefined || Array.isArray(policy.deny), "Invalid existing tool denylist");
  assert.ok(TOOLS.every((name) => matchesPolicy(name, policy)), "Do not widen an existing effective group policy");
  assert.ok(policy.alsoAllow === undefined || Array.isArray(policy.alsoAllow) &&
    policy.alsoAllow.every((name) => TOOLS.includes(name)),
  "Existing group alsoAllow exceeds the read-only ceiling");
}

function scope(config, identity, matchesPolicy) {
  assert.equal(typeof matchesPolicy, "function", "Load the pinned host tool-policy matcher");
  assert.equal(identity.channel, "feishu");
  assert.match(identity.chatId, /^oc_[A-Za-z0-9]+$/);
  for (const key of ["agentId", "accountId"]) assert.match(identity[key], /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
  const agent = config.agents?.entries?.[identity.agentId];
  const channel = config.channels?.feishu;
  const account = channel?.accounts?.[identity.accountId];
  assert.equal(agent?.runtime?.type, "embedded");
  assert.equal(agent.runtime.harness, "dsh-native");
  assert.ok(typeof agent.workspace === "string" && agent.workspace.trim());
  assert.ok(typeof identity.botAppId === "string" && identity.botAppId.length > 0);
  assert.equal(account?.appId, identity.botAppId, "Account does not own the verified group bot");
  assert.equal(identity.exactGroupMembershipVerified, true, "Verify dedicated group members before planning");
  assert.equal(identity.userCount, 1);
  assert.equal(identity.botCount, 1);
  assert.ok(identity.creatorMemberId && identity.botMemberId && identity.creatorMemberId !== identity.botMemberId);
  assert.ok(channel.groups === undefined || record(channel.groups));
  const group = channel.groups?.[identity.chatId];
  assert.ok(group === undefined || record(group));
  assert.notEqual(group?.enabled, false, "Do not enable a disabled conversation through a test policy");
  assertUnrestrictedOrSafe(channel.groups?.["*"]?.tools, matchesPolicy);
  assertUnrestrictedOrSafe(group?.tools, matchesPolicy);
  return { group, workspace: agent.workspace };
}

export function planDedicatedGroupReadOnly(config, identity, matchesPolicy) {
  const { group, workspace } = scope(config, identity, matchesPolicy);
  const before = group === undefined ? null : structuredClone(group);
  const after = { ...(before ?? {}), tools: { ...(before?.tools ?? {}), allow: [...TOOLS] } };
  return {
    schemaVersion: 1, kind: "dedicated-feishu-readonly-ceiling",
    identity: structuredClone(identity), workspace, configSha256: digest(config),
    path: `channels.feishu.groups.${identity.chatId}.tools`,
    before, after,
    requiredCompanions: [...COMPANIONS],
    modelTools: ["read"], privateCurrentSourceReply: true,
    changesGlobalAgentPolicy: false, changesOtherChats: false,
    note: "The private workspace guard is required; group tool names alone do not establish filesystem containment.",
  };
}

function assertPlan(plan) {
  assert.equal(plan?.schemaVersion, 1);
  assert.equal(plan.kind, "dedicated-feishu-readonly-ceiling");
  assert.deepEqual(plan.after?.tools?.allow, TOOLS);
  assert.deepEqual(plan.requiredCompanions, COMPANIONS);
  assert.equal(plan.path, `channels.feishu.groups.${plan.identity.chatId}.tools`);
  assert.match(plan.configSha256, /^[a-f0-9]{64}$/);
}

export function dedicatedGroupConfigPatch(config, plan, baseHash, appliedPatchIds, matchesPolicy) {
  assertPlan(plan);
  assert.ok(typeof baseHash === "string" && baseHash.length > 0, "Use the current host config.get baseHash");
  assert.equal(digest(config), plan.configSha256, "Configuration changed after planning");
  scope(config, plan.identity, matchesPolicy);
  assert.ok(plan.requiredCompanions.every((id) => appliedPatchIds.includes(id)), "Required host containment/reply companions missing");
  const current = config.channels.feishu.groups?.[plan.identity.chatId] ?? null;
  assert.ok(isDeepStrictEqual(current, plan.before), "Dedicated group changed after planning");
  return {
    raw: JSON.stringify({ channels: { feishu: { groups: { [plan.identity.chatId]: {
      tools: { allow: [...TOOLS] },
    } } } } }),
    baseHash, replacePaths: [`${plan.path}.allow`],
    note: "Apply explicit dedicated-test read-only ceiling; no agent-global or unrelated chat change",
  };
}

export function assertDedicatedGroupApplied(beforeConfig, afterConfig, plan) {
  assertPlan(plan);
  const expected = structuredClone(beforeConfig);
  expected.channels.feishu.groups ??= {};
  expected.channels.feishu.groups[plan.identity.chatId] = structuredClone(plan.after);
  assert.deepEqual(afterConfig, expected, "Changes exceeded the exact approved group tools field");
  return { configSha256: digest(afterConfig), ownedPath: plan.path, otherConfigurationUnchanged: true };
}

export function dedicatedGroupsConfigPatch(config, plans, baseHash, appliedPatchIds, matchesPolicy) {
  assert.ok(Array.isArray(plans) && plans.length > 0 && plans.length <= 2, "Expected one or two dedicated groups");
  assert.equal(new Set(plans.map((plan) => plan.identity.chatId)).size, plans.length, "Duplicate group proposal");
  const requests = plans.map((plan) => dedicatedGroupConfigPatch(config, plan, baseHash, appliedPatchIds, matchesPolicy));
  return {
    raw: JSON.stringify({ channels: { feishu: { groups: Object.assign({},
      ...requests.map((request) => JSON.parse(request.raw).channels.feishu.groups),
    ) } } }),
    baseHash, replacePaths: requests.flatMap((request) => request.replacePaths),
    note: "Atomically narrow only the explicitly verified dedicated test groups",
  };
}

export function assertDedicatedGroupsApplied(beforeConfig, afterConfig, plans) {
  const expected = structuredClone(beforeConfig);
  expected.channels.feishu.groups ??= {};
  for (const plan of plans) {
    assertPlan(plan);
    assert.equal(digest(beforeConfig), plan.configSha256, "Mixed configuration baselines");
    expected.channels.feishu.groups[plan.identity.chatId] = structuredClone(plan.after);
  }
  assert.deepEqual(afterConfig, expected, "Changes exceeded the approved dedicated groups");
  return { configSha256: digest(afterConfig), changedGroups: plans.length, otherConfigurationUnchanged: true };
}

export function dedicatedGroupRestorePatch(current, plan, baseHash) {
  assertPlan(plan);
  assert.ok(typeof baseHash === "string" && baseHash.length > 0);
  const group = current.channels?.feishu?.groups?.[plan.identity.chatId];
  assert.ok(group && isDeepStrictEqual(group.tools, plan.after.tools),
    "Owned group policy changed; do not overwrite a later operator edit");
  let restored;
  if (plan.before === null) {
    assert.ok(isDeepStrictEqual(group, plan.after), "New group received later changes; refusing to delete them");
    restored = null;
  } else if (plan.before.tools === undefined) {
    restored = { tools: null };
  } else {
    const tools = structuredClone(plan.before.tools);
    for (const key of Object.keys(plan.after.tools)) {
      if (!Object.hasOwn(tools, key)) tools[key] = null;
    }
    restored = { tools };
  }
  const arrayPaths = (value, path) => Array.isArray(value) ? [path] : record(value)
    ? Object.entries(value).flatMap(([key, child]) => arrayPaths(child, `${path}.${key}`)) : [];
  return {
    raw: JSON.stringify({ channels: { feishu: { groups: { [plan.identity.chatId]: restored } } } }),
    baseHash, replacePaths: [...new Set([
      ...arrayPaths(plan.after.tools, plan.path), ...arrayPaths(plan.before?.tools, plan.path),
    ])],
    note: "Restore only the unchanged owned test policy; preserve all later unrelated changes",
  };
}
