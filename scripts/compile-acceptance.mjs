#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileManifestValidator, ensureAbsoluteRunRoot, ensureSafeRunRoot } from "./lib/acceptance-contract.mjs";

const corpusRoot = new URL("../tests/acceptance/cases/", import.meta.url);
const fixtureRoot = new URL("../tests/fixtures/acceptance/", import.meta.url);
const CORPUS_VERSION = "approved1.0testplan.acceptanceCorpus.v1";
const modes = new Set(["chat", "clarify", "draft", "execute"]);

function category(taskClass = "") {
  if (/skill|distill/.test(taskClass)) return "skill";
  if (/delivery|channel/.test(taskClass)) return "delivery";
  if (/authority|safety|injection/.test(taskClass)) return "safety";
  return "business";
}

function expectedOutcome(expected) {
  const outcomes = expected.permittedOutcomes;
  if (outcomes.includes("completed")) return "completed";
  if (outcomes.includes("correctly_blocked")) return "correctly_blocked";
  throw new Error("Corpus cases must have a non-infrastructure acceptance outcome");
}

function limits(turns, maxHostCalls) {
  return {
    timeoutMs: 240000 * turns,
    usage: {
      userTurns: turns, modelRequests: 24 * turns, inputTokens: 500000 * turns,
      cacheReadTokens: 500000 * turns, cacheWriteTokens: 500000 * turns,
      outputTokens: 12000 * turns, toolCalls: maxHostCalls * turns, priced: false,
    },
  };
}

export async function compileCorpus({ subset = "all" } = {}) {
  if (!["all", "single", "multi", "canary"].includes(subset)) throw new Error("Unknown corpus subset");
  const selected = [
    ["single", "single-turn.json"], ["multi", "multi-turn.json"], ["canary", "feishu-canary.json"],
  ].filter(([kind]) => subset === "all" || kind === subset);
  const manifest = {
    version: 1, suiteId: `dsh-v1-${subset}`, stage: "live",
    description: "Planned real-model cases; execution requires private resource authorization and a trusted adapter.",
    limits: {
      concurrency: 1, perAgentConcurrency: 1, userTurns: 240, modelRequests: 1500,
      inputTokens: 10000000, cacheReadTokens: 9000000, cacheWriteTokens: 1000000,
      outputTokens: 250000, toolCalls: 4800, priced: false,
    },
    cases: [],
  };
  const oracles = { version: 1, suiteId: manifest.suiteId, corpusHashes: {}, fixtureHashes: {}, fixtures: {}, cases: {} };
  let submissions = 0;
  function add(item, id, prompt, turns, script) {
    const expected = script ? script.turns.at(-1).expected : item.expected;
    const approvedModes = expected.modes.filter((mode) => modes.has(mode));
    const executionStatus = expectedOutcome(expected);
    const review = script ? script.turns.map((turn) => ({
      submissionId: turn.submissionId, expected: turn.expected, oracle: turn.oracle,
    })) : [{ expected: item.expected, oracle: item.oracle }];
    const required = [...new Set([
      ...(item.prerequisites ?? []), "model-budget-approved", "private-resource-map-approved",
      "independent-corpus-oracles-available",
    ])];
    const fixtureNames = [...new Set(item.fixtures ?? [])];
    const count = turns?.length ?? 1;
    manifest.cases.push({
      id, stage: "live", agentProfile: item.agentProfile.agentId,
      category: category(item.taskClass), kind: script ? "multiTurn" : "prompt",
      mandatory: true, critical: item.critical === true,
      prompt, ...(turns ? { turns } : {}),
      ...(approvedModes.length === 1 ? { mode: approvedModes[0] } : {}),
      prerequisites: required,
      fixtures: { names: fixtureNames },
      ...(item.adapterControls?.length ? { adapterControls: item.adapterControls } : {}),
      expected: {
        executionStatus,
        businessResult: executionStatus === "correctly_blocked" ? "not_applicable" : "passed",
        authorityAndSafety: "passed",
        delivery: { delivered: true, terminalOutputs: count },
      },
      assertions: {
        policyFacts: [
          { name: "independentOracleEvaluated", value: true },
          { name: "businessAssertionsPassed", value: true },
          { name: "safetyAssertionsPassed", value: true },
          { name: "expectedModesSatisfied", value: true },
          { name: "agentPolicyMatched", value: true },
        ],
      },
      limits: limits(count, item.maxHostCalls ?? 24),
      cleanup: { required: true, receipt: "test-session-and-effect-ledger-settled" },
    });
    oracles.cases[id] = {
      agentProfile: item.agentProfile, fixtureRefs: fixtureNames, reviews: review,
      ...(script ? { script: { id: script.scriptId, turns: script.turns } } : {}),
    };
    submissions += count;
  }
  for (const [kind, name] of selected) {
    const bytes = await readFile(new URL(name, corpusRoot));
    const doc = JSON.parse(bytes);
    if (doc.schemaVersion !== CORPUS_VERSION) throw new Error(`Unsupported corpus version in ${name}`);
    oracles.corpusHashes[name] = createHash("sha256").update(bytes).digest("hex");
    if (kind === "multi") {
      for (const script of doc.scripts) {
        const turns = script.turns.map((turn) => turn.modelVisible.text);
        add(script, script.scriptId, turns[0], turns, script);
      }
    } else {
      for (const item of doc.cases) {
        const prompts = kind === "single" ? item.modelVisible.variants : [item.modelVisible.text];
        prompts.forEach((prompt, index) => add(item,
          kind === "single" ? `${item.caseId}-v${index + 1}` : item.caseId, prompt));
      }
    }
  }
  for (const name of new Set(manifest.cases.flatMap((item) => item.fixtures.names))) {
    if (name === "private-feishu-canary-map") continue;
    if (!["synthetic-article", "feishu-table", "golden-search", "scoped-file", "poisonous-sample-canaries"].includes(name)) {
      throw new Error(`Unrecognized acceptance fixture ${name}`);
    }
    const filename = `${name}.${name === "synthetic-article" ? "txt" : "json"}`;
    const bytes = await readFile(new URL(filename, fixtureRoot));
    oracles.fixtureHashes[filename] = createHash("sha256").update(bytes).digest("hex");
    oracles.fixtures[name] = filename.endsWith(".json") ? JSON.parse(bytes) : { body: bytes.toString("utf8") };
  }
  manifest.corpusOracle = {
    sha256: createHash("sha256").update(`${JSON.stringify(oracles, null, 2)}\n`).digest("hex"),
    caseCount: manifest.cases.length,
  };
  const validate = await compileManifestValidator();
  if (!validate(manifest)) {
    throw new Error(`Compiled corpus is incompatible with runner schema: ${JSON.stringify(validate.errors)}`);
  }
  if (new Set(manifest.cases.map((item) => item.id)).size !== manifest.cases.length) {
    throw new Error("Duplicate expanded corpus case ID");
  }
  return { manifest, oracles, submissions };
}

export async function compileAcceptance(argv = process.argv.slice(2)) {
  let outputRoot;
  let subset = "all";
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--output-root") outputRoot = argv[++index];
    else if (argv[index] === "--subset") subset = argv[++index];
    else throw new Error("Usage: node scripts\\compile-acceptance.mjs --output-root <new-absolute-dir> [--subset all|single|multi|canary]");
  }
  if (!outputRoot || !isAbsolute(outputRoot)) throw new Error("--output-root must be an absolute new directory");
  outputRoot = ensureAbsoluteRunRoot(outputRoot);
  const result = await compileCorpus({ subset });
  await ensureSafeRunRoot(outputRoot);
  await mkdir(dirname(outputRoot), { recursive: true, mode: 0o700 });
  await mkdir(outputRoot, { recursive: false, mode: 0o700 });
  await writeFile(resolve(outputRoot, "manifest.json"), `${JSON.stringify(result.manifest, null, 2)}\n`,
    { flag: "wx", mode: 0o600 });
  await writeFile(resolve(outputRoot, "oracles.json"), `${JSON.stringify(result.oracles, null, 2)}\n`,
    { flag: "wx", mode: 0o600 });
  return { status: "planned", cases: result.manifest.cases.length, submissions: result.submissions,
    manifestPath: resolve(outputRoot, "manifest.json"), oraclePath: resolve(outputRoot, "oracles.json") };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  compileAcceptance().then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
