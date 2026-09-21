import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ports = new Set(JSON.parse(process.env.DSH_ISOLATED_PORTS ?? "[]"));
const privateRoot = process.env.DSH_ISOLATED_ROOT;
if (!privateRoot || ports.size !== 2) throw new Error("Missing private fixture isolation boundary");
const hosts = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const children = new Set();
globalThis[Symbol.for("dsh.isolated.children")] = children;

// The SDK prefers a shared POSIX temp root even with TMPDIR set. Refuse it
// before any filesystem access so its normal secure-temp fallback stays private.
const guardedFilesystems = new WeakMap();
function privateTempOnly(original, canonicalTempRoot = false) {
  if (guardedFilesystems.has(original)) return guardedFilesystems.get(original);
  const guarded = function (path, ...args) {
    if (typeof path === "string" || Buffer.isBuffer(path) || path instanceof URL) {
      const resolved = resolve(path instanceof URL ? fileURLToPath(path) : String(path));
      if (/^\/(?:var\/)?tmp(?:\/|$)/u.test(resolved)) {
        // SQLite canonicalizes its hardcoded POSIX runtime directory before opening
        // locks. Resolve that root privately; never touch the shared filesystem path.
        if (resolved === "/tmp" && canonicalTempRoot) path = resolve(privateRoot, "tmp");
        else throw Object.assign(new Error("Isolated SDK fixture forbids shared temporary paths"), { code: "EACCES" });
      }
    }
    return original.call(this, path, ...args);
  };
  guardedFilesystems.set(original, guarded);
  for (const key of Reflect.ownKeys(original)) {
    if (["length", "name", "prototype", "arguments", "caller"].includes(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(original, key);
    if (typeof descriptor.value === "function") descriptor.value = privateTempOnly(descriptor.value, canonicalTempRoot);
    Object.defineProperty(guarded, key, descriptor);
  }
  return guarded;
}
for (const api of [fs, fs.promises]) {
  for (const method of ["access", "chmod", "exists", "lstat", "stat", "mkdir", "mkdtemp", "open", "opendir",
    "readFile", "readdir", "readlink", "realpath", "rm", "rmdir", "unlink", "writeFile",
    "appendFile", "createReadStream", "createWriteStream"]) {
    for (const name of [method, `${method}Sync`]) {
      if (typeof api[name] !== "function") continue;
      api[name] = privateTempOnly(api[name], ["exists", "realpath"].includes(method));
    }
  }
}

function check(host, port) {
  if (!hosts.has(host) || !ports.has(Number(port))) {
    throw new Error(`Isolated SDK fixture forbids socket ${host}:${port}`);
  }
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const options = typeof values[0] === "object" ? { ...values[0] }
    : { port: values[0], host: typeof values[1] === "string" ? values[1] : "127.0.0.1" };
  if (options.path || options.fd) throw new Error("Isolated SDK fixture forbids shared IPC sockets");
  check(options.host ?? "127.0.0.1", options.port);
  return connect.call(this, options, values.find((value) => typeof value === "function"));
};
net.Server.prototype.listen = function () {
  throw new Error("The direct SDK child must not start services");
};
for (const method of ["connect", "send"]) dgram.Socket.prototype[method] = function () {
  throw new Error("Isolated SDK fixture forbids datagrams");
};
// DNS can use c-ares without passing through the JavaScript socket guard.
for (const api of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  for (const method of Object.getOwnPropertyNames(api)) {
    if (method.startsWith("resolve") || ["lookup", "lookupService", "reverse"].includes(method)) {
      api[method] = function () { throw new Error("Isolated SDK fixture requires numeric loopback addresses"); };
    }
  }
}
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  check(url.hostname.replace(/^\[|\]$/gu, ""), url.port || (url.protocol === "https:" ? 443 : 80));
  return originalFetch(input, init);
};

const spawn = childProcess.spawn;
childProcess.spawn = function (command, args = [], options = {}) {
  if (resolve(command).toLowerCase() !== resolve(process.execPath).toLowerCase() || options.shell) {
    throw new Error("Isolated SDK fixture permits only its own Node children");
  }
  const env = { ...(options.env ?? process.env),
    DSH_ISOLATED_PORTS: process.env.DSH_ISOLATED_PORTS, DSH_ISOLATED_ROOT: privateRoot };
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "DSH_HOME", "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR", "TEMP", "TMP", "TMPDIR"]) {
    const value = env[key] ?? process.env[key];
    if (value && (resolve(value) === resolve(privateRoot) ||
      resolve(value).startsWith(`${resolve(privateRoot)}${process.platform === "win32" ? "\\" : "/"}`))) {
      env[key] = value;
    } else if (process.env[key]) env[key] = process.env[key];
    else delete env[key];
  }
  const child = spawn.call(this, command, ["--import", import.meta.url, ...args], {
    ...options,
    env,
  });
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
};
for (const method of ["exec", "execSync", "execFile", "execFileSync", "spawnSync", "fork"]) {
  childProcess[method] = function () {
    throw new Error(`Isolated SDK fixture forbids child_process.${method}`);
  };
}
process.once("exit", () => {
  for (const child of children) child.kill();
});
syncBuiltinESMExports();
