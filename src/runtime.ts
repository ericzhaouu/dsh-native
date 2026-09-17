import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { normalizeBaseUrl } from "./config.js";
import { COPILOT_ENDPOINTS, copilotHeaders } from "./copilot-policy.js";
import { createBridgePatch } from "./bridge/profile.js";
import {
  BRIDGE_VERSION, DSH_VERSION, isRecord,
  type BridgeEvent, type BridgeResult, type BridgeToolCall, type BridgeUsage,
} from "./protocol.js";
import { asError, JsonRpcPeer } from "./rpc.js";
import type { DshAttempt, DshConfig, DshRuntime } from "./runtime-types.js";
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
  modelRoute?: string;
  taskPreparation?: SessionPreparation;
}

class ChildTerminationError extends Error {}

function code(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
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
      value.modelRoute !== undefined && (typeof value.modelRoute !== "string" || !/^[a-f0-9]{64}$/.test(value.modelRoute)) ||
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
    modelRoute: value.modelRoute,
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
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
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
    ...(Object.hasOwn(value, "preparation") ? { preparation: parsePreparationResolution(value.preparation) } : {}),
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

function timeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export function createDshRuntime(config: DshConfig): DshRuntime {
  const active = new Set<AbortController>();
  const running = new Set<Promise<BridgeResult>>();
  let disposed = false;
  return {
    run(input) {
      if (disposed) return Promise.reject(new Error("dsh-native runtime has been disposed."));
      const controller = new AbortController();
      active.add(controller);
      const result = runChild(config, {
        ...input, signal: AbortSignal.any([input.signal, controller.signal]),
      }).finally(() => { active.delete(controller); running.delete(result); });
      running.add(result);
      return result;
    },
    async dispose() {
      disposed = true;
      for (const controller of active) controller.abort();
      await Promise.allSettled([...running]);
    },
  };
}

async function runChild(config: DshConfig, input: DshAttempt): Promise<BridgeResult> {
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
  const home = join(directory, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, "owner.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error: unknown) {
    if (code(error) === "EEXIST") {
      throw new Error("This DSH session already has an owner. A stale lock requires operator inspection; start a new session.");
    }
    throw error;
  }
  const statePath = join(directory, "binding.json");
  let state: SessionState | undefined;
  let submitted = false;
  let releaseLock = true;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, runId: input.runId }));
    const previous = await loadState(statePath);
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
      modelRoute,
    };
    state = currentState;
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
    const patchPath = join(directory, "bridge.patch.json");
    await writeFile(patchPath, JSON.stringify(createBridgePatch({
      bridgePath, baseUrl, thinking: input.thinking, reasoningEffort: input.reasoningEffort,
      maxTokens: input.maxTokens, contextWindow: input.contextWindow,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs,
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
      }, taskPreparation);
    if (taskPreparation && result.preparation && result.stopReason !== "aborted") {
      state.taskPreparation = {
        version: 1, policyFingerprint: preparationFingerprint!, state: result.preparation.state,
      };
    }
    state.status = taskPreparation && (!result.preparation || result.stopReason === "aborted") ? "blocked" : "ready";
    await saveState(statePath, state);
    return result;
  } catch (error: unknown) {
    if (error instanceof ChildTerminationError) releaseLock = false;
    if (submitted && state) {
      state.status = "blocked";
      await saveState(statePath, state);
    }
    const message = asError(error).message.replaceAll(input.apiKey, "[redacted]");
    throw new Error(message);
  } finally {
    await lock.close();
    if (releaseLock) await rm(lockPath, { force: true });
  }
}

async function executeChild(
  config: DshConfig, input: DshAttempt, cliPath: string, directory: string, home: string,
  patchPath: string, state: SessionState, resume: boolean, beforeSubmit: () => Promise<void>,
  taskPreparation?: PreparationRequest,
): Promise<BridgeResult> {
  input.signal.throwIfAborted();
  input.assertActive();
  const child = spawn(process.execPath, [cliPath, "--profile", "sdk-minimal", "--patch", patchPath], {
    cwd: directory, env: childEnvironment(home, input.apiKey),
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false,
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-32_768); });
  let resolveExit!: (code: number | null) => void;
  let rejectExit!: (error: Error) => void;
  const exited = new Promise<number | null>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  void exited.catch(() => {});
  child.once("close", resolveExit);
  child.once("error", rejectExit);
  let readyResolve!: () => void;
  const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
  const toolControllers = new Map<string, AbortController>();
  const toolTasks = new Set<Promise<unknown>>();
  const preparationTasks = new Set<Promise<void>>();
  const seenCalls = new Set<string>();
  const hostToolNames = input.tools.map((tool) => tool.name);
  const onPreparationDecision = input.onPreparationDecision;
  let acceptingTools = false;
  let preparationRequested = false;
  let resolved: PreparationResolution | undefined;
  let dispatchedTools = 0;
  let preparationFailure: Error | undefined;
  let abortTimer: NodeJS.Timeout | undefined;
  const failPreparation = (error: unknown): Error => {
    preparationFailure ??= asError(error);
    acceptingTools = false;
    resolved = undefined;
    for (const controller of toolControllers.values()) controller.abort();
    peer.close(preparationFailure);
    child.kill();
    return preparationFailure;
  };
  const peer = new JsonRpcPeer(child.stdout, child.stdin, {
    async onNotification(method, params) {
      if (method !== "event") throw new Error("Unknown worker notification.");
      const event = parseEvent(params);
      if (event.type === "ready") readyResolve();
      if (event.type === "tool-cancel") toolControllers.get(event.callId)?.abort();
      await input.onEvent(event);
    },
    async onRequest(method, params) {
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
      let task: Promise<unknown> | undefined;
      try {
        // Reserve the budget synchronously before dispatch, including concurrent or failed calls.
        dispatchedTools++;
        task = input.executeTool(call, AbortSignal.any([input.signal, controller.signal]));
        toolTasks.add(task);
        return await task;
      } finally {
        if (task) toolTasks.delete(task);
        toolControllers.delete(call.callId);
      }
    },
  });
  const abort = (): void => {
    acceptingTools = false;
    for (const controller of toolControllers.values()) controller.abort();
    void peer.notify("cancel", {}).catch(() => { child.kill(); });
    abortTimer ??= setTimeout(() => { child.kill(); }, config.shutdownTimeoutMs);
  };
  input.signal.addEventListener("abort", abort, { once: true });
  try {
    if (input.signal.aborted) abort();
    await timeout(Promise.race([
      ready,
      peer.closed.then(() => { throw preparationFailure ?? new Error(`DSH stopped before bridge initialization: ${stderr}`); }),
      exited.then((value) => { throw new Error(`DSH startup exited (${value}): ${stderr}`); }),
    ]), config.startupTimeoutMs, `DSH bridge startup timed out: ${stderr}`);
    input.signal.throwIfAborted();
    input.assertActive();
    await beforeSubmit();
    input.signal.throwIfAborted();
    input.assertActive();
    acceptingTools = true;
    const result = parseResult(await peer.request("run", {
      ...(input.provider === "github-copilot" ? { provider: input.provider } : {}),
      sessionId: state.sessionId, resume, workspaceDir: input.workspaceDir,
      systemPrompt: input.systemPrompt, prompt: input.prompt, modelId: input.modelId,
      reasoningEffort: input.reasoningEffort, maxTokens: input.maxTokens, tools: input.tools,
      ...(taskPreparation ? { taskPreparation } : {}),
    }), state.sessionId);
    acceptingTools = false;
    if (preparationFailure) throw preparationFailure;
    if (!isDeepStrictEqual(result.preparation, resolved)) {
      throw new Error("DSH result preparation does not match the authoritative parent resolution.");
    }
    if (taskPreparation && !resolved && result.stopReason !== "aborted") {
      throw new Error("DSH completed without the required task preparation decision.");
    }
    if (preparationRequested && !resolved) {
      throw new Error("DSH aborted before its parent preparation callback completed.");
    }
    await peer.drain();
    await timeout(peer.request("shutdown", {}), config.shutdownTimeoutMs, "DSH shutdown did not acknowledge.");
    await peer.drain();
    child.stdin.end();
    const exitCode = await timeout(exited, config.shutdownTimeoutMs, "DSH did not exit after shutdown.");
    await peer.drain();
    if (exitCode !== 0) throw new Error(`DSH shutdown failed (${exitCode}): ${stderr}`);
    if (preparationFailure) throw preparationFailure;
    if (input.signal.aborted && result.stopReason !== "aborted") {
      throw new Error("DSH completed after cancellation without confirming an interrupted outcome.");
    }
    return result;
  } finally {
    acceptingTools = false;
    input.signal.removeEventListener("abort", abort);
    clearTimeout(abortTimer);
    for (const controller of toolControllers.values()) controller.abort();
    peer.close();
    if (child.pid !== undefined) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      try {
        await timeout(exited, Math.min(config.shutdownTimeoutMs, 1000), "DSH child has not exited.");
      } catch {
        child.kill("SIGKILL");
        try { await timeout(exited, config.shutdownTimeoutMs, "DSH child termination is unconfirmed."); }
        catch (error: unknown) {
          throw new ChildTerminationError("DSH child could not be terminated; retaining its session ownership lock.",
            { cause: error });
        }
      }
    }
    await timeout(Promise.allSettled([...toolTasks]), config.shutdownTimeoutMs,
      "Host tool cancellation is unconfirmed; inspect the active tool before retrying.");
    try {
      await timeout(Promise.allSettled([...preparationTasks]), config.shutdownTimeoutMs,
        "DSH preparation callback cancellation is unconfirmed.");
    } catch (error: unknown) {
      throw new ChildTerminationError("DSH preparation callback did not settle; retaining its session ownership lock.",
        { cause: error });
    }
  }
}
