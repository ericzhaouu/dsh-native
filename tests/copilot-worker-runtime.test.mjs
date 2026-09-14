import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import * as Spine from "@deepseek-ai/dsh-agent-spine-demo";
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import { BridgeWorker } from "../dist/bridge/index.js";
import { JsonRpcPeer } from "../dist/rpc.js";

const callback = {
  name: "host_read",
  description: "Read through the host",
  parameters: {
    type: "object",
    properties: { file: { type: "string" } },
    required: ["file"],
    additionalProperties: false,
  },
};

async function harness(t, root, generate, onTool = async () => ({ text: "ok", isError: false })) {
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const ctx = new Context();
  await ctx.plugin(Spine, {
    agents: [], includeHarnessIdentity: false, includeRuntimeContext: false,
    persona: "", workspaceContext: false, skills: { enabled: false }, goals: false,
    toolBash: false, toolJobs: false, tools: { mode: "native" },
  }).await();
  await ctx.plugin(JsonlSessionPersistence, { root: path.join(root, "sessions"), compression: "none" }).await();
  let fibers;
  do {
    fibers = [...ctx.registry.values()].flatMap((runtime) => [...runtime.fibers]);
    await Promise.all(fibers.map((fiber) => fiber.await()));
  } while (fibers.some((fiber) => fiber.inertia));
  let step = 0;
  let middlewareCalls = 0;
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model, signal) {
      return {
        ...await super.resolveModel(provider, model, signal),
        reasoning: {
          efforts: [
            { id: "off", name: "Off" },
            { id: "minimal", name: "Minimal" },
            { id: "medium", name: "Medium" },
          ],
        },
      };
    }
    stream(request) { return generate(request, ++step); }
  }
  ctx.llm.registerAdapter(["github-copilot"], new Adapter());
  ctx.on("llm/stream", (_request, next) => {
    middlewareCalls++;
    return next();
  });
  const toWorker = new PassThrough();
  const toHost = new PassThrough();
  const peer = new JsonRpcPeer(toHost, toWorker, {
    onRequest: async (method, params) => {
      assert.equal(method, "tool");
      return onTool(params);
    },
    onNotification(method) { assert.equal(method, "event"); },
  });
  const worker = new BridgeWorker(ctx, toWorker, toHost, async () => { await ctx.fiber.dispose(); });
  t.after(async () => {
    peer.close();
    toWorker.end();
    await worker.cleanup().catch(() => {});
    await ctx.fiber.dispose();
  });
  await worker.ready();
  await peer.drain();
  return {
    peer,
    worker,
    workspace,
    middlewareCalls: () => middlewareCalls,
    shutdown: () => peer.request("shutdown", {}),
    run: {
      provider: "github-copilot",
      sessionId: "copilot_worker_runtime",
      resume: false,
      workspaceDir: workspace,
      systemPrompt: "Only host instructions.",
      prompt: "Hello",
      modelId: "gpt-5",
      reasoningEffort: "medium",
      tools: [callback],
    },
  };
}

test("Copilot runs sanitize opaque replay state before persistence and on resume", async (t) => {
  const root = path.join(process.cwd(), `.copilot-worker-${randomUUID()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  await t.test("initial run", async (t) => {
    const seen = [];
    const h = await harness(t, root, async function* (request, step) {
      if (step === 1) {
        yield { type: "reasoning-delta", index: 0, text: "hidden" };
        yield { type: "text-delta", index: 1, text: "visible" };
        yield {
          type: "block-end",
          index: 2,
          block: { type: "tool-call", id: "call-1|item-1", name: "host_read", arguments: "{\"file\":\"a\"}" },
        };
        yield {
          type: "finish",
          reason: { kind: "tool-calls" },
          replayState: {
            response: {
              kind: "pi-ai",
              version: 2,
              api: "openai-responses",
              provider: "github-copilot",
              model: "gpt-5",
              responseId: "resp_opaque",
              stopReason: "toolUse",
            },
            blocks: [
              { type: "reasoning", thinkingSignature: "enc" },
              { type: "text", textSignature: "msg_1" },
              { type: "tool-call", thoughtSignature: "sig" },
            ],
          },
        };
        return;
      }
      seen.push(request.messages);
      const assistant = request.messages.find((message) => message.role === "assistant");
      const toolResult = request.messages.flatMap((message) => message.content).find((block) => block.type === "tool-result");
      assert.equal(assistant.content.some((block) => block.type === "reasoning"), true);
      assert.equal(assistant.content.at(-1).id, "call-1");
      assert.equal(toolResult.toolCallId, "call-1");
      assert.deepEqual(assistant.source.replayState, {
        response: {
          kind: "pi-ai",
          version: 2,
          api: "openai-responses",
          provider: "github-copilot",
          model: "gpt-5",
          stopReason: "toolUse",
        },
        blocks: [{ type: "reasoning" }, { type: "text" }, { type: "tool-call" }],
      });
      yield { type: "text-delta", index: 0, text: "done" };
      yield { type: "finish", reason: { kind: "stop" } };
    }, async (params) => {
      assert.equal(params.callId, "call-1");
      return { text: "ok", isError: false };
    });
    const result = await h.peer.request("run", h.run);
    assert.equal(result.text, "visibledone");
    assert.equal(seen.length, 1);
    assert.equal(h.middlewareCalls(), 2);
    await h.shutdown();
  });
  await t.test("resume run", async (t) => {
    const h = await harness(t, root, async function* (request) {
      const assistant = request.messages.find((message) => message.role === "assistant");
      const toolResult = request.messages.flatMap((message) => message.content).find((block) => block.type === "tool-result");
      assert.equal(assistant.content.some((block) => block.type === "reasoning"), true);
      assert.equal(assistant.content.find((block) => block.type === "tool-call").id, "call-1");
      assert.equal(toolResult.toolCallId, "call-1");
      assert.deepEqual(assistant.source.replayState, {
        response: {
          kind: "pi-ai",
          version: 2,
          api: "openai-responses",
          provider: "github-copilot",
          model: "gpt-5",
          stopReason: "toolUse",
        },
        blocks: [{ type: "reasoning" }, { type: "text" }, { type: "tool-call" }],
      });
      yield { type: "text-delta", index: 0, text: "resumed" };
      yield { type: "finish", reason: { kind: "stop" } };
    });
    const result = await h.peer.request("run", { ...h.run, resume: true });
    assert.equal(result.text, "resumed");
    await h.shutdown();
  });
});
