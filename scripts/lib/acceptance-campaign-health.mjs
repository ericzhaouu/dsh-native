import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { CampaignError } from "./acceptance-campaign-state.mjs";

export class TransientHealthError extends CampaignError {
  constructor(code) { super(code); this.name = "TransientHealthError"; }
}
export class HealthWaitExpired extends CampaignError {
  constructor() { super("health-wait-expired"); this.name = "HealthWaitExpired"; }
}

export function validateHealth(config) {
  let url;
  try { url = new URL(config?.url); } catch { throw new CampaignError("invalid-health-config"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash ||
      !config.headers || typeof config.headers !== "object" || Array.isArray(config.headers) ||
      Object.values(config.headers).some((value) => typeof value !== "string")) {
    throw new CampaignError("invalid-health-config");
  }
  for (const key of ["totalWaitMs", "requestTimeoutMs", "initialBackoffMs", "maxBackoffMs"]) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0 || config[key] > 2147483647) {
      throw new CampaignError("invalid-health-config");
    }
  }
  const goodSamples = config.goodSamples ?? 3;
  if (!Number.isSafeInteger(goodSamples) || goodSamples < 3 ||
      config.maxBackoffMs < config.initialBackoffMs) throw new CampaignError("invalid-health-config");
  return { ...structuredClone(config), goodSamples };
}

export async function sampleHealth(config, { signal, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(config.url, { signal, headers: config.headers, redirect: "error" });
  } catch (error) {
    if (signal?.aborted) throw new TransientHealthError("health-request-timeout");
    const code = error.cause?.code ?? error.code;
    if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code)) {
      throw new TransientHealthError("health-connection");
    }
    throw new CampaignError("health-transport-config");
  }
  if ([429, 500, 502, 503, 504].includes(response.status)) {
    await response.body?.cancel();
    throw new TransientHealthError(`health-http-${response.status}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new CampaignError(response.status === 401 || response.status === 403 ?
      "health-authorization" : "health-endpoint-config");
  }
  let value;
  try { value = await response.json(); }
  catch {
    if (signal?.aborted) throw new TransientHealthError("health-request-timeout");
    throw new CampaignError("health-response-config");
  }
  if (value?.ready !== true || value?.eventLoop?.degraded !== false) {
    throw new TransientHealthError("health-not-ready");
  }
  return true;
}

/** Static checks are outside the retry catch; only typed transient health failures retry. */
export async function waitForHealth(input, {
  now = () => performance.now(), delay = sleep, probe = sampleHealth,
  preflight = async () => {}, onSample = async () => {},
} = {}) {
  const config = validateHealth(input);
  const deadline = now() + config.totalWaitMs;
  let good = 0;
  let backoff = config.initialBackoffMs;
  let samples = 0;
  while (now() < deadline) {
    await preflight();
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const timeoutMs = Math.min(remaining, config.requestTimeoutMs);
    const abort = new AbortController();
    let timer;
    let reason = null;
    try {
      await Promise.race([
        Promise.resolve().then(() => probe(config, { signal: abort.signal, timeoutMs })),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new TransientHealthError("health-request-timeout"));
          }, timeoutMs);
        }),
      ]);
      good++;
    } catch (error) {
      if (!(error instanceof TransientHealthError)) throw error;
      reason = error.code;
      good = 0;
    } finally { clearTimeout(timer); abort.abort(); }
    samples++;
    await onSample({ samples, good, reason, remainingMs: Math.max(0, deadline - now()) });
    if (now() >= deadline) break;
    if (good >= config.goodSamples) return { samples, good };
    await delay(Math.min(deadline - now(), reason ? backoff : config.initialBackoffMs));
    backoff = reason ? Math.min(config.maxBackoffMs, backoff * 2) : config.initialBackoffMs;
  }
  throw new HealthWaitExpired();
}
