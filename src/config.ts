import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isRecord } from "./protocol.js";
import type { DshConfig } from "./runtime-types.js";
import { COPILOT_ENDPOINTS } from "./copilot-policy.js";

const KEYS = new Set([
  "stateDir", "startupTimeoutMs", "shutdownTimeoutMs", "streamIdleTimeoutMs", "allowedBaseUrls", "allowedCopilotBaseUrls",
]);

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("DSH base URL must not contain credentials, query parameters, or a fragment.");
  }
  if (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) {
    throw new Error("DSH requires HTTPS, except for an explicitly allowed loopback development endpoint.");
  }
  return url.href.replace(/\/+$/, "");
}

export function parseDshConfig(value: unknown): DshConfig {
  const input = value ?? {};
  if (!isRecord(input)) throw new Error("dsh-native configuration must be an object.");
  for (const key of Object.keys(input)) {
    if (!KEYS.has(key)) throw new Error(`Unknown dsh-native configuration field: ${key}`);
  }
  const stateDir = input.stateDir ?? join(homedir(), ".openclaw", "dsh-native");
  if (typeof stateDir !== "string" || !isAbsolute(stateDir)) {
    throw new Error("dsh-native stateDir must be an absolute path.");
  }
  const urls = input.allowedBaseUrls ?? ["https://api.deepseek.com"];
  if (!Array.isArray(urls) || urls.length === 0 || urls.some((url) => typeof url !== "string")) {
    throw new Error("allowedBaseUrls must be a nonempty array of exact endpoint URLs.");
  }
  const copilotUrls = input.allowedCopilotBaseUrls ?? [...COPILOT_ENDPOINTS];
  if (!Array.isArray(copilotUrls) || copilotUrls.length === 0 || copilotUrls.some((url) => typeof url !== "string")) {
    throw new Error("allowedCopilotBaseUrls must be a nonempty array of exact endpoint URLs.");
  }
  return {
    stateDir,
    startupTimeoutMs: timeout(input.startupTimeoutMs, 60_000, "startupTimeoutMs"),
    shutdownTimeoutMs: timeout(input.shutdownTimeoutMs, 15_000, "shutdownTimeoutMs"),
    streamIdleTimeoutMs: timeout(input.streamIdleTimeoutMs, 120_000, "streamIdleTimeoutMs"),
    allowedBaseUrls: urls.map((url: string) => normalizeBaseUrl(url)),
    allowedCopilotBaseUrls: copilotUrls.map((url: string) => normalizeBaseUrl(url)),
  };
}

function timeout(value: unknown, fallback: number, key: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 100 || value > 3_600_000) {
    throw new Error(`${key} must be an integer between 100 and 3600000 milliseconds.`);
  }
  return value;
}
