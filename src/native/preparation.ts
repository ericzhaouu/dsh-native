import { parsePreparationResolution, type PreparationPolicy, type PreparationResolution } from "../preparation.js";

export interface PreparationGate {
  resolve(resolution: PreparationResolution): void;
  assertAllowed(name: string): void;
  start(name: string): void;
}

export function createPreparationGate(policy: PreparationPolicy): PreparationGate {
  let resolution: PreparationResolution | undefined;
  let started = 0;
  const ceiling = new Set(policy.executionTools);
  const assertAllowed = (name: string) => {
    if (!resolution || resolution.decision.mode !== "execute" ||
        !ceiling.has(name) || !resolution.allowedTools.includes(name)) {
      throw new Error(`Task preparation has not authorized host tool ${name} for this turn`);
    }
    if (started >= policy.maxToolCalls) throw new Error("Task preparation host tool-call budget exhausted");
  };
  return {
    resolve(value) {
      if (resolution) throw new Error("Task preparation decision cannot be replaced during an attempt");
      const next = parsePreparationResolution(value);
      if (next.allowedTools.some((name) => !ceiling.has(name)) ||
          next.decision.mode !== "execute" && next.allowedTools.length > 0) {
        throw new Error("Task preparation resolution exceeds the configured tool ceiling");
      }
      resolution = next;
    },
    assertAllowed,
    start(name) {
      assertAllowed(name);
      started++;
    },
  };
}

export function filterPreparationSkills(prompt: string | undefined, allowlist: readonly string[]): string | undefined {
  if (!prompt || allowlist.length === 0) return undefined;
  const allowed = new Set(allowlist);
  const skills = [...prompt.matchAll(/<skill>([\s\S]*?)<\/skill>/g)]
    .filter((match) => {
      const name = /<name>([^<]+)<\/name>/.exec(match[1] ?? "")?.[1];
      return name !== undefined && allowed.has(name);
    }).map((match) => match[0]);
  if (skills.length === 0) return undefined;
  return [
    "Only the following operator-selected skills are advertised for task execution.",
    "A listed skill is guidance, not permission. Check its dependencies against the currently supplied tools.",
    "Use only the tools actually supplied by the host. Do not bypass an unavailable capability through another tool.",
    "<available_skills>", ...skills, "</available_skills>",
  ].join("\n");
}
