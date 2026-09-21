import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import ts from "typescript";

const root = new URL("../dist/", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const url = context.parentURL && new URL(specifier, context.parentURL).href;
    return url?.startsWith(root) && url.endsWith(".js") ? { url, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith(root)) return next(url, context);
    return { format: "module", shortCircuit: true, source: ts.transpileModule(
      readFileSync(new URL(`../src/${url.slice(root.length, -3)}.ts`, import.meta.url), "utf8"),
      { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } },
    ).outputText };
  },
});
const { terminalBudgetUsage } = await import("../dist/bridge/budget-usage.js");
hooks.deregister();

const data = (value) => `data: ${JSON.stringify(value)}\n\n`;
const raw = (responses) => responses ? {
  input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
  output_tokens_details: { reasoning_tokens: 1 }, total_tokens: 15,
} : {
  prompt_tokens: 12, completion_tokens: 3, prompt_cache_hit_tokens: 2, prompt_cache_miss_tokens: 10,
  completion_tokens_details: { reasoning_tokens: 1 }, total_tokens: 15,
};
const wire = (responses, usage) => responses ?
  data({ type: "response.completed", response: { status: "completed", usage } }) :
  data({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }) + "data: [DONE]\n\n";

for (const responses of [false, true]) {
  const provider = responses ? "Responses" : "DeepSeek";
  test(`${provider}: integer aggregate and disjoint cache counts are mandatory`, () => {
    assert.deepEqual(terminalBudgetUsage(wire(responses, raw(responses)), responses),
      { input: responses ? 9 : 10, output: 3, cacheRead: 2, cacheWrite: responses ? 1 : 0 });
    for (const path of responses ?
      [["input_tokens"], ["output_tokens"], ["input_tokens_details", "cached_tokens"], ["input_tokens_details", "cache_write_tokens"]] :
      [["prompt_tokens"], ["completion_tokens"], ["prompt_cache_hit_tokens"], ["prompt_cache_miss_tokens"]]) {
      for (const invalid of [-1, 1.2, "2", null, Number.MAX_SAFE_INTEGER + 1]) {
        const usage = raw(responses);
        const owner = path.length === 2 ? usage[path[0]] : usage;
        owner[path.at(-1)] = invalid;
        assert.throws(() => terminalBudgetUsage(wire(responses, usage), responses), undefined, `${path}: ${invalid}`);
      }
    }
    for (const field of responses ? ["input_tokens", "output_tokens", "input_tokens_details"] :
      ["prompt_tokens", "completion_tokens", "prompt_cache_hit_tokens"]) {
      const usage = raw(responses);
      delete usage[field];
      assert.throws(() => terminalBudgetUsage(wire(responses, usage), responses));
    }
  });

  test(`${provider}: rejects contradictory totals, cache subdivisions and reasoning counts`, () => {
    for (const change of [
      (value) => { value.total_tokens = 1; },
      (value) => { value[responses ? "input_tokens_details" : "completion_tokens_details"] = null; },
      (value) => { value[responses ? "output_tokens_details" : "completion_tokens_details"].reasoning_tokens = 4; },
      (value) => { value[responses ? "output_tokens_details" : "completion_tokens_details"].reasoning_tokens = -1; },
      (value) => { if (responses) value.input_tokens_details.cached_tokens = 13; else value.prompt_cache_hit_tokens = 13; },
    ]) {
      const usage = raw(responses);
      change(usage);
      assert.throws(() => terminalBudgetUsage(wire(responses, usage), responses));
    }
  });

  test(`${provider}: named errors, duplicate terminals, truncation and data after terminal cannot settle`, () => {
    const valid = wire(responses, raw(responses));
    for (const text of [
      `event: error\ndata: {"message":"provider failed"}\n\n${valid}`,
      valid + valid, valid.slice(0, -1), valid + data({ type: "late-event", choices: [] }),
    ]) assert.throws(() => terminalBudgetUsage(text, responses));
  });
}

test("DeepSeek repeated identical terminal usage is a snapshot, not another charge", () => {
  const usage = raw(false);
  const base = data({ choices: [{ index: 0, finish_reason: "stop" }], usage });
  assert.deepEqual(terminalBudgetUsage(base + data({ choices: [], usage }) + "data: [DONE]\n\n", false),
    { input: 10, output: 3, cacheRead: 2, cacheWrite: 0 });
  assert.throws(() => terminalBudgetUsage(base + data({ choices: [], usage: {
    ...usage, completion_tokens: 2, total_tokens: 14,
  } }) + "data: [DONE]\n\n", false), /Conflicting/);
});

test("Responses permits optional final DONE only after validated terminal usage", () => {
  const valid = wire(true, raw(true));
  assert.deepEqual(terminalBudgetUsage(valid + "data: [DONE]\n\n", true),
    { input: 9, output: 3, cacheRead: 2, cacheWrite: 1 });
  assert.throws(() => terminalBudgetUsage("data: [DONE]\n\n" + valid, true));
  assert.throws(() => terminalBudgetUsage(valid + "data: [DONE]\n\ndata: [DONE]\n\n", true));
});

test("explicitly reported zero is not confused with missing usage", () => {
  assert.deepEqual(terminalBudgetUsage(wire(true, {
    input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 }, total_tokens: 0,
  }), true), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.throws(() => terminalBudgetUsage(wire(true, {}), true));
});
