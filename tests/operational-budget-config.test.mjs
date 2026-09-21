import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import ts from "typescript";

// Resolve the entire config graph from source, even when dist is missing or stale.
const distRoot = new URL("../dist/", import.meta.url);
const srcRoot = new URL("../src/", import.meta.url);
const loaded = new Set();
function sourceFor(url) {
  return url?.startsWith(distRoot.href) && url.endsWith(".js")
    ? new URL(`${url.slice(distRoot.href.length, -3)}.ts`, srcRoot)
    : undefined;
}
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const url = context.parentURL && new URL(specifier, context.parentURL).href;
    return sourceFor(url) ? { url, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    const source = sourceFor(url);
    if (!source) return next(url, context);
    loaded.add(source.href);
    return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(source, "utf8"), {
        fileName: fileURLToPath(source),
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
  },
});
let parseOperationalBudget, parseDshConfig, resolveOperationalBudget;
try {
  ({ parseOperationalBudget, parseDshConfig, resolveOperationalBudget } = await import("../dist/config.js"));
} finally {
  hooks.deregister();
}

const FIELDS = ["maxModelRequests", "maxInputTokens", "maxOutputTokens", "maxToolCalls", "maxDurationMs"];
const BASE = Object.freeze({
  maxModelRequests: 12, maxInputTokens: 12_000, maxOutputTokens: 800,
  maxToolCalls: 20, maxDurationMs: 60_000,
});
const budget = (overrides = {}) => ({ ...BASE, ...overrides });
const limits = (...values) => Object.fromEntries(FIELDS.map((field, i) => [field, values[i]]));
const uniform = (value) => Object.fromEntries(FIELDS.map((field) => [field, value]));
const agentMap = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`agent-${i}`, budget()]));
const budgetError = { name: "TypeError", code: "DSH_BUDGET_EXCEEDED" };
const schema = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")).configSchema;
const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);

const budgetEntrypoints = [
  ["standalone", (cap) => parseOperationalBudget(cap)],
  ["config global", (cap) => parseDshConfig({ operationalBudget: cap })],
  ["config agent", (cap) => parseDshConfig({ operationalBudgetByAgent: { worker: cap } })],
  ["resolved global", (cap) => resolveOperationalBudget({ operationalBudget: cap }, "worker")],
  ["resolved agent", (cap) => resolveOperationalBudget({ operationalBudgetByAgent: { worker: cap } }, "worker")],
  ["trusted attempt", (cap) => resolveOperationalBudget({}, "worker", cap)],
];
function rejectBudget(value, label) {
  for (const [name, parse] of budgetEntrypoints) {
    assert.throws(() => parse(value), budgetError, `${label}: ${name}`);
  }
}
function rejectMap(map, label) {
  assert.throws(() => parseDshConfig({ operationalBudgetByAgent: map }), budgetError, label);
  for (const agent of ["worker", "unlisted", undefined]) {
    assert.throws(() => resolveOperationalBudget({ operationalBudgetByAgent: map }, agent), budgetError,
      `${label}: resolving ${agent}`);
  }
}
function jsonAgreement(raw, accepted, label) {
  const input = JSON.parse(JSON.stringify(raw));
  const before = structuredClone(input);
  assert.equal(validate(input), accepted, `${label}: schema ${JSON.stringify(validate.errors)}`);
  if (accepted) {
    const parsed = parseDshConfig(input);
    for (const key of ["operationalBudget", "operationalBudgetByAgent"]) {
      assert.equal(Object.hasOwn(parsed, key), Object.hasOwn(input, key), `${label}: ${key} presence`);
      if (Object.hasOwn(input, key)) assert.deepEqual(parsed[key], input[key], `${label}: ${key}`);
    }
    assert.equal(validate(parsed), true, `${label}: parsed config ${JSON.stringify(validate.errors)}`);
    assert.deepEqual(parseDshConfig(JSON.parse(JSON.stringify(parsed))), parsed, `${label}: round trip`);
  } else {
    assert.throws(() => parseDshConfig(input), budgetError, `${label}: runtime`);
  }
  assert.deepEqual(input, before, `${label}: validation must not mutate input`);
}

const INVALID_NUMBERS = [
  ["zero", 0], ["negative zero", -0], ["negative", -1], ["fraction", 1.5],
  ["small fraction", Number.MIN_VALUE], ["negative fraction", -0.5],
  ["NaN", NaN], ["infinity", Infinity], ["negative infinity", -Infinity],
  ["unsafe integer", Number.MAX_SAFE_INTEGER + 1], ["large integer", 1e100],
];
const INVALID_TYPES = [
  ["undefined", undefined], ["null", null], ["numeric string", "1"], ["empty string", ""],
  ["boolean true", true], ["boolean false", false], ["array", []], ["number array", [1]],
  ["object", {}], ["boxed number", new Number(1)], ["bigint", 1n],
  ["symbol", Symbol("limit")], ["function", () => 1],
];
const NON_RECORDS = [
  ["null", () => null], ["array", () => []], ["string", () => "budget"],
  ["number", () => 1], ["boolean", () => true], ["bigint", () => 1n],
  ["symbol", () => Symbol("budget")], ["function", () => Object.assign(() => {}, budget())],
  ["date", () => Object.assign(new Date(0), budget())],
  ["map", () => Object.assign(new Map(), budget())],
  ["set", () => Object.assign(new Set(), budget())],
  ["class instance", () => new (class { constructor() { Object.assign(this, budget()); } })()],
  ["inherited limits", () => Object.create(budget())],
  ["custom prototype with own limits", () => Object.assign(Object.create({ marker: true }), budget())],
];
const INVALID_AGENT_IDS = [
  "", "Worker", "1worker", "_worker", "-worker", "*", "worker*", "worker.name",
  "worker/child", "worker\\child", " worker", "worker ", "work er", "équipe",
  "__proto__", "a".repeat(65),
];
const LINE_ENDINGS = ["\n", "\r", "\r\n", "\u2028", "\u2029"];

test("config and all current runtime dependencies are transpiled from source in memory", () => {
  for (const name of ["config", "protocol", "copilot-policy", "preparation"]) {
    assert.ok(loaded.has(new URL(`${name}.ts`, srcRoot).href), `${name} must not come from dist`);
  }
});

test("OperationalBudget declares exactly five required number properties", () => {
  const url = new URL("protocol.ts", srcRoot);
  const source = ts.createSourceFile(fileURLToPath(url), readFileSync(url, "utf8"), ts.ScriptTarget.Latest, true);
  const declarations = source.statements.filter((node) =>
    ts.isInterfaceDeclaration(node) && node.name.text === "OperationalBudget");
  assert.equal(declarations.length, 1);
  const declaration = declarations[0];
  assert.ok(declaration.modifiers?.some((node) => node.kind === ts.SyntaxKind.ExportKeyword));
  assert.equal(declaration.heritageClauses?.length ?? 0, 0);
  assert.equal(declaration.members.length, FIELDS.length);
  for (const member of declaration.members) {
    assert.ok(ts.isPropertySignature(member));
    assert.ok(ts.isIdentifier(member.name));
    assert.equal(member.questionToken, undefined, member.name.text);
    assert.equal(member.type?.kind, ts.SyntaxKind.NumberKeyword, member.name.text);
  }
  assert.deepEqual(declaration.members.map((member) => member.name.text).sort(), [...FIELDS].sort());
});

for (const field of FIELDS) {
  test(`${field} accepts positive safe integer boundaries without coercion`, () => {
    for (const value of [1, 2, Number.MAX_SAFE_INTEGER]) {
      const raw = budget({ [field]: value });
      assert.deepEqual(parseOperationalBudget(raw), raw);
      jsonAgreement({ operationalBudget: raw, operationalBudgetByAgent: { worker: raw } }, true,
        `${field}=${value}`);
      assert.deepEqual(resolveOperationalBudget({}, "worker", raw), raw);
    }
  });

  test(`${field} rejects invalid numbers and every other value type at every entrypoint`, () => {
    for (const [name, value] of [...INVALID_NUMBERS, ...INVALID_TYPES]) {
      rejectBudget(budget({ [field]: value }), `${field}: ${name}`);
    }
    let coercions = 0;
    const value = { valueOf() { coercions++; throw new Error("must not coerce"); } };
    rejectBudget(budget({ [field]: value }), `${field}: coercible object`);
    assert.equal(coercions, 0);
  });

  test(`${field} is required even when an unknown field keeps the property count at five`, () => {
    const missing = budget();
    delete missing[field];
    rejectBudget(missing, `missing ${field}`);
    rejectBudget({ ...missing, unexpected: 1 }, `replaced ${field}`);
    jsonAgreement({ operationalBudget: missing }, false, `missing global ${field}`);
    jsonAgreement({ operationalBudgetByAgent: { worker: missing } }, false, `missing agent ${field}`);
  });

  test(`${field} rejects accessors without evaluating getters or setters`, () => {
    for (const enumerable of [true, false]) {
      for (const kind of ["getter", "setter", "both"]) {
        let calls = 0;
        const trap = () => { calls++; throw new Error("accessor must not run"); };
        const raw = budget();
        Object.defineProperty(raw, field, {
          enumerable, configurable: true,
          ...(kind !== "setter" ? { get: trap } : {}),
          ...(kind !== "getter" ? { set: trap } : {}),
        });
        rejectBudget(raw, `${field}: ${kind}, enumerable=${enumerable}`);
        assert.equal(calls, 0);
      }
    }
  });
}

test("budgets reject empty, extra, nonenumerable unknown, and symbol properties", () => {
  rejectBudget({}, "empty budget");
  for (const key of ["unexpected", "__proto__", Symbol("extra")]) {
    for (const enumerable of [true, false]) {
      const raw = Object.defineProperty(budget(), key, { value: 1, enumerable });
      rejectBudget(raw, `extra ${String(key)}, enumerable=${enumerable}`);
    }
  }
  let calls = 0;
  for (const key of ["unexpected", Symbol("accessor")]) {
    const raw = Object.defineProperty(budget(), key, {
      get() { calls++; throw new Error("unknown accessor must not run"); },
    });
    rejectBudget(raw, "unknown accessor");
  }
  assert.equal(calls, 0);
});

test("budgets and agent maps reject primitives, non-plain objects, and inherited properties", () => {
  for (const [name, create] of NON_RECORDS) {
    rejectBudget(create(), name);
    rejectMap(create(), name);
  }
  assert.throws(() => parseOperationalBudget(undefined), budgetError);
  rejectMap({ worker: undefined }, "present agent must have a budget");
  rejectMap(Object.create({ worker: budget() }), "inherited agent");
  rejectMap(Object.assign(Object.create({ inherited: budget() }), { worker: budget() }), "custom map prototype");
});

test("frozen, sealed, nonextensible, null-prototype, and nonenumerable budgets clone to ordinary data", () => {
  const variants = [
    budget(), Object.freeze(budget()), Object.seal(budget()), Object.preventExtensions(budget()),
    Object.assign(Object.create(null), budget()),
    Object.defineProperties({}, Object.fromEntries(FIELDS.map((field) => [field, { value: BASE[field] }]))),
  ];
  for (const input of variants) {
    const output = parseOperationalBudget(input);
    assert.deepEqual(output, budget());
    assert.notStrictEqual(output, input);
    assert.equal(Object.getPrototypeOf(output), Object.prototype);
    for (const field of FIELDS) {
      assert.deepEqual(Object.getOwnPropertyDescriptor(output, field), {
        value: BASE[field], enumerable: true, writable: true, configurable: true,
      });
    }
    assert.deepEqual(parseDshConfig({ operationalBudget: input }).operationalBudget, budget());
    assert.deepEqual(parseDshConfig({ operationalBudgetByAgent: { worker: input } }).operationalBudgetByAgent.worker, budget());
    assert.deepEqual(resolveOperationalBudget({}, "worker", input), budget());
  }
});

test("standalone budget parsing never aliases inputs or independent outputs", () => {
  const input = budget();
  const first = parseOperationalBudget(input);
  const second = parseOperationalBudget(input);
  assert.notStrictEqual(first, second);
  Object.assign(input, uniform(1));
  assert.deepEqual(first, budget());
  assert.deepEqual(second, budget());
  Object.assign(first, uniform(2));
  assert.deepEqual(second, budget());
  assert.deepEqual(input, uniform(1));
  assert.deepEqual(parseOperationalBudget(input), uniform(1));
});

test("configuration parsing deep-clones shared global and per-agent caps on every call", () => {
  const shared = budget();
  const input = { operationalBudget: shared, operationalBudgetByAgent: { worker: shared, other: shared } };
  const before = structuredClone(input);
  const first = parseDshConfig(input);
  const second = parseDshConfig(input);
  assert.deepEqual(input, before);
  const clones = [first, second].flatMap((config) =>
    [config.operationalBudget, config.operationalBudgetByAgent.worker, config.operationalBudgetByAgent.other]);
  assert.equal(new Set([shared, ...clones]).size, 7);
  assert.notStrictEqual(first.operationalBudgetByAgent, input.operationalBudgetByAgent);
  assert.notStrictEqual(first.operationalBudgetByAgent, second.operationalBudgetByAgent);
  Object.assign(shared, uniform(1));
  delete input.operationalBudgetByAgent.worker;
  input.operationalBudgetByAgent.added = budget();
  for (const clone of clones) assert.deepEqual(clone, budget());
  const afterInputMutation = structuredClone(input);
  Object.assign(first.operationalBudget, uniform(2));
  Object.assign(first.operationalBudgetByAgent.worker, uniform(3));
  assert.deepEqual(first.operationalBudgetByAgent.other, budget());
  delete first.operationalBudgetByAgent.other;
  first.operationalBudgetByAgent.newagent = budget();
  assert.deepEqual(second.operationalBudget, budget());
  assert.deepEqual(second.operationalBudgetByAgent, { worker: budget(), other: budget() });
  assert.deepEqual(input, afterInputMutation);
});

test("agent maps accept empty, frozen, null-prototype, and all 64 valid own entries", () => {
  for (const input of [{}, Object.freeze({ worker: Object.freeze(budget()) }), Object.assign(Object.create(null), { worker: budget() }), agentMap(64)]) {
    const expected = Object.fromEntries(Object.entries(input));
    const parsed = parseDshConfig({ operationalBudgetByAgent: input }).operationalBudgetByAgent;
    assert.deepEqual(parsed, expected);
    assert.notStrictEqual(parsed, input);
    assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
    for (const [agent, cap] of Object.entries(input)) {
      assert.notStrictEqual(parsed[agent], cap);
      assert.deepEqual(resolveOperationalBudget({ operationalBudgetByAgent: input }, agent), cap);
    }
  }
  rejectMap(agentMap(65), "65 entries");
});

test("agent ids accept one through 64 characters and reject nonexact identifier shapes", () => {
  for (const agent of ["a", "worker", "worker-2_name", "a".repeat(64), "constructor", "tostring"]) {
    const input = { operationalBudgetByAgent: { [agent]: budget() } };
    assert.deepEqual(parseDshConfig(input).operationalBudgetByAgent, input.operationalBudgetByAgent);
    assert.deepEqual(resolveOperationalBudget(input, agent), budget());
  }
  for (const agent of INVALID_AGENT_IDS) rejectMap({ [agent]: budget() }, JSON.stringify(agent));
});

test("agent ids reject terminal line breaks rather than treating them as an end anchor", () => {
  for (const ending of LINE_ENDINGS) rejectMap({ [`worker${ending}`]: budget() }, JSON.stringify(ending));
});

test("agent maps reject symbols and accessors without evaluating them, even when unselected", () => {
  for (const enumerable of [true, false]) {
    rejectMap(Object.defineProperty({ worker: budget() }, Symbol("agent"), { value: budget(), enumerable }), "symbol agent");
    for (const key of ["worker", "unselected", Symbol("agent")]) {
      for (const kind of ["getter", "setter", "both"]) {
        let calls = 0;
        const trap = () => { calls++; throw new Error("agent accessor must not run"); };
        const map = Object.defineProperty({}, key, {
          enumerable,
          ...(kind !== "setter" ? { get: trap } : {}),
          ...(kind !== "getter" ? { set: trap } : {}),
        });
        rejectMap(map, `${String(key)} ${kind}, enumerable=${enumerable}`);
        assert.equal(calls, 0);
      }
    }
  }
});

test("nonenumerable own agent data caps cannot silently disappear", () => {
  const cap = budget();
  const map = Object.defineProperty({ other: budget() }, "worker", { value: cap });
  for (const parse of [
    () => parseDshConfig({ operationalBudgetByAgent: map }).operationalBudgetByAgent.worker,
    () => resolveOperationalBudget({ operationalBudgetByAgent: map }, "worker"),
  ]) {
    let result;
    try { result = parse(); }
    catch (error) {
      assert.equal(error.name, budgetError.name);
      assert.equal(error.code, budgetError.code);
      continue;
    }
    assert.deepEqual(result, budget(), "accepting the map must preserve its exact own agent cap");
    assert.notStrictEqual(result, cap);
  }
});

test("nonenumerable own agent ids must still be validated", () => {
  for (const agent of ["*", "Worker", "a".repeat(65)]) {
    rejectMap(Object.defineProperty({}, agent, { value: budget() }), `hidden ${agent}`);
  }
});

test("nonenumerable unselected agent caps must still be validated", () => {
  for (const cap of [{}, budget({ maxToolCalls: 0 }), null]) {
    rejectMap(Object.defineProperty({ worker: budget() }, "other", { value: cap }), "hidden malformed cap");
  }
});

test("the 64-agent bound counts nonenumerable own entries", () => {
  rejectMap(Object.defineProperty(agentMap(64), "hidden", { value: budget() }), "hidden 65th agent");
});

const GLOBAL = Object.freeze(limits(5, 500, 90, 9, 900));
const AGENT = Object.freeze(limits(8, 300, 60, 7, 1000));
const ATTEMPT = Object.freeze(limits(6, 400, 30, 8, 800));
for (const [name, mask, expected] of [
  ["none", 0, undefined],
  ["global", 1, GLOBAL],
  ["agent", 2, AGENT],
  ["attempt", 4, ATTEMPT],
  ["global + agent", 3, limits(5, 300, 60, 7, 900)],
  ["global + attempt", 5, limits(5, 400, 30, 8, 800)],
  ["agent + attempt", 6, limits(6, 300, 30, 7, 800)],
  ["global + agent + attempt", 7, limits(5, 300, 30, 7, 800)],
]) {
  test(`resolver intersects every field independently: ${name}`, () => {
    const raw = Object.freeze({
      ...(mask & 1 ? { operationalBudget: GLOBAL } : {}),
      ...(mask & 2 ? { operationalBudgetByAgent: Object.freeze({ worker: AGENT }) } : {}),
    });
    const attempt = mask & 4 ? ATTEMPT : undefined;
    for (const config of [raw, parseDshConfig(raw)]) {
      const result = resolveOperationalBudget(config, "worker", attempt);
      assert.deepEqual(result, expected);
      if (result !== undefined) {
        for (const cap of [GLOBAL, AGENT, ATTEMPT]) assert.notStrictEqual(result, cap);
        assert.notStrictEqual(result, resolveOperationalBudget(config, "worker", attempt));
      }
    }
    jsonAgreement(raw, true, name);
  });
}

test("any layer can supply every binding minimum, including equal and safe-integer boundary caps", () => {
  for (const values of [
    [1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    [Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1],
    [1, 1, 1],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  ]) {
    const [global, agent, attempt] = values.map(uniform);
    assert.deepEqual(resolveOperationalBudget({
      operationalBudget: global, operationalBudgetByAgent: { worker: agent },
    }, "worker", attempt), uniform(Math.min(...values)));
  }
});

test("resolution matches exact own agent ids, without normalization, prefix matches, or prototype inheritance", () => {
  const map = { worker: AGENT, "worker-child": ATTEMPT };
  for (const global of [undefined, GLOBAL]) {
    const config = { operationalBudget: global, operationalBudgetByAgent: map };
    for (const agent of [undefined, "", "unlisted", "Worker", " worker", "worker ", "work", "worker-child-more",
      "constructor", "toString", "hasOwnProperty", "__proto__"]) {
      assert.deepEqual(resolveOperationalBudget(config, agent), global, String(agent));
      assert.deepEqual(resolveOperationalBudget(config, agent, ATTEMPT),
        global ? limits(5, 400, 30, 8, 800) : ATTEMPT, `attempt fallback: ${agent}`);
    }
  }
  assert.deepEqual(resolveOperationalBudget({ operationalBudgetByAgent: map }, "worker"), AGENT);
  assert.deepEqual(resolveOperationalBudget({ operationalBudgetByAgent: map }, "worker-child"), ATTEMPT);
  assert.equal(resolveOperationalBudget({ operationalBudgetByAgent: {} }, "worker"), undefined);
});

test("resolving validates every unselected agent and never lets a tighter valid cap mask malformed input", () => {
  for (const invalid of [{}, budget({ maxDurationMs: 0 }), budget({ extra: 1 }), null, undefined]) {
    const map = { worker: budget(), other: invalid };
    rejectMap(map, "malformed unselected agent");
    assert.throws(() => resolveOperationalBudget({ operationalBudget: uniform(1), operationalBudgetByAgent: map },
      "worker", uniform(1)), budgetError);
  }
  for (const field of FIELDS) {
    const invalid = budget({ [field]: 0 });
    assert.throws(() => resolveOperationalBudget({ operationalBudget: invalid, operationalBudgetByAgent: { worker: uniform(1) } },
      "worker", uniform(1)), budgetError, `invalid global ${field}`);
    assert.throws(() => resolveOperationalBudget({ operationalBudget: uniform(1), operationalBudgetByAgent: { worker: uniform(1) } },
      "worker", invalid), budgetError, `invalid attempt ${field}`);
  }
});

test("resolved caps are independent snapshots across agents, attempts, input mutations, and output mutations", () => {
  const shared = budget();
  const config = { operationalBudget: shared, operationalBudgetByAgent: { worker: shared, other: shared } };
  const first = resolveOperationalBudget(config, "worker", shared);
  const second = resolveOperationalBudget(config, "other", shared);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first, shared);
  Object.assign(first, uniform(1));
  assert.deepEqual(shared, budget());
  assert.deepEqual(second, budget());
  assert.deepEqual(resolveOperationalBudget(config, "worker", shared), budget());
  Object.assign(shared, uniform(2));
  assert.deepEqual(second, budget());
  assert.deepEqual(resolveOperationalBudget(config, "worker", shared), uniform(2));
  assert.equal(resolveOperationalBudget({}, "worker"), undefined);
  assert.deepEqual(resolveOperationalBudget({}, "worker", budget()), budget());
});

test("omitted and explicitly undefined budgets leave legacy defaults and absence semantics unchanged", () => {
  const expected = {
    stateDir: join(homedir(), ".openclaw", "dsh-native"),
    startupTimeoutMs: 60_000, shutdownTimeoutMs: 15_000, streamIdleTimeoutMs: 120_000,
    maxConcurrentRuns: 8, allowedBaseUrls: ["https://api.deepseek.com"],
    allowedCopilotBaseUrls: [
      "https://api.individual.githubcopilot.com", "https://api.business.githubcopilot.com",
      "https://api.enterprise.githubcopilot.com", "https://api.githubcopilot.com",
    ],
  };
  for (const raw of [undefined, null, {}, { operationalBudget: undefined, operationalBudgetByAgent: undefined }]) {
    const parsed = parseDshConfig(raw);
    assert.deepEqual(parsed, expected);
    assert.equal(Object.hasOwn(parsed, "operationalBudget"), false);
    assert.equal(Object.hasOwn(parsed, "operationalBudgetByAgent"), false);
    assert.equal(resolveOperationalBudget(parsed, "worker", undefined), undefined);
  }
  assert.throws(() => parseDshConfig({ operationalBudgets: budget() }), /Unknown/);
});

test("budget options preserve explicitly configured legacy behavior", () => {
  const legacy = {
    stateDir: join(homedir(), ".openclaw", "budget-config-fixture"),
    startupTimeoutMs: 1000, shutdownTimeoutMs: 2000, streamIdleTimeoutMs: 3000,
    maxConcurrentRuns: 2, allowedBaseUrls: ["http://127.0.0.1:4321/v1/"],
    allowedCopilotBaseUrls: ["https://api.business.githubcopilot.com/"],
    toolAllowlist: ["read"], taskPreparation: { agentIds: ["worker"] },
  };
  const expected = parseDshConfig(legacy);
  const { operationalBudget, operationalBudgetByAgent, ...unchanged } = parseDshConfig({
    ...legacy, operationalBudget: budget(), operationalBudgetByAgent: { worker: budget() },
  });
  assert.deepEqual(unchanged, expected);
  assert.deepEqual(operationalBudget, budget());
  assert.deepEqual(operationalBudgetByAgent, { worker: budget() });
  assert.deepEqual(expected.allowedBaseUrls, ["http://127.0.0.1:4321/v1"]);
  assert.deepEqual(expected.taskPreparation.executionTools, ["read"]);
  jsonAgreement({}, true, "legacy defaults");
  jsonAgreement(legacy, true, "legacy explicit config");
  jsonAgreement({ ...legacy, operationalBudget: budget(), operationalBudgetByAgent: { worker: budget() } }, true,
    "legacy with budgets");
});

test("manifest declares the exact required positive safe-integer budget and bounded exact-id map", () => {
  const definition = schema.definitions.operationalBudget;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.equal(definition.type, "object");
  assert.equal(definition.additionalProperties, false);
  assert.deepEqual([...definition.required].sort(), [...FIELDS].sort());
  assert.deepEqual(Object.keys(definition.properties).sort(), [...FIELDS].sort());
  for (const field of FIELDS) {
    assert.equal(definition.properties[field].type, "integer", field);
    assert.equal(definition.properties[field].minimum, 1, field);
    assert.equal(definition.properties[field].maximum, Number.MAX_SAFE_INTEGER, field);
    assert.equal(Object.hasOwn(definition.properties[field], "default"), false, field);
  }
  assert.equal(schema.properties.operationalBudget.$ref, "#/definitions/operationalBudget");
  const map = schema.properties.operationalBudgetByAgent;
  assert.equal(map.type, "object");
  assert.equal(map.maxProperties, 64);
  assert.equal(map.propertyNames.pattern, "^[a-z][a-z0-9_-]{0,63}$");
  assert.deepEqual(map.additionalProperties, { $ref: "#/definitions/operationalBudget" });
  for (const key of ["operationalBudget", "operationalBudgetByAgent"]) {
    assert.equal((schema.required ?? []).includes(key), false);
    assert.equal(Object.hasOwn(schema.properties[key], "default"), false);
  }
});

for (const field of FIELDS) {
  test(`manifest and runtime reject invalid JSON ${field} limits globally and per agent`, () => {
    const values = [0, -1, -0.5, 1.5, Number.MAX_SAFE_INTEGER + 1, 1e100, "1", "", null, true, false, [], [1], {}];
    for (const value of values) {
      for (const raw of [
        { operationalBudget: budget({ [field]: value }) },
        { operationalBudgetByAgent: { worker: budget({ [field]: value }) } },
      ]) jsonAgreement(raw, false, `${field}=${JSON.stringify(value)}`);
    }
    for (const value of [NaN, Infinity, -Infinity]) {
      assert.equal(validate({ operationalBudget: budget({ [field]: value }) }), false);
      assert.equal(validate({ operationalBudgetByAgent: { worker: budget({ [field]: value }) } }), false);
    }
  });
}

test("manifest and runtime reject unknown budget fields and nonobject JSON budget containers", () => {
  for (const raw of [
    { operationalBudget: budget({ extra: 1 }) },
    { operationalBudgetByAgent: { worker: budget({ extra: 1 }) } },
    { operationalBudgetByAgent: { worker: budget(), unselected: {} } },
  ]) jsonAgreement(raw, false, "unknown field or malformed unselected budget");
  for (const value of [null, [], [budget()], "budget", 1, true, false]) {
    for (const raw of [
      { operationalBudget: value },
      { operationalBudgetByAgent: value },
      { operationalBudgetByAgent: { worker: value } },
    ]) jsonAgreement(raw, false, `invalid JSON container ${JSON.stringify(value)}`);
  }
  assert.equal(validate({ operationalBudgets: budget() }), false);
});

test("manifest and runtime agree on empty maps, 64 agents, 64-character ids, and rejected exact-id boundaries", () => {
  for (const map of [{}, agentMap(64), {
    a: budget(), ["a".repeat(64)]: budget(), "worker-2_name": budget(), constructor: budget(),
  }]) {
    jsonAgreement({ operationalBudgetByAgent: map }, true, "valid agent boundary");
  }
  jsonAgreement({ operationalBudgetByAgent: agentMap(65) }, false, "65 agents");
  for (const agent of INVALID_AGENT_IDS) {
    jsonAgreement({ operationalBudgetByAgent: { [agent]: budget() } }, false, `invalid id ${JSON.stringify(agent)}`);
  }
});

test("manifest rejects JSON agent ids containing terminal line breaks", () => {
  for (const ending of LINE_ENDINGS) {
    jsonAgreement({ operationalBudgetByAgent: { [`worker${ending}`]: budget() } }, false,
      `line break ${JSON.stringify(ending)}`);
  }
});
