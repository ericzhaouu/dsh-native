import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { bitableToolNames, parseBitablePolicy, policyRecord, toolPolicyDenied, type BitablePolicy } from "../tool-policy.js";
import type { HostToolSourceSnapshot } from "./tool-bridge.js";

/**
 * Host-only seam, NOT an SDK claim or model argument. The host must attest both
 * the authenticated inbound turn and the account captured by this exact tool.
 * The stock adapter supplies no capability until that contract is verified.
 */
export interface BitableToolCapability {
  readonly tool: AnyAgentTool;
  readonly agentId: string;
  readonly accountId: string;
  readonly groupId: string;
  readonly channel: "feishu";
  readonly provenance: "external_user";
  readonly foreground: true;
  readonly runId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly contract: "feishu-bitable-record-v1";
  assertCurrent(): void;
}

export interface BitableScope {
  policy: BitablePolicy;
  capabilities?: readonly BitableToolCapability[];
}

export function createBitableGate(scope: BitableScope, identity: {
  agentId?: string; runId: string; sessionId: string;
}) {
  const policy = parseBitablePolicy(scope.policy);
  const capabilities = new Map((scope.capabilities ?? []).map((capability) => [capability.tool, {
    ...capability, assertCurrent: () => capability.assertCurrent(),
  }]));
  if (capabilities.size !== (scope.capabilities ?? []).length) toolPolicyDenied();
  const assertSource = (tool: AnyAgentTool, source: HostToolSourceSnapshot) => {
    const capability = capabilities.get(tool);
    source.assertUnchanged();
    if (!bitableToolNames(policy).includes(source.name) ||
        source.key !== JSON.stringify(["plugin", policy.source.pluginId, source.name]) ||
        !capability || !identity.agentId || capability.agentId !== identity.agentId ||
        capability.accountId !== policy.accountId || capability.groupId !== policy.groupId ||
        capability.channel !== "feishu" || capability.provenance !== "external_user" ||
        capability.foreground !== true || capability.runId !== identity.runId ||
        capability.sessionId !== identity.sessionId || typeof capability.requestId !== "string" ||
        !capability.requestId.trim() || capability.contract !== "feishu-bitable-record-v1") toolPolicyDenied();
    try { capability.assertCurrent(); } catch { toolPolicyDenied(); }
  };
  const validateFields = (value: unknown) => {
    const fields = policyRecord(value);
    if (!Object.keys(fields).length || Object.entries(fields).some(([name, value]) =>
      !Object.hasOwn(policy.fields, name) || typeof value !== policy.fields[name] ||
      typeof value === "number" && !Number.isFinite(value) ||
      typeof value === "string" && (value.length > 4096 || value.includes("\0")))) toolPolicyDenied();
    return fields;
  };
  return {
    admits(tool: AnyAgentTool, source: HostToolSourceSnapshot): boolean {
      try { assertSource(tool, source); return true; } catch { return false; }
    },
    assertCall(tool: AnyAgentTool, source: HostToolSourceSnapshot, value: unknown): void {
      assertSource(tool, source);
      const args = policyRecord(value);
      const update = source.name === "feishu_bitable_update_record";
      const keys = ["app_token", "table_id", "record_id", ...(update ? ["fields"] : [])];
      if (Object.keys(args).length !== keys.length || keys.some((key) => !Object.hasOwn(args, key)) ||
          args.app_token !== policy.appToken || args.table_id !== policy.tableId ||
          typeof args.record_id !== "string" || !policy.recordIds.includes(args.record_id)) toolPolicyDenied();
      if (update) validateFields(args.fields);
    },
    projectResult(result: unknown, value: unknown): { content: { type: "text"; text: string }[]; details: null } {
      // Never forward provider errors, additional records, metadata or arbitrary text.
      try {
        const args = policyRecord(value);
        const raw = policyRecord(result);
        if (raw.isError || !Array.isArray(raw.content) || raw.content.length !== 1) toolPolicyDenied();
        const block = policyRecord(raw.content[0]);
        if (block.type !== "text" || typeof block.text !== "string") toolPolicyDenied();
        const body = policyRecord(JSON.parse(block.text));
        const record = policyRecord(body.record);
        if (record.record_id !== args.record_id || !policy.recordIds.includes(String(record.record_id))) toolPolicyDenied();
        const fields = policyRecord(record.fields);
        const selected = Object.fromEntries(Object.entries(fields).filter(([name]) => Object.hasOwn(policy.fields, name)));
        if (Object.keys(selected).length) validateFields(selected);
        return { content: [{ type: "text", text: JSON.stringify({ record: { record_id: record.record_id, fields: selected } }) }], details: null };
      } catch { return toolPolicyDenied(); }
    },
  };
}
