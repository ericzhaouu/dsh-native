import { isDeepStrictEqual } from "node:util";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

const CANONICAL = new Set([
  "message", "thinking_level_change", "model_change", "compaction", "reset",
  "branch_summary", "custom", "custom_message", "label", "session_info",
]);

type Node = {
  id: string;
  parentId: string | null;
  leafId?: string | null;
  appendParentId: string | null;
  event: Record<string, unknown>;
};

export type ActiveResetBoundary =
  | { kind: "none" }
  | { kind: "clear"; resetId: string; signature: string; stateId: string; assistantKeyPrefix: string; messageIds: Set<string> };

type VisibleMessage = { entryId: string; parentId: string | null; message: unknown };

function validateBoundaryEvent(event: Record<string, unknown>): void {
  if (event.type !== "reset" && event.type !== "compaction") return;
  if (!nonblank(event.id) || event.parentId !== null && !nonblank(event.parentId)) {
    throw new Error(`malformed ${String(event.type)} transcript boundary`);
  }
  const context = event.context;
  if (context !== undefined && context !== "clear" && context !== "preserve-tail") {
    throw new Error(`unsupported ${String(event.type)} boundary context`);
  }
  if (Object.hasOwn(event, "firstKeptEntryId") && !nonblank(event.firstKeptEntryId)) {
    throw new Error(`malformed retained-tail ${String(event.type)} boundary`);
  }
}

function parseTreeEntry(event: Record<string, unknown>, leafId: string | null): Omit<Node, "event"> | undefined {
  const id = nonblank(event.id) ? event.id : undefined;
  if (!id) return undefined;
  if (event.type === "leaf") {
    if (!Object.hasOwn(event, "parentId")) return undefined;
    const targetId = event.targetId === null ? null : nonblank(event.targetId) ? event.targetId : undefined;
    const appendParentId = event.appendParentId === undefined ? targetId :
      event.appendParentId === null ? null : nonblank(event.appendParentId) ? event.appendParentId : undefined;
    if (targetId === undefined || appendParentId === undefined) return undefined;
    return { id, parentId: targetId, leafId: targetId, appendParentId };
  }
  if (!CANONICAL.has(String(event.type))) return undefined;
  const parentId = event.parentId === undefined ? leafId :
    event.parentId === null ? null : nonblank(event.parentId) ? event.parentId : undefined;
  if (parentId === undefined) return undefined;
  return { id, parentId, leafId: event.appendMode === "side" ? undefined : id, appendParentId: id };
}

function activePath(byId: Map<string, Node>, leafId: string | null): Node[] {
  const path: Node[] = [];
  const seen = new Set<string>();
  let currentId: string | null | undefined = leafId;
  while (currentId) {
    if (seen.has(currentId)) throw new Error("cyclic active transcript branch");
    seen.add(currentId);
    const current = byId.get(currentId);
    if (!current) throw new Error("dangling active transcript branch");
    if (current.event.type !== "leaf") path.push(current);
    currentId = current.parentId;
  }
  return path.reverse();
}

export function resolveActiveResetBoundary(
  rawEvents: unknown[],
  canonicalSessionId: string,
  visibleMessages?: readonly VisibleMessage[],
): ActiveResetBoundary {
  const byId = new Map<string, Node>();
  let leafId: string | null = null;
  for (const event of rawEvents) {
    if (!record(event)) continue;
    validateBoundaryEvent(event);
    const parsed = parseTreeEntry(event, leafId);
    if (!parsed) {
      if (event.type === "leaf" || CANONICAL.has(String(event.type))) {
        throw new Error("malformed transcript tree entry");
      }
      continue;
    }
    if (byId.has(parsed.id)) throw new Error("duplicate transcript tree identity");
    const node = { ...parsed, event };
    byId.set(node.id, node);
    if (parsed.leafId !== undefined) leafId = parsed.leafId;
  }
  const path = activePath(byId, leafId);
  const resetIndex = path.findLastIndex((node) => node.event.type === "reset");
  const contextPath = path.slice(resetIndex + 1);
  if (contextPath.some((node) => node.event.type === "compaction")) {
    throw new Error("unsupported active compaction boundary; start a fresh session with /new");
  }
  if (contextPath.some((node) => node.event.type === "branch_summary")) {
    throw new Error("unsupported active branch summary; start a fresh session with /new");
  }
  if (resetIndex < 0) return { kind: "none" };
  // The two public reads must describe the same branch, including the admitted user.
  if (visibleMessages !== undefined) {
    const expected = path.filter((node) => node.event.type === "message").map((node) => ({
      entryId: node.id, parentId: node.parentId, message: node.event.message,
    }));
    const actual = visibleMessages.map(({ entryId, parentId, message }) => ({ entryId, parentId, message }));
    if (!isDeepStrictEqual(actual, expected)) {
      throw new Error("reset boundary does not match the scoped visible transcript projection");
    }
  }
  const reset = path[resetIndex]!;
  const context = reset.event.context;
  if (context !== undefined && context !== "clear" && context !== "preserve-tail") {
    throw new Error("unsupported reset boundary context");
  }
  if (context === "preserve-tail" || typeof reset.event.firstKeptEntryId === "string") {
    throw new Error("unsupported retained-tail reset boundary; start a fresh session with /new");
  }
  if (context !== undefined && context !== "clear") throw new Error("unsupported reset boundary context");
  const messageIds = new Set<string>();
  for (const node of contextPath) {
    if (node.event.type === "message" && record(node.event.message)) messageIds.add(node.id);
  }
  return {
    kind: "clear",
    resetId: reset.id,
    signature: JSON.stringify(reset.event),
    stateId: `${canonicalSessionId}\0reset\0${reset.id}`,
    assistantKeyPrefix: `dsh-native:reset:${reset.id}:`,
    messageIds,
  };
}
