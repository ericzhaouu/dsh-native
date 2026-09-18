import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { messageText, startDashboardGateway } from "./fixtures/dashboard-gateway.mjs";
import { MEMORY_MARKER, MEMORY_PATH } from "./fixtures/host-memory-plugin.mjs";

test("host-triggered memory flush is append-only and isolated from the continuing native conversation",
  { timeout: 600000 }, async () => {
    const constraint = `RETAIN-${randomUUID()}`;
    const initial = "PREEXISTING-MEMORY-MUST-REMAIN\n";
    let memoryStep = 0;
    let foregroundCalls = 0;
    const gateway = await startDashboardGateway(async ({ body, tool, text, finish }) => {
      const rendered = JSON.stringify(body.input);
      if (rendered.includes(MEMORY_MARKER)) {
        assert.deepEqual((body.tools ?? []).map((item) => item.name).sort(), ["read", "write"]);
        assert.ok(rendered.includes(constraint), "Maintenance must receive bounded canonical facts");
        if (memoryStep === 0) tool("write", { path: "forbidden-memory.txt", content: "FORBIDDEN" }, "memory_denied");
        else if (memoryStep === 1) {
          const denied = body.input.find((item) => item.type === "function_call_output" && item.call_id === "memory_denied");
          assert.match(denied?.output ?? "", /append.only|memory.*path|outside|only.*write|not.*allowed|restrict|denied/iu);
          tool("write", { path: MEMORY_PATH, content: `${constraint}\n` }, "memory_append");
        } else if (memoryStep === 2) {
          tool("read", { path: MEMORY_PATH }, "memory_readback");
        } else {
          assert.equal(memoryStep, 3);
          const readback = body.input.find((item) => item.type === "function_call_output" && item.call_id === "memory_readback");
          assert.ok(readback?.output.includes(initial.trim()));
          assert.ok(readback?.output.includes(constraint));
          text("NO_REPLY");
        }
        memoryStep++;
        finish();
        return;
      }
      foregroundCalls++;
      assert.equal(memoryStep === 0 || memoryStep === 4, true, "A foreground turn cannot race unfinished memory work");
      assert.ok(rendered.includes(constraint));
      assert.equal(rendered.includes("memory_denied"), false, "Maintenance history must not enter the native foreground thread");
      text(foregroundCalls === 1 ? "FIRST-READY" : "CONTINUED-READY");
      finish({
        input_tokens: foregroundCalls === 1 ? 60000 : 1000, output_tokens: 10,
        total_tokens: foregroundCalls === 1 ? 60010 : 1010,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
      });
    }, {
      memoryFixture: true, modelContextWindow: 128000, hostTools: ["read", "write", "exec"],
      setupWorkspaces: async ({ agents }) => {
        await mkdir(join(agents[0].workspace, "memory"), { recursive: true });
        await writeFile(join(agents[0].workspace, MEMORY_PATH), initial);
      },
    });
    try {
      const sessionKey = `agent:${gateway.agentId}:memory-${randomUUID()}`;
      let originalBinding;
      let canonicalSessionId;
      for (let turn = 0; turn < 2; turn++) {
        const runId = randomUUID();
        await gateway.chat.request("chat.send", {
          sessionKey, agentId: gateway.agentId, idempotencyKey: runId,
          message: turn === 0 ? `Remember ${constraint}. Do not use tools.` : "Continue using the remembered constraint, without tools.",
          thinking: "medium",
        }, { timeoutMs: 180000 });
        const final = await gateway.waitForFinal(sessionKey, runId, 180000);
        assert.equal(messageText(final.payload.message), turn === 0 ? "FIRST-READY" : "CONTINUED-READY");
        const settled = await gateway.waitForDurableSettle(sessionKey, runId, 180000);
        if (turn === 0) {
          originalBinding = settled.binding;
          canonicalSessionId = settled.history.sessionId;
        } else {
          assert.equal(settled.binding.path, originalBinding.path);
          assert.equal(settled.binding.value.sessionId, originalBinding.value.sessionId);
          assert.equal(settled.history.sessionId, canonicalSessionId);
          assert.equal(settled.binding.value.consumedRunIds.length, 2);
          assert.equal(JSON.stringify(settled.history.messages).includes(MEMORY_MARKER), false);
          assert.equal(JSON.stringify(settled.history.messages).includes("NO_REPLY"), false);
        }
      }
      assert.equal(foregroundCalls, 2);
      assert.equal(memoryStep, 4, "The real host must invoke memory maintenance, not skip it");
      const records = await gateway.memory.readRecords();
      assert.deepEqual(records.map((entry) => [entry.name, entry.error]), [["write", true], ["write", false], ["read", false]]);
      assert.equal(new Set(records.map((entry) => entry.runId)).size, 1);
      assert.equal(await readFile(join(gateway.workspace, MEMORY_PATH), "utf8"), `${initial}${constraint}\n`);
      await assert.rejects(stat(join(gateway.workspace, "forbidden-memory.txt")), { code: "ENOENT" });
      const bindings = await gateway.readDshBindings();
      assert.equal(bindings.length, 2, "One foreground and one independent maintenance binding are expected");
      assert.ok(bindings.every((entry) => entry.value.status === "ready"));
      const maintenance = bindings.find((entry) => entry.path !== originalBinding.path);
      assert.deepEqual(maintenance.value.consumedRunIds, [records[0].runId]);
      await gateway.assertHealthyLogs();
    } finally {
      await gateway.close();
    }
  });
