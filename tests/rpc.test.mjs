import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { JsonRpcPeer } from "../dist/rpc.js";

function pair(optionsA = {}, optionsB = {}) {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const a = new JsonRpcPeer(bToA, aToB, optionsA);
  const b = new JsonRpcPeer(aToB, bToA, optionsB);
  return { a, b, aToB, bToA, close() { a.close(); b.close(); aToB.destroy(); bToA.destroy(); } };
}

test("bidirectional requests allow tools while a run is pending", async () => {
  let peers;
  peers = pair(
    { onRequest: async (method, params) => { assert.equal(method, "tool"); return { text: params.name }; } },
    { onRequest: async () => peers.b.request("tool", { name: "read" }) },
  );
  try { assert.deepEqual(await peers.a.request("run", {}), { text: "read" }); }
  finally { peers.close(); }
});

test("remote errors reject rather than return success-shaped results", async () => {
  const peers = pair({}, { onRequest: async () => { throw new Error("denied"); } });
  try { await assert.rejects(peers.a.request("run", {}), /denied/); }
  finally { peers.close(); }
});

test("notifications retain ordering and drain waits for handlers", async () => {
  const seen = [];
  const peers = pair({ onNotification: async (_, value) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen.push(value);
  } });
  try {
    await peers.b.notify("event", 1);
    await peers.b.notify("event", 2);
    await new Promise((resolve) => setImmediate(resolve));
    await peers.a.drain();
    assert.deepEqual(seen, [1, 2]);
  } finally { peers.close(); }
});

test("malformed frames and oversized frames close pending calls", async () => {
  for (const frame of ["not-json\n", "x".repeat(129)]) {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const peer = new JsonRpcPeer(input, output, { maxFrameBytes: 128 });
    const rejected = assert.rejects(peer.request("run", {}), /Invalid|limit/);
    input.write(frame);
    await rejected;
    await peer.closed;
    input.destroy(); output.destroy();
  }
});

test("EOF rejects pending requests", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const peer = new JsonRpcPeer(input, output);
  const rejected = assert.rejects(peer.request("run", {}), /EOF/);
  input.end();
  await rejected;
  peer.close(); output.destroy();
});

test("close-only input destroy rejects pending requests and records failure reason", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const peer = new JsonRpcPeer(input, output);
  const rejected = assert.rejects(peer.request("run", {}), /input closed/);
  input.destroy();
  await rejected;
  assert.match(peer.failureReason.message, /input closed/);
  await peer.closed;
  output.destroy();
});

test("transport errors reject pending requests with the original code", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const peer = new JsonRpcPeer(input, output);
  const failure = Object.assign(new Error("read ENOTCONN"), { code: "ENOTCONN" });
  const rejected = assert.rejects(peer.request("run", {}), (error) => error.code === "ENOTCONN");
  input.destroy(failure);
  await rejected;
  assert.equal(peer.failureReason.code, "ENOTCONN");
  await peer.closed;
  output.destroy();
});

test("output close-only rejects pending requests without an unhandled write", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new JsonRpcPeer(input, output);
  const rejected = assert.rejects(peer.request("run", {}), /output closed|premature close|closed/i);
  output.destroy();
  await rejected;
  await peer.closed;
  input.destroy();
});

test("UTF-8 split across reads is preserved", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let resolve;
  const received = new Promise((done) => { resolve = done; });
  const peer = new JsonRpcPeer(input, output, { onNotification: (_, value) => resolve(value) });
  const bytes = Buffer.from('{"jsonrpc":"2.0","method":"event","params":"\u4e2d"}\n');
  const split = bytes.indexOf(Buffer.from("\u4e2d")) + 1;
  input.write(bytes.subarray(0, split));
  input.write(bytes.subarray(split));
  assert.equal(await received, "\u4e2d");
  peer.close(); input.destroy(); output.destroy();
});

test("malformed trailing output is not hidden by an earlier successful response", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const peer = new JsonRpcPeer(input, output);
  const request = peer.request("shutdown", {});
  input.write('{"jsonrpc":"2.0","id":1,"result":{}}\ngarbage\n');
  assert.deepEqual(await request, {});
  await assert.rejects(peer.drain(), /Invalid/);
  peer.close(); input.destroy(); output.destroy();
});

test("expected shutdown EOF is not a framing failure", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const peer = new JsonRpcPeer(input, output);
  const request = peer.request("shutdown", {});
  await new Promise((resolve) => setImmediate(resolve));
  input.end('{"jsonrpc":"2.0","id":1,"result":{}}\n');
  assert.deepEqual(await request, {});
  await peer.closed;
  await peer.drain();
  output.destroy();
});

test("a late stream write error after EOF remains handled", async () => {
  let failWrite;
  const input = new PassThrough();
  const output = new Writable({ write(_, __, callback) { failWrite = callback; } });
  const peer = new JsonRpcPeer(input, output);
  const request = assert.rejects(peer.request("run", {}), /EOF/);
  await new Promise((resolve) => setImmediate(resolve));
  input.end();
  await request;
  failWrite(new Error("late write failure"));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(peer.drain(), /late write failure/);
});
