import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { loadAcceptanceResources } from "../scripts/lib/acceptance-resources.mjs";

const stateRoot = resolve(".test-state", "acceptance-resources-test");

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function makeFixtureDir() {
  const root = resolve(stateRoot, randomUUID());
  await mkdir(root, { recursive: true });
  return root;
}

async function writeFixture(root, name, text) {
  const path = resolve(root, name);
  await writeFile(path, text, "utf8");
  return { path, sha256: sha256(text) };
}

test.after(async () => {
  await rm(stateRoot, { recursive: true, force: true });
});

test("loadAcceptanceResources exposes only requested selected-agent references", async () => {
  const root = await makeFixtureDir();
  const article = await writeFixture(root, "synthetic-article.txt", "PRIVATE ARTICLE BODY MUST STAY IN THE TOOL RESOURCE");
  const table = await writeFixture(root, "feishu-table.json", JSON.stringify({ rows: [{ id: "WB-001", hidden: "not pasted" }] }));
  const result = await loadAcceptanceResources({
    allowedFixtureRoots: [root],
    resourceMap: {
      "synthetic-article": {
        "dsh-assistant": { kind: "file", agents: ["dsh-assistant"], path: article.path, description: "Synthetic article file", sha256: article.sha256 },
        "dsh-partner": { kind: "inline", agents: ["dsh-partner"], description: "wrong profile", modelVisible: "must not appear" },
      },
      "feishu-table": { kind: "table", agents: ["dsh-assistant"], path: table.path, description: "Paginated table; read through the table resource", pageSize: 10, sha256: table.sha256 },
      "golden-search": { kind: "inline", agents: ["dsh-assistant"], description: "Public snippets only", modelVisible: { sources: [{ url: "https://www.nasa.gov/artemis-1/", shortFactText: "Artemis I launched on Nov. 16, 2022." }] } },
      "not-requested": { kind: "inline", agents: ["dsh-assistant"], modelVisible: "not serialized" },
    },
  }, { agentProfile: { agentId: "dsh-assistant" }, fixtureNames: ["synthetic-article", "feishu-table", "golden-search"], runId: "run-123" });

  // Binding keys expected by the main runner: fixtureId, kind, path/url, pageSize, sha256.
  assert.deepEqual(result.bindings.map((item) => item.fixtureId), ["synthetic-article", "feishu-table", "golden-search"]);
  assert.equal(result.bindings[0].kind, "file");
  assert.equal(result.bindings[0].path, article.path);
  assert.equal(result.bindings[0].sha256, article.sha256);
  assert.equal(result.bindings[1].kind, "table");
  assert.equal(result.bindings[1].pageSize, 10);
  assert.equal(result.bindings[1].sha256, table.sha256);
  assert.equal(result.bindings[2].kind, "inline");
  assert.equal(result.observations.runId, "run-123");
  assert.equal(result.observations.agentProfile, "dsh-assistant");

  assert.match(result.modelVisibleContext, /addresses, not blanket authority/);
  assert.match(result.modelVisibleContext, /Synthetic article file/);
  assert.match(result.modelVisibleContext, /Paginated table/);
  assert.match(result.modelVisibleContext, /Artemis I launched/);
  assert.doesNotMatch(result.modelVisibleContext, /PRIVATE ARTICLE BODY/);
  assert.doesNotMatch(result.modelVisibleContext, /WB-001/);
  assert.doesNotMatch(result.modelVisibleContext, /must not appear|not serialized/);
});

test("resourceMapPath accepts absolute private JSON and https approved hosts", async () => {
  const root = await makeFixtureDir();
  const mapPath = resolve(root, "resource-map.json");
  await writeFile(mapPath, JSON.stringify({
    version: 1,
    resources: {
      "live-table": { kind: "table", agents: ["dsh-assistant"], url: "https://fixtures.example.test/tables/private-table-id", description: "Live table handle", pageSize: 25 },
    },
  }), "utf8");

  const result = await loadAcceptanceResources({
    resourceMapPath: mapPath,
    resourceHosts: ["fixtures.example.test"],
  }, { agentProfile: "dsh-assistant", fixtureNames: ["live-table"] });

  assert.deepEqual(result.bindings, [{ fixtureId: "live-table", kind: "table", url: "https://fixtures.example.test/tables/private-table-id", pageSize: 25 }]);
  assert.match(result.modelVisibleContext, /fixtures\.example\.test/);
});

test("rejects hidden oracle fields instead of serializing them", async () => {
  await assert.rejects(() => loadAcceptanceResources({
    resourceMap: {
      "poisonous-samples": { kind: "inline", agents: ["dsh-assistant"], modelVisible: { samples: [], forbiddenOutputSubstrings: ["DUMMY_TOKEN"] } },
    },
  }, { agentProfile: "dsh-assistant", fixtureNames: ["poisonous-samples"] }), /hidden-oracle metadata/);

  await assert.rejects(() => loadAcceptanceResources({
    resourceMap: {
      "bad-fixture": { kind: "inline", agents: ["dsh-assistant"], modelVisible: {}, oracle: { answer: 42 } },
    },
  }, { agentProfile: "dsh-assistant", fixtureNames: ["bad-fixture"] }), /unsupported field oracle/);
});

test("requires requested fixture selection and agent allowlist", async () => {
  await assert.rejects(() => loadAcceptanceResources({
    resourceMap: { "synthetic-article": { "dsh-partner": { kind: "inline", agents: ["dsh-partner"], modelVisible: "partner only" } } },
  }, { agentProfile: { agentId: "dsh-assistant" }, fixtureNames: ["synthetic-article"] }), /no resource selection/);

  await assert.rejects(() => loadAcceptanceResources({
    resourceMap: { "golden-search": { kind: "inline", agents: ["dsh-partner"], modelVisible: "partner only" } },
  }, { agentProfile: "dsh-assistant", fixtureNames: ["golden-search"] }), /not allowed/);

  await assert.rejects(() => loadAcceptanceResources({ resourceMap: {} }, { agentProfile: "dsh-assistant", fixtureNames: ["missing"] }), /missing from resource map/);
});

test("file fixtures are read-only references with root and hash checks", async () => {
  const root = await makeFixtureDir();
  const outside = await makeFixtureDir();
  const good = await writeFixture(root, "scoped-file.txt", "scoped synthetic file");
  const bad = await writeFixture(outside, "business-file.txt", "outside business data");

  const ok = await loadAcceptanceResources({
    allowedFixtureRoots: [root],
    resourceMap: { "scoped-file": { kind: "file", agents: ["dsh-assistant"], path: good.path, description: "Scoped file", sha256: good.sha256 } },
  }, { agentProfile: "dsh-assistant", fixtureNames: ["scoped-file"] });
  assert.equal(ok.bindings[0].path, good.path);

  await assert.rejects(() => loadAcceptanceResources({
    allowedFixtureRoots: [root],
    resourceMap: { "scoped-file": { kind: "file", agents: ["dsh-assistant"], path: bad.path } },
  }, { agentProfile: "dsh-assistant", fixtureNames: ["scoped-file"] }), /outside allowedFixtureRoots/);

  await assert.rejects(() => loadAcceptanceResources({
    allowedFixtureRoots: [root],
    resourceMap: { "scoped-file": { kind: "file", agents: ["dsh-assistant"], path: good.path, sha256: "0".repeat(64) } },
  }, { agentProfile: "dsh-assistant", fixtureNames: ["scoped-file"] }), /sha256 mismatch/);
});

test("URL resources deny unsafe protocols, credentials, credential query, and unapproved hosts", async () => {
  const base = { kind: "table", agents: ["dsh-assistant"], pageSize: 10 };
  async function rejectUrl(url, pattern, resourceHosts = ["fixtures.example.test"]) {
    await assert.rejects(() => loadAcceptanceResources({
      resourceHosts,
      resourceMap: { "live-table": { ...base, url } },
    }, { agentProfile: "dsh-assistant", fixtureNames: ["live-table"] }), pattern);
  }

  await rejectUrl("http://fixtures.example.test/table", /must use https/);
  await rejectUrl("https://user:pass@fixtures.example.test/table", /must not embed credentials/);
  await rejectUrl("https://fixtures.example.test/table?access_token=abc", /credential-like/);
  await rejectUrl("https://evil.example.test/table", /host is not approved/);
});
