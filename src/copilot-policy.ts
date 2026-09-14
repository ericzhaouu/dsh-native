import { isRecord } from "./protocol.js";

export const COPILOT_ENDPOINTS: readonly string[] = [
  "https://api.individual.githubcopilot.com",
  "https://api.business.githubcopilot.com",
  "https://api.enterprise.githubcopilot.com",
  "https://api.githubcopilot.com",
] as const;

const HEADER_NAMES = new Map([
  ["accept-encoding", "Accept-Encoding"],
  ["editor-version", "Editor-Version"],
  ["editor-plugin-version", "Editor-Plugin-Version"],
  ["user-agent", "User-Agent"],
  ["openai-organization", "Openai-Organization"],
  ["copilot-integration-id", "Copilot-Integration-Id"],
]);

/** Only non-secret request identity can enter an on-disk DSH profile. */
export function copilotHeaders(...layers: unknown[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const layer of layers) {
    if (layer === undefined) continue;
    if (!isRecord(layer)) throw new Error("Copilot request headers must be a plain record.");
    const seen = new Set<string>();
    for (const [name, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      const canonical = HEADER_NAMES.get(name.toLowerCase());
      if (!canonical) throw new Error(`Unsupported Copilot header: ${name}`);
      if (seen.has(canonical)) throw new Error(`Ambiguous Copilot header: ${canonical}`);
      if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/u.test(value)) {
        throw new Error(`Invalid Copilot header: ${canonical}`);
      }
      if (/(?:github_pat_|gh[pousr]_|sk-)[A-Za-z0-9_]{8,}|bearer\s/i.test(value)) {
        throw new Error("Credential-shaped data is not allowed in Copilot identity headers.");
      }
      seen.add(canonical);
      result[canonical] = value;
    }
  }
  return result;
}
