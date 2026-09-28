import { createHash } from "node:crypto";
import { parseToolAllowlist, resolvePreparationPolicy, type PreparationPolicy } from "./preparation.js";
import type { DshConfig } from "./runtime-types.js";

export type BitableOperation = "get_record" | "update_record";
export interface BitablePolicy {
  source: { kind: "plugin"; pluginId: string };
  accountId: string;
  groupId: string;
  appToken: string;
  tableId: string;
  recordIds: string[];
  fields: Record<string, "string" | "number" | "boolean">;
  operations: BitableOperation[];
  maxBatchSize: 1;
}

const reserved = new Set(["__proto__", "prototype", "constructor"]);
export const exactAgentId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value) && !reserved.has(value);

export function toolPolicyDenied(): never {
  throw new Error("DSH tool scope denied or unverifiable.");
}

export function policyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return toolPolicyDenied();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || reserved.has(key) || !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, "value")) return toolPolicyDenied();
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: unknown, keys: string[]): Record<string, unknown> {
  const input = policyRecord(value);
  if (Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key))) toolPolicyDenied();
  return input;
}

function exactString(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value) || reserved.has(value)) toolPolicyDenied();
  return value;
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length < 1 || value.length > 64 || Reflect.ownKeys(value).length !== value.length + 1) toolPolicyDenied();
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) toolPolicyDenied();
    result.push(exactString(descriptor.value));
  }
  if (new Set(result).size !== result.length) toolPolicyDenied();
  return result;
}

function agentMap<T>(value: unknown, parse: (entry: unknown) => T): Record<string, T> {
  const input = policyRecord(value);
  const agents = Object.keys(input);
  if (agents.length > 64 || agents.some((agent) => !exactAgentId(agent))) toolPolicyDenied();
  return Object.fromEntries(agents.map((agent) => [agent, parse(input[agent])]));
}

export function parseToolAllowlistByAgent(value: unknown): Record<string, string[]> {
  return agentMap(value, (entry) => {
    const tools = parseToolAllowlist(entry);
    if (tools.some((name) => reserved.has(name))) toolPolicyDenied();
    return tools;
  });
}

export function parseBitablePolicy(value: unknown): BitablePolicy {
  const input = exactKeys(value, ["source", "accountId", "groupId", "appToken", "tableId", "recordIds",
    "fields", "operations", "maxBatchSize"]);
  const source = exactKeys(input.source, ["kind", "pluginId"]);
  if (source.kind !== "plugin" || input.maxBatchSize !== 1) toolPolicyDenied();
  const fields = policyRecord(input.fields);
  if (!Object.keys(fields).length || Object.keys(fields).length > 64 ||
      Object.entries(fields).some(([name, type]) => name.trim() !== name || !name.length || name.length > 128 ||
        /[\x00-\x1f\x7f]/u.test(name) || /^fld/i.test(name) ||
        type !== "string" && type !== "number" && type !== "boolean")) toolPolicyDenied();
  const operations = uniqueStrings(input.operations);
  if (operations.some((op) => op !== "get_record" && op !== "update_record")) toolPolicyDenied();
  return {
    source: { kind: "plugin", pluginId: exactString(source.pluginId) },
    accountId: exactString(input.accountId), groupId: exactString(input.groupId),
    appToken: exactString(input.appToken), tableId: exactString(input.tableId),
    recordIds: uniqueStrings(input.recordIds),
    fields: { ...fields } as BitablePolicy["fields"],
    operations: operations as BitableOperation[], maxBatchSize: 1,
  };
}

export function parseBitablePolicyByAgent(value: unknown): Record<string, BitablePolicy> {
  return agentMap(value, parseBitablePolicy);
}

export function bitableToolNames(policy: BitablePolicy): string[] {
  return policy.operations.map((operation) => `feishu_bitable_${operation}`);
}

export function hasAgentToolPolicy(config: DshConfig): boolean {
  return Object.keys(config.toolAllowlistByAgent ?? {}).length > 0 || Object.keys(config.bitablePolicyByAgent ?? {}).length > 0;
}

export function resolveAgentToolPolicy(config: DshConfig, agentId?: string): {
  toolAllowlist: string[] | undefined;
  preparationPolicy: PreparationPolicy | undefined;
  bitablePolicy: BitablePolicy | undefined;
  fingerprint: string | undefined;
} {
  const overrides = config.toolAllowlistByAgent === undefined ? undefined : parseToolAllowlistByAgent(config.toolAllowlistByAgent);
  const resources = config.bitablePolicyByAgent === undefined ? undefined : parseBitablePolicyByAgent(config.bitablePolicyByAgent);
  if ((Object.keys(overrides ?? {}).length || Object.keys(resources ?? {}).length) && !exactAgentId(agentId)) toolPolicyDenied();
  const selected = !!agentId && !!overrides && Object.hasOwn(overrides, agentId);
  const toolAllowlist = selected ? overrides![agentId!]! : config.toolAllowlist;
  const bitablePolicy = agentId && resources && Object.hasOwn(resources, agentId) ? resources[agentId] : undefined;
  if (selected && !bitablePolicy && toolAllowlist!.some((name) => name.startsWith("feishu_bitable_"))) toolPolicyDenied();
  if (bitablePolicy && (!selected || toolAllowlist!.some((name) => !bitableToolNames(bitablePolicy).includes(name)))) {
    // No shell, filesystem, generic HTTP, alternate dispatcher or unscoped read path on this Agent.
    toolPolicyDenied();
  }
  let preparationPolicy = resolvePreparationPolicy(config.taskPreparation, agentId ?? "");
  if (preparationPolicy && selected) {
    preparationPolicy = { ...preparationPolicy, executionTools: config.taskPreparationExecutionToolsExplicit === false
      ? [...toolAllowlist!] : preparationPolicy.executionTools.filter((name) => toolAllowlist!.includes(name)) };
  }
  const fingerprint = selected || bitablePolicy ? createHash("sha256").update(JSON.stringify({
    agentId, tools: [...toolAllowlist!].sort(),
    preparation: preparationPolicy && { ...preparationPolicy,
      executionTools: [...preparationPolicy.executionTools].sort(), skillAllowlist: [...preparationPolicy.skillAllowlist].sort() },
    bitable: bitablePolicy && { ...bitablePolicy, recordIds: [...bitablePolicy.recordIds].sort(),
      operations: [...bitablePolicy.operations].sort(),
      fields: Object.fromEntries(Object.entries(bitablePolicy.fields).sort(([a], [b]) => a.localeCompare(b))) },
  })).digest("hex") : undefined;
  return { toolAllowlist: toolAllowlist === undefined ? undefined : [...toolAllowlist], preparationPolicy, bitablePolicy, fingerprint };
}
