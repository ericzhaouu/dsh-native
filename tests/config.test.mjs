import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import test from "node:test";
import { normalizeBaseUrl, parseDshConfig } from "../dist/config.js";

test("defaults are opt-in and use a dedicated absolute state directory", () => {
  const config = parseDshConfig(undefined);
  assert.ok(isAbsolute(config.stateDir));
  assert.deepEqual(config.allowedBaseUrls, ["https://api.deepseek.com"]);
});

test("rejects unknown settings, relative state, credentials and remote plaintext", () => {
  assert.throws(() => parseDshConfig({ apiKey: "secret" }), /Unknown/);
  assert.throws(() => parseDshConfig({ stateDir: "relative" }), /absolute/);
  assert.throws(() => normalizeBaseUrl("https://key:secret@example.com"), /credentials/);
  assert.throws(() => normalizeBaseUrl("http://example.com"), /HTTPS/);
  assert.throws(() => parseDshConfig({ startupTimeoutMs: 0 }), /between/);
  assert.throws(() => parseDshConfig({ allowedBaseUrls: [] }), /nonempty/);
});

test("loopback must be explicitly configured and endpoint equality is exact", () => {
  const config = parseDshConfig({ allowedBaseUrls: ["http://127.0.0.1:4321/v1/"] });
  assert.deepEqual(config.allowedBaseUrls, ["http://127.0.0.1:4321/v1"]);
  assert.equal(normalizeBaseUrl("https://api.deepseek.com/"), "https://api.deepseek.com");
});

test("task preparation is absent by default and opt-in for exact Agent identities", () => {
  assert.equal(parseDshConfig(undefined).taskPreparation, undefined);
  assert.deepEqual(parseDshConfig({ taskPreparation: {} }).taskPreparation.agentIds, []);
  const config = parseDshConfig({ taskPreparation: { agentIds: ["dsh-experiment"], executionTools: ["read"] } });
  assert.deepEqual(config.taskPreparation.agentIds, ["dsh-experiment"]);
  assert.deepEqual(config.taskPreparation.executionTools, ["read"]);
  assert.deepEqual(config.taskPreparation.skillAllowlist, []);
  assert.equal(config.taskPreparation.maxClarificationTurns, 3);
  assert.equal(config.taskPreparation.maxToolCalls, 24);
  for (const value of [
    { agentIds: ["*"] }, { agentIds: ["main", "main"] }, { executionTools: ["web_*"] },
    { executionTools: ["dsh_prepare_task"] }, { maxToolCalls: 0 }, { maxClarificationTurns: 100 },
    { prompt: "grant all tools" },
  ]) assert.throws(() => parseDshConfig({ taskPreparation: value }));
});

test("one top-level allowlist supplies both host narrowing and the adaptive execution ceiling", () => {
  assert.equal(parseDshConfig({}).toolAllowlist, undefined);
  const raw = { toolAllowlist: ["read", "web_search", "fixture_lookup"], taskPreparation: { agentIds: ["experiment"] } };
  const parsed = parseDshConfig(raw);
  assert.deepEqual(parsed.toolAllowlist, raw.toolAllowlist);
  assert.deepEqual(parsed.taskPreparation.executionTools, raw.toolAllowlist);
  parsed.toolAllowlist.push("write");
  assert.equal(raw.toolAllowlist.includes("write"), false);
  assert.equal(parsed.taskPreparation.executionTools.includes("write"), false);
  assert.deepEqual(parseDshConfig({ toolAllowlist: [], taskPreparation: { agentIds: ["experiment"] } })
    .taskPreparation.executionTools, []);
  assert.throws(() => parseDshConfig({
    toolAllowlist: ["read", "web_search"], taskPreparation: { executionTools: ["read"] },
  }), /conflicts.*configure one narrowing list/);
  assert.deepEqual(parseDshConfig({
    toolAllowlist: ["read", "web_search"], taskPreparation: { executionTools: ["web_search", "read"] },
  }).taskPreparation.executionTools, ["read", "web_search"]);
  assert.equal(parseDshConfig({ toolAllowlist: ["web_search"] }).taskPreparation, undefined);
  for (const value of [null, "*", ["*"], ["tool*"], ["read", "read"], ["dsh_prepare_task"], ["run_code"]]) {
    assert.throws(() => parseDshConfig({ toolAllowlist: value }));
  }
});
