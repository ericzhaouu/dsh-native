import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { messageText, startDashboardGateway } from "./fixtures/dashboard-gateway.mjs";

const TIMEOUT = 900000;
const SOURCE_FACT = `COPILOT-SOURCE-${randomUUID()}`;
const ACCOUNT_FACT = `COPILOT-ACCOUNT-${randomUUID()}`;
const CONTINUATION = `COPILOT-AUTH-COMPACT-RETAINED ${SOURCE_FACT} ${ACCOUNT_FACT}`;

function serialized(value) {
  return JSON.stringify(value);
}

function isCompactionRequest(body) {
  return /You are now acting as a compaction engine|Output EXACTLY the Markdown structure/iu.test(serialized(body.input));
}

async function readNativeEvents(root, sessionId) {
  const results = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".jsonl")) {
        const rows = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
        if (rows.some((row) => row.type === "session" && row.id === sessionId)) results.push(...rows);
      }
    }
  }
  await walk(root);
  assert.ok(results.length > 0, "Exact native session JSONL must exist");
  return results;
}

function compactSummary(input) {
  assert.ok(input.includes(SOURCE_FACT), "Compaction must receive the source fact");
  assert.ok(input.includes(ACCOUNT_FACT), "Compaction must receive the account fact");
  return [
    "## Primary Request and Intent",
    "- Preserve Copilot auth handoff facts across native compaction.",
    "",
    "## Key Technical Concepts",
    "- Gateway provider registry prepareRuntimeAuth; DSH native compaction.",
    "",
    "## Files and Code",
    "- No files changed by this test conversation.",
    "",
    "## Errors and Fixes",
    "- (none)",
    "",
    "## Pending Jobs",
    "- Continue with the same native session and retained source binding.",
    "",
    "## Current Work",
    `- Retained facts: ${SOURCE_FACT}; ${ACCOUNT_FACT}.`,
    "",
    "## Next Step",
    "- Answer the next user request from compacted context.",
    "",
    "## Critical Context",
    `- ${SOURCE_FACT}`,
    `- ${ACCOUNT_FACT}`,
  ].join("\n");
}

async function runTurn(gateway, sessionKey, message, answer, state) {
  const runId = randomUUID();
  const response = await gateway.chat.request("chat.send", {
    sessionKey,
    agentId: gateway.agentId,
    message,
    thinking: "medium",
    idempotencyKey: runId,
  }, { timeoutMs: 180000 });
  assert.equal(response?.status, "started");
  const final = await gateway.waitForFinal(sessionKey, runId, 180000);
  assert.equal(messageText(final.payload.message), answer);
  const settled = await gateway.waitForDurableSettle(sessionKey, runId, 180000);
  state.hostSessionId ??= settled.history.sessionId;
  state.nativeSessionId ??= settled.binding.value.sessionId;
  state.bindingPath ??= settled.binding.path;
  assert.equal(settled.history.sessionId, state.hostSessionId);
  assert.equal(settled.binding.value.sessionId, state.nativeSessionId);
  assert.equal(settled.binding.path, state.bindingPath);
  return settled;
}

for (const { compactionAuthPatch, trigger } of [
  { compactionAuthPatch: false, trigger: "manual" },
  { compactionAuthPatch: true, trigger: "manual" },
  { compactionAuthPatch: true, trigger: "preflight" },
]) {
test(`Copilot runtime-auth ${trigger} handoff ${compactionAuthPatch ? "prepares the account route and preserves source identity" : "reproduces the unpatched compaction route rejection"}`,
  { timeout: TIMEOUT },
  async () => {
    const state = { summaryRequests: 0, foregroundRequests: 0, routes: [] };
    const gateway = await startDashboardGateway(async ({ body, text, finish, request }) => {
      state.routes.push(request.url);
      assert.equal(request.url, "/account/responses", "DSH must call the prepared account endpoint, never the configured endpoint");
      assert.equal(request.headers.authorization, "Bearer fixture-source-key",
        "DSH must receive the raw source credential owned by the host harness");
      assert.equal(request.headers["copilot-integration-id"], "copilot-developer-cli");
      assert.equal(request.headers["editor-version"], "dsh-native-fixture/0.0.0");

      const input = serialized(body.input);
      if (isCompactionRequest(body)) {
        state.summaryRequests++;
        assert.deepEqual(body.tools ?? [], [], "Compaction summary calls must not receive callable tools");
        text(compactSummary(input));
        finish();
        return;
      }
      state.foregroundRequests++;
      if (state.foregroundRequests === 1) {
        assert.ok(input.includes(SOURCE_FACT));
        text("COPILOT-AUTH-SEEDED");
      } else if (state.foregroundRequests === 2) {
        assert.ok(input.includes(SOURCE_FACT));
        assert.ok(input.includes(ACCOUNT_FACT));
        text("COPILOT-AUTH-ACCOUNTED");
      } else if (state.foregroundRequests === 3) {
        assert.ok(!input.includes(CONTINUATION), "Final answer must not be fed in the user prompt");
        assert.ok(input.includes("<compacted-summary>"));
        assert.ok(input.includes(SOURCE_FACT));
        assert.ok(input.includes(ACCOUNT_FACT));
        text(CONTINUATION);
      } else {
        throw new Error(`Unexpected foreground request ${state.foregroundRequests}`);
      }
      const inputTokens = trigger === "preflight" && state.foregroundRequests === 2 ? 60_000 : 32_000;
      finish({ input_tokens: inputTokens, output_tokens: 10, total_tokens: inputTokens + 10,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } });
    }, {
      copilotAuthFixture: true,
      compactionAuthPatch,
      modelContextWindow: 65536,
      hostTools: [],
      compaction: { enabled: true },
    });

    try {
      const sessionKey = `agent:${gateway.agentId}:copilot-auth-${randomUUID()}`;
      await runTurn(gateway, sessionKey,
        `Remember ${SOURCE_FACT} and ${ACCOUNT_FACT}. Discardable historical padding: ${"synthetic-entry ".repeat(2000)}End padding.`,
        "COPILOT-AUTH-SEEDED", state);
      await runTurn(gateway, sessionKey, "Keep the original source and account facts; do not use tools.", "COPILOT-AUTH-ACCOUNTED", state);

      const requestsBeforeCompact = gateway.responses.requests.length;
      const compact = trigger === "manual" ? await gateway.chat.request("sessions.compact", {
        key: sessionKey,
        agentId: gateway.agentId,
      }, { timeoutMs: 240000 }) : undefined;
      if (!compactionAuthPatch) {
        assert.equal(compact?.ok, false);
        assert.match(compact.reason, /route or account changed/u);
        assert.equal(gateway.responses.requests.length, requestsBeforeCompact);
        assert.equal(state.summaryRequests, 0);
        const binding = JSON.parse(await readFile(state.bindingPath, "utf8"));
        assert.equal(binding.status, "ready");
        return;
      }
      if (trigger === "manual") {
        assert.equal(compact?.ok, true);
        assert.equal(compact.compacted, true);
      }

      await runTurn(gateway, sessionKey,
        "Return the compacted Copilot auth facts without tools. Do not invent identifiers.",
        CONTINUATION, state);

      assert.deepEqual([...new Set(state.routes)], ["/account/responses"]);
      assert.equal(state.summaryRequests, 1, `${trigger} compaction must use one genuine native summary`);
      const records = await gateway.copilotAuthFixture.readRecords();
      const preparations = records.filter((record) => record.kind === "prepare-runtime-auth");
      assert.ok(preparations.length >= 4, "Every foreground and compaction route must use provider prepareRuntimeAuth");
      assert.equal(new Set(preparations.map((record) => record.sourceKeyHash)).size, 1,
        "Host source credential binding must stay stable");
      assert.ok(new Set(preparations.map((record) => record.derivedKeyHash)).size >= 3,
        "The fixture must rotate the provider-derived runtime token on repeated preparation");
      assert.ok(preparations.every((record) => record.accountBaseUrl !== record.configuredBaseUrl));
      assert.ok(preparations.every((record) => record.modelBaseUrl === record.configuredBaseUrl));

      const nativeEvents = await readNativeEvents(gateway.dshState, state.nativeSessionId);
      const summaries = nativeEvents.filter((event) => event.type === "compaction/summary");
      assert.equal(summaries.length, 1);
      assert.ok(serialized(summaries).includes(SOURCE_FACT));
      assert.ok(serialized(summaries).includes(ACCOUNT_FACT));
      await gateway.assertHealthyLogs();
    } finally {
      await gateway.close();
    }
  });
}
