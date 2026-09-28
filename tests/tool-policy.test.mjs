import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv from "ajv";
import { parseDshConfig } from "../dist/config.js";
import { resolveAgentToolPolicy } from "../dist/tool-policy.js";

const globalTools = ["read", "write", "edit", "apply_patch", "exec", "process", "web_search", "web_fetch"];
const resource = () => ({
  source: { kind: "plugin", pluginId: "feishu" }, accountId: "fixture_account", groupId: "oc_synthetic",
  appToken: "synthetic_app", tableId: "tbl_synthetic", recordIds: ["rec_synthetic"],
  fields: { Status: "string", Count: "number", Checked: "boolean" },
  operations: ["get_record", "update_record"], maxBatchSize: 1,
});
const scoped = () => ({
  toolAllowlist: globalTools,
  toolAllowlistByAgent: { "dsh-acceptance-writer": ["feishu_bitable_get_record", "feishu_bitable_update_record"] },
  bitablePolicyByAgent: { "dsh-acceptance-writer": resource() },
});

test("per-Agent candidates replace defaults; absent/unmatched are byte-compatible and empty is explicit", () => {
  const legacy = parseDshConfig({ toolAllowlist: globalTools });
  const next = parseDshConfig(scoped());
  for (const agent of ["daily_assistant", "think_partner", "dsh-acceptance-assistant", "dsh-acceptance-partner"]) {
    assert.deepEqual(resolveAgentToolPolicy(next, agent), resolveAgentToolPolicy(legacy, agent));
    assert.equal(resolveAgentToolPolicy(next, agent).fingerprint, undefined);
  }
  assert.deepEqual(resolveAgentToolPolicy(next, "dsh-acceptance-writer").toolAllowlist,
    ["feishu_bitable_get_record", "feishu_bitable_update_record"]);
  assert.deepEqual(resolveAgentToolPolicy(parseDshConfig({ toolAllowlistByAgent: { target: [] } }), "target").toolAllowlist, []);
  assert.equal(resolveAgentToolPolicy(parseDshConfig({ toolAllowlistByAgent: { target: [] } }), "other").toolAllowlist, undefined);
  assert.equal(resolveAgentToolPolicy(parseDshConfig({})).fingerprint, undefined);
});

test("scoped config and manifest reject wildcards, duplicate names, prototype keys and invalid Agent IDs", async () => {
  const { configSchema } = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  const validate = new Ajv().compile(configSchema);
  for (const key of ["*", "Target", "target x", "__proto__", "prototype", "constructor", "target*"]) {
    const value = { toolAllowlistByAgent: Object.fromEntries([[key, ["read"]]]) };
    assert.equal(validate(value), false, key);
    assert.throws(() => parseDshConfig(value));
  }
  for (const names of [["*"], ["read", "read"], ["__proto__"], ["prototype"], ["constructor"], ["run_code"], ["a.b"]]) {
    const value = { toolAllowlistByAgent: { target: names } };
    assert.equal(validate(value), false);
    assert.throws(() => parseDshConfig(value));
  }
  for (const value of [
    Object.create({ target: ["read"] }),
    Object.defineProperty({}, "target", { enumerable: true, get() { throw new Error("getter ran"); } }),
    { target: Object.assign(["read"], { extra: true }) }, { target: Array(1) },
  ]) assert.throws(() => parseDshConfig({ toolAllowlistByAgent: value }), (error) => !error.message.includes("getter ran"));
  assert.throws(() => parseDshConfig(Object.create({ toolAllowlistByAgent: { target: ["read"] } })), /scope/);
  assert.throws(() => parseDshConfig(Object.defineProperty({}, "toolAllowlistByAgent", {
    enumerable: true, get() { throw new Error("getter ran"); },
  })), /scope/);
  assert.equal(validate(scoped()), true, JSON.stringify(validate.errors));
  assert.equal(validate({ toolAllowlistByAgent: { target: [] } }), true);
  assert.deepEqual(resolveAgentToolPolicy(parseDshConfig({ toolAllowlistByAgent: {} })),
    resolveAgentToolPolicy(parseDshConfig({})));
});

test("missing or malformed trusted identity cannot fall back to a global list", () => {
  for (const id of [undefined, "", "*", "target\n", "constructor"]) {
    assert.throws(() => resolveAgentToolPolicy(parseDshConfig({ toolAllowlistByAgent: { target: [] } }), id), /scope/);
  }
});

test("preparation derives implicit execution ceiling but intersects an explicitly configured one", () => {
  const raw = { toolAllowlist: ["read", "web_search"], toolAllowlistByAgent: { target: ["lookup"] },
    taskPreparation: { agentIds: ["target", "other"] } };
  const config = parseDshConfig(raw);
  assert.deepEqual(resolveAgentToolPolicy(config, "target").preparationPolicy.executionTools, ["lookup"]);
  assert.deepEqual(resolveAgentToolPolicy(config, "other").preparationPolicy.executionTools, ["read", "web_search"]);
  const explicit = parseDshConfig({ ...raw, taskPreparation: { ...raw.taskPreparation, executionTools: ["read", "web_search"] } });
  assert.deepEqual(resolveAgentToolPolicy(explicit, "target").preparationPolicy.executionTools, []);
  const empty = parseDshConfig({ ...raw, toolAllowlistByAgent: { target: [] } });
  assert.deepEqual(resolveAgentToolPolicy(empty, "target").preparationPolicy.executionTools, []);
});

test("policy fingerprint follows only the selected Agent and effective policy, not unrelated Agents", () => {
  const first = parseDshConfig(scoped());
  const hash = resolveAgentToolPolicy(first, "dsh-acceptance-writer").fingerprint;
  assert.match(hash, /^[a-f0-9]{64}$/);
  const changed = scoped();
  changed.toolAllowlistByAgent.other = ["lookup"];
  changed.toolAllowlist = ["exec"];
  assert.equal(resolveAgentToolPolicy(parseDshConfig(changed), "dsh-acceptance-writer").fingerprint, hash);
  changed.bitablePolicyByAgent["dsh-acceptance-writer"].tableId = "tbl_another_synthetic";
  assert.notEqual(resolveAgentToolPolicy(parseDshConfig(changed), "dsh-acceptance-writer").fingerprint, hash);
  const reordered = scoped();
  reordered.toolAllowlistByAgent["dsh-acceptance-writer"].reverse();
  reordered.bitablePolicyByAgent["dsh-acceptance-writer"].operations.reverse();
  assert.equal(resolveAgentToolPolicy(parseDshConfig(reordered), "dsh-acceptance-writer").fingerprint, hash);
});

test("resource policy rejects alternate tools, field aliases, batch/admin operations and missing exact override", () => {
  for (const edit of [
    (raw) => { delete raw.toolAllowlistByAgent; },
    (raw) => { delete raw.bitablePolicyByAgent; },
    (raw) => { raw.toolAllowlistByAgent["dsh-acceptance-writer"].push("exec"); },
    (raw) => { raw.toolAllowlistByAgent["dsh-acceptance-writer"].push("web_fetch"); },
    (raw) => { raw.bitablePolicyByAgent["dsh-acceptance-writer"].operations.push("delete_record"); },
    (raw) => { raw.bitablePolicyByAgent["dsh-acceptance-writer"].maxBatchSize = 2; },
    (raw) => { raw.bitablePolicyByAgent["dsh-acceptance-writer"].fields.fldAlias = "string"; },
    (raw) => { raw.bitablePolicyByAgent["dsh-acceptance-writer"].fields.Status = "object"; },
    (raw) => { raw.bitablePolicyByAgent["dsh-acceptance-writer"].recordIds = ["rec_synthetic", "rec_synthetic"]; },
  ]) {
    const raw = scoped(); edit(raw);
    assert.throws(() => parseDshConfig(raw), /scope/);
  }
});
