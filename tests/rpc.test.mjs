import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import ts from "typescript";

const sourceModules = new Map([["rpc", new URL("../src/rpc.ts", import.meta.url)]].map(([name, source]) => [
  new URL(`../dist/${name}.js`, import.meta.url).href,
  source,
]));
const sourceHooks = registerHooks({
  resolve(specifier, context, next) {
    const url = context.parentURL && new URL(specifier, context.parentURL).href;
    return sourceModules.has(url) ? { url, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return sourceModules.has(url) ? { format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(sourceModules.get(url), "utf8"),
        { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText } : next(url, context);
  },
});
const { JsonRpcPeer } = await import("../dist/rpc.js");
sourceHooks.deregister();

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

test("closing settles a write stuck before its callback", async () => {
  const input = new PassThrough();
  const output = new Writable({ write() {} });
  const peer = new JsonRpcPeer(input, output);
  const request = assert.rejects(peer.request("run", {}), /closed/i);
  await new Promise((resolve) => setImmediate(resolve));
  const drained = assert.rejects(peer.drain(), /closed/i);
  peer.close();
  await request;
  await drained;
  input.destroy(); output.destroy();
});

test("outgoing request overflow fails closed and rejects pending callers", async () => {
  const input = new PassThrough();
  const output = new Writable({ write() {} });
  const peer = new JsonRpcPeer(input, output, { maxPendingRequests: 1 });
  const first = assert.rejects(peer.request("run", { id: 1 }), /pending request limit|closed/i);
  const second = assert.rejects(peer.request("run", { id: 2 }), /pending request limit/i);
  await first;
  await second;
  assert.match(peer.failureReason.message, /pending request limit/);
  input.destroy(); output.destroy();
});

test("notification overflow while a callback is blocked stops later handlers", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const seen = [];
  const peer = new JsonRpcPeer(input, output, {
    maxQueuedNotifications: 2,
    onNotification: async (_, value) => {
      seen.push(value);
      if (value === 1) await new Promise(() => {});
    },
  });
  input.write('{"jsonrpc":"2.0","method":"event","params":1}\n');
  input.write('{"jsonrpc":"2.0","method":"event","params":2}\n');
  input.write('{"jsonrpc":"2.0","method":"event","params":3}\n');
  await peer.closed;
  await assert.rejects(peer.drain(), /notification queue limit|closed/i);
  input.write('{"jsonrpc":"2.0","method":"event","params":4}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [1]);
  input.destroy(); output.destroy();
});

test("inbound request overflow closes without duplicate or late dispatch", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const seen = [];
  const peer = new JsonRpcPeer(input, output, {
    maxInboundRequests: 1,
    onRequest: async (method) => {
      seen.push(method);
      await new Promise(() => {});
    },
  });
  input.write('{"jsonrpc":"2.0","id":1,"method":"first","params":{}}\n');
  await new Promise((resolve) => setImmediate(resolve));
  input.write('{"jsonrpc":"2.0","id":2,"method":"second","params":{}}\n');
  await peer.closed;
  input.write('{"jsonrpc":"2.0","id":3,"method":"late","params":{}}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["first"]);
  assert.match(peer.failureReason.message, /inbound request limit/);
  input.destroy(); output.destroy();
});

test("write queue byte and count overflow reject without counter leaks", async () => {
  const input = new PassThrough();
  const output = new Writable({ write() {} });
  const peer = new JsonRpcPeer(input, output, { maxQueuedWrites: 1, maxQueuedWriteBytes: 1024 });
  const first = assert.rejects(peer.notify("event", "a"), /write queue limit|closed/i);
  const second = assert.rejects(peer.notify("event", "b"), /write queue limit/i);
  await first;
  await second;
  await assert.rejects(peer.notify("event", "c"), /write queue limit|closed/i);
  input.destroy(); output.destroy();
});

test("outgoing JSON preflight rejects oversized sparse arrays without materializing them", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const peer = new JsonRpcPeer(input, output, { maxFrameBytes: 128 });
  await assert.rejects(peer.notify("event", new Array(1_000_000)), /too large/);
  peer.close(); input.destroy(); output.destroy();
});

test("outgoing JSON preflight does not invoke getters", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const peer = new JsonRpcPeer(input, output, { maxFrameBytes: 1024 });
  const params = {};
  Object.defineProperty(params, "secret", { enumerable: true, get() { throw new Error("getter invoked"); } });
  await assert.rejects(peer.notify("event", params), /too large/);
  peer.close(); input.destroy(); output.destroy();
});

test("incoming queued payload bytes are bounded independently of frame and message counts", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const peer = new JsonRpcPeer(input, output, {
    maxFrameBytes: 1024, maxQueuedReadBytes: 150,
    onNotification: async () => new Promise(() => {}),
  });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "event", params: "x".repeat(50) })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "event", params: "y".repeat(50) })}\n`);
  await peer.closed;
  assert.match(peer.failureReason.message, /incoming queue byte limit/);
  await assert.rejects(peer.drain(), /incoming queue byte limit/);
  input.destroy(); output.destroy();
});

test("invalid queue settings cannot disable bounds", () => {
  const input = new PassThrough();
  const output = new PassThrough();
  for (const value of [0, -1, Infinity, 1.5]) {
    assert.throws(() => new JsonRpcPeer(input, output, { maxQueuedWrites: value }), /Invalid.*limit/);
  }
  input.destroy(); output.destroy();
});
