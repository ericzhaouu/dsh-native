import { keys, positiveInteger, record } from "./validation.js";

export interface BridgeBudgetConfig {
  operationalBudget: true;
  budgetBaseUrl: string;
  budgetMaxTokens: number;
}

export function budgetBaseUrl(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("budgetBaseUrl must be an HTTP(S) URL");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError("budgetBaseUrl must be an HTTP(S) URL without credentials, query, or fragment");
  }
  return url.href.replace(/\/+$/u, "");
}

/** Only the parent-owned bridge patch can enable this; run/model arguments cannot. */
export function parseBridgeConfig(value: unknown): BridgeBudgetConfig | undefined {
  const config = record(value, "bridge config");
  keys(config, ["operationalBudget", "budgetBaseUrl", "budgetMaxTokens"], "bridge config");
  if (Object.keys(config).length === 0) return undefined;
  if (config.operationalBudget !== true) throw new TypeError("operationalBudget must be true or the config must be empty");
  return {
    operationalBudget: true,
    budgetBaseUrl: budgetBaseUrl(config.budgetBaseUrl),
    budgetMaxTokens: positiveInteger(config.budgetMaxTokens, "budgetMaxTokens"),
  };
}
