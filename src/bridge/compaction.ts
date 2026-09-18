import type { Context } from "@deepseek-ai/cordis";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";

export default class OpenClawNativeCompaction extends BasicCompactionEngine {
  static override inject = BasicCompactionEngine.inject;
  static override Config = BasicCompactionEngine.Config;

  constructor(ctx: Context, config?: ConstructorParameters<typeof BasicCompactionEngine>[1]) {
    super(ctx, { auto: false, ...config });
  }

  protected override summarize(
    input: Parameters<BasicCompactionEngine["summarize"]>[0],
    agent: Parameters<BasicCompactionEngine["summarize"]>[1],
    signal?: AbortSignal,
  ): ReturnType<BasicCompactionEngine["summarize"]> {
    return super.summarize({ ...input, tools: [] }, agent, signal);
  }
}
