import type { Context, Events } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { BridgeEvent, BridgeResult, BridgeUsage } from "../protocol.js";

type ChunkEvent = SessionEvent<"assistant/chunk">;
type MessageEvent = SessionEvent<"assistant/message">;
type Finish = Extract<ChunkEvent["data"]["chunk"], { type: "finish" }>["reason"];
type EndReason = SessionEvent<"turn/end">["data"]["reason"];
type AgentError = Parameters<Events["agent/error"]>[0];

interface Attempt {
  seqs: number[];
  text: string;
  reasoning: string;
  blocks: Map<number, { type: "text" | "reasoning"; text: string }>;
  closedBlocks: Set<number>;
  finish?: Finish;
}

interface Step {
  internal: boolean;
  attempt?: Attempt;
  message?: MessageEvent;
  failure?: Error;
  ended: boolean;
}

export interface TurnTrackerOptions {
  isInternalStep?: (turn: number, step: number) => boolean;
}

interface Turn {
  id: number;
  steps: Map<number, Step>;
  end?: EndReason;
  lastMessage?: MessageEvent;
}

function failure(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(typeof error === "string" ? error : "DSH agent failed", { cause: error });
}

function output(message: MessageEvent): { text: string; reasoning: string } {
  let text = "";
  let reasoning = "";
  for (const block of message.data.message.content) {
    if (block.type === "text") text += block.text;
    if (block.type === "reasoning") reasoning += block.text;
  }
  return { text, reasoning };
}

/**
 * One bridge run, attached to an idle Agent.ctx (including create/resume setup)
 * BEFORE followup/send. Only new live events are observed; history is never replayed.
 *
 * alpha.2 has no agent/assistant-stream augmentation: the loop publishes live
 * assistant/chunk through the post-commit session/event feed.
 */
export class TurnTracker {
  private readonly agent: Agent;
  private readonly emit: (event: BridgeEvent) => void;
  private readonly options: TurnTrackerOptions;
  private readonly listeners: (() => void)[];
  private readonly turns: Turn[] = [];
  private readonly usage: BridgeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private lastSeq: number;
  private error?: Error;
  private text = "";
  private reasoning = "";
  private committedText = "";
  private committedReasoning = "";

  constructor(ctx: Context, emit: (event: BridgeEvent) => void, options: TurnTrackerOptions = {}) {
    const agent = ctx.agent;
    if (!agent) throw new Error("TurnTracker requires an agent-scoped Context");
    if (agent.status !== "idle") throw new Error("Attach TurnTracker before followup/send");
    this.agent = agent;
    this.emit = emit;
    this.options = options;
    this.lastSeq = agent.session.events.length - 1;
    this.listeners = [
      ctx.on("session/event", (session, event) => {
        if (session !== this.agent.session || event.seq <= this.lastSeq) return;
        this.lastSeq = event.seq;
        this.observe(event);
      }),
      ctx.on("agent/status", ({ agent: subject, status }) => {
        if (subject === this.agent) this.publish({ type: "status", status });
      }),
      ctx.on("agent/error", (event) => this.agentError(event)),
    ];
  }

  /** Detach only this tracker; does not cancel or dispose its agent. Idempotent. */
  dispose(): void {
    for (const off of this.listeners.splice(0)) off();
  }

  /** Allow a safety gate to reject invalid raw output before dispatching tools. */
  assertHealthy(): void {
    if (this.error) throw this.error;
  }

  private fail(message: string): void {
    this.error ??= new Error(message);
  }

  private publish(event: BridgeEvent): void {
    if (this.error) return;
    try {
      this.emit(event);
    } catch (error) {
      // Session observers are contained by DSH; preserve delivery failures for result().
      this.error ??= failure(error);
    }
  }

  private agentError(event: AgentError): void {
    if (event.agent === this.agent) this.error ??= failure(event.error);
  }

  private turn(id: number): Turn | undefined {
    const turn = this.turns.at(-1);
    if (!turn || turn.id !== id || turn.end) {
      this.fail("DSH event outside its live turn");
      return;
    }
    return turn;
  }

  private step(turn: Turn, id: number): Step | undefined {
    const step = turn.steps.get(id);
    if (!step || step.ended) {
      this.fail("DSH event outside its live step");
      return;
    }
    return step;
  }

  private observe(event: SessionEvent): void {
    switch (event.type) {
      case "turn/start": {
        const previous = this.turns.at(-1);
        if (previous && (!previous.end || previous.id >= event.data.turn)) {
          this.fail("DSH opened an overlapping or repeated turn");
          return;
        }
        this.turns.push({ id: event.data.turn, steps: new Map() });
        return;
      }
      case "step/start": {
        const turn = this.turn(event.data.turn);
        if (!turn) return;
        if (turn.steps.has(event.data.step) || [...turn.steps.values()].some((step) => !step.ended)) {
          this.fail("DSH opened an overlapping or repeated step");
          return;
        }
        try {
          turn.steps.set(event.data.step, {
            ended: false, internal: this.options.isInternalStep?.(event.data.turn, event.data.step) ?? false,
          });
        } catch (error) {
          this.error ??= failure(error);
        }
        return;
      }
      case "assistant/chunk": {
        const turn = this.turn(event.data.turn);
        const step = turn && this.step(turn, event.data.step);
        if (step) this.chunk(step, event);
        return;
      }
      case "assistant/message": {
        const turn = this.turn(event.data.turn);
        const step = turn && this.step(turn, event.data.step);
        if (turn && step) this.commit(turn, step, event);
        return;
      }
      case "step/end": {
        const turn = this.turn(event.data.turn);
        const step = turn && this.step(turn, event.data.step);
        if (step) step.ended = true;
        return;
      }
      case "turn/end": {
        const turn = this.turn(event.data.turn);
        if (!turn) return;
        turn.end = event.data.reason;
        if (event.data.reason.kind === "error") {
          this.fail(event.data.reason.error.message);
        }
        return;
      }
    }
  }

  private delta(type: "text" | "reasoning", text: string): void {
    if (!text) return;
    if (type === "text") this.text += text;
    else this.reasoning += text;
    this.publish({ type, text });
  }

  private chunk(step: Step, event: ChunkEvent): void {
    if (step.message) {
      this.fail("DSH streamed after committing its assistant response");
      return;
    }
    let attempt = step.attempt;
    if (attempt?.finish) {
      if (attempt.finish.kind !== "error" && attempt.finish.kind !== "aborted") {
        this.fail("DSH streamed after a successful terminal finish");
        return;
      }
      // Retry attempts share turn/step and restart block indexes. Only a failed
      // terminal finish permits a new attempt; message source seqs verify identity.
      attempt = undefined;
    }
    if (!attempt) {
      attempt = { seqs: [], text: "", reasoning: "", blocks: new Map(), closedBlocks: new Set() };
      step.attempt = attempt;
    }
    attempt.seqs.push(event.seq);
    const chunk = event.data.chunk;
    switch (chunk.type) {
      case "text-delta":
      case "reasoning-delta": {
        if (attempt.closedBlocks.has(chunk.index)) return;
        const type = chunk.type === "text-delta" ? "text" : "reasoning";
        const block = attempt.blocks.get(chunk.index);
        if (block && block.type !== type) {
          this.fail("DSH changed the type of a streamed block");
          return;
        }
        attempt.blocks.set(chunk.index, { type, text: (block?.text ?? "") + chunk.text });
        attempt[type] += chunk.text;
        if (!step.internal) this.delta(type, chunk.text);
        return;
      }
      case "block-end": {
        if (attempt.closedBlocks.has(chunk.index)) return;
        attempt.closedBlocks.add(chunk.index);
        const { block } = chunk;
        const previous = attempt.blocks.get(chunk.index);
        if (previous && previous.type !== block.type) {
          this.fail("DSH changed the type of a streamed block");
          return;
        }
        if (block.type === "text" || block.type === "reasoning") {
          const prefix = previous?.text ?? "";
          if (!block.text.startsWith(prefix)) {
            this.fail("DSH closed block output differs from emitted deltas");
            return;
          }
          const suffix = block.text.slice(prefix.length);
          attempt[block.type] += suffix;
          if (!step.internal) this.delta(block.type, suffix);
        }
        return;
      }
      case "finish":
        attempt.finish = chunk.reason;
        if (chunk.reason.kind === "error" || chunk.reason.kind === "aborted") {
          step.failure = new Error(chunk.reason.failure.message);
          if (attempt.text || attempt.reasoning) {
            this.fail(`DSH abandoned streamed output; bridge deltas cannot be retracted: ${chunk.reason.failure.message}`);
          }
        }
        return;
    }
  }

  private commit(turn: Turn, step: Step, event: MessageEvent): void {
    if (step.message) {
      this.fail("DSH committed more than one assistant response for a step");
      return;
    }
    step.message = event;
    turn.lastMessage = event;
    const attempt = step.attempt;
    const sources = event.sourceEventSeqs;
    if (
      !attempt || !sources || sources.length !== attempt.seqs.length ||
      !sources.every((seq, index) => seq === attempt.seqs[index])
    ) {
      this.fail("DSH committed output from an absent or different stream attempt");
      return;
    }
    const final = output(event);
    if (event.data.interrupted) {
      // Cancellation may drop whitespace-only blocks. The aborted result keeps
      // exactly the already delivered prefix, never disguising it as completion.
      return;
    }
    if (!attempt.finish) {
      // BlockAssembler defaults missing finish to stop; that is not completion proof.
      this.fail("DSH assistant stream ended without a terminal finish");
      return;
    }
    if (!["stop", "tool-calls", "max-tokens"].includes(attempt.finish.kind)) {
      this.fail("DSH committed an unsuccessful assistant stream");
      return;
    }
    if (!final.text.startsWith(attempt.text) || !final.reasoning.startsWith(attempt.reasoning)) {
      this.fail("DSH committed assistant output differs from emitted deltas");
      return;
    }
    if (!step.internal) {
      this.delta("text", final.text.slice(attempt.text.length));
      this.delta("reasoning", final.reasoning.slice(attempt.reasoning.length));
      this.committedText += final.text;
      this.committedReasoning += final.reasoning;
    }
    step.failure = undefined;
    const usage = event.data.usage;
    // DSH inputTokens is already uncached; cache counters are disjoint.
    const reported: BridgeUsage = {
      input: usage?.inputTokens ?? 0,
      output: usage?.outputTokens ?? 0,
      cacheRead: usage?.cacheReadTokens ?? 0,
      cacheWrite: usage?.cacheWriteTokens ?? 0,
    };
    this.usage.input += reported.input;
    this.usage.output += reported.output;
    this.usage.cacheRead += reported.cacheRead;
    this.usage.cacheWrite += reported.cacheWrite;
    this.publish({ type: "usage", usage: reported });
  }

  /**
   * Call after await agent.whenIdle(); await ctx.sessions.flush(agent.session).
   * Flush failures must propagate; whenIdle alone contains driver failures.
   *
   * Text/reasoning concatenate every committed tool-loop response, without
   * separators, matching the live per-channel deltas rather than only the last
   * response. Cancellation returns the delivered prefix (possibly empty).
   */
  result(sessionId: string, cancelled: boolean, toolCalls: number): BridgeResult {
    if (sessionId !== this.agent.id) throw new Error("TurnTracker session identity mismatch");
    if (!Number.isSafeInteger(toolCalls) || toolCalls < 0) throw new Error("Invalid tool call count");
    if (this.agent.status !== "idle") throw new Error("Await agent.whenIdle() before result()");
    if (this.error) throw this.error;
    if (!this.turns.length && !cancelled) throw new Error("DSH has no live turn completion");
    let aborted = cancelled;
    let length = false;
    for (const turn of this.turns) {
      if (!turn.end) throw new Error("DSH turn has no committed turn/end");
      if ([...turn.steps.values()].some((step) => !step.ended)) {
        throw new Error("DSH turn ended with an open step");
      }
      // Cancellation during request-error/retry must not hide an unrecovered
      // provider failure. Only a successfully committed retry clears it.
      for (const step of turn.steps.values()) {
        if (step.failure) throw step.failure;
      }
      if (turn.end.kind === "aborted") {
        aborted = true;
        continue;
      }
      if (turn.end.kind !== "completed" && turn.end.kind !== "max-tokens") {
        throw new Error(`DSH turn did not complete: ${turn.end.kind}`);
      }
      for (const step of turn.steps.values()) {
        if (!step.message || step.message.data.interrupted) {
          throw new Error("DSH step has no completed, committed assistant output");
        }
        length ||= step.attempt?.finish?.kind === "max-tokens";
      }
      const last = turn.lastMessage && !turn.steps.get(turn.lastMessage.data.step)?.internal && output(turn.lastMessage);
      if (!last || (!last.text.trim() && !last.reasoning.trim())) {
        throw new Error("DSH turn has no committed final assistant output");
      }
      length ||= turn.end.kind === "max-tokens";
    }
    if (!aborted && (this.text !== this.committedText || this.reasoning !== this.committedReasoning)) {
      throw new Error("DSH left uncommitted streamed output");
    }
    return {
      text: this.text,
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
      usage: { ...this.usage },
      stopReason: aborted ? "aborted" : length ? "length" : "stop",
      sessionId,
      toolCalls,
    };
  }
}
