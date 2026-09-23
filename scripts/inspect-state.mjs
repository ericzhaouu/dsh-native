import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function readJson(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return { error: "unexpected-state-file" };
    if (stat.size > 4 * 1024 * 1024) return { error: "state-file-too-large-for-inspection" };
    return { value: JSON.parse(await readFile(path, "utf8")) };
  }
  catch (error) {
    if (error.code === "ENOENT") return { absent: true };
    return { error: error instanceof SyntaxError ? "invalid-json" : error.code ?? "read-failed" };
  }
}

function ownerSummary(value) {
  if (!value || typeof value !== "object") return undefined;
  return {
    pid: Number.isSafeInteger(value.pid) ? value.pid : undefined,
    runId: typeof value.runId === "string" ? value.runId : undefined,
    operation: value.operation,
    processStart: value.processStart,
    processInstance: value.processInstance,
    createdAt: value.createdAt,
  };
}

function failureSummary(value) {
  if (!value || typeof value !== "object" || value.version !== 1) return undefined;
  const reason = ["budget-exceeded", "budget-uncertain", "preparation-failed", "host-tool-failed",
    "cancelled", "child-failed", "state-persistence-failed", "termination-unconfirmed"].includes(value.reason)
    ? value.reason : "unrecognized";
  const preparation = value.preparation;
  return {
    version: 1,
    operation: ["run", "compact", "inspectCompact"].includes(value.operation) ? value.operation : undefined,
    phase: ["spawn", "handshake", "run", "shutdown", "admission", "persistence"].includes(value.phase) ? value.phase : undefined,
    reason,
    childPid: Number.isSafeInteger(value.childPid) && value.childPid > 0 ? value.childPid : undefined,
    ...(preparation && typeof preparation === "object" ? {
      preparation: {
        requested: typeof preparation.requested === "boolean" ? preparation.requested : undefined,
        resolved: typeof preparation.resolved === "boolean" ? preparation.resolved : undefined,
        failed: typeof preparation.failed === "boolean" ? preparation.failed : undefined,
        phase: ["not-requested", "validation", "callback", "resolved"].includes(preparation.phase)
          ? preparation.phase : undefined,
      },
    } : {}),
  };
}

export async function inspectState(stateDir) {
  if (!stateDir || !isAbsolute(stateDir)) throw new Error("--state-dir must be an explicit absolute path");
  const records = [];
  for (const entry of await readdir(stateDir, { withFileTypes: true })) {
    if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      records.push({ stateKey: entry.name, disposition: "unexpected-state-entry" });
      continue;
    }
    const directory = join(stateDir, entry.name);
    const [binding, owner, deliveryOwner, delivery] = await Promise.all([
      readJson(join(directory, "binding.json")), readJson(join(directory, "owner.lock")),
      readJson(join(directory, "source-reply.lock")), readJson(join(directory, "source-reply-receipt.json")),
    ]);
    const errors = [binding, owner, deliveryOwner, delivery].flatMap((record) => record.error ? [record.error] : []);
    const fenced = !owner.absent || !deliveryOwner.absent || errors.length > 0 ||
      (binding.value?.status !== undefined && binding.value.status !== "ready");
    records.push({
      stateKey: entry.name, status: binding.value?.status, lastRunId: binding.value?.lastRunId,
      pendingCompactRunId: binding.value?.pendingCompact?.runId,
      failureDiagnostic: failureSummary(binding.value?.failureDiagnostic),
      owner: ownerSummary(owner.value), sourceReplyOwner: ownerSummary(deliveryOwner.value),
      sourceReply: delivery.value ? { state: delivery.value.state, runId: delivery.value.runId,
        privateCallId: delivery.value.privateCallId, updatedAt: delivery.value.updatedAt } : undefined,
      errors, disposition: fenced ? "operator-inspection-required" : "no-local-fence-observed",
    });
  }
  return { readOnly: true, records,
    warning: "This report does not authorize replay or unlock. Confirm host/child/tool settlement and external receipts; preserve history. A PID alone is not proof of ownership." };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 4 || process.argv[2] !== "--state-dir") {
    console.error("Usage: node scripts/inspect-state.mjs --state-dir <absolute-private-state-directory>");
    process.exitCode = 1;
  } else {
    inspectState(process.argv[3]).then((value) => console.log(JSON.stringify(value, null, 2))).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
