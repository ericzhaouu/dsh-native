import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { normalizeBaseUrl, parseOperationalBudget, resolveOperationalBudget } from "./config.js";
import { COPILOT_ENDPOINTS, copilotHeaders } from "./copilot-policy.js";
import { createBridgePatch } from "./bridge/profile.js";
import { BudgetLedger, budgetError } from "./bridge/budget-ledger.js";
import {
  BRIDGE_VERSION, DSH_VERSION, isRecord,
  type BridgeCompactResult, type BridgeContextUsage, type BridgeEvent, type BridgeResult, type BridgeToolCall, type BridgeUsage,
  type OperationalBudget,
} from "./protocol.js";
import { asError, JsonRpcPeer } from "./rpc.js";
import { createDurableOwnership, writeDurableJson, type DurableOwnership } from "./durable-state.js";
import type { DshAttempt, DshCompactAttempt, DshConfig, DshRuntime } from "./runtime-types.js";
import {
  PREPARATION_TOOL_NAME, parsePreparationPolicy, parsePreparationRequest,
  parsePreparationResolution, parsePreparationState, resolvePreparationDecision,
  type PreparationPolicy, type PreparationRequest, type PreparationResolution, type PreparationState,
} from "./preparation.js";

interface SessionPreparation {
  version: 1;
  policyFingerprint: string;
  state: PreparationState;
}

interface SessionState {
  version: number;
  dshVersion: string;
  sessionId: string;
  workspaceDir: string;
  status: "running" | "ready" | "blocked";
  lastRunId: string;
  consumedRunIds: string[];
  compactRunIds?: string[];
  pendingCompact?: { runId: string };
  modelRoute?: string;
  budgetFailure?: "DSH_BUDGET_EXCEEDED" | "DSH_BUDGET_UNCERTAIN";
  taskPreparation?: SessionPreparation;
}

class ChildTerminationError extends Error {}

function code(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

type ChildLifecycleStage = "spawn" | "handshake" | "run" | "shutdown";
type ChildStreamName = "process" | "stdin" | "stdout" | "stderr";

function childLifecycleError(stage: ChildLifecycleStage, stream: ChildStreamName, error: unknown, pid?: number): Error {
  const parts = [`DSH child ${stream} failed during ${stage}`];
  if (pid !== undefined) parts.push(`pid=${pid}`);
  const errorCode = code(error);
  if (errorCode) parts.push(`code=${errorCode}`);
  return new Error(parts.join(" "), { cause: error });
}

function redactDiagnostic(value: string, apiKey: string): string {
  return value.replaceAll(apiKey, "[redacted]");
}

async function loadState(path: string): Promise<SessionState | undefined> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error: unknown) { if (code(error) === "ENOENT") return undefined; throw error; }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error: unknown) {
    throw new Error("Invalid DSH session state JSON; use /new to start a new OpenClaw session.", { cause: error });
  }
  if (!isRecord(value) || value.version !== BRIDGE_VERSION || value.dshVersion !== DSH_VERSION ||
      typeof value.sessionId !== "string" || typeof value.workspaceDir !== "string" ||
      !Array.isArray(value.consumedRunIds) || value.consumedRunIds.some((id) => typeof id !== "string") ||
      value.compactRunIds !== undefined && (!Array.isArray(value.compactRunIds) ||
        value.compactRunIds.some((id) => typeof id !== "string")) ||
      value.pendingCompact !== undefined && (!isRecord(value.pendingCompact) ||
        Object.keys(value.pendingCompact).some((key) => key !== "runId") ||
        typeof value.pendingCompact.runId !== "string" || !value.pendingCompact.runId) ||
      value.modelRoute !== undefined && (typeof value.modelRoute !== "string" || !/^[a-f0-9]{64}$/.test(value.modelRoute)) ||
      value.budgetFailure !== undefined && !["DSH_BUDGET_EXCEEDED", "DSH_BUDGET_UNCERTAIN"].includes(String(value.budgetFailure)) ||
      typeof value.lastRunId !== "string" || !["ready", "running", "blocked"].includes(String(value.status))) {
    throw new Error("Invalid or incompatible DSH session state; start a new OpenClaw session.");
  }
  let taskPreparation: SessionPreparation | undefined;
  if (Object.hasOwn(value, "taskPreparation")) {
    const preparation = value.taskPreparation;
    if (!isRecord(preparation) || preparation.version !== 1 ||
        Object.keys(preparation).some((key) => !["version", "policyFingerprint", "state"].includes(key)) ||
        typeof preparation.policyFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(preparation.policyFingerprint)) {
      throw new Error("Invalid DSH preparation binding; use /new to start a new OpenClaw session.");
    }
    let parsed: PreparationState;
    try { parsed = parsePreparationState(preparation.state); }
    catch (error: unknown) {
      throw new Error("Invalid DSH preparation state; use /new to start a new OpenClaw session.", { cause: error });
    }
    if (parsed.sourceRunId !== value.lastRunId || parsed.revision !== value.consumedRunIds.length ||
        parsed.clarificationTurns > parsed.revision ||
        value.consumedRunIds.at(-1) !== value.lastRunId ||
        new Set(value.consumedRunIds).size !== value.consumedRunIds.length) {
      throw new Error("Inconsistent DSH preparation revision or source binding; use /new to start a new OpenClaw session.");
    }
    taskPreparation = { version: 1, policyFingerprint: preparation.policyFingerprint, state: parsed };
  }
  return {
    version: value.version, dshVersion: value.dshVersion, sessionId: value.sessionId,
    workspaceDir: value.workspaceDir, lastRunId: value.lastRunId,
    consumedRunIds: value.consumedRunIds,
    ...(value.compactRunIds ? { compactRunIds: value.compactRunIds } : {}),
    ...(value.pendingCompact ? { pendingCompact: { runId: String(value.pendingCompact.runId) } } : {}),
    modelRoute: value.modelRoute,
    ...(value.budgetFailure ? { budgetFailure: value.budgetFailure as SessionState["budgetFailure"] } : {}),
    status: value.status === "ready" ? "ready" : value.status === "running" ? "running" : "blocked",
    ...(taskPreparation ? { taskPreparation } : {}),
  };
}

function policyFingerprint(policy: PreparationPolicy): string {
  return createHash("sha256").update(JSON.stringify({
    version: policy.version,
    executionTools: [...policy.executionTools].sort(),
    skillAllowlist: [...policy.skillAllowlist].sort(),
    maxClarificationTurns: policy.maxClarificationTurns,
    maxToolCalls: policy.maxToolCalls,
  })).digest("hex");
}

async function saveState(path: string, state: SessionState): Promise<void> {
  await writeDurableJson(path, state);
}

async function finishOwnership(lock: DurableOwnership, release: boolean, apiKey: string,
  ledger?: BudgetLedger, shutdownTimeoutMs = 1000, onUncertain?: () => Promise<void>): Promise<void> {
  let failure: unknown;
  try { if (release) await lock.release(); }
  catch (error) { failure = error; }
  try { await lock.handle.close(); }
  catch (error) { failure ??= error; }
  if (failure) {
    if (ledger) {
      try {
        await timeout(Promise.allSettled([ledger.fence(), onUncertain?.()]),
          shutdownTimeoutMs, "Budget fence persistence is unconfirmed.");
      }
      catch { /* Retain the authoritative uncertainty code. */ }
    }
    throw Object.assign(new Error(
      `DSH ownership cleanup is unconfirmed; inspect its lock. ${asError(failure).message.replaceAll(apiKey, "[redacted]")}`),
    { code: ledger ? "DSH_BUDGET_UNCERTAIN" : "DSH_TERMINATION_UNCONFIRMED" });
  }
}

function childEnvironment(home: string, apiKey: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "PATH", "Path",
    "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"), DSH_HOME: home,
    OPENCLAW_DSH_MODEL_KEY: apiKey, DO_NOT_TRACK: "1", NO_COLOR: "1",
    DSH_TELEMETRY: "0",
  };
}

function usage(value: unknown): BridgeUsage {
  if (!isRecord(value)) throw new Error("Missing DSH usage.");
  const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
  for (const key of fields) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0) {
      throw new Error(`Invalid DSH usage field: ${key}`);
    }
  }
  return {
    input: Number(value.input), output: Number(value.output),
    cacheRead: Number(value.cacheRead), cacheWrite: Number(value.cacheWrite),
  };
}

function contextUsage(value: unknown): BridgeContextUsage {
  if (!isRecord(value)) throw new Error("Invalid DSH context usage.");
  if (value.state === "unavailable") return { state: "unavailable" };
  if (value.state !== "available" ||
      typeof value.promptTokens !== "number" || !Number.isSafeInteger(value.promptTokens) || value.promptTokens < 0 ||
      typeof value.totalTokens !== "number" || !Number.isSafeInteger(value.totalTokens) || value.totalTokens < value.promptTokens) {
    throw new Error("Invalid DSH context usage.");
  }
  return { state: "available", promptTokens: value.promptTokens, totalTokens: value.totalTokens };
}

function parseResult(value: unknown, sessionId: string): BridgeResult {
  if (!isRecord(value) || typeof value.text !== "string" || value.sessionId !== sessionId ||
      typeof value.toolCalls !== "number" || !Number.isSafeInteger(value.toolCalls) || value.toolCalls < 0 ||
      (value.reasoning !== undefined && typeof value.reasoning !== "string")) {
    throw new Error("Malformed DSH run result.");
  }
  const stopReason = value.stopReason;
  if (stopReason !== "stop" && stopReason !== "length" && stopReason !== "aborted") {
    throw new Error("Unknown DSH completion outcome.");
  }
  return {
    text: value.text, reasoning: value.reasoning, sessionId, stopReason,
    usage: usage(value.usage), toolCalls: value.toolCalls,
    ...(Object.hasOwn(value, "summaryUsage") ? { summaryUsage: usage(value.summaryUsage) } : {}),
    ...(Object.hasOwn(value, "contextUsage") ? { contextUsage: contextUsage(value.contextUsage) } : {}),
    ...(Object.hasOwn(value, "lastCallUsage") ? { lastCallUsage: usage(value.lastCallUsage) } : {}),
    ...(Object.hasOwn(value, "preparation") ? { preparation: parsePreparationResolution(value.preparation) } : {}),
  };
}

function parseCompactResult(value: unknown, sessionId: string): BridgeCompactResult {
  if (!isRecord(value) || typeof value.compacted !== "boolean" || value.sessionId !== sessionId) {
    throw new Error("Malformed DSH compaction result.");
  }
  for (const key of ["tokensBefore", "tokensAfter"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || value[key] < 0)) {
      throw new Error(`Invalid DSH compaction field: ${key}`);
    }
  }
  if (value.summary !== undefined && typeof value.summary !== "string") throw new Error("Invalid DSH compaction summary.");
  if (value.summaryUsage !== undefined) usage(value.summaryUsage);
  if (value.details !== undefined && !isRecord(value.details)) throw new Error("Invalid DSH compaction details.");
  return {
    compacted: value.compacted,
    sessionId,
    ...(value.summary === undefined ? {} : { summary: value.summary }),
    ...(value.tokensBefore === undefined ? {} : { tokensBefore: Number(value.tokensBefore) }),
    ...(value.tokensAfter === undefined ? {} : { tokensAfter: Number(value.tokensAfter) }),
    ...(value.summaryUsage === undefined ? {} : { summaryUsage: usage(value.summaryUsage) }),
    ...(value.details === undefined ? {} : { details: JSON.parse(JSON.stringify(value.details)) }),
  };
}

function parseEvent(value: unknown): BridgeEvent {
  if (!isRecord(value)) throw new Error("Invalid DSH event.");
  switch (value.type) {
    case "ready":
      if (value.version !== BRIDGE_VERSION || value.dshVersion !== DSH_VERSION) {
        throw new Error("Incompatible DSH native bridge version.");
      }
      return { type: "ready", version: value.version, dshVersion: value.dshVersion };
    case "text":
    case "reasoning":
      if (typeof value.text !== "string") throw new Error("Invalid DSH text event.");
      return { type: value.type, text: value.text };
    case "usage": return { type: "usage", usage: usage(value.usage) };
    case "status":
      if (typeof value.status !== "string") throw new Error("Invalid DSH status event.");
      return { type: "status", status: value.status };
    case "tool-cancel":
      if (typeof value.callId !== "string") throw new Error("Invalid DSH tool cancellation.");
      return { type: "tool-cancel", callId: value.callId };
    default: throw new Error("Unknown DSH event type.");
  }
}

function timeout<T>(promise: Promise<T>, ms: number, message: string | (() => string)): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(typeof message === "function" ? message() : message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

interface AttemptBudget {
  cap: OperationalBudget;
  admittedAt: number;
}

function snapshotAttempt<T extends DshAttempt | DshCompactAttempt>(config: DshConfig, input: T): {
  input: T; budget?: AttemptBudget;
} {
  const snapshot = { ...input };
  if (!Number.isSafeInteger(snapshot.contextWindow) || snapshot.contextWindow <= 0 ||
      snapshot.maxTokens !== undefined && (!Number.isSafeInteger(snapshot.maxTokens) || snapshot.maxTokens <= 0)) {
    throw new Error("DSH contextWindow and maxTokens must be positive safe integers.");
  }
  if (snapshot.agentId !== undefined && (typeof snapshot.agentId !== "string" || !snapshot.agentId.trim())) {
    throw new Error("Invalid DSH agent identity.");
  }
  const resolved = resolveOperationalBudget(config, snapshot.agentId ?? "host", snapshot.operationalBudget);
  if (resolved === undefined) return { input: snapshot };
  const cap = structuredClone(parseOperationalBudget(resolved));
  snapshot.operationalBudget = cap;
  snapshot.maxTokens = Math.min(snapshot.maxTokens ?? snapshot.contextWindow, snapshot.contextWindow, cap.maxOutputTokens);
  if (snapshot.contextWindow > cap.maxInputTokens) {
    throw budgetError("DSH_BUDGET_EXCEEDED", "Input budget cannot reserve a full contextWindow.");
  }
  return { input: snapshot, budget: { cap, admittedAt: Date.now() } };
}

function budgetTimer(budget: AttemptBudget | undefined, controller: AbortController): () => void {
  let timer: NodeJS.Timeout | undefined;
  const tick = () => {
    const remaining = budget!.cap.maxDurationMs - (Date.now() - budget!.admittedAt);
    if (remaining <= 0) controller.abort(budgetError("DSH_BUDGET_EXCEEDED", "Operational duration budget exhausted."));
    else timer = setTimeout(tick, Math.min(remaining, 2_147_483_647));
  };
  if (budget) tick();
  return () => clearTimeout(timer);
}

function ledgerFor(directory: string, input: DshAttempt | DshCompactAttempt, budget: AttemptBudget,
  purpose: "main" | "compaction"): BudgetLedger {
  return new BudgetLedger(directory, {
    version: 1, runId: input.runId, sessionKey: input.sessionId, agentId: input.agentId ?? "host",
    operationalBudget: budget.cap, contextWindow: input.contextWindow, maxTokens: input.maxTokens!,
  }, purpose, budget.admittedAt);
}

async function assertBudgetSettled(directory: string): Promise<void> {
  const read = async (path: string) => {
    try { return await readFile(path, "utf8"); }
    catch (error) { if (code(error) === "ENOENT") return undefined; throw error; }
  };
  try {
    const configText = await read(join(directory, "operational-budget-config.json"));
    const ledgerText = await read(join(directory, "operational-budget-ledger.json"));
    if (configText === undefined && ledgerText === undefined) {
      try { await stat(join(directory, "budgets")); }
      catch (error) { if (code(error) === "ENOENT") return; throw error; }
      throw new Error("Missing budget evidence.");
    }
    if (configText === undefined || ledgerText === undefined) throw new Error("Incomplete budget evidence.");
    const config: unknown = JSON.parse(configText);
    const ledger: unknown = JSON.parse(ledgerText);
    if (!isRecord(config) || !isRecord(ledger) || config.version !== 1 || ledger.version !== 1 ||
        typeof config.runId !== "string" || !config.runId ||
        ["runId", "sessionKey", "agentId"].some((key) => ledger[key] !== config[key]) ||
        ledger.configSha256 !== createHash("sha256").update(JSON.stringify(config)).digest("hex") ||
        !Array.isArray(ledger.entries) || ledger.entries[0]?.type !== "admitted" ||
        ledger.entries.some((entry, seq) => !isRecord(entry) || entry.seq !== seq || entry.type === "fenced")) {
      throw new Error("Invalid budget evidence.");
    }
    const terminal = ledger.entries.at(-1);
    if (terminal?.type !== "settled" || terminal.providerSettled !== true || terminal.toolsSettled !== true) {
      throw new Error("Unsettled budget evidence.");
    }
    const historical = join(directory, "budgets", createHash("sha256").update(config.runId).digest("hex"));
    if (await read(join(historical, "operational-budget-config.json")) !== configText ||
        await read(join(historical, "operational-budget-ledger.json")) !== ledgerText) {
      throw new Error("Budget evidence mirrors disagree.");
    }
  } catch {
    throw budgetError("DSH_BUDGET_UNCERTAIN", "Prior budget evidence is unsettled or unreadable; operator inspection is required.");
  }
}

async function retainBudgetOwnership(directory: string, statePath: string, state: SessionState | undefined,
  input: DshAttempt | DshCompactAttempt, operation: "run" | "compact"): Promise<void> {
  if (state) { state.status = "blocked"; state.budgetFailure = "DSH_BUDGET_UNCERTAIN"; }
  await Promise.allSettled([
    state ? saveState(statePath, state) : Promise.resolve(),
    (async () => {
      try {
        const retained = await createDurableOwnership(join(directory, "owner.lock"), {
          runId: input.runId, operation, stateKey: input.nativeStateId ?? input.sessionId,
        });
        await retained.handle.close();
      } catch (error) { if (code(error) !== "ELOCKED") throw error; }
    })(),
  ]);
}

function waitBudgetAdmission<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  return Promise.race([pending, cancelled]).finally(() => signal.removeEventListener("abort", abort));
}

async function hasBudgetHistory(directory: string, runId: string): Promise<boolean> {
  try {
    await stat(join(directory, "budgets", createHash("sha256").update(runId).digest("hex")));
    return true;
  } catch (error) {
    if (code(error) === "ENOENT") return false;
    throw error;
  }
}

async function rejectLockedBudget(directory: string, budget?: AttemptBudget): Promise<void> {
  if (!budget) {
    try { await stat(join(directory, "budgets")); }
    catch (error) { if (code(error) === "ENOENT") return; }
  }
  // A lock is an unresolved owner, not permission to retry on another model.
  // Inspect only; never mutate another owner's evidence while rejecting admission.
  throw budgetError("DSH_BUDGET_UNCERTAIN", "This budgeted DSH session already has an owner; operator inspection is required.");
}

async function finishBudget(ledger: BudgetLedger | undefined, error: unknown, shutdownTimeoutMs: number): Promise<unknown> {
  if (!ledger) return error;
  // JSON-RPC only carries an error message. Recover only our closed, explicit budget prefix.
  const wireCode = /^DSH_BUDGET_(EXCEEDED|UNCERTAIN):/.exec(asError(error).message)?.[1];
  if (!code(error) && wireCode) error = budgetError(`DSH_BUDGET_${wireCode}` as "DSH_BUDGET_EXCEEDED" | "DSH_BUDGET_UNCERTAIN",
    "Budgeted worker rejected the operation.");
  try {
    const done = error instanceof ChildTerminationError || code(error) === "DSH_BUDGET_UNCERTAIN"
      ? ledger.fence() : ledger.finish();
    await timeout(done, shutdownTimeoutMs, "Budget finalization is unconfirmed.");
  } catch {
    // Latch independently of queued disk I/O; a deadline is never evidence of remote settlement.
    void ledger.fence().catch(() => {});
  }
  return ledger.failure ?? error;
}

function operationError(error: unknown, releaseLock: boolean, persistenceFailure: unknown, apiKey: string,
  ledger?: BudgetLedger): Error {
  const errorCode = code(error) === "DSH_BUDGET_UNCERTAIN" ||
    ledger?.failure && code(ledger.failure) === "DSH_BUDGET_UNCERTAIN" || ledger && !releaseLock
    ? "DSH_BUDGET_UNCERTAIN"
    : !releaseLock ? "DSH_TERMINATION_UNCONFIRMED" : code(error);
  const message = asError(error).message.replaceAll(apiKey, "[redacted]") +
    (persistenceFailure ? "; failure state could not be persisted; ownership retained." : "");
  return Object.assign(new Error(message), errorCode ? { code: errorCode } : {});
}

export function createDshRuntime(config: DshConfig): DshRuntime {
  const active = new Set<AbortController>();
  const running = new Set<Promise<unknown>>();
  let disposed = false;
  let unconfirmedOperations = 0;
  let uncertainBudgets = 0;
  const maxConcurrentRuns = config.maxConcurrentRuns ?? 8;
  if (!Number.isSafeInteger(maxConcurrentRuns) || maxConcurrentRuns < 1 || maxConcurrentRuns > 64) {
    throw new Error("Invalid DSH runtime concurrency limit.");
  }
  const admit = () => {
    if (disposed) throw new Error("dsh-native runtime has been disposed.");
    if (active.size + unconfirmedOperations >= maxConcurrentRuns) {
      const message = "DSH runtime capacity reached before session admission; no operation was submitted.";
      if (uncertainBudgets) throw budgetError("DSH_BUDGET_UNCERTAIN", message);
      throw new Error(message);
    }
  };
  const trackUnconfirmed = (error: unknown): never => {
    if (code(error) === "DSH_BUDGET_UNCERTAIN") { unconfirmedOperations++; uncertainBudgets++; }
    else if (code(error) === "DSH_TERMINATION_UNCONFIRMED") unconfirmedOperations++;
    throw error;
  };
  const compact = (input: DshCompactAttempt) => {
    let prepared: ReturnType<typeof snapshotAttempt<DshCompactAttempt>>;
    try { prepared = snapshotAttempt(config, input); admit(); } catch (error) { return Promise.reject(error); }
    const controller = new AbortController();
    const stopTimer = budgetTimer(prepared.budget, controller);
    active.add(controller);
    const result = compactChild(config, {
      ...prepared.input, signal: AbortSignal.any([prepared.input.signal, controller.signal]),
    }, prepared.budget).catch(trackUnconfirmed).finally(() => {
      stopTimer(); active.delete(controller); running.delete(result);
    });
    running.add(result);
    return result;
  };
  return {
    run(input) {
      let prepared: ReturnType<typeof snapshotAttempt<DshAttempt>>;
      try { prepared = snapshotAttempt(config, input); admit(); } catch (error) { return Promise.reject(error); }
      const controller = new AbortController();
      const stopTimer = budgetTimer(prepared.budget, controller);
      active.add(controller);
      const result = runChild(config, {
        ...prepared.input, signal: AbortSignal.any([prepared.input.signal, controller.signal]),
      }, prepared.budget).catch(trackUnconfirmed).finally(() => {
        stopTimer(); active.delete(controller); running.delete(result);
      });
      running.add(result);
      return result;
    },
    compact,
    recoverCompaction: (input) => compact({ ...input, recoverOnly: true }),
    async dispose() {
      disposed = true;
      for (const controller of active) controller.abort();
      await Promise.allSettled([...running]);
      if (unconfirmedOperations) {
        throw Object.assign(new Error("DSH runtime disposal cannot confirm all prior operations stopped; inspect retained ownership locks."),
          { code: uncertainBudgets ? "DSH_BUDGET_UNCERTAIN" : "DSH_TERMINATION_UNCONFIRMED" });
      }
    },
  };
}

async function runChild(config: DshConfig, input: DshAttempt, budget?: AttemptBudget): Promise<BridgeResult> {
  input.signal.throwIfAborted();
  input.assertActive();
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const provider = input.provider ?? "deepseek";
  if (provider !== "deepseek" && provider !== "github-copilot") throw new Error("Unsupported DSH model provider.");
  const allowedUrls = provider === "github-copilot"
    ? config.allowedCopilotBaseUrls ?? COPILOT_ENDPOINTS : config.allowedBaseUrls;
  if (!allowedUrls.includes(baseUrl)) throw new Error("Prepared DSH endpoint is not explicitly allowed for this provider.");
  const headers = provider === "github-copilot" ? copilotHeaders(input.headers) : undefined;
  if (provider === "deepseek" && (input.headers !== undefined || input.reasoningEfforts !== undefined)) {
    throw new Error("Copilot request settings cannot be applied to a DeepSeek session.");
  }
  if (!input.apiKey || !input.sessionId || !input.runId ||
      input.nativeStateId !== undefined && (!input.nativeStateId || input.nativeStateId.trim() !== input.nativeStateId)) {
    throw new Error("Missing prepared DSH authentication or identity.");
  }
  if (new Set(input.tools.map((tool) => tool.name)).size !== input.tools.length) {
    throw new Error("Duplicate host tool names.");
  }
  let taskPreparation: PreparationRequest | undefined;
  let preparationFingerprint: string | undefined;
  if (input.taskPreparation !== undefined) {
    if (!isRecord(input.taskPreparation) ||
        Object.keys(input.taskPreparation).some((key) => !["policy", "userText"].includes(key))) {
      throw new Error("Invalid DSH task preparation input.");
    }
    if (typeof input.onPreparationDecision !== "function") {
      throw new Error("DSH task preparation requires an onPreparationDecision host gate callback.");
    }
    if (input.tools.some((tool) => tool.name === PREPARATION_TOOL_NAME)) {
      throw new Error(`Host tool collides with reserved preparation tool ${PREPARATION_TOOL_NAME}.`);
    }
    taskPreparation = structuredClone(parsePreparationRequest({
      version: 1, policy: parsePreparationPolicy(input.taskPreparation.policy),
      userText: input.taskPreparation.userText,
    }));
    preparationFingerprint = policyFingerprint(taskPreparation.policy);
  }
  if (headers && Object.values(headers).some((value) => value.includes(input.apiKey))) {
    throw new Error("Model credentials cannot be included in persistent request headers.");
  }
  const modelRoute = createHash("sha256").update(JSON.stringify({
    provider, model: input.modelId, baseUrl,
    credential: createHash("sha256").update(input.apiKey).digest("hex"),
    headers: Object.entries(headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  })).digest("hex");
  const key = createHash("sha256").update(input.nativeStateId ?? input.sessionId).digest("hex");
  const directory = join(config.stateDir, key);
  // Windows can read longer paths while CreateProcess still rejects a long cwd.
  if (process.platform === "win32" && directory.length > 258) {
    throw new Error("DSH child working directory exceeds the Windows process limit; configure a shorter stateDir before retrying.");
  }
  const home = join(directory, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, "owner.lock");
  let lock;
  try { lock = await createDurableOwnership(lockPath, { runId: input.runId, operation: "run", stateKey: input.nativeStateId ?? input.sessionId }); }
  catch (error: unknown) {
    if (code(error) === "ELOCKED") {
      await rejectLockedBudget(directory, budget);
      throw new Error("This DSH session already has an owner. A stale lock requires operator inspection; start a new session.");
    }
    throw error;
  }
  const statePath = join(directory, "binding.json");
  let state: SessionState | undefined;
  let submitted = false;
  let releaseLock = true;
  let ledger: BudgetLedger | undefined;
  try {
    await assertBudgetSettled(directory);
    const previous = await loadState(statePath);
    if (previous?.budgetFailure) {
      throw budgetError(previous.budgetFailure, "Previous budget outcome blocks this session; start a new session.");
    }
    if (previous && previous.status !== "ready") {
      throw new Error("Previous DSH outcome is uncertain; refusing to replay possible tool side effects. Start a new session.");
    }
    if (previous?.consumedRunIds.includes(input.runId)) {
      throw new Error("This DSH attempt was already submitted; refusing replay.");
    }
    if (previous && previous.workspaceDir !== input.workspaceDir) {
      throw new Error("DSH session workspace changed; start a new session.");
    }
    if (previous && previous.modelRoute !== modelRoute) {
      throw new Error("DSH model route or account changed, or this is a v0.1 session. Start a new OpenClaw session.");
    }
    if (previous && Boolean(previous.taskPreparation) !== Boolean(taskPreparation)) {
      throw new Error("DSH task preparation mode changed; use /new to start a new OpenClaw session.");
    }
    if (previous?.taskPreparation && previous.taskPreparation.policyFingerprint !== preparationFingerprint) {
      throw new Error("DSH task preparation policy changed; use /new to start a new OpenClaw session.");
    }
    if (taskPreparation && previous?.taskPreparation) {
      if (previous.taskPreparation.state.clarificationTurns > taskPreparation.policy.maxClarificationTurns) {
        throw new Error("Invalid persisted DSH preparation clarification count; use /new to start a new OpenClaw session.");
      }
      try {
        taskPreparation = parsePreparationRequest({
          ...taskPreparation, previous: previous.taskPreparation.state,
        });
      } catch (error: unknown) {
        throw new Error("Invalid persisted DSH preparation context; use /new to start a new OpenClaw session.", { cause: error });
      }
    }
    const currentState: SessionState = {
      version: BRIDGE_VERSION, dshVersion: DSH_VERSION, sessionId: previous?.sessionId ?? randomUUID(),
      workspaceDir: input.workspaceDir, status: "running", lastRunId: input.runId,
      consumedRunIds: [...(previous?.consumedRunIds ?? []), input.runId],
      ...(previous?.compactRunIds ? { compactRunIds: [...previous.compactRunIds] } : {}),
      modelRoute,
    };
    state = currentState;
    if (budget) {
      ledger = ledgerFor(directory, input, budget, "main");
      submitted = true;
      await waitBudgetAdmission(saveState(statePath, currentState), input.signal);
      input.signal.throwIfAborted();
      await waitBudgetAdmission(ledger.initialize(), input.signal);
    }
    for (const patch of [join(home, "cordis.patch.yml"), join(home, "profiles", "sdk-minimal", "cordis.patch.yml")]) {
      try {
        const content = await readFile(patch, "utf8");
        const entries = content.split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith("#"));
        if (entries.length > 0 && !(entries.length === 1 && /^\s*\[\s*\]\s*(?:#.*)?$/.test(entries[0]!))) {
          throw new Error("Unexpected user plugin patch in the private DSH home.");
        }
      } catch (error: unknown) { if (code(error) !== "ENOENT") throw error; }
    }
    const bridgePath = fileURLToPath(new URL("./bridge/index.js", import.meta.url));
    const compactionPath = fileURLToPath(new URL("./bridge/compaction.js", import.meta.url));
    const patchPath = join(directory, "bridge.patch.json");
    await writeFile(patchPath, JSON.stringify(createBridgePatch({
      bridgePath, compactionPath, baseUrl, thinking: input.thinking, reasoningEffort: input.reasoningEffort,
      maxTokens: input.maxTokens, contextWindow: input.contextWindow,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs,
      ...(ledger ? { operationalBudget: true } : {}),
      ...(provider === "github-copilot" ? {
        provider, modelId: input.modelId, modelName: input.modelName, headers,
        reasoningEfforts: input.reasoningEfforts,
      } : {}),
    })), { mode: 0o600 });
    const require = createRequire(import.meta.url);
    const dshPackage = require.resolve("@deepseek-ai/dsh/package.json");
    const cliPath = join(dirname(dshPackage), "lib", "bin.js");
    const result = await executeChild(config, input, cliPath, directory, home, patchPath, state,
      Boolean(previous), async () => {
        await saveState(statePath, currentState);
        submitted = true;
      }, taskPreparation, "run", ledger);
    if (ledger) {
      if (ledger.failure) throw ledger.failure;
      if (input.signal.aborted || result.stopReason === "aborted") {
        throw code(input.signal.reason) === "DSH_BUDGET_EXCEEDED" ? input.signal.reason
          : budgetError("DSH_BUDGET_UNCERTAIN", "Budgeted attempt was interrupted.");
      }
      if (!ledger.hasRequests) throw budgetError("DSH_BUDGET_UNCERTAIN", "No provider settlement was observed.");
    }
    if (taskPreparation && result.preparation && result.stopReason !== "aborted") {
      state.taskPreparation = {
        version: 1, policyFingerprint: preparationFingerprint!, state: result.preparation.state,
      };
    }
    state.status = taskPreparation && (!result.preparation || result.stopReason === "aborted") ? "blocked" : "ready";
    await saveState(statePath, state);
    if (ledger) {
      const failure = await finishBudget(ledger, undefined, config.shutdownTimeoutMs);
      if (failure) throw failure;
    }
    return result;
  } catch (error: unknown) {
    if (error instanceof ChildTerminationError) releaseLock = false;
    error = await finishBudget(ledger, error, config.shutdownTimeoutMs);
    if (ledger?.retainOwnership || code(error) === "DSH_BUDGET_UNCERTAIN") releaseLock = false;
    let persistenceFailure: unknown;
    if (submitted && state) {
      state.status = "blocked";
      if (ledger && code(error)?.startsWith("DSH_BUDGET_")) state.budgetFailure = code(error) as SessionState["budgetFailure"];
      try { await saveState(statePath, state); }
      catch (failure) {
        persistenceFailure = failure; releaseLock = false;
        if (ledger) {
          error = await finishBudget(ledger, budgetError("DSH_BUDGET_UNCERTAIN", "Binding persistence failed."),
            config.shutdownTimeoutMs);
        }
      }
    }
    throw operationError(error, releaseLock, persistenceFailure, input.apiKey, ledger);
  } finally {
    await finishOwnership(lock, releaseLock, input.apiKey, ledger, config.shutdownTimeoutMs,
      () => retainBudgetOwnership(directory, statePath, state, input, "run"));
  }
}

async function compactChild(config: DshConfig, input: DshCompactAttempt, budget?: AttemptBudget): Promise<BridgeCompactResult> {
  input.signal.throwIfAborted();
  input.assertActive();
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const provider = input.provider ?? "deepseek";
  if (provider !== "deepseek" && provider !== "github-copilot") throw new Error("Unsupported DSH model provider.");
  const allowedUrls = provider === "github-copilot"
    ? config.allowedCopilotBaseUrls ?? COPILOT_ENDPOINTS : config.allowedBaseUrls;
  if (!allowedUrls.includes(baseUrl)) throw new Error("Prepared DSH endpoint is not explicitly allowed for this provider.");
  const headers = provider === "github-copilot" ? copilotHeaders(input.headers) : undefined;
  if (provider === "deepseek" && (input.headers !== undefined || input.reasoningEfforts !== undefined)) {
    throw new Error("Copilot request settings cannot be applied to a DeepSeek session.");
  }
  if (!input.apiKey || !input.sessionId || !input.runId ||
      input.nativeStateId !== undefined && (!input.nativeStateId || input.nativeStateId.trim() !== input.nativeStateId)) {
    throw new Error("Missing prepared DSH authentication or identity.");
  }
  if (headers && Object.values(headers).some((value) => value.includes(input.apiKey))) {
    throw new Error("Model credentials cannot be included in persistent request headers.");
  }
  const modelRoute = createHash("sha256").update(JSON.stringify({
    provider, model: input.modelId, baseUrl,
    credential: createHash("sha256").update(input.apiKey).digest("hex"),
    headers: Object.entries(headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  })).digest("hex");
  const key = createHash("sha256").update(input.nativeStateId ?? input.sessionId).digest("hex");
  const directory = join(config.stateDir, key);
  if (process.platform === "win32" && directory.length > 258) {
    throw new Error("DSH child working directory exceeds the Windows process limit; configure a shorter stateDir before retrying.");
  }
  const home = join(directory, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, "owner.lock");
  let lock;
  try { lock = await createDurableOwnership(lockPath, { runId: input.runId, operation: "compact", stateKey: input.nativeStateId ?? input.sessionId }); }
  catch (error: unknown) {
    if (code(error) === "ELOCKED") {
      await rejectLockedBudget(directory, budget);
      throw new Error("This DSH session already has an owner. A stale lock requires operator inspection; start a new session.");
    }
    throw error;
  }
  const statePath = join(directory, "binding.json");
  let state: SessionState | undefined;
  let submitted = false;
  let releaseLock = true;
  let ledger: BudgetLedger | undefined;
  try {
    await assertBudgetSettled(directory);
    const previous = await loadState(statePath);
    if (previous?.budgetFailure) {
      throw budgetError(previous.budgetFailure, "Previous budget outcome blocks compaction and recovery.");
    }
    if (previous?.pendingCompact && await hasBudgetHistory(directory, previous.pendingCompact.runId)) {
      releaseLock = false;
      throw budgetError("DSH_BUDGET_UNCERTAIN", "Budgeted compaction cannot be recovered by replay or receipt inspection.");
    }
    if (input.recoverOnly && (!previous || previous.status === "ready" && !previous.pendingCompact)) {
      return { compacted: false, sessionId: previous?.sessionId ?? input.sessionId, details: { recovered: false } };
    }
    if (!previous) throw new Error("No ready DSH native session binding is available for compaction.");
    if (previous.compactRunIds?.includes(input.runId)) throw new Error("This DSH compaction was already submitted; refusing replay.");
    if (previous.consumedRunIds.includes(input.runId)) throw new Error("This DSH run id was already submitted; refusing replay.");
    if (previous.workspaceDir !== input.workspaceDir) throw new Error("DSH session workspace changed; start a new session.");
    if (previous.modelRoute !== modelRoute) {
      throw new Error("DSH model route or account changed. Native compaction must use the established model route.");
    }
    if (budget && previous.status === "ready" && !input.recoverOnly) {
      state = { ...previous, status: "running", pendingCompact: { runId: input.runId } };
      ledger = ledgerFor(directory, input, budget, "compaction");
      submitted = true;
      await waitBudgetAdmission(saveState(statePath, state), input.signal);
      input.signal.throwIfAborted();
      await waitBudgetAdmission(ledger.initialize(), input.signal);
    }
    const bridgePath = fileURLToPath(new URL("./bridge/index.js", import.meta.url));
    const compactionPath = fileURLToPath(new URL("./bridge/compaction.js", import.meta.url));
    const patchPath = join(directory, "bridge.patch.json");
    await writeFile(patchPath, JSON.stringify(createBridgePatch({
      bridgePath, compactionPath, baseUrl, thinking: input.thinking, reasoningEffort: input.reasoningEffort,
      maxTokens: input.maxTokens, contextWindow: input.contextWindow,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs,
      ...(ledger ? { operationalBudget: true } : {}),
      ...(provider === "github-copilot" ? {
        provider, modelId: input.modelId, modelName: input.modelName, headers,
        reasoningEfforts: input.reasoningEfforts,
      } : {}),
    })), { mode: 0o600 });
    const require = createRequire(import.meta.url);
    const dshPackage = require.resolve("@deepseek-ai/dsh/package.json");
    const cliPath = join(dirname(dshPackage), "lib", "bin.js");
    const bridgeInput: DshAttempt = {
      ...input, prompt: "compact", systemPrompt: "", tools: [],
      onEvent: () => {},
      executeTool: async () => { throw new Error("Compaction summaries cannot execute host tools."); },
    };
    if (previous.status === "running" && previous.pendingCompact) {
      state = previous;
      const recoveredRunId = previous.pendingCompact.runId;
      const recovered = await executeChild(config, { ...bridgeInput, runId: recoveredRunId },
        cliPath, directory, home, patchPath, state, true, async () => {}, undefined, "inspectCompact");
      state.status = "ready";
      delete state.pendingCompact;
      state.compactRunIds = [...new Set([...(state.compactRunIds ?? []), recoveredRunId,
        ...(input.recoverOnly ? [] : [input.runId])])];
      await saveState(statePath, state);
      return recovered;
    }
    if (previous.status !== "ready") throw new Error("No ready DSH native session binding is available for compaction.");
    if (input.recoverOnly) throw new Error("No reconcilable native compaction receipt is available.");
    state = { ...previous, status: "running", pendingCompact: { runId: input.runId } };
    const result = await executeChild(config, bridgeInput, cliPath, directory, home, patchPath, state,
      true, async () => {
        await saveState(statePath, state!);
        submitted = true;
      }, undefined, "compact", ledger);
    if (ledger?.failure) throw ledger.failure;
    if (ledger && input.signal.aborted) {
      throw code(input.signal.reason) === "DSH_BUDGET_EXCEEDED" ? input.signal.reason
        : budgetError("DSH_BUDGET_UNCERTAIN", "Budgeted compaction was interrupted.");
    }
    if (ledger && result.compacted && !ledger.hasRequests) {
      throw budgetError("DSH_BUDGET_UNCERTAIN", "No compaction provider settlement was observed.");
    }
    state.status = "ready";
    delete state.pendingCompact;
    state.compactRunIds = [...(state.compactRunIds ?? []), input.runId];
    await saveState(statePath, state);
    if (ledger) {
      const failure = await finishBudget(ledger, undefined, config.shutdownTimeoutMs);
      if (failure) throw failure;
    }
    return result;
  } catch (error: unknown) {
    if (error instanceof ChildTerminationError) releaseLock = false;
    error = await finishBudget(ledger, error, config.shutdownTimeoutMs);
    if (ledger?.retainOwnership || code(error) === "DSH_BUDGET_UNCERTAIN") releaseLock = false;
    let persistenceFailure: unknown;
    if (submitted && state) {
      state.status = ledger ? "blocked" : "running";
      state.pendingCompact ??= { runId: input.runId };
      if (ledger && code(error)?.startsWith("DSH_BUDGET_")) state.budgetFailure = code(error) as SessionState["budgetFailure"];
      try { await saveState(statePath, state); }
      catch (failure) {
        persistenceFailure = failure; releaseLock = false;
        if (ledger) {
          error = await finishBudget(ledger, budgetError("DSH_BUDGET_UNCERTAIN", "Binding persistence failed."),
            config.shutdownTimeoutMs);
        }
      }
    }
    throw operationError(error, releaseLock, persistenceFailure, input.apiKey, ledger);
  } finally {
    await finishOwnership(lock, releaseLock, input.apiKey, ledger, config.shutdownTimeoutMs,
      () => retainBudgetOwnership(directory, statePath, state, input, "compact"));
  }
}

type ChildArguments = [
  config: DshConfig, input: DshAttempt, cliPath: string, directory: string, home: string,
  patchPath: string, state: SessionState, resume: boolean, beforeSubmit: () => Promise<void>,
  taskPreparation: PreparationRequest | undefined,
];
function executeChild(...args: [...ChildArguments, operation: "compact" | "inspectCompact", ledger?: BudgetLedger]): Promise<BridgeCompactResult>;
function executeChild(...args: [...ChildArguments, operation?: "run", ledger?: BudgetLedger]): Promise<BridgeResult>;
async function executeChild(
  config: DshConfig, input: DshAttempt, cliPath: string, directory: string, home: string,
  patchPath: string, state: SessionState, resume: boolean, beforeSubmit: () => Promise<void>,
  taskPreparation?: PreparationRequest,
  operation: "run" | "compact" | "inspectCompact" = "run",
  ledger?: BudgetLedger,
): Promise<BridgeResult | BridgeCompactResult> {
  input.signal.throwIfAborted();
  input.assertActive();
  const child = spawn(process.execPath, [cliPath, "--profile", "sdk-minimal", "--patch", patchPath], {
    cwd: directory, env: childEnvironment(home, input.apiKey),
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false,
    detached: process.platform === "linux",
  });
  const signalChild = (signal: NodeJS.Signals = "SIGTERM") => {
    if (process.platform === "linux" && child.pid !== undefined) {
      try { process.kill(-child.pid, signal); }
      catch (error) { if (code(error) !== "ESRCH") throw error; }
    } else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const groupActive = () => {
    if (process.platform !== "linux" || child.pid === undefined) return false;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) { if (code(error) === "ESRCH") return false; throw error; }
  };
  const waitGroupClosed = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (groupActive()) {
      if (Date.now() >= deadline) throw new Error("DSH process group termination is unconfirmed.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  let stage: ChildLifecycleStage = "spawn";
  let stderr = "";
  const diagnostic = (message: string): string => {
    const parts = [message, `stage=${stage}`];
    if (child.pid !== undefined) parts.push(`pid=${child.pid}`);
    if (childFailure) {
      const failureCode = code(childFailure.cause);
      parts.push(`failure=${childFailure.message}${failureCode ? ` code=${failureCode}` : ""}`);
    }
    const safeStderr = redactDiagnostic(stderr, input.apiKey);
    if (safeStderr) parts.push(`stderr=${safeStderr}`);
    return parts.join("; ");
  };
  let resolveClosed!: (code: number | null) => void;
  const childClosed = new Promise<number | null>((resolve) => { resolveClosed = resolve; });
  let rejectChildFailed!: (error: Error) => void;
  const childFailed = new Promise<never>((_, reject) => { rejectChildFailed = reject; });
  void childFailed.catch(() => {});
  let childFailure: Error | undefined;
  let peer: JsonRpcPeer | undefined;
  const recordChildFailure = (stream: ChildStreamName, error: unknown): Error => {
    const failure = childLifecycleError(stage, stream, error, child.pid);
    childFailure ??= failure;
    rejectChildFailed(childFailure);
    peer?.close(childFailure, { fatal: true });
    return childFailure;
  };
  child.once("close", resolveClosed);
  child.once("error", (error) => { recordChildFailure("process", error); });
  for (const name of ["stdin", "stdout", "stderr"] as const) {
    child[name]?.on("error", (error) => { recordChildFailure(name, error); });
  }
  if (!child.stdin || !child.stdout || !child.stderr) {
    const missing = !child.stdin ? "stdin" : !child.stdout ? "stdout" : "stderr";
    const failure = recordChildFailure(missing, new Error("missing stdio"));
    signalChild();
    try {
      await timeout(childClosed, Math.min(config.shutdownTimeoutMs, 1000), "DSH child has not exited.");
    } catch (error: unknown) {
      throw new ChildTerminationError("DSH child could not be terminated; retaining its session ownership lock.",
        { cause: error });
    }
    throw failure;
  }
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-32_768); });
  stage = "handshake";
  let readyResolve!: () => void;
  const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
  const toolControllers = new Map<string, AbortController>();
  const toolTasks = new Set<Promise<unknown>>();
  const budgetTasks = new Set<Promise<unknown>>();
  const preparationTasks = new Set<Promise<void>>();
  const eventTasks = new Set<Promise<void>>();
  const seenCalls = new Set<string>();
  const hostToolNames = input.tools.map((tool) => tool.name);
  const onPreparationDecision = input.onPreparationDecision;
  let acceptingTools = false;
  let acceptingBudget = false;
  let preparationRequested = false;
  let resolved: PreparationResolution | undefined;
  let dispatchedTools = 0;
  let preparationFailure: Error | undefined;
  let hostFailure: Error | undefined;
  let abortTimer: NodeJS.Timeout | undefined;
  let rejectCancellation!: (error: Error) => void;
  const cancellationExpired = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
  void cancellationExpired.catch(() => {});
  let rejectBudgetFailure!: (error: Error) => void;
  const budgetFailed = new Promise<never>((_resolve, reject) => { rejectBudgetFailure = reject; });
  void budgetFailed.catch(() => {});
  const failBudget = (error: Error): Error => {
    acceptingTools = false;
    acceptingBudget = false;
    for (const controller of toolControllers.values()) controller.abort();
    rejectBudgetFailure(error);
    return error;
  };
  const failPreparation = (error: unknown): Error => {
    preparationFailure ??= asError(error);
    acceptingTools = false;
    resolved = undefined;
    for (const controller of toolControllers.values()) controller.abort();
    peer?.close(preparationFailure, { fatal: true });
    signalChild();
    return preparationFailure;
  };
  peer = new JsonRpcPeer(child.stdout, child.stdin, {
    async onNotification(method, params) {
      if (method !== "event") throw new Error("Unknown worker notification.");
      const event = parseEvent(params);
      if (event.type === "tool-cancel") toolControllers.get(event.callId)?.abort();
      if (input.signal.aborted) {
        if (event.type === "ready") input.signal.throwIfAborted();
        // Drain the worker's interrupted result without forwarding late visible events.
        return;
      }
      const task = Promise.resolve().then(() => input.onEvent(event));
      eventTasks.add(task);
      try { await task; } finally { eventTasks.delete(task); }
      if (event.type === "ready") {
        input.signal.throwIfAborted();
        input.assertActive();
        readyResolve();
      }
    },
    async onRequest(method, params) {
      if (ledger && method.startsWith("budget.")) {
        const task = Promise.resolve().then(async () => {
          try {
            if (method === "budget.reserve") {
              if (!acceptingBudget) {
                await ledger.fence();
                throw ledger.failure!;
              }
              input.signal.throwIfAborted();
              input.assertActive();
              const grant = await ledger.reserve(params);
              input.signal.throwIfAborted();
              input.assertActive();
              if (!acceptingBudget) {
                await ledger.fence();
                throw ledger.failure!;
              }
              return grant;
            }
            if (method === "budget.settle") return await ledger.settle(params);
            if (method === "budget.uncertain") {
              const result = await ledger.uncertain(params);
              failBudget(ledger.failure!);
              return result;
            }
            await ledger.fence();
            throw ledger.failure!;
          } catch (error) {
            throw failBudget(ledger.failure ?? asError(error));
          }
        });
        budgetTasks.add(task);
        try { return await task; } finally { budgetTasks.delete(task); }
      }
      if (method === "prepare" && taskPreparation) {
        try {
          if (!acceptingTools || preparationRequested || !isRecord(params) ||
              Object.keys(params).length !== 1 || !Object.hasOwn(params, "decision")) {
            throw new Error("Invalid, duplicate or out-of-turn DSH preparation request.");
          }
          preparationRequested = true;
          input.signal.throwIfAborted();
          input.assertActive();
          const resolution = resolvePreparationDecision(taskPreparation, params.decision, input.runId, hostToolNames);
          if (resolution.state.sourceRunId !== input.runId ||
              resolution.state.revision !== (taskPreparation.previous?.revision ?? 0) + 1) {
            throw new Error("Invalid DSH preparation resolution source or revision.");
          }
          if (!onPreparationDecision) throw new Error("Missing DSH preparation host gate callback.");
          const preparationTask = Promise.resolve().then(() => onPreparationDecision(structuredClone(resolution)));
          preparationTasks.add(preparationTask);
          try { await preparationTask; }
          finally { preparationTasks.delete(preparationTask); }
          input.signal.throwIfAborted();
          input.assertActive();
          if (!acceptingTools || preparationFailure) throw new Error("DSH preparation completed outside the active turn.");
          resolved = resolution;
          return structuredClone(resolution);
        } catch (error: unknown) {
          throw failPreparation(error);
        }
      }
      if (method !== "tool" || !acceptingTools || !isRecord(params) ||
          typeof params.callId !== "string" || !params.callId ||
          typeof params.name !== "string" || !isRecord(params.arguments)) {
        throw new Error("Invalid or out-of-turn DSH tool request.");
      }
      if (seenCalls.has(params.callId)) throw new Error("Duplicate DSH tool call; refusing replay.");
      if (!input.tools.some((tool) => tool.name === params.name)) throw new Error("DSH requested an unadvertised tool.");
      input.signal.throwIfAborted();
      input.assertActive();
      if (taskPreparation) {
        if (!resolved || resolved.decision.mode !== "execute" || !resolved.allowedTools.includes(params.name)) {
          throw new Error("DSH task preparation has not authorized this host tool.");
        }
        if (dispatchedTools >= taskPreparation.policy.maxToolCalls) {
          throw new Error("DSH task preparation host tool-call budget exhausted.");
        }
      }
      seenCalls.add(params.callId);
      const controller = new AbortController();
      toolControllers.set(params.callId, controller);
      // JSON-RPC parsing already limits values to JSON; schemas are checked by the host adapter.
      const call: BridgeToolCall = {
        callId: params.callId, name: params.name,
        arguments: JSON.parse(JSON.stringify(params.arguments)),
      };
      dispatchedTools++;
      const task = Promise.resolve().then(async () => {
        let started = false;
        try {
          if (ledger) {
            await ledger.startTool(call.callId);
            started = true;
            input.signal.throwIfAborted();
            input.assertActive();
            if (!acceptingTools || ledger.failure) throw ledger.failure ?? new Error("DSH tool admission closed.");
          }
          return await input.executeTool(call, AbortSignal.any([input.signal, controller.signal]));
        } finally {
          if (started) await ledger!.settleTool(call.callId);
        }
      });
      toolTasks.add(task);
      try {
        return await task;
      } catch (error) {
        if (ledger?.failure) throw failBudget(ledger.failure);
        hostFailure ??= asError(error);
        throw error;
      } finally {
        toolTasks.delete(task);
        toolControllers.delete(call.callId);
      }
    },
  });
  const abort = (): void => {
    acceptingTools = false;
    acceptingBudget = false;
    for (const controller of toolControllers.values()) controller.abort();
    void peer!.notify("cancel", {}).catch((error: unknown) => rejectCancellation(asError(error)));
    if (ledger) {
      rejectCancellation(code(input.signal.reason) === "DSH_BUDGET_EXCEEDED" ? input.signal.reason
        : budgetError("DSH_BUDGET_UNCERTAIN", "Budgeted attempt was interrupted."));
    }
    // Enter bounded finalization even if the worker ignores both cancel and TERM.
    abortTimer ??= setTimeout(() => {
      const error = new Error("DSH cancellation acknowledgement timed out.");
      rejectCancellation(error);
      peer?.close(error, { fatal: true });
    }, config.shutdownTimeoutMs);
  };
  input.signal.addEventListener("abort", abort, { once: true });
  try {
    if (input.signal.aborted) abort();
    await timeout(Promise.race([
      ready,
      peer.closed.then(() => { throw preparationFailure ?? peer!.failureReason ?? childFailure ??
        new Error(diagnostic("DSH stopped before bridge initialization")); }),
      childFailed,
      budgetFailed,
      cancellationExpired,
      childClosed.then((value) => { throw childFailure ?? new Error(diagnostic(`DSH startup exited (${value})`)); }),
    ]), config.startupTimeoutMs, () => diagnostic("DSH bridge startup timed out"));
    input.signal.throwIfAborted();
    input.assertActive();
    await beforeSubmit();
    input.signal.throwIfAborted();
    input.assertActive();
    stage = "run";
    acceptingTools = operation === "run";
    acceptingBudget = operation !== "inspectCompact";
    const rpcResult = await Promise.race([
      peer.request(operation, operation === "run" ? {
        ...(input.provider === "github-copilot" ? { provider: input.provider } : {}),
        sessionId: state.sessionId, resume, workspaceDir: input.workspaceDir,
        systemPrompt: input.systemPrompt, prompt: input.prompt, modelId: input.modelId,
        reasoningEffort: input.reasoningEffort, maxTokens: input.maxTokens, tools: input.tools,
        ...(taskPreparation ? { taskPreparation } : {}),
      } : {
        ...(input.provider === "github-copilot" ? { provider: input.provider } : {}),
        sessionId: state.sessionId, runId: input.runId, completedTurns: state.consumedRunIds.length,
        workspaceDir: input.workspaceDir, modelId: input.modelId,
        reasoningEffort: input.reasoningEffort, maxTokens: input.maxTokens,
      }),
      childFailed,
      budgetFailed,
      cancellationExpired,
      childClosed.then((value) => { throw childFailure ?? peer!.failureReason ??
        new Error(diagnostic(`DSH exited during run (${value})`)); }),
    ]);
    const result = operation === "run"
      ? parseResult(rpcResult, state.sessionId)
      : parseCompactResult(rpcResult, state.sessionId);
    acceptingTools = false;
    acceptingBudget = false;
    if (ledger?.failure) throw ledger.failure;
    if (preparationFailure) throw preparationFailure;
    if (operation === "run") {
      const runResult = result as BridgeResult;
      if (!isDeepStrictEqual(runResult.preparation, resolved)) {
        throw new Error("DSH result preparation does not match the authoritative parent resolution.");
      }
      if (taskPreparation && !resolved && runResult.stopReason !== "aborted") {
        throw new Error("DSH completed without the required task preparation decision.");
      }
    }
    if (preparationRequested && !resolved) {
      throw new Error("DSH aborted before its parent preparation callback completed.");
    }
    await timeout(Promise.race([peer.drain(), cancellationExpired]), config.shutdownTimeoutMs, "DSH event drain timed out.");
    stage = "shutdown";
    await timeout(Promise.race([
      peer.request("shutdown", {}),
      childFailed,
      childClosed.then((value) => { throw childFailure ?? peer!.failureReason ??
        new Error(diagnostic(`DSH exited before shutdown acknowledgement (${value})`)); }),
    ]), config.shutdownTimeoutMs, "DSH shutdown did not acknowledge.");
    await timeout(Promise.race([peer.drain(), cancellationExpired]), config.shutdownTimeoutMs, "DSH shutdown drain timed out.");
    child.stdin.end();
    const exitCode = await timeout(childClosed, config.shutdownTimeoutMs, "DSH did not exit after shutdown.");
    await timeout(Promise.race([peer.drain(), cancellationExpired]), config.shutdownTimeoutMs, "DSH final drain timed out.");
    if (childFailure) throw childFailure;
    if (exitCode !== 0) throw new Error(diagnostic(`DSH shutdown failed (${exitCode})`));
    if (preparationFailure) throw preparationFailure;
    if (operation === "run" && input.signal.aborted && (result as BridgeResult).stopReason !== "aborted") {
      throw new Error("DSH completed after cancellation without confirming an interrupted outcome.");
    }
    return result;
  } catch (error) {
    throw ledger?.failure ?? preparationFailure ?? hostFailure ?? error;
  } finally {
    acceptingTools = false;
    acceptingBudget = false;
    input.signal.removeEventListener("abort", abort);
    clearTimeout(abortTimer);
    for (const controller of toolControllers.values()) controller.abort();
    peer?.close();
    if (child.pid !== undefined) {
      try {
        if (child.exitCode === null && child.signalCode === null || groupActive()) signalChild();
        try {
          const graceMs = Math.min(config.shutdownTimeoutMs, 1000);
          await timeout(Promise.all([childClosed, waitGroupClosed(graceMs)]), graceMs,
            "DSH child or its process group has not exited.");
        } catch {
          signalChild("SIGKILL");
          await timeout(Promise.all([childClosed, waitGroupClosed(config.shutdownTimeoutMs)]),
            config.shutdownTimeoutMs, "DSH child termination is unconfirmed.");
        }
      } catch (error) {
        throw new ChildTerminationError("DSH child could not be terminated; retaining its session ownership lock.", { cause: error });
      }
    }
    try {
      await timeout(Promise.allSettled([...toolTasks]), config.shutdownTimeoutMs,
        "Host tool cancellation is unconfirmed; inspect the active tool before retrying.");
    } catch (error: unknown) {
      throw new ChildTerminationError("Host tool cancellation is unconfirmed; retaining its session ownership lock.",
        { cause: error });
    }
    try {
      await timeout(Promise.all([Promise.allSettled([...budgetTasks]), ledger?.drain()]), config.shutdownTimeoutMs,
        "DSH budget callbacks did not settle.");
    } catch (error) {
      throw new ChildTerminationError("DSH budget persistence is unconfirmed; retaining its session ownership lock.", { cause: error });
    }
    try {
      await timeout(Promise.allSettled([...preparationTasks]), config.shutdownTimeoutMs,
        "DSH preparation callback cancellation is unconfirmed.");
    } catch (error: unknown) {
      throw new ChildTerminationError("DSH preparation callback did not settle; retaining its session ownership lock.",
        { cause: error });
    }
    try {
      await timeout(Promise.allSettled([...eventTasks]), config.shutdownTimeoutMs, "DSH event callback did not settle.");
    } catch (error) {
      throw new ChildTerminationError("DSH event callback cancellation is unconfirmed; retaining its session ownership lock.", { cause: error });
    }
  }
}
