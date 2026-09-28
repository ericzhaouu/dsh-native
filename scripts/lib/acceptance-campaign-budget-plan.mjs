import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CampaignError, readJson } from "./acceptance-campaign-state.mjs";

const requireValue = (value, code) => { if (!value) throw new CampaignError(code); };
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const fields = ["maxModelRequests", "maxInputTokens", "maxOutputTokens", "maxToolCalls", "maxDurationMs"];
const multiply = (value, count) => {
  const result = value * count;
  requireValue(positive(result), "budget-plan-overflow");
  return result;
};

function configuredAgent(host, agentId) {
  requireValue(object(host?.agents) &&
    (host.agents.entries === undefined || object(host.agents.entries)) &&
    (host.agents.list === undefined || Array.isArray(host.agents.list)), "budget-agent-not-configured");
  const matches = [];
  if (object(host.agents?.entries) && Object.hasOwn(host.agents.entries, agentId)) matches.push(host.agents.entries[agentId]);
  if (Array.isArray(host.agents?.list)) matches.push(...host.agents.list.filter((item) => item?.id === agentId));
  requireValue(matches.length < 2, "budget-agent-config-ambiguous");
  requireValue(matches.length === 1 && object(matches[0]) &&
    (matches[0].id === undefined || matches[0].id === agentId), "budget-agent-not-configured");
  return matches[0];
}

function modelRoutes(host, agent) {
  const defaults = host.agents?.defaults?.model;
  requireValue([agent.model, defaults].every((model) =>
    model === undefined || typeof model === "string" || object(model)), "budget-model-not-configured");
  const configured = object(agent.model) ? agent.model : undefined;
  const primary = typeof agent.model === "string" ? agent.model :
    configured && Object.hasOwn(configured, "primary") ? configured.primary :
      typeof defaults === "string" ? defaults : defaults?.primary;
  const fallbacks = configured && Object.hasOwn(configured, "fallbacks") ? configured.fallbacks :
    object(defaults) && Object.hasOwn(defaults, "fallbacks") ? defaults.fallbacks : [];
  requireValue(typeof primary === "string" && Array.isArray(fallbacks), "budget-model-not-configured");
  return [primary, ...fallbacks];
}

export function resolveHostContextWindow(host, agentId) {
  const agent = configuredAgent(host, agentId);
  return Math.max(...modelRoutes(host, agent).map((ref) => {
    requireValue(typeof ref === "string" && ref.trim() === ref &&
      ref.indexOf("/") > 0 && !ref.endsWith("/"), "budget-model-not-configured");
    const slash = ref.indexOf("/");
    const models = host.models?.providers?.[ref.slice(0, slash)]?.models;
    const matches = Array.isArray(models) ? models.filter((item) => item?.id === ref.slice(slash + 1)) : [];
    requireValue(matches?.length === 1 && positive(matches[0].contextWindow),
      "budget-full-context-not-configured");
    return matches[0].contextWindow;
  }));
}

function usage(root, turns, review = false) {
  return { userTurns: turns, modelRequests: root.maxModelRequests,
    inputTokens: root.maxInputTokens, cacheReadTokens: root.maxInputTokens,
    cacheWriteTokens: root.maxInputTokens, outputTokens: root.maxOutputTokens,
    toolCalls: review ? 0 : root.maxToolCalls, priced: false };
}

function rootBudget(attempt, turns, setupMs) {
  requireValue(attempt && fields.every((key) => positive(attempt[key])) &&
    Object.keys(attempt).every((key) => fields.includes(key)), "explicit-native-attempt-budget-required");
  const root = Object.fromEntries(fields.map((key) => [key, multiply(attempt[key], turns)]));
  root.maxDurationMs += setupMs;
  requireValue(positive(root.maxDurationMs) && root.maxDurationMs <= 2147483647, "budget-plan-overflow");
  return root;
}

/** Pure allocation arithmetic; adapters still prove their actual prepared context and runtime limits. */
export function allocateCampaignCase(testCase, originalScope, settings) {
  const turns = testCase.turns?.length || 1;
  for (const caps of [testCase.limits?.usage, originalScope.budgets, originalScope.reviewBudgets]) {
    requireValue(caps?.priced !== true && caps?.currencyMicros === undefined, "budget-native-pricing-unsupported");
  }
  const scope = structuredClone(originalScope);
  const attemptBudget = scope.attemptBudget ?? scope.operationalBudget;
  const reviewAttemptBudget = scope.reviewAttemptBudget ?? scope.reviewOperationalBudget;
  const caseBudget = rootBudget(attemptBudget, turns, settings.caseSetupMs);
  const reviewCaseBudget = rootBudget(reviewAttemptBudget, 1, settings.reviewSetupMs);
  for (const [name, derived] of [["caseBudget", caseBudget], ["reviewCaseBudget", reviewCaseBudget]]) {
    if (Object.hasOwn(scope, name)) {
      requireValue(scope[name] && fields.every((key) =>
        positive(scope[name][key]) && scope[name][key] >= derived[key]), "budget-case-root-too-small");
    }
  }
  const dut = usage(caseBudget, turns);
  const review = usage(reviewCaseBudget, 1, true);
  Object.assign(scope, { attemptBudget, caseBudget, reviewAttemptBudget, reviewCaseBudget,
    budgets: dut, reviewBudgets: review });
  // Legacy keys must not silently constrain the new whole-case root to one turn.
  delete scope.operationalBudget;
  delete scope.reviewOperationalBudget;
  const selected = structuredClone(testCase);
  selected.limits = { ...selected.limits, timeoutMs: Math.max(caseBudget.maxDurationMs, reviewCaseBudget.maxDurationMs),
    usage: dut };
  const pools = { dut: { userTurns: turns, modelRequests: dut.modelRequests,
    inputTokens: dut.inputTokens, outputTokens: dut.outputTokens },
  review: { userTurns: 0, modelRequests: review.modelRequests,
    inputTokens: review.inputTokens, outputTokens: review.outputTokens } };
  const reservation = Object.fromEntries(Object.keys(pools.dut).map((key) =>
    [key, pools.dut[key] + pools.review[key]]));
  requireValue(Object.values(reservation).every(positive), "budget-plan-overflow");
  return { testCase: selected, scope, limits: { ...dut, concurrency: 1, perAgentConcurrency: 1 },
    pools, reservation };
}

export async function planCampaignBudgets(config) {
  const manifest = await readJson(config.manifest);
  const scope = await readJson(config.scope, true);
  const gateway = await readJson(config.env.DSH_ACCEPTANCE_GATEWAY_CONFIG, true);
  const reviewer = await readJson(config.env.DSH_ACCEPTANCE_REVIEW_GATEWAY_CONFIG, true);
  const host = await readJson(config.env.OPENCLAW_CONFIG_PATH, true);
  const runner = await import(pathToFileURL(config.runner).href);
  const native = await import(pathToFileURL(join(config.sourceRoot, "scripts", "lib",
    "gateway-acceptance-adapter.mjs")).href);
  const plans = new Map();
  for (const id of config.caseIds) {
    const original = manifest.cases.find((item) => item.id === id);
    requireValue(original, "budget-case-not-found");
    const plan = allocateCampaignCase(original, scope, config.budget);
    requireValue(config.runnerTimeoutMs > plan.scope.caseBudget.maxDurationMs +
      plan.scope.reviewCaseBudget.maxDurationMs, "budget-runner-timeout-too-small");
    for (const review of [false, true]) {
      const agentId = review ? reviewer.agentId : gateway.agentMap?.[original.agentProfile];
      requireValue(typeof agentId === "string" && agentId.length > 0, "budget-agent-not-configured");
      const allocation = runner.resolveCaseBudgetAllocation(plan.testCase, plan.scope, {
        review, globalCaps: review ? plan.scope.reviewBudgets : plan.limits,
      });
      const effective = native.resolveConfiguredOperationalBudget(host, agentId);
      requireValue(effective, "budget-native-caps-not-configured");
      native.preflightConfiguredOperationalBudget({ hostConfig: host, agentId, ...allocation,
        contextWindow: resolveHostContextWindow(host, agentId), zeroTools: review });
    }
    plans.set(id, plan);
  }
  return plans;
}
