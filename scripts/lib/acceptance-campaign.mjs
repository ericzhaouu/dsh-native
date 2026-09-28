import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  CampaignError, assertRealPath, createJournal, exists, hash, identityValid, immutable,
  inspectProcess, journalWriter, privateDirectory, processIdentity, readBytes, readJournal, readJson,
} from "./acceptance-campaign-state.mjs";
import { HealthWaitExpired, validateHealth, waitForHealth } from "./acceptance-campaign-health.mjs";
import { createAcceptanceExecutor } from "./acceptance-campaign-executor.mjs";
import { createCampaignPolicy, readBudgetAuthorization, validateCampaignBudgetConfig } from "./acceptance-campaign-budget.mjs";
import { planCampaignBudgets } from "./acceptance-campaign-budget-plan.mjs";

export { CampaignError, inspectProcess, processIdentity };

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const epochName = (epoch) => `epoch-${String(epoch).padStart(8, "0")}.json`;
const workerName = (epoch) => `worker-${String(epoch).padStart(8, "0")}.json`;
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const clone = (value) => JSON.parse(JSON.stringify(value));

function requireValue(value, code) { if (!value) throw new CampaignError(code); }
function safeReason(error) { return error instanceof CampaignError ? error.code : "controller-error"; }
const reservationEvent = (event) => event.startsWith("budget.") &&
  /(?:^|-)reserv(?:e|ed|ation)(?:-|$)/.test(event.slice("budget.".length));
function confirmedReservationDenial(admission, events) {
  return object(admission) && admission.admitted === false &&
    admission.reservation === undefined &&
    !events.some((row) => reservationEvent(row.event));
}

export function validateCampaignConfig(input) {
  requireValue(object(input) && input.version === 1, "invalid-campaign-config");
  const config = clone(input);
  for (const key of ["campaignRoot", "sourceRoot", "runner", "node", "adapter", "reviewer",
    "manifest", "oracles", "scope"]) {
    requireValue(typeof config[key] === "string" && isAbsolute(config[key]), `absolute-${key}-required`);
    config[key] = resolve(config[key]);
  }
  requireValue(!inside(config.sourceRoot, config.campaignRoot), "campaign-root-must-be-private-external");
  requireValue(config.runner === join(config.sourceRoot, "scripts", "run-acceptance.mjs"),
    "existing-acceptance-runner-required");
  requireValue(config.adapter !== config.reviewer, "independent-reviewer-required");
  requireValue(Array.isArray(config.caseIds) && config.caseIds.length > 0 &&
    config.caseIds.every((id) => typeof id === "string" && id.length > 0) &&
    new Set(config.caseIds).size === config.caseIds.length, "invalid-case-ids");
  requireValue(typeof config.live === "boolean" && object(config.env) &&
    Object.entries(config.env).every(([key, value]) =>
      key && !/[=\0]/.test(key) && typeof value === "string" && !value.includes("\0")), "explicit-env-required");
  requireValue(!Object.keys(config.env).some((key) =>
    ["NODE_OPTIONS", "NODE_PATH"].includes(key.toUpperCase())), "runtime-injection-forbidden");
  for (const key of ["heartbeatMs", "runnerTimeoutMs"]) {
    requireValue(Number.isSafeInteger(config[key]) && config[key] > 0 && config[key] <= 2147483647,
      `invalid-${key}`);
  }
  config.health = validateHealth(config.health);
  requireValue(object(config.pins) && Object.entries(config.pins).every(([path, sha]) =>
    isAbsolute(path) && digest(sha)), "explicit-pins-required");
  config.pins = Object.fromEntries(Object.entries(config.pins).map(([path, sha]) => [resolve(path), sha]));
  if (config.policyModule !== undefined) {
    requireValue(typeof config.policyModule === "string" && isAbsolute(config.policyModule),
      "absolute-policy-module-required");
    config.policyModule = resolve(config.policyModule);
  }
  if (config.budget !== undefined) {
    config.budget = validateCampaignBudgetConfig(config.budget);
    requireValue(!config.policyModule, "choose-one-budget-policy");
  }
  requireValue(config.artifactRoots === undefined || (Array.isArray(config.artifactRoots) &&
    config.artifactRoots.every((path) => typeof path === "string" && isAbsolute(path))),
  "absolute-artifact-roots-required");
  config.artifactRoots = (config.artifactRoots ?? []).map((path) => resolve(path));
  const required = ["runner", "node", "adapter", "reviewer", "manifest", "oracles", "scope", "policyModule"]
    .filter((key) => config[key]).map((key) => config[key]);
  if (config.budget) {
    for (const name of ["authorization", "baseline"]) {
      const path = resolve(config.budget[`${name}Path`]);
      requireValue(config.pins[path] === config.budget[`${name}Sha256`], "required-budget-pin-missing");
      required.push(path);
    }
    for (const key of ["OPENCLAW_CONFIG_PATH", "DSH_ACCEPTANCE_GATEWAY_CONFIG",
      "DSH_ACCEPTANCE_REVIEW_GATEWAY_CONFIG"]) {
      requireValue(typeof config.env[key] === "string" && isAbsolute(config.env[key]),
        `explicit-${key}-required`);
      required.push(resolve(config.env[key]));
    }
  }
  if (config.live) {
    for (const key of ["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "DSH_ACCEPTANCE_GATEWAY_CONFIG",
      "DSH_ACCEPTANCE_REVIEW_GATEWAY_CONFIG"]) {
      requireValue(typeof config.env[key] === "string" && isAbsolute(config.env[key]), `explicit-${key}-required`);
      if (key !== "OPENCLAW_STATE_DIR") required.push(resolve(config.env[key]));
    }
  }
  for (const path of required) requireValue(digest(config.pins[path]), "required-pin-missing");
  return config;
}

async function collectSources(directory, all = false) {
  await assertRealPath(directory, true);
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    requireValue(!entry.isSymbolicLink(), "source-symlink");
    if (entry.isDirectory()) result.push(...await collectSources(path, all));
    else if (all || entry.name.endsWith(".mjs")) result.push(path);
  }
  return result.sort();
}

async function sourceFiles(config) {
  const files = await collectSources(join(config.sourceRoot, "scripts"));
  const artifacts = new Set(config.artifactRoots);
  const runtime = join(config.sourceRoot, "dist");
  if (config.live || await exists(runtime)) artifacts.add(runtime);
  if (config.live) {
    for (const path of [config.env.DSH_ACCEPTANCE_GATEWAY_CONFIG, config.env.DSH_ACCEPTANCE_REVIEW_GATEWAY_CONFIG]) {
      const host = (await readJson(path, true)).hostRoot;
      artifacts.add(join(host, "dist"));
      files.push(join(host, "package.json"));
    }
  }
  for (const root of artifacts) files.push(...await collectSources(root, true));
  // Pin the actual controller implementation even when orchestrating a different frozen source tree.
  const ownScripts = dirname(dirname(fileURLToPath(import.meta.url)));
  for (const name of ["run-acceptance-campaign.mjs", "lib/acceptance-campaign.mjs",
    "lib/acceptance-campaign-state.mjs", "lib/acceptance-campaign-health.mjs",
    "lib/acceptance-campaign-executor.mjs", "lib/acceptance-campaign-budget.mjs",
    "lib/acceptance-campaign-budget-plan.mjs"]) files.push(join(ownScripts, ...name.split("/")));
  for (const name of ["package.json", "npm-shrinkwrap.json"]) {
    const path = join(config.sourceRoot, name);
    if (await exists(path)) files.push(path);
  }
  const schema = join(config.sourceRoot, "tests", "acceptance", "manifest.schema.json");
  if (await exists(schema)) files.push(schema);
  return [...new Set(files)].sort();
}

function resourceRecords(resources) {
  requireValue(object(resources), "invalid-resource-map");
  return Object.values(resources).flatMap((value) => {
    requireValue(object(value), "invalid-resource-map");
    return typeof value.kind === "string" ? [value] : Object.values(value);
  });
}

async function resourceInputs(config) {
  const scope = await readJson(config.scope, true);
  const files = [];
  let resources = scope.resourceMap;
  if (scope.resourceMapPath !== undefined) {
    requireValue(typeof scope.resourceMapPath === "string" && isAbsolute(scope.resourceMapPath),
      "absolute-resource-map-required");
    files.push(resolve(scope.resourceMapPath));
    const doc = await readJson(scope.resourceMapPath, true);
    requireValue(doc.version === 1 && object(doc.resources), "invalid-resource-map");
    resources = doc.resources;
  }
  if (resources !== undefined) {
    for (const record of resourceRecords(resources)) {
      requireValue(object(record), "invalid-resource-map");
      if (record.path === undefined) continue;
      requireValue(typeof record.path === "string" && isAbsolute(record.path), "absolute-fixture-path-required");
      const bytes = await readBytes(record.path);
      requireValue(record.sha256 === undefined || record.sha256.toLowerCase() === hash(bytes), "fixture-hash-mismatch");
      files.push(resolve(record.path));
    }
  }
  return [...new Set(files)].sort();
}

async function checkPins(pins) {
  for (const [path, sha256] of Object.entries(pins)) {
    try { requireValue(hash(await readBytes(path)) === sha256, "static-drift"); }
    catch (error) {
      if (error instanceof CampaignError && error.code === "static-drift") throw error;
      throw new CampaignError("static-drift");
    }
  }
}

async function loadInputs(config) {
  const manifest = await readJson(config.manifest);
  const oracles = await readJson(config.oracles);
  const scope = await readJson(config.scope, true);
  requireValue(Array.isArray(manifest.cases) && object(oracles.cases) &&
    manifest.suiteId === oracles.suiteId && manifest.corpusOracle?.sha256 === hash(await readBytes(config.oracles)) &&
    manifest.corpusOracle?.caseCount === manifest.cases.length, "manifest-oracle-mismatch");
  const byId = new Map(manifest.cases.map((testCase) => [testCase.id, testCase]));
  requireValue(byId.size === manifest.cases.length && config.caseIds.every((id) => byId.has(id) &&
    Object.hasOwn(oracles.cases, id)), "case-selection-mismatch");
  requireValue(scope.authorization === "private" && typeof scope.readOnly === "boolean", "explicit-private-scope-required");
  if (config.live) {
    const gateway = await readJson(config.env.DSH_ACCEPTANCE_GATEWAY_CONFIG, true);
    const reviewer = await readJson(config.env.DSH_ACCEPTANCE_REVIEW_GATEWAY_CONFIG, true);
    for (const value of [gateway, reviewer]) {
      for (const key of ["hostRoot", "configPath", "stateDir"]) {
        requireValue(typeof value[key] === "string" && isAbsolute(value[key]), "explicit-host-paths-required");
      }
      requireValue(resolve(value.configPath) === resolve(config.env.OPENCLAW_CONFIG_PATH) &&
        resolve(value.stateDir) === resolve(config.env.OPENCLAW_STATE_DIR), "host-config-mismatch");
    }
    requireValue(typeof gateway.nativeStateDir === "string" && isAbsolute(gateway.nativeStateDir) &&
      /^acceptance-[a-z0-9-]+$/.test(gateway.ownedSessionPrefix) &&
      Array.isArray(scope.testNamespaces) && scope.testNamespaces.includes(gateway.ownedSessionPrefix),
    "explicit-session-scope-required");
    let url;
    try { url = new URL(gateway.gatewayUrl); } catch { throw new CampaignError("explicit-gateway-url-required"); }
    requireValue(["ws:", "wss:"].includes(url.protocol) && !url.username && !url.password,
      "explicit-gateway-url-required");
  }
  return { manifest, oracles, scope };
}

/** Creates an exclusive private campaign. No model, health request or policy code executes here. */
export async function prepareCampaign(configPath) {
  requireValue(isAbsolute(configPath), "absolute-config-required");
  const bytes = await readBytes(configPath, true);
  const config = validateCampaignConfig(JSON.parse(bytes));
  await checkPins(config.pins);
  await loadInputs(config);
  if (config.budget) {
    await readBudgetAuthorization(config.budget);
    await planCampaignBudgets(config);
  }
  const sources = await sourceFiles(config);
  const resources = await resourceInputs(config);
  const pins = { ...config.pins, [resolve(configPath)]: hash(bytes) };
  for (const path of [...sources, ...resources]) {
    const sha256 = hash(await readBytes(path));
    if (pins[path] !== undefined) requireValue(pins[path] === sha256, "static-drift");
    pins[path] = sha256;
  }
  await checkPins(pins);
  await assertRealPath(dirname(config.campaignRoot), true);
  await privateDirectory(config.campaignRoot);
  for (const name of ["locks", "cases", "receipts"]) await privateDirectory(join(config.campaignRoot, name));
  const savedPins = await immutable(join(config.campaignRoot, "pins.json"), { pins, sources, resources });
  await immutable(join(config.campaignRoot, "campaign.json"), {
    version: 1, campaignId: randomUUID(), configPath: resolve(configPath), configSha256: hash(bytes),
    pinsSha256: savedPins.sha256, caseIds: config.caseIds,
  });
  await createJournal(config.campaignRoot);
  return config.campaignRoot;
}

async function loadCampaign(root) {
  requireValue(typeof root === "string" && isAbsolute(root), "absolute-campaign-root-required");
  root = resolve(root);
  await assertRealPath(root, true, true);
  const meta = await readJson(join(root, "campaign.json"), true);
  requireValue(meta.version === 1 && typeof meta.campaignId === "string", "campaign-corrupt");
  const configBytes = await readBytes(meta.configPath, true);
  requireValue(hash(configBytes) === meta.configSha256, "static-drift");
  const config = validateCampaignConfig(JSON.parse(configBytes));
  requireValue(config.campaignRoot === root && JSON.stringify(config.caseIds) === JSON.stringify(meta.caseIds),
    "campaign-corrupt");
  const pinBytes = await readBytes(join(root, "pins.json"), true);
  requireValue(hash(pinBytes) === meta.pinsSha256, "campaign-pins-corrupt");
  return { root, meta, config, pinned: JSON.parse(pinBytes) };
}

async function claims(root) {
  const names = (await readdir(join(root, "locks"))).filter((name) => name.startsWith("epoch-")).sort();
  const result = [];
  for (const [index, name] of names.entries()) {
    requireValue(name === epochName(index), "lock-chain-corrupt");
    const claim = await readJson(join(root, "locks", name), true);
    requireValue(claim.epoch === index && typeof claim.controllerId === "string" &&
      identityValid(claim.identity) && ["foreground", "detached"].includes(claim.mode), "lock-chain-corrupt");
    result.push(claim);
  }
  return result;
}

async function assertClaim(root, claim) {
  const latest = (await claims(root)).at(-1);
  requireValue(latest?.controllerId === claim.controllerId && latest.epoch === claim.epoch, "controller-fenced");
}

async function ownerIdentity(root, claim) {
  if (claim.mode === "foreground") return claim.identity;
  const path = join(root, "locks", workerName(claim.epoch));
  if (!await exists(path)) throw new CampaignError("launch-identity-unknown");
  const worker = await readJson(path, true);
  requireValue(worker.controllerId === claim.controllerId && identityValid(worker.identity), "lock-chain-corrupt");
  return worker.identity;
}

async function acquire(campaign, { resume, detached, identify, inspect }) {
  const old = await claims(campaign.root);
  requireValue(resume ? old.length > 0 : old.length === 0, resume ? "resume-requires-claim" : "already-started");
  if (old.length) {
    const identity = await ownerIdentity(campaign.root, old.at(-1));
    const state = await inspect(identity);
    requireValue(state === "gone", state === "alive" ? "controller-alive" : "controller-identity-unknown");
  }
  const identity = await identify(process.pid);
  requireValue(identityValid(identity), "controller-identity-unavailable");
  const claim = { campaignId: campaign.meta.campaignId, controllerId: randomUUID(), epoch: old.length,
    mode: detached ? "detached" : "foreground", identity };
  // Exclusive next-epoch creation is the compare-and-swap. Old locks are never unlinked.
  await immutable(join(campaign.root, "locks", epochName(claim.epoch)), claim);
  await assertClaim(campaign.root, claim);
  return claim;
}

function caseStates(events) {
  const states = new Map();
  for (const row of events) {
    const data = row.data;
    if (!data.caseId) continue;
    const state = states.get(data.caseId) ?? {};
    if (row.event === "prepare-intent") state.preparing = true;
    if (row.event === "case-prepared") {
      requireValue(!state.context, "duplicate-case-preparation");
      state.context = data.context;
      state.preparedReceipt = data.receipt;
    }
    if (row.event === "reservation-intent") {
      requireValue(!state.reservationIntent && !state.reservation && !state.intent &&
        state.context?.dispatchId === data.dispatchId, "duplicate-reservation");
      state.reservationIntent = data.dispatchId;
    }
    if (row.event === "reservation-rejected") {
      requireValue(state.reservationIntent === data.dispatchId && state.context?.dispatchId === data.dispatchId &&
        !state.reservation && !state.intent, "reservation-rejection-corrupt");
      state.reservationIntent = null;
    }
    if (row.event === "reserved") {
      requireValue(state.reservationIntent === data.dispatchId && state.context?.dispatchId === data.dispatchId &&
        !state.reservation && !state.intent, "reservation-corrupt");
      state.reservation = data.reservation;
    }
    if (row.event === "dispatch-intent") {
      requireValue(!state.intent && state.reservation && state.context?.dispatchId === data.dispatchId,
        "duplicate-dispatch");
      state.intent = true;
    }
    if (row.event === "child-started") {
      requireValue(state.intent && !state.child && identityValid(data.identity), "child-identity-corrupt");
      state.child = data.identity;
    }
    if (row.event === "case-settled") {
      requireValue(state.intent && !state.settlement, "duplicate-settlement");
      state.settlement = data;
    }
    if (row.event === "case-unknown") state.unknown = true;
    states.set(data.caseId, state);
  }
  return states;
}

async function verifyReceipt(receipt) {
  requireValue(object(receipt) && isAbsolute(receipt.path) && digest(receipt.sha256), "receipt-corrupt");
  const bytes = await readBytes(receipt.path, true);
  requireValue(hash(bytes) === receipt.sha256, "receipt-changed");
  return JSON.parse(bytes);
}

async function verifyContext(context) {
  for (const [path, sha] of Object.entries(context.hashes)) {
    requireValue(hash(await readBytes(path, true)) === sha, "case-input-drift");
  }
}

async function prepareCase(campaign, caseId, journal, policy) {
  const { config, meta, root } = campaign;
  const index = config.caseIds.indexOf(caseId);
  const directory = join(root, "cases", String(index).padStart(6, "0"));
  const dispatchId = randomUUID();
  const suiteId = `campaign-${meta.campaignId}-${index}`;
  await journal.append("prepare-intent", { caseId, dispatchId });
  await privateDirectory(directory);
  const { manifest, oracles, scope } = await loadInputs(config);
  const budgetPlan = await policy?.planCase?.({ caseId });
  const selected = budgetPlan?.testCase ?? manifest.cases.find((testCase) => testCase.id === caseId);
  const isolatedOracle = { ...oracles, suiteId, cases: { [caseId]: oracles.cases[caseId] } };
  const oracle = await immutable(join(directory, "oracles.json"), isolatedOracle);
  const isolatedManifest = { ...manifest, suiteId, cases: [selected],
    corpusOracle: { ...manifest.corpusOracle, caseCount: 1, sha256: oracle.sha256 },
    limits: { ...(budgetPlan?.limits ?? manifest.limits), concurrency: 1, perAgentConcurrency: 1 } };
  const isolatedScope = clone(budgetPlan?.scope ?? scope);
  const environmentFiles = {};
  const hashes = { [oracle.path]: oracle.sha256 };
  const pinResources = (resources) => {
    for (const record of resourceRecords(resources)) {
      if (record.path !== undefined) record.sha256 = campaign.pinned.pins[resolve(record.path)];
    }
    return resources;
  };
  if (isolatedScope.resourceMapPath !== undefined) {
    const map = await readJson(isolatedScope.resourceMapPath, true);
    map.resources = pinResources(map.resources);
    const receipt = await immutable(join(directory, "resources.json"), map);
    isolatedScope.resourceMapPath = receipt.path;
    hashes[receipt.path] = receipt.sha256;
  } else if (isolatedScope.resourceMap !== undefined) {
    isolatedScope.resourceMap = pinResources(isolatedScope.resourceMap);
  }
  if (config.live) {
    const gateway = await readJson(config.env.DSH_ACCEPTANCE_GATEWAY_CONFIG, true);
    const reviewer = await readJson(config.env.DSH_ACCEPTANCE_REVIEW_GATEWAY_CONFIG, true);
    gateway.ownedSessionPrefix = `${gateway.ownedSessionPrefix}-${meta.campaignId}-${index}`;
    isolatedScope.testNamespaces = [gateway.ownedSessionPrefix];
    for (const [key, name, value] of [
      ["DSH_ACCEPTANCE_GATEWAY_CONFIG", "gateway.json", gateway],
      ["DSH_ACCEPTANCE_REVIEW_GATEWAY_CONFIG", "reviewer.json", reviewer],
    ]) {
      const receipt = await immutable(join(directory, name), value);
      environmentFiles[key] = receipt.path;
      hashes[receipt.path] = receipt.sha256;
    }
  }
  const manifestReceipt = await immutable(join(directory, "manifest.json"), isolatedManifest);
  const scopeReceipt = await immutable(join(directory, "scope.json"), isolatedScope);
  hashes[manifestReceipt.path] = manifestReceipt.sha256;
  hashes[scopeReceipt.path] = scopeReceipt.sha256;
  const context = { campaignId: meta.campaignId, caseId, dispatchId, directory,
    manifestPath: manifestReceipt.path, oraclePath: oracle.path, scopePath: scopeReceipt.path,
    manifestSha256: manifestReceipt.sha256, oracleSha256: oracle.sha256,
    runRoot: join(directory, "runs"), hashes, environmentFiles };
  const receipt = await immutable(join(directory, "prepared.json"), context);
  await journal.append("case-prepared", { caseId, context, receipt });
  return context;
}

async function policyFor(campaign, injected) {
  let policy = injected;
  if (!policy && campaign.config.policyModule) {
    const module = await import(pathToFileURL(campaign.config.policyModule).href);
    requireValue(typeof module.createCampaignPolicy === "function", "invalid-policy-module");
    policy = await module.createCampaignPolicy({
      campaignId: campaign.meta.campaignId, campaignRoot: campaign.root,
      config: clone(campaign.config),
    });
  }
  if (!policy && campaign.config.budget) policy = await createCampaignPolicy({
    campaignId: campaign.meta.campaignId, campaignRoot: campaign.root, config: clone(campaign.config),
  });
  for (const method of ["audit", "reserve", "settle"]) {
    requireValue(typeof policy?.[method] === "function", "campaign-policy-required");
  }
  return policy;
}

/** Claims before a detached spawn; an unproven launch is deliberately not automatically reclaimable. */
export async function claimCampaign(root, { resume = false, detached = false,
  identify = processIdentity, inspect = inspectProcess } = {}) {
  const campaign = await loadCampaign(root);
  const claim = await acquire(campaign, { resume, detached, identify, inspect });
  const journal = await journalWriter(root, claim.controllerId, () => assertClaim(root, claim));
  await journal.append(detached ? "launch-intent" : "controller-acquired", { claim, resume });
  await journal.status({ campaignId: campaign.meta.campaignId, controllerId: claim.controllerId,
    status: "running", phase: detached ? "launch-pending" : "starting", heartbeat: new Date().toISOString(),
    currentCase: null, nextCase: campaign.config.caseIds[0], remainingCaseIds: campaign.config.caseIds });
  return claim;
}

/**
 * Policy hooks receive a stable dispatchId and {events, append}; append writes budget.* into the
 * same fsynced journal. Hooks must be offline/idempotent; reserve cannot dispatch.
 * The built-in policy aggregates those journals through one private authorization account.
 */
export async function runCampaign(root, options = {}) {
  const identify = options.identify ?? processIdentity;
  const inspect = options.inspect ?? inspectProcess;
  const campaign = await loadCampaign(root);
  const claim = options.claim ?? await claimCampaign(root, {
    resume: options.resume === true, identify, inspect,
  });
  await assertClaim(root, claim);
  requireValue(claim.campaignId === campaign.meta.campaignId, "wrong-campaign-claim");
  if (claim.mode === "detached") {
    const identity = await identify(process.pid);
    requireValue(identityValid(identity), "controller-identity-unavailable");
    await immutable(join(root, "locks", workerName(claim.epoch)), { controllerId: claim.controllerId, identity });
  } else {
    const identity = await identify(process.pid);
    requireValue(identityValid(identity) && identity.pid === claim.identity.pid &&
      identity.startId === claim.identity.startId, "wrong-controller-process");
  }
  const journal = await journalWriter(root, claim.controllerId, () => assertClaim(root, claim));
  const status = { campaignId: campaign.meta.campaignId, controllerId: claim.controllerId,
    status: "running", currentCase: null, nextCase: null, remainingCaseIds: [], completed: [], reason: null };
  let heartbeat;
  let heartbeatError;
  let writingHeartbeat = false;
  let policy;
  const refresh = async () => {
    const states = caseStates(journal.rows());
    status.remainingCaseIds = campaign.config.caseIds.filter((id) => !states.get(id)?.intent);
    status.nextCase = status.remainingCaseIds.find((id) => id !== status.currentCase) ?? null;
    status.completed = [...states].filter(([, state]) => state.settlement)
      .map(([caseId, state]) => ({ caseId, outcome: state.settlement.outcome }));
    status.heartbeat = new Date().toISOString();
    await journal.status(status);
  };
  const checkpoint = async (name, data) => {
    if (heartbeatError) throw heartbeatError;
    await options.checkpoint?.(name, data);
    await assertClaim(root, claim);
  };
  const hookContext = () => ({
    campaignId: campaign.meta.campaignId, events: journal.rows(),
    append: async (event, data) => {
      requireValue(typeof event === "string" && /^[a-z][a-z0-9-]*$/.test(event) && object(data),
        "invalid-policy-event");
      return journal.append(`budget.${event}`, clone(data));
    },
  });
  const staticCheck = async () => {
    if (heartbeatError) throw heartbeatError;
    await assertClaim(root, claim);
    await checkPins(campaign.pinned.pins);
    requireValue(JSON.stringify(await sourceFiles(campaign.config)) === JSON.stringify(campaign.pinned.sources),
      "static-drift");
    await policy?.preflight?.(hookContext());
  };
  const executorFor = (context) => options.executor ?? createAcceptanceExecutor({
    ...campaign.config, env: { ...campaign.config.env, ...context.environmentFiles },
  }, { processIdentity: identify, inspectProcess: inspect });
  const accountingAudit = async (admission = true) => {
    const result = await policy.audit(hookContext());
    requireValue(object(result) && typeof result.safeToContinue === "boolean", "accounting-unresolved");
    await journal.append("accounting-audited", { proof: clone(result) });
    if (admission) requireValue(result.safeToContinue === true, "accounting-unresolved");
  };
  const settle = async (context, result, recovered = false) => {
    requireValue(result?.status === "settled" && result.accountingComplete === true &&
      result.quiescent === true && ["passed", "failed", "blocked"].includes(result.outcome),
    "execution-unresolved");
    const settlement = await policy.settle({ ...hookContext(), context: clone(context), result: clone(result) });
    requireValue(settlement?.settled === true && settlement.accountingComplete === true &&
      settlement.quiescent === true, "accounting-unresolved");
    const receipt = await immutable(join(root, "receipts", `${context.dispatchId}-${claim.epoch}.json`), {
      caseId: context.caseId, dispatchId: context.dispatchId, result, settlement, recovered,
    });
    await journal.append("case-settled", { caseId: context.caseId, dispatchId: context.dispatchId,
      outcome: result.outcome, receipt });
  };
  try {
    await journal.append("controller-running", { epoch: claim.epoch });
    await refresh();
    heartbeat = setInterval(() => {
      if (writingHeartbeat || heartbeatError) return;
      writingHeartbeat = true;
      refresh().catch((error) => { heartbeatError = error; }).finally(() => { writingHeartbeat = false; });
    }, campaign.config.heartbeatMs);
    await staticCheck();
    policy = await policyFor(campaign, options.policy);
    await staticCheck();
    // Inspect historical budget exposure even when a later dispatch audit must keep the case fenced.
    await accountingAudit(false);
    const states = caseStates(journal.rows());
    for (const [caseId, state] of states) {
      requireValue(campaign.config.caseIds.includes(caseId), "unknown-case-in-journal");
      if (state.preparing && !state.context) throw new CampaignError("preparation-unresolved");
      if (!state.context) continue;
      requireValue(isDeepStrictEqual(await verifyReceipt(state.preparedReceipt), state.context),
        "prepared-context-mismatch");
      await verifyContext(state.context);
      const saved = state.settlement ? await verifyReceipt(state.settlement.receipt) : null;
      if (state.intent) {
        // Audit even completed cases on resume: changed evidence and PID reuse cannot authorize replay.
        const identityState = state.child ? await inspect(state.child) : "unknown";
        const result = await executorFor(state.context).audit(state.context);
        await journal.append("dispatch-audited", { caseId, dispatchId: state.context.dispatchId,
          identityState, result: clone(result) });
        if (result?.status !== "settled" || result.accountingComplete !== true || result.quiescent !== true) {
          await policy.retain?.({ ...hookContext(), context: clone(state.context), result: clone(result) });
        }
        requireValue(identityState !== "alive" && identityState !== "unknown" &&
          result?.status === "settled" && result.accountingComplete === true && result.quiescent === true,
        "execution-unresolved");
        if (saved) {
          for (const key of ["reportPath", "reportSha256", "ledgerSha256", "outcome", "accounting"]) {
            requireValue(isDeepStrictEqual(saved.result[key], result[key]), "settled-evidence-changed");
          }
        }
        if (!state.settlement) await settle(state.context, result, true);
      } else if (state.reservationIntent) throw new CampaignError("reservation-unresolved");
    }
    await accountingAudit();
    for (const caseId of campaign.config.caseIds) {
      let state = caseStates(journal.rows()).get(caseId);
      if (state?.intent) continue;
      // Isolate and validate allocations before any health request, not after it.
      const context = state?.context ?? await prepareCase(campaign, caseId, journal, policy);
      await verifyContext(context);
      status.currentCase = caseId;
      status.status = "waiting-health";
      await refresh();
      await journal.append("health-wait-started", { caseId });
      await waitForHealth(campaign.config.health, {
        ...options.health,
        preflight: staticCheck,
        onSample: async (sample) => { await journal.append("health-sample", { caseId, ...sample }); await refresh(); },
      });
      await staticCheck();
      await accountingAudit();
      status.status = "running";
      await refresh();
      await verifyContext(context);
      await journal.append("reservation-intent", { caseId, dispatchId: context.dispatchId });
      await checkpoint("before-reserve", context);
      const reserveStart = journal.rows().length;
      const admission = await policy.reserve({ ...hookContext(), context: clone(context),
        testCase: (await readJson(context.manifestPath)).cases[0], scope: await readJson(context.scopePath, true) });
      if (confirmedReservationDenial(admission, journal.rows().slice(reserveStart))) {
        await journal.append("reservation-rejected", { caseId, dispatchId: context.dispatchId });
        throw new CampaignError("budget-admission-denied");
      }
      requireValue(admission?.admitted === true && object(admission.reservation), "budget-admission-denied");
      await journal.append("reserved", { caseId, dispatchId: context.dispatchId, reservation: clone(admission.reservation) });
      await checkpoint("after-reserve", context);
      await staticCheck();
      await verifyContext(context);
      await journal.append("dispatch-intent", { caseId, dispatchId: context.dispatchId,
        manifestSha256: context.manifestSha256, oracleSha256: context.oracleSha256 });
      await checkpoint("before-spawn", context);
      const result = await executorFor(context).execute(context, {
        onStarted: async (identity) => {
          requireValue(identityValid(identity), "child-identity-unavailable");
          await journal.append("child-started", { caseId, dispatchId: context.dispatchId, identity });
          await checkpoint("after-start", context);
        },
      });
      await checkpoint("after-execute", context);
      await verifyContext(context);
      if (result?.status !== "settled" || result.accountingComplete !== true || result.quiescent !== true) {
        await policy.retain?.({ ...hookContext(), context: clone(context), result: clone(result) });
        await journal.append("case-unknown", { caseId, dispatchId: context.dispatchId,
          reason: typeof result?.reason === "string" ? result.reason : "execution-unresolved" });
        throw new CampaignError("execution-unresolved");
      }
      await settle(context, result);
      await staticCheck();
      await refresh();
    }
    status.status = "completed";
    status.currentCase = null;
    status.reason = null;
  } catch (error) {
    status.reason = safeReason(error);
    status.status = error instanceof HealthWaitExpired ||
      ["execution-unresolved", "accounting-unresolved", "preparation-unresolved", "reservation-unresolved",
        "budget-admission-denied"].includes(status.reason) ? "paused" : "failed";
  } finally {
    clearInterval(heartbeat);
    await journal.flush();
  }
  await refresh();
  const receipt = await immutable(join(root, "receipts", `controller-${claim.controllerId}.json`), {
    ...status, terminalAt: new Date().toISOString(),
  });
  await journal.append("controller-terminal", { status: status.status, reason: status.reason, receipt });
  await refresh();
  return { ...status, receipt };
}

/** Read-only status: never interprets a stale heartbeat as permission to restart. */
export async function campaignStatus(root, { inspect = inspectProcess } = {}) {
  const campaign = await loadCampaign(root);
  const events = await readJournal(root);
  const latest = (await claims(root)).at(-1);
  let ownerState = "not-started";
  if (latest) {
    try { ownerState = await inspect(await ownerIdentity(root, latest)); }
    catch { ownerState = "unknown"; }
  }
  const states = caseStates(events);
  const terminal = events.filter((row) => row.event === "controller-terminal" &&
    row.owner === latest?.controllerId).at(-1);
  const saved = await exists(join(root, "status.json")) ? await readJson(join(root, "status.json"), true) : {};
  return { ...saved, campaignId: campaign.meta.campaignId, controllerId: latest?.controllerId ?? null,
    status: terminal?.data.status ?? (ownerState === "alive" ? saved.status ?? "running" :
      latest ? "paused" : "prepared"),
    reason: terminal?.data.reason ?? (latest && ownerState !== "alive" ? "explicit-resume-audit-required" : null),
    ownerState, journalSequence: events.length - 1,
    remainingCaseIds: campaign.config.caseIds.filter((id) => !states.get(id)?.intent),
    fencedCaseIds: [...states].filter(([, state]) => state.reservationIntent && !state.settlement).map(([id]) => id),
  };
}
