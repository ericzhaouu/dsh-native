import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { posix, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";

export const CONTRACT = "V073-CRON-01/explicit-ownership-v1";
export const HOST_VERSION = "2026.9.2";
const MAX_AGE_MS = 300_000;
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const own = (value, key) => Object.hasOwn(value, key);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const copy = (value) => structuredClone(value);
const controls = [
  "workspace", "cwd", "model", "utilityModel", "models", "modelPolicy", "tools",
  "skills", "sandbox", "subagents", "embeddedAgent", "params", "thinkingDefault",
  "verboseDefault", "toolProgressDetail", "reasoningDefault", "fastModeDefault",
  "contextInjection", "bootstrapMaxChars", "bootstrapTotalMaxChars", "experimental",
  "memory", "humanDelay", "typingMode", "tts", "skillsLimits", "contextLimits",
  "identity", "groupChat",
];
const sourceFields = new Set([...controls, "id", "name", "description", "agentDir", "runtime", "heartbeat"]);
const privateKey = /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|credentials?|auth|authorization|cookie|headers|env)$/i;
const pointer = (text) => String(text).replaceAll("~", "~0").replaceAll("/", "~1");

export class OwnershipError extends Error {
  constructor(code) {
    super(code);
    this.name = "OwnershipError";
    this.code = code;
  }
}

function requireThat(condition, code) {
  if (!condition) throw new OwnershipError(code);
}

function freezeTree(value) {
  if (record(value) || Array.isArray(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  requireThat(value !== undefined && (typeof value !== "number" || Number.isFinite(value)), "NON_JSON_INPUT");
  return JSON.stringify(value);
}

export function digest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function safeTree(value) {
  if (Array.isArray(value)) return value.every(safeTree);
  if (record(value)) return Object.entries(value).every(([key, entry]) =>
    !["__proto__", "prototype", "constructor"].includes(key) && !privateKey.test(key) && safeTree(entry));
  return typeof value !== "string" || !/(?:-----BEGIN .*PRIVATE KEY-----|\bBearer\s+\S+|\bgh[pousr]_[A-Za-z0-9]+)/i.test(value);
}

function pathIdentity(value) {
  requireThat(typeof value === "string" && value.length > 1, "ABSOLUTE_AGENT_PATH_REQUIRED");
  // Do not expand the production host's home using this planner machine's user.
  // Host validation still checks all resolved realpaths, including defaults.
  if (/^~[/\\]/.test(value)) return `host-home:${posix.normalize(value.slice(2).replaceAll("\\", "/"))}`;
  if (win32.isAbsolute(value) && !value.startsWith("/")) return win32.normalize(value).toLowerCase();
  requireThat(posix.isAbsolute(value), "ABSOLUTE_AGENT_PATH_REQUIRED");
  return posix.normalize(value);
}

function fresh(readAtMs, nowMs) {
  requireThat(Number.isSafeInteger(readAtMs) && readAtMs <= nowMs && nowMs - readAtMs <= MAX_AGE_MS,
    "FRESH_HOST_SNAPSHOT_REQUIRED");
}

function snapshotFacts(input, nowMs) {
  const { configSnapshot, jobsSnapshot } = input;
  requireThat(record(configSnapshot) && record(jobsSnapshot), "HOST_SNAPSHOTS_REQUIRED");
  fresh(configSnapshot.readAtMs, nowMs);
  fresh(jobsSnapshot.readAtMs, nowMs);
  requireThat(typeof configSnapshot.hash === "string" && configSnapshot.hash.length >= 16, "HOST_CONFIG_HASH_REQUIRED");
  requireThat(!configSnapshot.redacted && !jobsSnapshot.redacted, "FULL_PRIVATE_SNAPSHOT_REQUIRED");
  const config = configSnapshot.config;
  requireThat(record(config?.agents?.entries) && !own(config.agents, "list"), "EXPLICIT_AGENT_ENTRIES_REQUIRED");
  requireThat(Array.isArray(jobsSnapshot.jobs), "COMPLETE_JOB_SNAPSHOT_REQUIRED");
  requireThat(jobsSnapshot.complete === true, "ALL_CRON_LIST_PAGES_REQUIRED");
  requireThat(jobsSnapshot.authorityComplete === true, "PUBLIC_CRON_VIEW_CANNOT_PROVE_AUTHORITY_ABSENCE");
  requireThat(jobsSnapshot.stateComplete === true, "PRIVATE_SCHEDULER_STATE_REQUIRED");
  const jobs = new Map();
  jobsSnapshot.jobs.forEach((job, index) => {
    requireThat(record(job) && typeof job.id === "string" && !jobs.has(job.id), "UNIQUE_JOB_IDS_REQUIRED");
    jobs.set(job.id, { job, index });
  });
  return { config, jobs };
}

function targetEntry(config, mapping, resolvedAgentPaths = {}) {
  const source = config.agents.entries[mapping.fromAgentId];
  requireThat(record(source), "SOURCE_AGENT_MISSING");
  requireThat(source.runtime?.type === "embedded" && source.runtime.harness === "dsh-native", "SOURCE_DSH_PIN_REQUIRED");
  requireThat(Object.keys(source).every((key) => sourceFields.has(key)), "UNSUPPORTED_AGENT_CONTEXT_FIELD");
  requireThat(!own(config.agents.entries, mapping.toAgentId), "TARGET_AGENT_MUST_BE_NEW");
  const sourceWorkspace = source.workspace ?? resolvedAgentPaths[mapping.fromAgentId]?.workspace;
  requireThat(typeof sourceWorkspace === "string", "HOST_RESOLVED_SOURCE_WORKSPACE_REQUIRED");
  const workspace = pathIdentity(sourceWorkspace);
  const agentDir = pathIdentity(mapping.agentDir);
  requireThat(agentDir !== workspace, "AGENT_DIR_MUST_NOT_BE_WORKSPACE");
  for (const [id, entry] of Object.entries(config.agents.entries)) {
    const existingDir = resolvedAgentPaths[id]?.agentDir ?? entry.agentDir;
    if (typeof existingDir === "string") requireThat(pathIdentity(existingDir) !== agentDir, "DUPLICATE_AGENT_DIR");
  }
  const target = {};
  for (const key of controls) {
    if (!own(source, key)) continue;
    requireThat(safeTree(source[key]), "PRIVATE_AGENT_MATERIAL_REQUIRES_HOST_MANAGED_REFERENCE");
    target[key] = copy(source[key]);
  }
  target.workspace = sourceWorkspace;
  target.agentDir = mapping.agentDir;
  target.runtime = { type: "embedded", harness: "openclaw" };
  // A cron-only identity must not acquire a second, default foreground heartbeat.
  target.heartbeat = { every: "0m" };
  return target;
}

function validateJob(job, mapping) {
  requireThat(job.agentId === mapping.fromAgentId, "JOB_SOURCE_AGENT_MISMATCH");
  requireThat(typeof job.enabled === "boolean" && job.sessionTarget === "isolated" && job.payload?.kind === "agentTurn",
    "ONLY_EXPLICIT_ISOLATED_AGENT_TURNS_SUPPORTED");
  requireThat(typeof job.payload.message === "string" && typeof job.payload.model === "string"
    && job.payload.model.includes("/"), "FULL_JOB_PAYLOAD_AND_EXPLICIT_MODEL_REQUIRED");
  requireThat(Array.isArray(job.payload.toolsAllow) && job.payload.toolsAllow.every((tool) => typeof tool === "string"),
    "EXPLICIT_TOOLS_CAP_REQUIRED");
  requireThat(digest(job.scheduledToolPolicy ?? null) === digest({ version: 1, mode: "trusted" }),
    "TRUSTED_V1_POLICY_REQUIRED_REAUTHORIZE_OTHER_CASES");
  requireThat(job.owner == null, "ACCOUNT_OWNER_MIGRATION_REQUIRES_OWNER_BOUND_REAUTHORIZATION");
  requireThat(job.runtimeAuthority === undefined, "CAPTURED_RUNTIME_AUTHORITY_REQUIRES_REAUTHORIZATION");
  requireThat(!job.runtimeAuthorityRecoveryRequired, "RUNTIME_AUTHORITY_RECOVERY_REQUIRES_REAUTHORIZATION");
  requireThat(typeof job.configRevision === "string" && job.configRevision.length > 0, "HOST_JOB_CONFIG_REVISION_REQUIRED");
  requireThat(record(job.state), "PRIVATE_JOB_STATE_REQUIRED");
  requireThat(job.enabled ? Number.isSafeInteger(job.state.nextRunAtMs) : job.state.nextRunAtMs === undefined,
    job.enabled ? "PRESERVABLE_NEXT_RUN_REQUIRED" : "PAUSED_JOB_MUST_HAVE_NO_NEXT_RUN");
  requireThat(job.state.runningAtMs == null && job.state.queuedAtMs == null, "JOB_ACTIVE");
  requireThat(job.schedule?.kind !== "every" || Number.isSafeInteger(job.schedule.anchorMs), "STABLE_SCHEDULE_ANCHOR_REQUIRED");
  requireThat(job.sessionKey == null || typeof job.sessionKey === "string", "INVALID_SESSION_BINDING");
}

function jobDefinition(job) {
  const { configRevision: _revision, updatedAtMs: _updatedAt, ...definition } = job;
  return definition;
}

function publicBinding(job) {
  return job.sessionKey !== undefined ? { present: true, sha256: digest(job.sessionKey) } : { present: false };
}

function nextJobDefinition(job, patch) {
  const next = copy(jobDefinition(job));
  next.agentId = patch.agentId;
  if (own(patch, "sessionKey")) delete next.sessionKey;
  return next;
}

export function planCronOwnership(input, { nowMs = Date.now() } = {}) {
  const { config, jobs } = snapshotFacts(input, nowMs);
  const { mapping, approval } = input;
  requireThat(Array.isArray(mapping) && mapping.length > 0, "EXPLICIT_MAPPING_REQUIRED");
  requireThat(record(approval) && Object.keys(approval).every((key) => ["mappingSha256", "reference"].includes(key))
    && approval.mappingSha256 === digest(mapping)
    && typeof approval.reference === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(approval.reference),
  "OPERATOR_MAPPING_APPROVAL_REQUIRED");
  const additions = {};
  const selected = new Set();
  const dirs = new Set();
  const jobOperations = [];
  for (const route of mapping) {
    requireThat(record(route) && Object.keys(route).every((key) =>
      ["fromAgentId", "toAgentId", "agentDir", "jobIds", "sessionBinding"].includes(key)), "UNKNOWN_MAPPING_FIELD");
    requireThat(ID.test(route.fromAgentId) && ID.test(route.toAgentId)
      && !["constructor", "prototype", "__proto__"].includes(route.toAgentId), "INVALID_AGENT_ID");
    requireThat(route.fromAgentId !== route.toAgentId && !own(additions, route.toAgentId), "DISTINCT_TARGET_AGENTS_REQUIRED");
    requireThat(route.sessionBinding === "clear-explicit-isolated", "SESSION_BINDING_DECISION_REQUIRED");
    requireThat(Array.isArray(route.jobIds) && route.jobIds.length > 0, "EXPLICIT_JOB_IDS_REQUIRED");
    const target = targetEntry(config, route, input.configSnapshot.resolvedAgentPaths);
    const dir = pathIdentity(target.agentDir);
    requireThat(!dirs.has(dir), "DUPLICATE_AGENT_DIR");
    dirs.add(dir);
    additions[route.toAgentId] = target;
    for (const id of route.jobIds) {
      requireThat(typeof id === "string" && jobs.has(id) && !selected.has(id), "JOB_MISSING_OR_MAPPING_DUPLICATED");
      selected.add(id);
      const { job, index } = jobs.get(id);
      validateJob(job, route);
      const patch = { agentId: route.toAgentId };
      if (job.sessionKey !== undefined) patch.sessionKey = null;
      const path = `/jobs/${index}`;
      jobOperations.push({
        method: "cron.update",
        params: { id, expectedConfigRevision: job.configRevision, patch },
        paths: [
          { path: `${path}/agentId`, before: job.agentId, after: route.toAgentId },
          ...(own(patch, "sessionKey") ? [{ path: `${path}/sessionKey`, before: publicBinding(job), after: { present: false } }] : []),
        ],
        beforeSha256: digest(jobDefinition(job)),
        afterSha256: digest(nextJobDefinition(job, patch)),
        preservedSha256: digest(Object.fromEntries(Object.entries(jobDefinition(job))
          .filter(([key]) => key !== "agentId" && key !== "sessionKey"))),
        newSessionBase: `agent:${route.toAgentId}:cron:${id}`,
      });
    }
  }
  const plan = {
    contract: CONTRACT,
    hostVersion: HOST_VERSION,
    mapping: copy(mapping),
    approval: copy(approval),
    snapshots: {
      configHash: input.configSnapshot.hash,
      configSha256: digest(config),
      jobsSha256: digest(input.jobsSnapshot.jobs),
    },
    configOperation: {
      method: "config.patch",
      baseHash: input.configSnapshot.hash,
      patch: { agents: { entries: additions } },
      paths: Object.entries(additions).flatMap(([id, entry]) => Object.entries(entry).map(([field, value]) => ({
        path: `/agents/entries/${pointer(id)}/${pointer(field)}`,
        before: { present: false },
        after: { present: true, value },
      }))),
    },
    jobOperations,
    validationRequired: [
      "exact-host-and-agent-pin-patch",
      "candidate-config-valid-and-agentDirs-unique-including-realpaths",
      "explicit-builtin-selection-and-foreground-pins-unchanged",
      "same-auth-principal-entitlement-and-owner-context-without-credential-copy",
      "same-effective-permission-and-user-scope-including-deny",
      "same-resolved-delivery-and-source-scope-after-clearing-binding",
      "unused-target-session-namespace-and-no-transcript-copy",
      "fresh-CAS-idle-jobs-and-preserved-enabled-state",
    ],
  };
  return { ...plan, planId: digest(plan) };
}

export function checkCronOwnershipPlan(plan, input, options) {
  const { planId, ...body } = plan;
  requireThat(planId === digest(body), "PLAN_TAMPERED");
  const current = planCronOwnership({ ...input, mapping: plan.mapping, approval: plan.approval }, options);
  requireThat(current.planId === planId, "SNAPSHOT_DRIFT_REPLAN_REQUIRED");
  return current;
}

function configDefinition(config) {
  const result = { ...config };
  if (record(result.meta)) {
    const { lastTouchedAt: _at, lastTouchedVersion: _version, ...meta } = result.meta;
    if (Object.keys(meta).length) result.meta = meta;
    else delete result.meta;
  }
  return result;
}

function validateProof(proof, plan) {
  requireThat(record(proof) && proof.planId === plan.planId && proof.hostVersion === HOST_VERSION
    && proof.agentPinPatchVerified === true && proof.candidateConfigValid === true,
  "HOST_VALIDATION_REQUIRED");
  requireThat(Array.isArray(proof.routes) && proof.routes.length === plan.mapping.length, "ROUTE_VALIDATION_REQUIRED");
  for (const mapping of plan.mapping) {
    const matches = proof.routes.filter((route) => route.fromAgentId === mapping.fromAgentId && route.toAgentId === mapping.toAgentId);
    requireThat(matches.length === 1, "ROUTE_VALIDATION_REQUIRED");
    const route = matches[0];
    requireThat(route.runtime === "openclaw" && route.runtimeSource === "agent" && route.foregroundRuntime === "dsh-native",
      "EXPLICIT_HOST_SELECTION_REQUIRED");
    for (const key of ["uniqueAgentDir", "authContextEquivalent", "modelEntitlementVerified"]) {
      requireThat(route[key] === true, `VALIDATION_REQUIRED_${key}`);
    }
  }
  requireThat(Array.isArray(proof.jobs) && proof.jobs.length === plan.jobOperations.length, "PER_JOB_VALIDATION_REQUIRED");
  for (const operation of plan.jobOperations) {
    const matches = proof.jobs.filter((job) => job.id === operation.params.id);
    requireThat(matches.length === 1 && matches[0].beforeSha256 === operation.beforeSha256
      && matches[0].afterSha256 === operation.afterSha256, "PER_JOB_VALIDATION_REQUIRED");
    for (const key of ["permissionScopeEquivalent", "deliveryScopeEquivalent", "executionUserScopeEquivalent", "freshSessionNamespace"]) {
      requireThat(matches[0][key] === true, `VALIDATION_REQUIRED_${key}`);
    }
  }
}

function idleWindow(jobs, operations, nowMs, deadlineMs) {
  for (const operation of operations) {
    const job = jobs.get(operation.params.id)?.job;
    requireThat(job && job.state.runningAtMs == null && job.state.queuedAtMs == null
      && (job.enabled === false ? job.state.nextRunAtMs === undefined : job.state.nextRunAtMs > deadlineMs)
      && nowMs < deadlineMs, "IDLE_APPLY_WINDOW_REQUIRED");
  }
}

/**
 * The adapter is an authenticated local operator integration, not an agent tool.
 * snapshot() returns fresh private source config/full jobs with RPC CAS tokens;
 * public cron.list alone hides authority/queued state and is NOT sufficient.
 * request() sends stock RPCs; validateCandidate() performs read-only host probes.
 * No transport, credentials, transcript copying or production writes on import.
 */
export async function applyCronOwnershipPlan(plan, {
  adapter, approvedPlanId, now = Date.now, windowMs = 60_000,
} = {}) {
  // Approval covers this private snapshot, never caller mutations across awaits.
  plan = freezeTree(copy(plan));
  requireThat(approvedPlanId === plan?.planId, "EXACT_PLAN_APPROVAL_REQUIRED");
  requireThat(adapter && ["snapshot", "request", "validateCandidate"].every((key) => typeof adapter[key] === "function"),
    "AUTHENTICATED_LOCAL_OPERATOR_ADAPTER_REQUIRED");
  requireThat(Number.isSafeInteger(windowMs) && windowMs > 0 && windowMs <= MAX_AGE_MS, "INVALID_APPLY_WINDOW");
  const receipt = { contract: CONTRACT, planId: plan.planId, status: "not-started", configApplied: false, updatedJobIds: [] };
  try {
    const before = freezeTree(copy(await adapter.snapshot()));
    checkCronOwnershipPlan(plan, before, { nowMs: now() });
    const { config, jobs } = snapshotFacts(before, now());
    const deadline = now() + windowMs;
    idleWindow(jobs, plan.jobOperations, now(), deadline);
    const candidateConfig = {
      ...config,
      agents: { ...config.agents, entries: { ...config.agents.entries, ...plan.configOperation.patch.agents.entries } },
    };
    validateProof(await adapter.validateCandidate({
      plan: copy(plan), before: copy(before), candidateConfig: copy(candidateConfig),
    }), plan);
    const checked = await adapter.snapshot();
    checkCronOwnershipPlan(plan, checked, { nowMs: now() });
    idleWindow(snapshotFacts(checked, now()).jobs, plan.jobOperations, now(), deadline);
    receipt.status = "applying";
    // Mark attempted first: a lost RPC response can mean a committed write.
    receipt.configAttempted = true;
    await adapter.request("config.patch", {
      baseHash: plan.configOperation.baseHash,
      raw: JSON.stringify(plan.configOperation.patch),
    });
    receipt.configApplied = true;
    const expectedJobs = new Map(plan.jobOperations.map(({ params }) => [params.id, copy(jobs.get(params.id).job)]));
    const verifySnapshot = (snapshot) => {
      const facts = snapshotFacts(snapshot, now());
      requireThat(digest(configDefinition(facts.config)) === digest(configDefinition(candidateConfig)), "CONFIG_POSTCONDITION_FAILED");
      for (const [id, expected] of expectedJobs) {
        const actual = facts.jobs.get(id)?.job;
        requireThat(actual && digest(jobDefinition(actual)) === digest(jobDefinition(expected)), "JOB_POSTCONDITION_OR_STATE_DRIFT");
        requireThat(actual.configRevision === expected.configRevision, "JOB_REVISION_DRIFT");
      }
      return facts;
    };
    for (const operation of plan.jobOperations) {
      const snapshot = await adapter.snapshot();
      const facts = verifySnapshot(snapshot);
      idleWindow(facts.jobs, plan.jobOperations, now(), deadline);
      // RPC checks definition CAS under the cron service lock. Scheduler state
      // has no stock CAS; verify it before/after and stop on drift, never replay.
      receipt.attemptedJobId = operation.params.id;
      const updated = await adapter.request("cron.update", copy(operation.params));
      requireThat(record(updated) && updated.id === operation.params.id, "CRON_UPDATE_RESPONSE_REQUIRED");
      requireThat(typeof updated.configRevision === "string" && updated.configRevision.length > 0, "UPDATED_JOB_REVISION_REQUIRED");
      expectedJobs.set(updated.id, {
        ...nextJobDefinition(expectedJobs.get(updated.id), operation.params.patch),
        configRevision: updated.configRevision,
      });
      verifySnapshot(await adapter.snapshot());
      receipt.updatedJobIds.push(updated.id);
      delete receipt.attemptedJobId;
    }
    receipt.status = "verified";
    return receipt;
  } catch (error) {
    receipt.status = receipt.configAttempted ? "partial-or-uncertain-stop-and-reconcile" : "blocked-no-writes";
    // Never persist host error messages: they may contain prompts, tokens or targets.
    receipt.errorCode = error instanceof OwnershipError ? error.code : "HOST_OPERATION_FAILED";
    return receipt;
  }
}

const usage = `Cron ownership planner (offline; CLI NEVER applies):
  node scripts\\cron-ownership.mjs plan <private-input.json> <new-plan.json>
  node scripts\\cron-ownership.mjs check <private-input.json> <plan.json>
Input: configSnapshot:{config,hash,readAtMs},
jobsSnapshot:{jobs,complete:true,authorityComplete:true,stateComplete:true,readAtMs},
mapping:[{fromAgentId,toAgentId,agentDir,jobIds,sessionBinding:"clear-explicit-isolated"}],
approval:{mappingSha256:digest(mapping),reference:"operator-change-reference"}.
Use private source config/full job snapshots plus config.get/cron.list CAS tokens.
Public cron.list hides authority; never infer absence from its projected records.
Keep full input private; plans omit job prompts/delivery and hash old session keys.
Apply only by importing applyCronOwnershipPlan with a reviewed plan ID and an
authenticated local operator adapter. See the private cron-routing proposal for
validation/maintenance steps. Paused jobs stay paused and must have no next run;
enabled jobs must not be due during the apply window. No enabled/schedule edits,
job runs, raw database writes or per-job harness override are performed.`;

async function cli(args) {
  if (args.length === 0 || args[0] === "--help") {
    console.log(usage);
    return;
  }
  requireThat(args.length === 3 && ["plan", "check"].includes(args[0]), "EXPECTED_PLAN_OR_CHECK_ARGUMENTS");
  const [command, inputPath, outputPath] = args;
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  if (command === "plan") {
    const plan = planCronOwnership(input);
    await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ status: "planned-not-applied", planId: plan.planId, jobs: plan.jobOperations.length }));
  } else {
    const plan = JSON.parse(await readFile(outputPath, "utf8"));
    checkCronOwnershipPlan(plan, input);
    console.log(JSON.stringify({ status: "snapshot-matches-not-live-validated", planId: plan.planId }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof OwnershipError ? error.code : "INPUT_OR_OUTPUT_FAILED");
    process.exitCode = 1;
  });
}
