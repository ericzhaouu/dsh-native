import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import test from "node:test";
import { normalizeBaseUrl, parseDshConfig } from "../dist/config.js";

test("defaults are opt-in and use a dedicated absolute state directory", () => {
  const config = parseDshConfig(undefined);
  assert.ok(isAbsolute(config.stateDir));
  assert.deepEqual(config.allowedBaseUrls, ["https://api.deepseek.com"]);
});

test("rejects unknown settings, relative state, credentials and remote plaintext", () => {
  assert.throws(() => parseDshConfig({ apiKey: "secret" }), /Unknown/);
  assert.throws(() => parseDshConfig({ stateDir: "relative" }), /absolute/);
  assert.throws(() => normalizeBaseUrl("https://key:secret@example.com"), /credentials/);
  assert.throws(() => normalizeBaseUrl("http://example.com"), /HTTPS/);
  assert.throws(() => parseDshConfig({ startupTimeoutMs: 0 }), /between/);
  assert.throws(() => parseDshConfig({ allowedBaseUrls: [] }), /nonempty/);
});

test("loopback must be explicitly configured and endpoint equality is exact", () => {
  const config = parseDshConfig({ allowedBaseUrls: ["http://127.0.0.1:4321/v1/"] });
  assert.deepEqual(config.allowedBaseUrls, ["http://127.0.0.1:4321/v1"]);
  assert.equal(normalizeBaseUrl("https://api.deepseek.com/"), "https://api.deepseek.com");
});
