import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { patchHost } from "../host-patch/source-reply/apply.mjs";
import { edits, ownershipHelper, transform, stateName } from "../host-patch/source-reply/spec.mjs";
import { projectRoot } from "./fixtures/patched-host.mjs";

const genuine = join(projectRoot, "node_modules", "openclaw");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "dsh-source-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.9.2" }));
  for (const edit of edits) {
    const target = join(root, ...edit.file.split("/"));
    await mkdir(join(root, "dist"), { recursive: true });
    await cp(join(genuine, ...edit.file.split("/")), target);
  }
  return root;
}
test("ownership companion pins exact bytes, applies idempotently and restores independently", async (t) => {
  const root = await fixture(t);
  assert.equal((await patchHost(root)).status, "unpatched");
  await assert.rejects(patchHost(root, { action: "apply" }), /offline-confirmed/);
  assert.equal((await patchHost(root, { action: "apply", offlineConfirmed: true })).status, "applied");
  assert.equal((await patchHost(root, { action: "apply", offlineConfirmed: true })).status, "applied");
  for (const edit of edits) {
    const result = spawnSync(process.execPath, ["--check", join(root, ...edit.file.split("/"))], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal((await patchHost(root, { action: "restore", offlineConfirmed: true })).status, "unpatched");
  for (const edit of edits) assert.equal(hash(await readFile(join(root, ...edit.file.split("/")))), edit.sha256);
});
test("unsupported versions, source edits and corrupt patch receipts fail closed", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.9.3" }));
  await assert.rejects(patchHost(root), /exact OpenClaw/);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.9.2" }));
  const target = join(root, ...edits[0].file.split("/"));
  const body = await readFile(target);
  await writeFile(target, Buffer.concat([body, Buffer.from("\n// local edit")]));
  await assert.rejects(patchHost(root, { action: "apply", offlineConfirmed: true }), /local changes/);
  await writeFile(target, body);
  await patchHost(root, { action: "apply", offlineConfirmed: true });
  await writeFile(join(root, stateName, "receipt.json"), "{}");
  await assert.rejects(patchHost(root), /Invalid host-patch receipt/);
});

const bindingFactory = new Function(`${ownershipHelper}\nreturn createNativeSourceReplyOwnershipBinding;`)();
function bound({ reset = "reset-one", text = "First  \nSecond", assertCurrent = async () => {} } = {}) {
  const options = { runSessionKey: "agent:ruibi:chat", agentSessionKey: "agent:ruibi:chat",
    sessionId: "session", runId: "run", sourceReplyDeliveryMode: "message_tool_only" };
  const proof = { version: 1, agentId: "ruibi", sessionId: options.sessionId, sessionKey: options.runSessionKey,
    runId: options.runId, nativeStateId: reset ? `session\0reset\0${reset}` : "session",
    assistantKey: reset ? `dsh-native:reset:${reset}:run:assistant` : "dsh-native:run:assistant",
    text, assertCurrent };
  return { options, proof, binding: bindingFactory(options, "ruibi"),
    args: { action: "send", message: text, final: true },
    route: { agentId: "ruibi", sessionId: "session", runId: "run", sessionKey: "agent:ruibi:chat",
      destinationSessionKey: "agent:ruibi:chat", sourceReplyDeliveryMode: "message_tool_only", hasMedia: false, dryRun: false } };
}
for (const reset of ["reset-one", undefined]) {
  test(`out-of-band ownership is one-shot and epoch-bound (${reset ?? "no reset"})`, async () => {
    const f = bound({ reset: reset ?? "" });
    f.binding.bind(f.proof);
    const verify = f.binding.take("dsh-source-reply:run", f.args);
    assert.equal(await verify(f.route), f.proof.assistantKey);
    assert.throws(() => f.binding.bind(f.proof), /duplicate/);
    assert.throws(() => f.binding.take("dsh-source-reply:run", f.args), /cannot authorize/);
  });
}
test("model tool arguments and a guessed native call id cannot grant ownership", () => {
  const f = bound();
  assert.equal(f.binding.take("dsh-source-reply:run", { ...f.args, suppressTranscriptMirror: true }), undefined);
  f.binding.bind(f.proof);
  assert.throws(() => f.binding.take("dsh-source-reply:run", { ...f.args, suppressTranscriptMirror: true }), /cannot authorize/);
});
for (const field of ["runId", "sessionId", "sessionKey", "agentId", "nativeStateId", "assistantKey"]) {
  test(`binding rejects mismatched ${field}`, () => {
    const f = bound();
    assert.throws(() => f.binding.bind({ ...f.proof, [field]: "foreign" }), /binding|mismatch/);
  });
}
for (const field of ["runId", "sessionId", "sessionKey", "agentId", "destinationSessionKey", "sourceReplyDeliveryMode"]) {
  test(`delivery rejects changed ${field}`, async () => {
    const f = bound();
    f.binding.bind(f.proof);
    await assert.rejects(f.binding.take("dsh-source-reply:run", f.args)({ ...f.route, [field]: "foreign" }), /cannot cross/);
  });
}
test("stale committed snapshot is checked immediately before delivery", async () => {
  const f = bound({ assertCurrent: async () => { throw new Error("active reset changed"); } });
  f.binding.bind(f.proof);
  await assert.rejects(f.binding.take("dsh-source-reply:run", f.args)(f.route), /active reset changed/);
});
test("equal text in another run or modified tool text cannot reuse the grant", () => {
  const f = bound();
  f.binding.bind(f.proof);
  assert.throws(() => f.binding.take("dsh-source-reply:other", f.args), /cannot authorize/);
  const g = bound();
  g.binding.bind(g.proof);
  assert.throws(() => g.binding.take("dsh-source-reply:run", { ...g.args, message: "First\nSecond" }), /cannot authorize/);
});
test("real runner suppresses only verified native owner, retaining ordinary mirror behavior", async () => {
  for (const edit of edits.filter((e) => e.file.includes("message-action-runner"))) {
    const original = await readFile(join(genuine, ...edit.file.split("/")), "utf8");
    const patched = transform(original, edit);
    const start = patched.indexOf("\t\t\tmirror: nativeSourceReplyOwned ?");
    const end = patched.indexOf(",\n\t\t\tabortSignal", start);
    assert.ok(start > 0 && end > start);
    const expression = patched.slice(start + "\t\t\tmirror: ".length, end);
    const mirror = new Function("nativeSourceReplyOwned", "dryRun", "input", "outboundRoute", "sendPayload",
      "agentId", "params", "normalizeOptionalString", `return (${expression});`);
    const values = [false, {}, { sessionKey: "destination" }, { message: "Normalized\ntext", mediaUrls: [] },
      "ruibi", { idempotencyKey: "transport-key" }, (s) => s];
    assert.equal(mirror(true, ...values), undefined);
    assert.equal(mirror(false, ...values).sessionKey, "destination");
    assert.equal(mirror(false, ...values).text, "Normalized\ntext");
    assert.ok(patched.includes('throw new Error("Native source reply ownership requires local current-source delivery")'));
  }
});
