import assert from "node:assert/strict";
import test from "node:test";
import { createPreparationGate, filterPreparationSkills } from "../dist/native/preparation.js";
import { parseTaskPreparationConfig, resolvePreparationPolicy, resolvePreparationDecision } from "../dist/preparation.js";

function resolution(mode = "execute", maxToolCalls = 2) {
  const policy = resolvePreparationPolicy(parseTaskPreparationConfig({
    agentIds: ["experiment"], executionTools: ["read", "write"], maxToolCalls,
  }), "experiment");
  const request = { version: 1, policy, userText: "Create a local report." };
  const decision = {
    version: 1, revision: 0, mode, task: mode === "chat" ? "none" : "new",
    goal: mode === "chat" ? "" : "Create a report",
    deliverables: mode === "chat" ? [] : ["report.txt"],
    constraints: ["Local files only"], assumptions: [], unresolved: mode === "clarify" ? ["Report subject"] : [],
    question: mode === "clarify" ? "What is the report about?" : "",
    enhancedPrompt: mode === "chat" ? "" : "Create report.txt within the workspace.",
    evidence: { source: "current", quote: "Create a local report." },
  };
  return { policy, value: resolvePreparationDecision(request, decision, "run-1", ["read", "write"]) };
}

test("preparation gate starts closed and keeps non-execution decisions tool-free", () => {
  for (const mode of ["chat", "clarify", "draft", "execute"]) {
    const { policy, value } = resolution(mode);
    const gate = createPreparationGate(policy);
    assert.throws(() => gate.assertAllowed("read"), /not authorized/);
    gate.resolve(value);
    if (mode === "execute") {
      assert.doesNotThrow(() => gate.start("write"));
      assert.throws(() => gate.start("exec"), /not authorized/);
    } else assert.throws(() => gate.start("read"), /not authorized/);
    assert.throws(() => gate.resolve(value), /cannot be replaced/);
  }
});

test("the host gate independently enforces the tool ceiling and call budget", () => {
  const { policy, value } = resolution("execute", 1);
  const gate = createPreparationGate(policy);
  assert.throws(() => gate.resolve({ ...value, allowedTools: ["exec"] }), /ceiling/);
  gate.resolve(value);
  gate.assertAllowed("read");
  gate.start("read");
  assert.throws(() => gate.start("write"), /budget exhausted/);
});

test("preparation skill catalog is explicit, exact-name scoped and empty by default", () => {
  const prompt = [
    "Unfiltered catalog instructions must not survive.",
    "<available_skills>",
    "<skill><name>local-helper</name><description>Local coding</description><location>local/SKILL.md</location></skill>",
    "<skill><name>web-helper</name><description>Requires unavailable browser</description><location>web/SKILL.md</location></skill>",
    "</available_skills>",
  ].join("\n");
  assert.equal(filterPreparationSkills(prompt, []), undefined);
  assert.equal(filterPreparationSkills(undefined, ["local-helper"]), undefined);
  assert.equal(filterPreparationSkills(prompt, ["local"]), undefined);
  assert.equal(filterPreparationSkills("unstructured skill text", ["local-helper"]), undefined);
  const filtered = filterPreparationSkills(prompt, ["local-helper"]);
  assert.match(filtered, /<name>local-helper<\/name>/);
  assert.doesNotMatch(filtered, /web-helper|Unfiltered catalog/);
  assert.match(filtered, /guidance, not permission/);
});
