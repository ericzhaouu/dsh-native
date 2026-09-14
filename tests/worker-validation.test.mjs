import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import {
  emptyParams, jsonObject, keys, parseRun, parseToolResult, positiveInteger, record,
} from "../dist/bridge/validation.js";

const tool = (overrides = {}) => ({
  name: "host_read",
  description: "Read a workspace file",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
  ...overrides,
});
const run = (overrides = {}) => ({
  sessionId: "worker-validation_1",
  resume: false,
  workspaceDir: process.cwd(),
  systemPrompt: "Use only the supplied host tools.",
  prompt: "Read the requested file.",
  modelId: "deepseek-chat",
  tools: [tool()],
  ...overrides,
});
const nonRecords = [
  undefined, null, [], [{}], "", "{}", 0, 1, NaN, Infinity, false, true,
  1n, Symbol("value"), () => {}, new Date(0), new Map(), new Set(),
  new String("object"), new Number(1), new Boolean(false),
  new (class Payload {})(), Object.create({ inherited: true }),
];
const nonStrings = [undefined, null, [], {}, 0, false, 1n, Symbol("text"), new String("text")];
const invalidPositiveIntegers = [
  undefined, null, [], {}, "", "1", false, true, 0, -0, -1, 0.5,
  NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, 1n, new Number(1),
];
const nonJsonValues = [
  undefined, NaN, Infinity, -Infinity, 1n, Symbol("value"), () => {},
  new Date(0), new Map(), new Set(), new String("text"),
  new (class Payload {})(), Object.create({ inherited: true }),
];
const lineTerminators = ["\n", "\r", "\r\n", "\u2028", "\u2029"];

function rejectRunField(field, values) {
  for (const value of values) {
    assert.throws(() => parseRun(run({ [field]: value })), TypeError, `${field}: ${inspect(value)}`);
  }
}

function nested(levels, wrap) {
  let value = null;
  for (let index = 0; index < levels; index++) value = wrap(value);
  return value;
}

for (const [name, validate] of [
  ["record", (value) => record(value, "payload")],
  ["parseRun", parseRun],
  ["parseToolResult", parseToolResult],
  ["jsonObject", (value) => jsonObject(value, "arguments")],
  ["emptyParams", emptyParams],
]) {
  test(`${name} rejects null, arrays, primitives, and non-plain objects`, () => {
    for (const value of nonRecords) {
      assert.throws(() => validate(value), TypeError, inspect(value));
    }
  });
}

test("record accepts ordinary and null-prototype records without changing them", () => {
  for (const value of [{}, { answer: 42 }, Object.create(null)]) {
    assert.strictEqual(record(value, "payload"), value);
  }
  assert.throws(() => record(null, "callback arguments"), /callback arguments must be a plain object/);
});

test("keys rejects unknown own fields including JSON-parsed prototype-looking keys", () => {
  assert.equal(keys({ allowed: true }, ["allowed"], "payload"), undefined);
  assert.equal(keys({}, ["optional"], "payload"), undefined);
  for (const value of [
    { extra: undefined },
    JSON.parse('{"__proto__": {"polluted": true}}'),
    { constructor: {}, prototype: {} },
  ]) {
    assert.throws(() => keys(value, ["allowed"], "payload"), /Unexpected payload field/);
  }
});

test("emptyParams requires an empty object rather than omitted or ignored parameters", () => {
  assert.equal(emptyParams({}), undefined);
  assert.equal(emptyParams(Object.create(null)), undefined);
  for (const value of [{ ignored: true }, { ignored: undefined }, JSON.parse('{"__proto__": null}')]) {
    assert.throws(() => emptyParams(value), /Unexpected params field/);
  }
});

test("positiveInteger accepts only positive safe integers without coercion", () => {
  for (const value of [1, 8192, Number.MAX_SAFE_INTEGER]) {
    assert.equal(positiveInteger(value, "limit"), value);
  }
  for (const value of invalidPositiveIntegers) {
    assert.throws(() => positiveInteger(value, "limit"), /limit must be a positive safe integer/, inspect(value));
  }
});

test("parseRun preserves the existing request shape and returns detached JSON data", () => {
  const input = run({ reasoningEffort: "high", maxTokens: 8192 });
  const expected = structuredClone(input);
  const parsed = parseRun(input);
  assert.deepEqual(parsed, expected);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), expected);
  assert.notStrictEqual(parsed, input);
  assert.notStrictEqual(parsed.tools, input.tools);
  assert.notStrictEqual(parsed.tools[0], input.tools[0]);
  assert.notStrictEqual(parsed.tools[0].parameters, input.tools[0].parameters);
  assert.notStrictEqual(parsed.tools[0].parameters.properties.path, input.tools[0].parameters.properties.path);
  parsed.tools[0].parameters.properties.path.type = "number";
  parsed.tools[0].parameters.required.push("extra");
  parsed.tools.push(tool({ name: "other" }));
  assert.deepEqual(input, expected);
});

test("parseRun accepts the optional provider field without changing deepseek defaults", () => {
  assert.equal(Object.hasOwn(parseRun(run()), "provider"), false);
  assert.equal(parseRun(run({ provider: "deepseek" })).provider, "deepseek");
});

test("parseRun accepts empty tools, both resume values, and empty system prompts and descriptions", () => {
  for (const resume of [false, true]) {
    const input = run({ resume, tools: [], systemPrompt: "", prompt: " \nHello, 世界!\n " });
    assert.deepEqual(parseRun(input), input);
  }
  assert.equal(parseRun(run({ tools: [tool({ description: "" })] })).tools[0].description, "");
});

test("parseRun accepts null-prototype input records but produces normal objects", () => {
  const input = Object.assign(Object.create(null), run());
  input.tools[0] = Object.assign(Object.create(null), input.tools[0]);
  input.tools[0].parameters = Object.assign(Object.create(null), input.tools[0].parameters);
  const parsed = parseRun(input);
  assert.deepEqual(parsed, run());
  for (const value of [parsed, parsed.tools[0], parsed.tools[0].parameters]) {
    assert.strictEqual(Object.getPrototypeOf(value), Object.prototype);
  }
});

test("parseRun requires every non-optional protocol field", () => {
  for (const field of Object.keys(run())) {
    const input = run();
    delete input[field];
    assert.throws(() => parseRun(input), TypeError, `missing ${field}`);
  }
});

test("parseRun rejects unknown run and tool fields instead of silently stripping them", () => {
  for (const extra of [
    { unexpected: true }, { unexpected: undefined },
    JSON.parse('{"__proto__": {"polluted": true}}'), { constructor: {} },
  ]) {
    assert.throws(() => parseRun(run(extra)), /Unexpected run field/);
    assert.throws(() => parseRun(run({ tools: [tool(extra)] })), /Unexpected tool field/);
  }
});

test("parseRun accepts safe session identifiers at both length boundaries", () => {
  for (const sessionId of ["a", "A-Z_09", "a".repeat(128), "COM0", "lpt10", "con-safe", "__proto__"]) {
    assert.equal(parseRun(run({ sessionId })).sessionId, sessionId);
  }
});

test("parseRun rejects unsafe, traversal, overlong, and Windows device session identifiers", () => {
  const devices = ["con", "prn", "aux", "nul"];
  for (let index = 1; index <= 9; index++) devices.push(`com${index}`, `lpt${index}`);
  rejectRunField("sessionId", [
    ...nonStrings, "", " ", ".", "..", "../outside", "..\\outside", "a/b", "a\\b",
    "C:\\outside", "C:outside", "file:stream", "has space", "trailing.", "a\0b",
    "世界", "a".repeat(129), ...devices, ...devices.map((value) => value.toUpperCase()),
    "cOn", ...lineTerminators.map((value) => `session${value}`),
  ]);
});

test("parseRun requires an absolute nonempty workspace path without NUL", () => {
  assert.equal(parseRun(run()).workspaceDir, process.cwd());
  rejectRunField("workspaceDir", [
    ...nonStrings, "", " ", ".", "..", "relative", "relative\\folder", "..\\outside",
    "C:relative", "file:///workspace", `${process.cwd()}\0suffix`,
  ]);
});

test("parseRun requires boolean resume and appropriately nonempty string prompts", () => {
  rejectRunField("resume", [undefined, null, 0, 1, "true", "false", [], {}, new Boolean(false)]);
  rejectRunField("systemPrompt", [...nonStrings, "before\0after"]);
  rejectRunField("prompt", [...nonStrings, "", " \t\r\n", "before\0after"]);
});

test("parseRun validates model identifiers without changing provider-qualified names", () => {
  for (const modelId of ["a", "deepseek-chat", "deepseek:deepseek-v4.1_flash", "a".repeat(128)]) {
    assert.equal(parseRun(run({ modelId })).modelId, modelId);
  }
  rejectRunField("modelId", [
    ...nonStrings, "", " ", "../model", "provider/model", "a\\b", "-model", "_model", ".model",
    ":model", "has space", "a?key=value", "a#fragment", "a\0b", "世界", "a".repeat(129),
    ...lineTerminators.map((value) => `model${value}`),
  ]);
});

test("parseRun omits absent or undefined optional fields from its JSON result", () => {
  for (const input of [run(), run({ reasoningEffort: undefined, maxTokens: undefined })]) {
    const parsed = parseRun(input);
    assert.equal(Object.hasOwn(parsed, "reasoningEffort"), false);
    assert.equal(Object.hasOwn(parsed, "maxTokens"), false);
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), parsed);
  }
});

test("parseRun accepts deepseek and Copilot reasoning effort sets with positive safe token limits", () => {
  for (const reasoningEffort of ["off", "low", "high", "max"]) {
    for (const maxTokens of [1, 8192, Number.MAX_SAFE_INTEGER]) {
      const input = run({ reasoningEffort, maxTokens });
      assert.deepEqual(parseRun(input), input);
    }
  }
  for (const reasoningEffort of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    const input = run({ provider: "github-copilot", reasoningEffort });
    assert.deepEqual(parseRun(input), input);
  }
});

test("parseRun rejects unsupported efforts and malformed optional token limits", () => {
  rejectRunField("reasoningEffort", [
    ...nonStrings.filter((value) => value !== undefined), "", " ", "medium", "HIGH",
    " high ", "disabled", "high\0", ...lineTerminators.map((value) => `high${value}`),
  ]);
  assert.throws(() => parseRun(run({ provider: "github-copilot", reasoningEffort: "ultra" })), /reasoningEffort/);
  assert.throws(() => parseRun(run({ provider: "other" })), /provider must be deepseek or github-copilot/);
  rejectRunField("maxTokens", invalidPositiveIntegers.filter((value) => value !== undefined));
});

test("parseRun requires a tool array containing only complete plain tool records", () => {
  rejectRunField("tools", [undefined, null, {}, "", "[]", 0, false, new Set()]);
  for (const value of nonRecords) {
    assert.throws(() => parseRun(run({ tools: [value] })), TypeError, inspect(value));
  }
  for (const field of ["name", "description", "parameters"]) {
    const input = tool();
    delete input[field];
    assert.throws(() => parseRun(run({ tools: [input] })), TypeError, `missing tool.${field}`);
  }
});

test("parseRun rejects sparse tool arrays rather than allowing unvalidated holes", () => {
  for (const tools of [new Array(1), [tool(), ,], [, tool()]]) {
    assert.throws(() => parseRun(run({ tools })), TypeError, inspect(tools));
  }
});

test("parseRun accepts distinct safe tool names and does not retain names between requests", () => {
  const names = ["a", "host-read_2", "A".repeat(64), "__proto__", "constructor", "prototype"];
  const input = run({ tools: names.map((name) => tool({ name })) });
  assert.deepEqual(parseRun(input), input);
  assert.deepEqual(parseRun(input), input);
});

test("parseRun rejects unsafe, reserved, duplicate, and overlong tool names", () => {
  for (const name of [
    ...nonStrings, "", " ", "run_code", "a".repeat(65), "a/b", "a\\b", "a.b", "a:b",
    "has space", "a\0b", "世界", ...lineTerminators.map((value) => `run_code${value}`),
  ]) {
    assert.throws(() => parseRun(run({ tools: [tool({ name })] })), TypeError, inspect(name));
  }
  for (const name of ["host_read", "__proto__", "constructor"]) {
    assert.throws(() => parseRun(run({ tools: [tool({ name }), tool({ name })] })), /duplicate/);
  }
  for (const description of [...nonStrings, "before\0after"]) {
    assert.throws(() => parseRun(run({ tools: [tool({ description })] })), TypeError, inspect(description));
  }
});

test("parseRun requires a JSON object schema with explicit object type", () => {
  for (const parameters of [
    ...nonRecords, {}, { properties: {} }, { type: "array" }, { type: "string" },
    { type: ["object"] }, { type: null }, { type: true },
  ]) {
    assert.throws(() => parseRun(run({ tools: [tool({ parameters })] })), TypeError, inspect(parameters));
  }
  const input = run({ tools: [tool({ parameters: { type: "object" } })] });
  assert.deepEqual(parseRun(input), input);
});

test("parseRun rejects recursively non-JSON schema data instead of dropping or coercing it", () => {
  for (const value of nonJsonValues) {
    const parameters = { type: "object", properties: { path: { type: "string", default: value } } };
    assert.throws(() => parseRun(run({ tools: [tool({ parameters })] })), TypeError, inspect(value));
  }
  const cyclic = { type: "object" };
  cyclic.properties = { self: cyclic };
  for (const parameters of [cyclic, { type: "object", default: nested(65, (value) => ({ value })) }]) {
    assert.throws(() => parseRun(run({ tools: [tool({ parameters })] })), /JSON nesting exceeds 64 levels/);
  }
});

test("jsonObject preserves JSON primitives and nested arrays in detached normal callback arguments", () => {
  const input = {
    path: "file.txt", empty: "", nul: "before\0after", unicode: "世界",
    values: [null, true, false, 0, -0, 1.25, Number.MAX_VALUE, Number.MIN_VALUE],
    nested: [{ empty: {}, list: [] }],
  };
  const expected = structuredClone(input);
  const parsed = jsonObject(input, "arguments");
  assert.deepEqual(parsed, expected);
  assert.strictEqual(Object.getPrototypeOf(parsed), Object.prototype);
  assert.notStrictEqual(parsed, input);
  assert.notStrictEqual(parsed.values, input.values);
  assert.notStrictEqual(parsed.nested[0], input.nested[0]);
  parsed.nested[0].list.push("changed");
  input.values.push("source changed");
  assert.deepEqual(input.nested, expected.nested);
  assert.deepEqual(parsed.values, expected.values);
});

test("jsonObject normalizes null-prototype records without retaining caller objects", () => {
  const input = Object.assign(Object.create(null), {
    nested: Object.assign(Object.create(null), { answer: 42 }),
  });
  const parsed = jsonObject(input, "arguments");
  assert.deepEqual(parsed, { nested: { answer: 42 } });
  assert.strictEqual(Object.getPrototypeOf(parsed), Object.prototype);
  assert.strictEqual(Object.getPrototypeOf(parsed.nested), Object.prototype);
  assert.notStrictEqual(parsed.nested, input.nested);
  assert.deepEqual(jsonObject(Object.create(null), "arguments"), {});
});

test("jsonObject preserves own __proto__ and constructor keys without prototype pollution", () => {
  const input = JSON.parse('{"__proto__":{"validationPolluted":true},"constructor":{"prototype":{"validationPolluted":true}},"nested":[{"__proto__":{"answer":42}}]}');
  const parsed = jsonObject(input, "arguments");
  assert.deepEqual(parsed, input);
  for (const value of [parsed, parsed.nested[0]]) {
    assert.strictEqual(Object.getPrototypeOf(value), Object.prototype);
    const descriptor = Object.getOwnPropertyDescriptor(value, "__proto__");
    assert.equal(descriptor.enumerable, true);
    assert.equal(descriptor.get, undefined);
    assert.strictEqual(descriptor.value, value.__proto__);
  }
  assert.notStrictEqual(parsed.__proto__, input.__proto__);
  assert.equal(Object.hasOwn(parsed, "constructor"), true);
  assert.equal(Object.hasOwn(Object.prototype, "validationPolluted"), false);
  assert.equal(parsed.validationPolluted, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), input);
  const parameters = { type: "object", properties: input };
  assert.deepEqual(parseRun(run({ tools: [tool({ parameters })] })).tools[0].parameters, parameters);
});

test("jsonObject rejects undefined, nonfinite, and non-JSON values at every nested position", () => {
  for (const value of nonJsonValues) {
    for (const input of [{ value }, { nested: { value } }, { nested: [value] }]) {
      assert.throws(() => jsonObject(input, "arguments"), TypeError, inspect(input));
    }
  }
  for (const values of [new Array(1), [1, , 3]]) {
    assert.throws(() => jsonObject({ values }, "arguments"), TypeError, inspect(values));
  }
  let called = false;
  const input = { toJSON() { called = true; return {}; } };
  assert.throws(() => jsonObject(input, "arguments"), TypeError);
  assert.equal(called, false, "validation must not use caller-supplied JSON serialization");
});

for (const [name, wrap] of [
  ["objects", (value) => ({ value })],
  ["arrays", (value) => [value]],
]) {
  test(`jsonObject enforces the 64-level nesting boundary for ${name}`, () => {
    const input = { value: nested(63, wrap) };
    assert.deepEqual(jsonObject(input, "arguments"), input);
    assert.throws(() => jsonObject({ value: nested(64, wrap) }, "arguments"), {
      name: "TypeError", message: /JSON nesting exceeds 64 levels/,
    });
  });
}

test("jsonObject rejects cycles with bounded validation errors, but accepts shared acyclic objects", () => {
  const objectCycle = {};
  objectCycle.self = objectCycle;
  const arrayCycle = [];
  arrayCycle.push(arrayCycle);
  const mutualCycle = { other: {} };
  mutualCycle.other.back = mutualCycle;
  for (const input of [objectCycle, { values: arrayCycle }, mutualCycle]) {
    assert.throws(() => jsonObject(input, "arguments"), {
      name: "TypeError", message: /JSON nesting exceeds 64 levels/,
    });
  }
  const shared = { value: [1, 2] };
  const input = { first: shared, second: shared };
  const parsed = jsonObject(input, "arguments");
  assert.deepEqual(parsed, input);
  assert.notStrictEqual(parsed.first, shared);
  assert.notStrictEqual(parsed.second, shared);
});

test("parseToolResult preserves required text and explicit success or error without adding fields", () => {
  for (const isError of [false, true]) {
    for (const text of ["", " \n", "Host result 世界", "before\0after"]) {
      const input = { text, isError };
      const parsed = parseToolResult(input);
      assert.deepEqual(parsed, input);
      assert.notStrictEqual(parsed, input);
      assert.deepEqual(JSON.parse(JSON.stringify(parsed)), input);
    }
  }
  const input = Object.assign(Object.create(null), { text: "failed", isError: true });
  const parsed = parseToolResult(input);
  assert.deepEqual(parsed, { text: "failed", isError: true });
  assert.strictEqual(Object.getPrototypeOf(parsed), Object.prototype);
});

test("parseToolResult requires isError rather than assuming success when it is missing or malformed", () => {
  assert.throws(() => parseToolResult({ text: "ok" }), /isError must be boolean/);
  for (const isError of [undefined, null, 0, 1, "", "false", "true", [], {}, new Boolean(false)]) {
    assert.throws(() => parseToolResult({ text: "ok", isError }), /isError must be boolean/, inspect(isError));
  }
});

test("parseToolResult requires string text and rejects all unknown result fields", () => {
  assert.throws(() => parseToolResult({ isError: false }), /text must be a string/);
  for (const text of nonStrings) {
    assert.throws(() => parseToolResult({ text, isError: false }), /text must be a string/, inspect(text));
  }
  for (const extra of [
    { content: [] }, { error: "failed" }, { unknown: undefined },
    JSON.parse('{"__proto__": {"polluted": true}}'), { constructor: {} },
  ]) {
    assert.throws(() => parseToolResult({ text: "ok", isError: false, ...extra }), /Unexpected tool result field/);
  }
});
