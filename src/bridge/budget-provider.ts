import { createRequire, findPackageJSON } from "node:module";
import { isDeepStrictEqual } from "node:util";
import type { GenerateOptions } from "@deepseek-ai/dsh-llm";
import { budgetBaseUrl, type BridgeBudgetConfig } from "./budget-config.js";

function refuse(): never {
  throw Object.assign(new Error("DSH_BUDGET_UNCERTAIN: unaudited or changed provider transport"), {
    code: "DSH_BUDGET_UNCERTAIN",
  });
}

function version(name: string, expected: string, from = import.meta.url): string {
  const manifest = findPackageJSON(name, from);
  if (!manifest || createRequire(import.meta.url)(manifest).version !== expected) refuse();
  return manifest;
}

/**
 * alpha.2 has no public transport inspection API. Fail closed on its pinned
 * registration/profile layout rather than trusting a provider name to mean fetch.
 * Both admitted adapters create their transport after llm/stream begins:
 * DeepSeek request() calls global fetch; pi's Responses createClient() captures it.
 */
export async function auditBudgetProvider(llm: unknown, config: BridgeBudgetConfig): Promise<(options: GenerateOptions) => void> {
  const require = createRequire(import.meta.url);
  version("@deepseek-ai/dsh-llm", "0.1.2-alpha.2");
  const runtime = llm as { adapters?: Map<string, { adapter: object }> };
  const registrations = runtime.adapters;
  if (!(registrations instanceof Map) || registrations.size !== 1) refuse();
  const [route, registration] = [...registrations][0]!;
  const adapter = registration.adapter;
  let check: () => void;
  if (route === "deepseek-official") {
    version("@deepseek-ai/dsh-llm-deepseek", "0.1.2-alpha.2");
    const { DeepSeekAdapter } = await import("@deepseek-ai/dsh-llm-deepseek");
    if (Object.getPrototypeOf(adapter) !== DeepSeekAdapter.prototype) refuse();
    const inspected = adapter as unknown as { config: { options(): {
      baseURL: string; apiKeyEnv: string;
    } } };
    const connection = structuredClone(inspected.config.options());
    if (budgetBaseUrl(connection.baseURL) !== config.budgetBaseUrl || connection.apiKeyEnv !== "OPENCLAW_DSH_MODEL_KEY") refuse();
    check = () => { if (!isDeepStrictEqual(connection, inspected.config.options())) refuse(); };
  } else if (route === "github-copilot") {
    version("@deepseek-ai/dsh-llm-pi-ai", "0.1.2-alpha.2");
    const piManifest = version("@earendil-works/pi-ai", "0.84.4", require.resolve("@deepseek-ai/dsh-llm-pi-ai"));
    version("openai", "6.40.0", piManifest);
    const { PiAiAdapter } = await import("@deepseek-ai/dsh-llm-pi-ai");
    if (Object.getPrototypeOf(adapter) !== PiAiAdapter.prototype) refuse();
    const inspected = adapter as unknown as { current(): {
      profiles: Map<string, { api?: string; apiKeyEnv?: string; baseURL?: string; transport?: string }>;
      models: { getModels(provider: string): { api: string; baseUrl: string; input: string[] }[] };
    } };
    const snapshot = inspected.current();
    const profile = snapshot.profiles.get(route);
    if (snapshot.profiles.size !== 1 || !profile || profile.api !== "openai-responses" ||
        profile.apiKeyEnv !== "OPENCLAW_DSH_MODEL_KEY" ||
        budgetBaseUrl(profile.baseURL) !== config.budgetBaseUrl ||
        (profile.transport !== undefined && profile.transport !== "sse")) refuse();
    const models = snapshot.models.getModels(route);
    if (!models.length || models.some((model) => model.api !== "openai-responses" ||
        budgetBaseUrl(model.baseUrl) !== config.budgetBaseUrl || model.input.some((input) => input !== "text"))) refuse();
    check = () => { if (inspected.current() !== snapshot) refuse(); };
  } else {
    refuse();
  }
  return (options) => {
    if (runtime.adapters !== registrations || registrations.size !== 1 ||
        registrations.get(route) !== registration || registration.adapter !== adapter || options.provider !== route) refuse();
    check();
    // No media/file preparation, native sockets, WebSockets, auth discovery, or
    // unreviewed catalog APIs are admitted. Tool-result text is still supported.
    const content = (blocks: readonly { type: string; content?: unknown }[]): void => {
      for (const block of blocks) {
        if (!["text", "reasoning", "tool-call", "tool-result"].includes(block.type)) refuse();
        if (block.type === "tool-result") {
          if (!Array.isArray(block.content)) refuse();
          content(block.content);
        }
      }
    };
    for (const message of options.messages) content(message.content);
  };
}
