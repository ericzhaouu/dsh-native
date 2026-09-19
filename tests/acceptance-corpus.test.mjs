import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import Ajv from "ajv";

const corpusBase = new URL("./acceptance/cases/", import.meta.url);
const fixtureBase = new URL("./fixtures/acceptance/", import.meta.url);
async function readJson(url) { return JSON.parse(await readFile(url, "utf8")); }
async function corpusFiles() {
  const names = (await readdir(corpusBase)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(names.map(async (name) => [name, await readJson(new URL(name, corpusBase))]));
}
function allSingleCases(corpora) {
  return corpora.flatMap(([, doc]) => doc.corpusKind === "single_turn" ? doc.cases : []);
}
function allCases(corpora) { return corpora.flatMap(([, doc]) => doc.cases ?? []); }
function allTurns(corpora) { return corpora.flatMap(([, doc]) => (doc.scripts ?? []).flatMap((script) => script.turns)); }
function stringify(value) { return JSON.stringify(value); }

const chinese = /[\u3400-\u9fff]/;
const realIdentifierPattern = /\b(?:C:\\Users\\|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|xox[baprs]-)\b/;
const placeholderPattern = /请依据公开合成夹具完成本轮验收任务|合成验收脚本|如获授权执行金丝雀检查|本轮验收任务/;

test("acceptance corpus keeps a runner-schema handoff and local runner format", async () => {
  const schema = await readJson(new URL("./acceptance/manifest.schema.json", import.meta.url));
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  assert.equal(typeof ajv.compile(schema), "function");
  assert.ok(schema.required.includes("cases"));
  for (const [name, doc] of await corpusFiles()) {
    assert.equal(doc.schemaVersion, "approved1.0testplan.acceptanceCorpus.v1", name);
    assert.match(doc.runnerIntegration.proposedFormat, /manifest-driven node:test acceptance runner/, name);
    assert.equal(doc.runnerIntegration.defaultMaxHostCalls, 24, name);
  }
});

test("declares exactly 212 model submissions with unique ids", async () => {
  const corpora = await corpusFiles();
  const single = corpora.find(([, doc]) => doc.corpusKind === "single_turn")[1].cases;
  const multi = corpora.find(([, doc]) => doc.corpusKind === "multi_turn")[1].scripts;
  const canary = corpora.find(([, doc]) => doc.corpusKind === "feishu_canary")[1].cases;
  assert.equal(single.length, 56);
  assert.equal(single.reduce((sum, item) => sum + item.modelVisible.variants.length, 0), 168);
  assert.equal(multi.length, 8);
  assert.equal(multi.flatMap((script) => script.turns).length, 32);
  assert.equal(canary.length, 12);
  assert.equal(168 + 32 + 12, 212);
  const ids = [...single.map((item) => item.caseId), ...multi.map((item) => item.scriptId), ...multi.flatMap((item) => item.turns.map((turn) => turn.submissionId)), ...canary.map((item) => item.caseId)];
  assert.equal(new Set(ids).size, ids.length);
});

test("single-turn matrix has the requested agent distribution and skill policy", async () => {
  const single = (await corpusFiles()).find(([, doc]) => doc.corpusKind === "single_turn")[1].cases;
  const byAgent = Object.groupBy(single, (item) => item.agentProfile.agentId);
  assert.equal(byAgent["dsh-assistant"].length, 28);
  assert.equal(byAgent["dsh-partner"].length, 28);
  assert.deepEqual(new Set(byAgent["dsh-assistant"].map((item) => JSON.stringify(item.agentProfile.skillAllowlist))), new Set([JSON.stringify(["content-distill"])]));
  assert.deepEqual(new Set(byAgent["dsh-partner"].map((item) => JSON.stringify(item.agentProfile.skillAllowlist))), new Set([JSON.stringify([])]));
});

test("all cases declare modes, outcomes, prerequisites, fixtures, assertions, critical flags and finite caps", async () => {
  const corpora = await corpusFiles();
  const caseLike = [...allCases(corpora), ...allTurns(corpora)];
  for (const item of caseLike) {
    assert.ok(typeof item.critical === "boolean" || item.turnId, item.caseId ?? item.scriptId ?? item.turnId);
    assert.ok(Array.isArray(item.prerequisites) ? item.prerequisites.length > 0 : true, item.caseId ?? item.scriptId ?? item.turnId);
    assert.ok(Array.isArray(item.fixtures) || item.turnId, item.caseId ?? item.scriptId ?? item.turnId);
    assert.ok(item.maxHostCalls === undefined || item.maxHostCalls <= 24, item.caseId ?? item.scriptId);
    assert.ok(item.expected.modes.length > 0, item.caseId ?? item.turnId);
    assert.ok(item.expected.permittedOutcomes.length > 0, item.caseId ?? item.turnId);
    assert.ok(item.oracle.businessAssertions.length > 0, item.caseId ?? item.turnId);
    assert.ok(item.oracle.safetyAssertions.length > 0, item.caseId ?? item.turnId);
  }
});

test("natural automatic content-distill positives do not require users to say the skill name", async () => {
  const single = (await corpusFiles()).find(([, doc]) => doc.corpusKind === "single_turn")[1].cases;
  const auto = single.filter((item) => item.oracle.skillBehavior?.expectedSelection === "auto");
  assert.ok(auto.length >= 1);
  for (const item of auto) {
    const text = item.modelVisible.variants.join("\n");
    assert.doesNotMatch(text, /content-distill|content_distill|content distill/i, item.caseId);
  }
});

test("corpus contains no production identifiers, host paths, or real secret-looking values", async () => {
  const corpora = await corpusFiles();
  const fixtures = await Promise.all((await readdir(fixtureBase)).map(async (name) => [name, await readFile(new URL(name, fixtureBase), "utf8")]));
  const body = stringify(corpora) + fixtures.map(([, text]) => text).join("\n");
  assert.doesNotMatch(body, realIdentifierPattern);
  assert.doesNotMatch(body, /[A-Za-z]:\\/);
});

test("model-visible prompts and hidden oracles are split", async () => {
  const corpora = await corpusFiles();
  for (const item of allSingleCases(corpora)) {
    const visible = stringify(item.modelVisible);
    assert.doesNotMatch(visible, placeholderPattern, item.caseId);
    assert.doesNotMatch(visible, /WB-\d{3}/, item.caseId);
    assert.doesNotMatch(visible, /resultIds|forbiddenOutputSubstrings|officialSourceCount/, item.caseId);
    for (const variant of item.modelVisible.variants) assert.match(variant, chinese, item.caseId);
  }
  for (const turn of allTurns(corpora)) {
    assert.match(turn.modelVisible.text, chinese, turn.turnId);
    assert.doesNotMatch(turn.modelVisible.text, placeholderPattern, turn.turnId);
  }
});

test("model-visible wording is diverse and tied to per-case semantic anchors", async () => {
  const corpora = await corpusFiles();
  const singlePrompts = allSingleCases(corpora).flatMap((item) => item.modelVisible.variants);
  const multiPrompts = allTurns(corpora).map((turn) => turn.modelVisible.text);
  const canaryPrompts = corpora.find(([, doc]) => doc.corpusKind === "feishu_canary")[1].cases.map((item) => item.modelVisible.text);
  assert.ok(new Set(singlePrompts).size >= 108);
  assert.equal(new Set(multiPrompts).size, 32);
  assert.equal(new Set(canaryPrompts).size, 12);
  for (const item of allSingleCases(corpora)) {
    const visible = item.modelVisible.variants.join("\n");
    assert.ok((item.oracle.modelVisibleRequiredTokens ?? []).length >= 2, item.caseId);
    for (const token of item.oracle.modelVisibleRequiredTokens ?? []) assert.ok(visible.includes(token), `${item.caseId} missing ${token}`);
    assert.deepEqual(item.modelVisible.fixtureRefs, item.fixtures, item.caseId);
  }
  for (const turn of allTurns(corpora)) {
    assert.ok((turn.oracle.modelVisibleRequiredTokens ?? []).length >= 2, turn.turnId);
    for (const token of turn.oracle.modelVisibleRequiredTokens ?? []) assert.ok(turn.modelVisible.text.includes(token), `${turn.turnId} missing ${token}`);
  }
  for (const item of corpora.find(([, doc]) => doc.corpusKind === "feishu_canary")[1].cases) {
    assert.ok((item.oracle.modelVisibleRequiredTokens ?? []).length >= 2, item.caseId);
    for (const token of item.oracle.modelVisibleRequiredTokens ?? []) assert.ok(item.modelVisible.text.includes(token), `${item.caseId} missing ${token}`);
  }
});

test("single-turn table variants ask the same read-only fixture task as their oracle", async () => {
  const single = (await corpusFiles()).find(([, doc]) => doc.corpusKind === "single_turn")[1].cases;
  const tableCases = single.filter((item) => item.fixtures.includes("feishu-table"));
  for (const item of tableCases) {
    const filterIds = new Set((item.oracle.fixtureExpectations ?? []).map((expectation) => expectation.filterId));
    for (const variant of item.modelVisible.variants) {
      assert.doesNotMatch(variant, /hidden\s*oracle|隐藏oracle|resultIds|WB-\d{3}/i, item.caseId);
      if (filterIds.has("open_due_before_oct")) {
        assert.match(variant, /open|state=open/i, item.caseId);
        assert.match(variant, /2026-10-01|10-01|9月/, item.caseId);
        assert.match(variant, /分页|读完|读取|遍历/, item.caseId);
      }
      if (filterIds.has("all_open")) {
        assert.match(variant, /open|state=open/i, item.caseId);
        assert.match(variant, /分页|读完|全部|所有|遍历|不只看第一页/, item.caseId);
      }
    }
  }
});

test("prompt anchors remain separate from deterministic answer checks", async () => {
  const corpora = await corpusFiles();
  const canary = corpora.find(([, doc]) => doc.corpusKind === "feishu_canary")[1].cases;
  const anchorExamples = [
    ["canary-dsh-assistant-03", "120字"],
    ["canary-dsh-assistant-05", "一次"],
    ["canary-dsh-assistant-06", "文本"]
  ];
  for (const [caseId, token] of anchorExamples) {
    const item = canary.find((entry) => entry.caseId === caseId);
    assert.ok(item.oracle.modelVisibleRequiredTokens.includes(token), caseId);
    assert.ok(item.modelVisible.text.includes(token), caseId);
    assert.deepEqual(item.oracle.answerChecks, [], `${caseId} keeps prompt anchors out of answer checks`);
  }
});

test("Feishu canary control proof is hidden and receipt based", async () => {
  const canary = (await corpusFiles()).find(([, doc]) => doc.corpusKind === "feishu_canary")[1].cases;
  for (const item of canary) {
    assert.ok((item.adapterControls ?? []).every((control) => control.visibleToModel === false), item.caseId);
    assert.doesNotMatch(item.modelVisible.text, /适配器|控制器|已完成\/new|重复投递|卡片失败/, item.caseId);
    assert.equal(item.oracle.delivery?.requireReadbackReceipt, true, item.caseId);
    const assertions = item.oracle.businessAssertions.join("\n");
    if (item.taskClass.endsWith("new-reset-prompt")) {
      assert.match(assertions, /hidden adapter receipt/, item.caseId);
      assert.match(assertions, /not by model self-claim/, item.caseId);
    }
    if (item.taskClass.endsWith("duplicate-replay") || item.taskClass.endsWith("reconnect-card")) {
      assert.match(assertions, /hidden adapter receipt/, item.caseId);
      assert.match(assertions, /not prompt self-claim/, item.caseId);
    }
  }
});

test("Feishu table fixture forces pagination and exact timezone-aware oracle results", async () => {
  const table = await readJson(new URL("feishu-table.json", fixtureBase));
  const rows = table.modelVisible.records;
  assert.equal(table.timezone, "Asia/Shanghai");
  assert.equal(table.asOfDate, "2026-09-17");
  assert.equal(table.modelVisible.delivery, "tool-resource");
  assert.ok(rows.length >= 30);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  assert.ok(rows.length > table.pageSize * 2);
  assert.ok(rows.some((row) => row.estimateHours === 0));
  assert.ok(rows.some((row) => row.estimateHours === null));
  assert.ok(rows.some((row) => /[^\u0000-\u007f]/.test(row.title)));
  const titleCounts = Object.groupBy(rows, (row) => row.title);
  assert.ok(Object.values(titleCounts).some((items) => items.length > 1));
  const ids = (filter) => rows.filter(filter).map((row) => row.id);
  assert.deepEqual(table.oracle.filters.open_due_before_oct.resultIds, ids((row) => row.state === "open" && row.dueAt < "2026-10-01"));
  assert.equal(table.oracle.filters.open_due_before_oct.resultIds.length, 10);
  assert.deepEqual(table.oracle.filters.all_open.resultIds, ids((row) => row.state === "open"));
  assert.equal(table.oracle.filters.all_open.resultIds.length, 17);
  assert.deepEqual(table.oracle.filters.zero_estimate.resultIds, ids((row) => row.estimateHours === 0));
  assert.equal(table.oracle.filters.zero_estimate.resultIds.length, 3);
});

test("golden search and poison fixtures are public, synthetic, and bounded", async () => {
  const golden = await readJson(new URL("golden-search.json", fixtureBase));
  assert.ok(golden.modelVisible.sources.every((source) => source.url.startsWith("https://www.") && source.sourceType === "official"));
  assert.ok(golden.modelVisible.sources.every((source) => source.shortFactText.length <= 140));
  assert.equal(golden.oracle.artemisILaunchYear, 2022);
  const poison = await readJson(new URL("poisonous-sample-canaries.json", fixtureBase));
  assert.equal(poison.oracle.allSamplesAreSynthetic, true);
  assert.ok(poison.oracle.forbiddenOutputSubstrings.every((value) => value.startsWith("DUMMY_")));
});

test("live Feishu canaries are explicitly prerequisite-gated and never declared runnable by fixture data", async () => {
  const canary = (await corpusFiles()).find(([, doc]) => doc.corpusKind === "feishu_canary")[1].cases;
  const byAgent = Object.groupBy(canary, (item) => item.agentProfile.agentId);
  assert.equal(byAgent["dsh-assistant"].length, 6);
  assert.equal(byAgent["dsh-partner"].length, 6);
  for (const item of canary) {
    assert.ok(item.prerequisites.includes("live-feishu-canary-approved"), item.caseId);
    assert.ok(item.prerequisites.includes("private-logical-resource-map-present"), item.caseId);
    assert.equal(item.prerequisiteFailureOutcome, "infrastructure_blocked", item.caseId);
    assert.ok(!item.expected.permittedOutcomes.includes("infrastructure_blocked"), item.caseId);
    assert.ok(item.expected.modes.every((mode) => ["chat", "draft", "clarify", "execute"].includes(mode)));
    assert.doesNotMatch(stringify(item), /(?:doccn|shtcn|bascn|tbl)[A-Za-z0-9_-]{8,}/, item.caseId);
  }
});

