import { record } from "./validation.js";

export interface BudgetUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function counter(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Missing or invalid raw provider usage counter");
  }
  return value;
}

function usage(value: unknown, responses: boolean): BudgetUsage {
  const raw = record(value, "raw provider usage");
  const input = counter(responses ? raw.input_tokens : raw.prompt_tokens);
  const output = counter(responses ? raw.output_tokens : raw.completion_tokens);
  const detailsValue = responses ? raw.input_tokens_details : raw.prompt_tokens_details;
  const details = detailsValue === undefined ? {} : record(detailsValue, "input token details");
  // Require an explicit cache-read count: never guess uncached input from a missing counter.
  const cacheRead = counter(responses ? details.cached_tokens : (details.cached_tokens ?? raw.prompt_cache_hit_tokens));
  const cacheWrite = responses && details.cache_write_tokens !== undefined ? counter(details.cache_write_tokens) : 0;
  if (raw.prompt_cache_hit_tokens !== undefined && counter(raw.prompt_cache_hit_tokens) !== cacheRead) {
    throw new Error("Conflicting cache-read counters");
  }
  const uncached = input - cacheRead - cacheWrite;
  if (!Number.isSafeInteger(uncached) || uncached < 0 ||
      (raw.prompt_cache_miss_tokens !== undefined && counter(raw.prompt_cache_miss_tokens) !== uncached)) {
    throw new Error("Invalid disjoint input usage");
  }
  const total = input + output;
  if (!Number.isSafeInteger(total) || (raw.total_tokens !== undefined && counter(raw.total_tokens) !== total)) {
    throw new Error("Inconsistent raw total usage");
  }
  const outputDetailsValue = responses ? raw.output_tokens_details : raw.completion_tokens_details;
  if (outputDetailsValue !== undefined) {
    const outputDetails = record(outputDetailsValue, "output token details");
    if (outputDetails.reasoning_tokens !== undefined && counter(outputDetails.reasoning_tokens) > output) {
      throw new Error("Invalid reasoning token usage");
    }
  }
  return { input: uncached, output, cacheRead, cacheWrite };
}

/**
 * Validate wire SSE, not DSH/pi usage (which may synthesize zeros). Called only
 * after the actual response body reaches EOF. No incremental usage is summed.
 */
export function terminalBudgetUsage(text: string, responses: boolean): BudgetUsage {
  const frames = text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").split("\n\n");
  if (frames.pop()?.trim()) throw new Error("Truncated provider SSE frame");
  let terminal = false;
  let done = false;
  let finished = false;
  let result: BudgetUsage | undefined;
  for (const frame of frames) {
    const lines = frame.split("\n");
    if (lines.some((line) => line.startsWith("event:") &&
        ["error", "response.failed"].includes(line.slice(6).trim()))) throw new Error("Failed provider SSE event");
    const data = lines.filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, "")).join("\n");
    if (!data) continue;
    if (data === "[DONE]") {
      if (done || (responses ? !terminal : !finished) || !result) throw new Error("Provider ended without complete terminal usage");
      terminal = true;
      done = true;
      continue;
    }
    if (terminal) throw new Error("Provider data after terminal SSE event");
    const event = record(JSON.parse(data), "provider SSE event");
    if (event.error !== undefined || event.type === "error" || event.type === "response.failed") {
      throw new Error("Failed provider SSE response");
    }
    if (responses) {
      if (event.type === "response.completed" || event.type === "response.incomplete") {
        const response = record(event.response, "terminal response");
        // A max-output terminal with complete final counters is known billed work,
        // just like DeepSeek's length finish; other incomplete responses are not.
        if (response.error != null ||
            (event.type === "response.completed" ? response.status !== "completed" :
              response.status !== "incomplete" ||
              record(response.incomplete_details, "incomplete details").reason !== "max_output_tokens")) {
          throw new Error("Unsuccessful terminal provider response");
        }
        result = usage(response.usage, true);
        terminal = true;
      }
    } else {
      if (!Array.isArray(event.choices) || event.choices.length > 1) throw new Error("Unsupported provider choices");
      for (const value of event.choices) {
        const choice = record(value, "provider choice");
        if (choice.index !== 0 || finished) throw new Error("Invalid provider choice lifecycle");
        if (choice.finish_reason != null) {
          if (!["stop", "length", "tool_calls"].includes(String(choice.finish_reason))) {
            throw new Error("Unsuccessful provider finish");
          }
          finished = true;
        }
      }
      if (event.usage != null) {
        if (!finished) throw new Error("Provider usage preceded terminal choice");
        const next = usage(event.usage, false);
        if (result && Object.keys(next).some((key) => result![key as keyof BudgetUsage] !== next[key as keyof BudgetUsage])) {
          throw new Error("Conflicting terminal provider usage");
        }
        result = next;
      }
    }
  }
  if (!terminal || !result) throw new Error("Missing terminal provider usage");
  return result;
}
