import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { syncParentDirectory, writeDurableJson } from "../durable-state.js";
import type { OperationalBudget } from "../protocol.js";

type BudgetCode = "DSH_BUDGET_EXCEEDED" | "DSH_BUDGET_UNCERTAIN";
type Config = {
  version: 1;
  runId: string;
  sessionKey: string;
  agentId: string;
  operationalBudget: OperationalBudget;
  contextWindow: number;
  maxTokens: number;
};
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
type Event =
  | { type: "admitted" }
  | { type: "request_reserved"; requestId: string; purpose: "main" | "compaction"; inputTokens: number; outputTokens: number }
  | { type: "request_settled"; requestId: string; usage: Usage }
  | { type: "tool_started" | "tool_settled"; callId: string }
  | { type: "settled"; providerSettled: true; toolsSettled: true }
  | { type: "fenced" };
type Entry = Event & { seq: number; at: number };

const CONFIG_FILE = "operational-budget-config.json";
const LEDGER_FILE = "operational-budget-ledger.json";
const budgetFields = ["maxModelRequests", "maxInputTokens", "maxOutputTokens", "maxToolCalls", "maxDurationMs"];

export function budgetError(code: BudgetCode, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function invalid(): never {
  throw budgetError("DSH_BUDGET_UNCERTAIN", "Invalid budget parameters.");
}

function closed(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== fields.length ||
      fields.some((key) => !Object.hasOwn(descriptors, key) || !("value" in descriptors[key]!))) return invalid();
  return Object.fromEntries(fields.map((key) => [key, descriptors[key]!.value]));
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positive(value: unknown): value is number {
  return nonNegative(value) && value > 0;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function snapshotConfig(config: Config, admittedAt: number): Config {
  const value = closed(config, ["version", "runId", "sessionKey", "agentId", "operationalBudget", "contextWindow", "maxTokens"]);
  const budget = closed(value.operationalBudget, budgetFields);
  if (value.version !== 1 || !["runId", "sessionKey", "agentId"].every((key) => identifier(value[key])) ||
      !budgetFields.every((key) => positive(budget[key])) ||
      !positive(value.contextWindow) || !positive(value.maxTokens) ||
      value.contextWindow > (budget.maxInputTokens as number) ||
      value.maxTokens > value.contextWindow || value.maxTokens > (budget.maxOutputTokens as number) ||
      !nonNegative(admittedAt) || admittedAt > Date.now()) return invalid();
  // Preserve the caller's JSON property order for the config fingerprint, without retaining mutable references.
  return JSON.parse(JSON.stringify(config)) as Config;
}

export class BudgetLedger {
  private readonly config: Config;
  private readonly history: string;
  private readonly configSha256: string;
  private readonly entries: Entry[] = [];
  private readonly requests = new Map<string, number>();
  private readonly requestIds = new Set<string>();
  private readonly tools = new Set<string>();
  private readonly toolIds = new Set<string>();
  private inputUsed = 0;
  private outputUsed = 0;
  private inputReserved = 0;
  private outputReserved = 0;
  private initialized = false;
  private historyOwned = false;
  private terminal?: "settled" | "fenced";
  private failureValue?: Error;
  private uncertainty = false;
  private persistenceFailed = false;
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;

  constructor(
    private readonly directory: string,
    config: Config,
    private readonly purpose: "main" | "compaction",
    private readonly admittedAt: number,
  ) {
    this.config = snapshotConfig(config, admittedAt);
    if (purpose !== "main" && purpose !== "compaction") invalid();
    this.configSha256 = createHash("sha256").update(JSON.stringify(this.config)).digest("hex");
    this.history = join(directory, "budgets", createHash("sha256").update(this.config.runId).digest("hex"));
  }

  get failure(): Error | undefined {
    return this.failureValue;
  }

  get retainOwnership(): boolean {
    return this.uncertainty || this.queued > 0 || this.requests.size > 0 || this.tools.size > 0;
  }

  get hasRequests(): boolean {
    return this.requestIds.size > 0;
  }

  initialize(): Promise<void> {
    return this.serialize(async () => {
      if (this.failureValue) throw this.failureValue;
      if (this.initialized) return;
      this.entries.push({ seq: 0, at: this.admittedAt, type: "admitted" });
      try {
        const budgets = join(this.directory, "budgets");
        await mkdir(budgets, { recursive: true });
        // Claim this run before touching either latest mirror or any historical evidence.
        await mkdir(this.history);
        this.historyOwned = true;
        await syncParentDirectory(budgets);
        await syncParentDirectory(this.history);
        await this.writeBoth(CONFIG_FILE, this.config);
        await this.writeLedger();
        this.initialized = true;
      } catch {
        this.persistenceFailed = true;
        await this.fenceInternal();
        throw this.failureValue!;
      }
    });
  }

  reserve(params: unknown): Promise<{ requestId: string; maxTokens: number }> {
    return this.serialize(async () => {
      await this.assertOpen();
      const requested = await this.validate(() => {
        const value = closed(params, ["maxTokens"]);
        if (!positive(value.maxTokens)) return invalid();
        return value.maxTokens;
      });
      const at = this.timestamp();
      this.checkAdmission(at);
      const budget = this.config.operationalBudget;
      const availableInput = budget.maxInputTokens - this.inputUsed - this.inputReserved;
      const availableOutput = budget.maxOutputTokens - this.outputUsed - this.outputReserved;
      if (this.requestIds.size >= budget.maxModelRequests || availableInput < this.config.contextWindow ||
          availableOutput <= 0) throw this.exceeded();
      const maxTokens = Math.min(requested, this.config.maxTokens, availableOutput);
      let requestId = randomUUID();
      while (this.requestIds.has(requestId)) requestId = randomUUID();
      this.requestIds.add(requestId);
      this.requests.set(requestId, maxTokens);
      this.inputReserved += this.config.contextWindow;
      this.outputReserved += maxTokens;
      await this.append({
        type: "request_reserved", requestId, purpose: this.purpose,
        inputTokens: this.config.contextWindow, outputTokens: maxTokens,
      }, at);
      return { requestId, maxTokens };
    });
  }

  settle(params: unknown): Promise<{}> {
    return this.serialize(async () => {
      await this.assertOpen();
      const { requestId, usage, input } = await this.validate(() => {
        const value = closed(params, ["requestId", "usage"]);
        if (!identifier(value.requestId)) return invalid();
        const reserved = this.requests.get(value.requestId);
        if (reserved === undefined) return invalid();
        const raw = closed(value.usage, ["input", "output", "cacheRead", "cacheWrite"]);
        if (!Object.values(raw).every(nonNegative)) return invalid();
        const usage = raw as Usage;
        // Subtraction checks reject overflow before summing cache and prompt usage.
        let remaining = this.config.contextWindow;
        for (const tokens of [usage.input, usage.cacheRead, usage.cacheWrite]) {
          if (tokens > remaining) return invalid();
          remaining -= tokens;
        }
        if (usage.output > reserved) return invalid();
        return { requestId: value.requestId, usage, input: this.config.contextWindow - remaining };
      });
      const reserved = this.requests.get(requestId)!;
      await this.append({ type: "request_settled", requestId, usage });
      this.inputUsed += input;
      this.outputUsed += usage.output;
      this.inputReserved -= this.config.contextWindow;
      this.outputReserved -= reserved;
      this.requests.delete(requestId);
      return {};
    });
  }

  uncertain(params: unknown): Promise<{}> {
    const closedBeforeReport = this.uncertainty || this.terminal !== undefined || !this.initialized;
    this.latchUncertainty();
    return this.serialize(async () => {
      let valid = !closedBeforeReport;
      try {
        const value = closed(params, ["requestId"]);
        if (!identifier(value.requestId) || !this.requests.has(value.requestId)) invalid();
      } catch { valid = false; }
      await this.fenceInternal();
      if (!valid) throw this.failureValue!;
      return {};
    });
  }

  startTool(callId: string): Promise<void> {
    return this.serialize(async () => {
      await this.assertOpen();
      await this.validate(() => {
        if (!identifier(callId) || this.toolIds.has(callId)) invalid();
      });
      const at = this.timestamp();
      this.checkAdmission(at);
      if (this.toolIds.size >= this.config.operationalBudget.maxToolCalls) throw this.exceeded();
      this.toolIds.add(callId);
      this.tools.add(callId);
      await this.append({ type: "tool_started", callId }, at);
    });
  }

  settleTool(callId: string): Promise<void> {
    return this.serialize(async () => {
      await this.assertOpen();
      await this.validate(() => {
        if (!identifier(callId) || !this.tools.has(callId)) invalid();
      });
      await this.append({ type: "tool_settled", callId });
      this.tools.delete(callId);
    });
  }

  fence(_message?: string): Promise<void> {
    // Caller text can contain credentials or tool arguments; persist only a generic fence.
    this.latchUncertainty();
    return this.serialize(() => this.fenceInternal());
  }

  finish(): Promise<void> {
    return this.serialize(async () => {
      if (this.uncertainty) throw this.failureValue!;
      if (this.terminal === "settled") return;
      await this.assertOpen();
      if (this.requests.size || this.tools.size) {
        await this.fenceInternal();
        throw this.failureValue!;
      }
      await this.append({ type: "settled", providerSettled: true, toolsSettled: true });
      this.terminal = "settled";
    });
  }

  async drain(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.queue;
      await pending;
    } while (pending !== this.queue);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    this.queued++;
    const result = this.queue.then(operation);
    this.queue = result.then(() => { this.queued--; }, () => { this.queued--; });
    return result;
  }

  private timestamp(): number {
    return Math.max(this.entries.at(-1)?.at ?? this.admittedAt, Date.now(), 0);
  }

  private exceeded(): Error {
    this.failureValue ??= budgetError("DSH_BUDGET_EXCEEDED", "Operational budget exhausted.");
    return this.failureValue;
  }

  private checkAdmission(at: number): void {
    if (this.failureValue) throw this.failureValue;
    if (at - this.admittedAt >= this.config.operationalBudget.maxDurationMs) throw this.exceeded();
  }

  private async assertOpen(): Promise<void> {
    if (this.uncertainty) throw this.failureValue!;
    if (this.terminal === "settled" || !this.initialized) {
      await this.fenceInternal();
      throw this.failureValue!;
    }
  }

  private async validate<T>(read: () => T): Promise<T> {
    try {
      return read();
    } catch {
      await this.fenceInternal();
      throw this.failureValue!;
    }
  }

  private async writeBoth(name: string, value: unknown): Promise<void> {
    const results = await Promise.allSettled([
      writeDurableJson(join(this.history, name), value),
      writeDurableJson(join(this.directory, name), value),
    ]);
    if (results.some((result) => result.status === "rejected")) {
      throw budgetError("DSH_BUDGET_UNCERTAIN", "Budget evidence could not be persisted.");
    }
  }

  private writeLedger(): Promise<void> {
    const { runId, sessionKey, agentId } = this.config;
    return this.writeBoth(LEDGER_FILE, {
      version: 1, runId, sessionKey, agentId, configSha256: this.configSha256, entries: this.entries,
    });
  }

  private async append(event: Event, at = this.timestamp()): Promise<void> {
    this.entries.push({ ...event, seq: this.entries.length, at });
    try {
      await this.writeLedger();
    } catch {
      this.persistenceFailed = true;
      // An unacknowledged final settlement must become a fence, not precede one.
      if (event.type === "settled") this.entries.pop();
      await this.fenceInternal();
      throw this.failureValue!;
    }
    if (this.uncertainty) throw this.failureValue!;
  }

  private latchUncertainty(): void {
    if (!this.uncertainty) {
      this.uncertainty = true;
      this.failureValue = budgetError("DSH_BUDGET_UNCERTAIN", "Operational budget settlement is uncertain.");
    }
  }

  private async fenceInternal(): Promise<void> {
    this.latchUncertainty();
    if (this.entries.at(-1)?.type === "settled") {
      // A later binding/ownership failure supersedes, rather than follows, the terminal proof.
      this.entries.pop();
      this.terminal = undefined;
    }
    if (!this.terminal) {
      this.terminal = "fenced";
      this.entries.push({ type: "fenced", seq: this.entries.length, at: this.timestamp() });
      if (this.historyOwned) {
        try {
          await this.writeLedger();
        } catch {
          this.persistenceFailed = true;
        }
      }
    }
    if (this.persistenceFailed) throw this.failureValue!;
  }
}
