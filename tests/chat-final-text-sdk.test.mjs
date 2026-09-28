import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { patchHost } from "../host-patch/chat-final-text/apply.mjs";
import { edits, stateName } from "../host-patch/chat-final-text/spec.mjs";
import { patchHost as patchPin } from "../host-patch/apply.mjs";
import { projectRoot } from "./fixtures/patched-host.mjs";

const textOf = (frame) => frame?.message?.content?.filter((b) => b.type === "text").map((b) => b.text).join("");

test("genuine SDK handler scopes body bytes to trusted pinned runs, not producer metadata", { timeout: 300000 }, async (t) => {
  await mkdir(join(projectRoot, "artifacts"), { recursive: true });
  const root = await mkdtemp(join(projectRoot, "artifacts", "chat-final-sdk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = join(root, "openclaw");
  await mkdir(host);
  const source = join(projectRoot, "node_modules", "openclaw");
  const { realpath } = await import("node:fs/promises");
  for (const name of ["package.json", "dist"]) await cp(join(source, name), join(host, name), { recursive: true });
  await symlink(dirname(await realpath(source)), join(host, "node_modules"), "junction");
  await patchPin(host, { action: "apply", offlineConfirmed: true });
  const configPath = join(root, "openclaw.json");
  const config = { agents: { ownership: "explicit", entries: {
    dsh: { runtime: { type: "embedded", harness: "dsh-native" } },
    builtin: { runtime: { type: "embedded" } },
    acp: { runtime: { type: "acp", acp: { agent: "fixture" } } },
    model: { models: { "fixture/test": { agentRuntime: { id: "dsh-native" } } } },
  } }, plugins: { enabled: false } };
  await writeFile(configPath, JSON.stringify(config));
  const saved = { ...process.env };
  Object.assign(process.env, { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: join(root, "state"),
    OPENCLAW_HOME: join(root, "home"), NODE_DISABLE_COMPILE_CACHE: "1" });
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  const load = (name) => import(pathToFileURL(join(host, "dist", name)).href);
  const registry = await load("agent-run-registry-CKYKdfNd.js");
  const events = await load("agent-events-CoxiItUi.js");
  const io = await load("io.runtime-B9iJRs3w.js");
  // Import an unpatched copy first so the controls exercise the genuine original, not a reimplementation.
  const original = await load("server-chat-DhlqkrkS.js");
  const plugin = join(root, "plugin");
  await mkdir(join(plugin, "dist", "native"), { recursive: true });
  await mkdir(join(plugin, "node_modules"));
  await writeFile(join(plugin, "package.json"), '{"type":"module"}');
  await cp(join(projectRoot, "dist", "native", "final-text.js"), join(plugin, "dist", "native", "final-text.js"));
  await cp(join(projectRoot, "host-patch"), join(plugin, "host-patch"), { recursive: true });
  await symlink(host, join(plugin, "node_modules", "openclaw"), "junction");
  const { assertFinalTextCompanion } = await import(pathToFileURL(join(plugin, "dist", "native", "final-text.js")).href);
  await t.test("native preflight rejects missing/partial companion and accepts exact applied bytes", async () => {
    await assert.rejects(assertFinalTextCompanion(), /chat-final-text companion required/);
    await patchHost(host, { action: "apply", offlineConfirmed: true });
    await assertFinalTextCompanion();
    await cp(join(host, stateName, edits[1].file), join(host, edits[1].file));
    await assert.rejects(assertFinalTextCompanion(), /chat-final-text companion required/);
    await patchHost(host, { action: "apply", offlineConfirmed: true });
    await assertFinalTextCompanion();
  });
  await patchHost(host, { action: "apply", offlineConfirmed: true });
  for (const edit of edits) {
    const alternate = edit.file.replace(/\.js$/, "-patched.js");
    await cp(join(host, edit.file), join(host, alternate));
  }
  // The handler's private import must use the patched state's cleanup implementation too.
  const handlerPath = join(host, "dist", "server-chat-DhlqkrkS-patched.js");
  await writeFile(handlerPath, (await readFile(handlerPath, "utf8"))
    .replace('"./server-chat-state-CwKZZaYd.js"', '"./server-chat-state-CwKZZaYd-patched.js"'));
  const patched = await load("server-chat-DhlqkrkS-patched.js");
  let serial = 0;
  const fixture = (sdk, { agent = "dsh", context = true, link = true, linkAgent = agent,
    heartbeat = false, alias = true, generation = events.c(), sourceId } = {}) => {
    const runId = sourceId ?? `source-${++serial}`;
    const clientRunId = alias && link ? `client-${serial}` : runId;
    const sessionKey = `agent:${agent}:body-${serial}`;
    const state = sdk.createChatRunState();
    const frames = [];
    if (context) registry.h(runId, { agentId: agent, sessionKey, lifecycleGeneration: generation,
      isHeartbeat: heartbeat, projectSessionLifecycle: false });
    if (link) state.registry.add(runId, { clientRunId, agentId: linkAgent, sessionKey });
    const handler = sdk.createAgentEventHandler({
      chatRunState: state, agentRunSeq: new Map(), toolEventRecipients: state.toolEventRecipients,
      sessionEventSubscribers: sdk.createSessionEventSubscriberRegistry(),
      sessionMessageSubscribers: sdk.createSessionMessageSubscriberRegistry(),
      broadcast: (event, payload) => frames.push({ event, ...payload }),
      broadcastToConnIds() {}, nodeSendToSession() {},
      resolveSessionKeyForRun: () => sessionKey, clearAgentRunContext: registry.a,
      loadGatewaySessionLifecycleSnapshotForEvent: () => ({}),
      persistGatewaySessionLifecycleEventForEvent: async () => {},
      lifecycleErrorRetryGraceMs: 0,
    });
    let seq = 0;
    const emit = (stream, data, extra = {}) => handler({
      runId, sessionKey, agentId: agent, lifecycleGeneration: generation,
      seq: ++seq, ts: Date.now(), stream, data, ...extra,
    });
    const finish = (data = {}, extra) => {
      emit("lifecycle", { phase: "end", ...data }, extra);
      return frames.findLast((f) => f.event === "chat" && ["final", "error", "aborted"].includes(f.state));
    };
    const close = () => { handler.dispose(); state.clear(); registry.a(runId); };
    t.after(close);
    return { runId, clientRunId, sessionKey, state, frames, emit, finish, close };
  };
  const answer = (sdk, body, options, extra = {}) => {
    const f = fixture(sdk, options);
    f.emit("assistant", { text: body, ...extra });
    const final = f.finish();
    const delta = f.frames.findLast((frame) => frame.event === "chat" && frame.state === "delta");
    f.close();
    return { final, delta };
  };

  await t.test("baseline loses 4501st byte; pinned final and last flush preserve it", () => {
    const body = "x".repeat(4500) + "\n";
    assert.equal(textOf(answer(original, body).final).length, 4500);
    const f = fixture(patched);
    f.emit("assistant", { text: "x", itemId: "one" });
    f.emit("assistant", { text: body, itemId: "one" });
    assert.deepEqual(Buffer.from(textOf(f.finish())), Buffer.from(body));
    const lastDelta = f.frames.findLast((frame) => frame.event === "chat" && frame.state === "delta");
    assert.deepEqual(Buffer.from(textOf(lastDelta)), Buffer.from(body));
  });
  for (const body of ["plain", "末行\n", "\n\n中文🙂\r\n\r\n", "\t body \t", "```js\r\n\tcode  \r\n```\r\n"]) {
    await t.test(`exact DSH body ${JSON.stringify(body)}`, () => {
      const { final } = answer(patched, body);
      assert.deepEqual(Buffer.from(textOf(final)), Buffer.from(body));
    });
  }
  for (const options of [{ agent: "builtin" }, { agent: "acp" }, { agent: "model" },
    { context: false }, { linkAgent: "builtin" }, { generation: "stale-generation" }]) {
    await t.test(`non-DSH/ambiguous identity parity ${JSON.stringify(options)}`, () => {
      const body = " \tordinary\n";
      const forged = { preserveWhitespace: true, rawFinal: body, agentId: "dsh",
        metadata: { harness: "dsh-native" }, itemId: "dsh-native:forged:assistant" };
      assert.equal(textOf(answer(patched, body, options, forged).final),
        textOf(answer(original, body, options, forged).final));
    });
  }
  await t.test("spoofed event agentId cannot opt an ordinary registered run into DSH", () => {
    const f = fixture(patched, { agent: "builtin" });
    f.emit("assistant", { text: "ordinary\n", itemId: "dsh-native:run:assistant" }, { agentId: "dsh" });
    assert.equal(textOf(f.finish({}, { agentId: "dsh" })), "ordinary");
  });
  await t.test("trusted context without chat link supports the same body projection", () => {
    assert.equal(textOf(answer(patched, "no-link\n", { link: false }).final), "no-link\n");
  });
  await t.test("config reload and context cleanup cannot reselect a bound run", () => {
    const f = fixture(patched);
    f.emit("assistant", { text: "stable\n" });
    assert.equal(io.D("agents.entries.dsh.runtime.harness", "openclaw").ok, true);
    registry.a(f.runId);
    assert.equal(textOf(f.finish()), "stable\n");
    io.E();
    const g = fixture(patched, { agent: "builtin" });
    g.emit("assistant", { text: "ordinary\n" });
    io.D("agents.entries.builtin.runtime.harness", "dsh-native");
    assert.equal(textOf(g.finish()), "ordinary");
    io.E();
  });
  await t.test("changed trusted context, generation and source alias cannot reuse the grant", () => {
    for (const change of ["context", "session", "replacement", "generation", "alias"]) {
      const f = fixture(patched);
      f.emit("assistant", { text: "body\n" });
      if (change === "context") registry.h(f.runId, { agentId: "builtin" });
      if (change === "session") registry.h(f.runId, { sessionKey: "agent:dsh:foreign" });
      if (change === "replacement") {
        registry.a(f.runId);
        registry.h(f.runId, { agentId: "dsh", sessionKey: f.sessionKey });
      }
      if (change === "alias") {
        f.state.registry.add("foreign-run", { clientRunId: f.clientRunId, agentId: "dsh", sessionKey: f.sessionKey });
      }
      const extra = change === "generation" ? { lifecycleGeneration: "stale" }
        : change === "alias" ? { runId: "foreign-run" } : {};
      assert.notEqual(textOf(f.finish({}, extra)), "body\n");
    }
  });
  await t.test("cleanup removes grants even when tool recipients retain the record", () => {
    const f = fixture(patched, { alias: false });
    f.state.toolEventRecipients.add(f.runId, "retained-client");
    f.emit("assistant", { text: "body\n" });
    assert.equal(textOf(f.finish()), "body\n");
    const record = f.state.runs.get(f.runId);
    assert.ok(record);
    assert.equal(Object.getOwnPropertySymbols(record).length, 0);
    registry.h(f.runId, { agentId: "builtin", sessionKey: f.sessionKey });
    f.emit("assistant", { text: "ordinary\n" });
    assert.equal(textOf(f.finish()), "ordinary");
  });
  await t.test("abort and lifecycle rotation cannot retain a body-preservation grant", () => {
    const f = fixture(patched, { alias: false });
    f.emit("assistant", { text: "partial\n" });
    f.state.getOrCreate(f.runId).abortMarker = patched.createChatAbortMarker();
    assert.equal(f.finish({ aborted: true }), undefined);
    assert.equal(f.state.runs.get(f.runId)?.[Symbol.for("openclaw.dshNative.chatFinalText.v1")], undefined);
    const g = fixture(patched);
    g.emit("assistant", { text: "old generation\n" });
    registry.C();
    assert.notEqual(textOf(g.finish()), "old generation\n");
  });
  for (const body of ["", "\n \t\r\n", "NO_REPLY\n", "REPLY_SKIP\n", "ANNOUNCE_SKIP\n",
    "NO_RE", "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\npublic",
    "[[reply_to_current]]public", "Reasoning:\n_visible upstream semantics_\n\npublic"]) {
    await t.test(`suppression/redaction semantics ${JSON.stringify(body)}`, () => {
      for (const heartbeat of [false, true]) {
        const before = answer(original, body, { heartbeat });
        const after = answer(patched, body, { heartbeat });
        assert.equal(textOf(after.final), textOf(before.final),
          "Existing display projection, not raw metadata, defines control and internal text");
        assert.equal(after.final?.message === undefined, before.final?.message === undefined);
        assert.ok(!textOf(after.final)?.includes("secret"));
      }
    });
  }
  await t.test("heartbeat acknowledgements remain suppressed", () => {
    assert.equal(answer(original, "HEARTBEAT_OK\n", { heartbeat: true }).final.message, undefined);
    assert.equal(answer(patched, "HEARTBEAT_OK\n", { heartbeat: true }).final.message, undefined);
  });
  await t.test("commentary, reasoning and error do not turn into visible final body", () => {
    for (const sdk of [original, patched]) {
      const f = fixture(sdk);
      f.emit("reasoning", { text: "PRIVATE REASONING\n" });
      f.emit("assistant", { text: "PRIVATE COMMENTARY\n", phase: "commentary", itemId: "commentary" });
      assert.equal(f.finish().message, undefined);
      const g = fixture(sdk);
      g.emit("assistant", { text: "partial\n" });
      g.emit("lifecycle", { phase: "error", error: "fixture", status: "failed" });
      assert.equal(g.frames.findLast((e) => e.event === "chat").state, "error");
    }
  });
  await t.test("test copies never modify shared SDK bytes", async () => {
    const { createHash } = await import("node:crypto");
    for (const edit of edits) {
      assert.equal(createHash("sha256").update(await readFile(join(source, edit.file))).digest("hex"), edit.sha256);
    }
  });
});
