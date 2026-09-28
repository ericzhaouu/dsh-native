#!/usr/bin/env node
import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CampaignError, campaignStatus, claimCampaign, prepareCampaign, runCampaign,
} from "./lib/acceptance-campaign.mjs";
import { immutable, readJson, syncDirectory } from "./lib/acceptance-campaign-state.mjs";

export function campaignHelp() {
  return [
    "Usage: node scripts\\run-acceptance-campaign.mjs prepare --config <absolute-private-json>",
    "       node scripts\\run-acceptance-campaign.mjs start|resume --root <absolute-private-dir> [--detach]",
    "       node scripts\\run-acceptance-campaign.mjs status --root <absolute-private-dir>",
    "",
    "prepare pins inputs/scripts, local resource maps/fixtures and compiled runtime/host dist trees.",
    "Additional executable dependency trees belong in artifactRoots; start never reclaims a claim.",
    "resume audits old controller/child PID+OS start identity, journal, receipts, report and dispatch ledger.",
    "Confirmed admitted:false writes reservation-rejected; interrupted or malformed reserve stays fenced.",
    "Started, unknown, and successful cases are never replayed. Missing launch identity is fenced.",
    "Only typed transient health faults retry; expiration produces a durable paused receipt.",
    "No ambient runner environment, automatic authorization, budget reset, Gateway restart, or evidence recovery.",
    "POSIX private modes and directory fsync are enforced. On Windows provision private ACLs externally;",
    "file fsync is enforced but directory fsync is unavailable. Unsupported process-identity hosts fail closed.",
    "",
    "Private config structure (replace all placeholders; every path is absolute; no credentials in Git):",
    JSON.stringify({
      version: 1, campaignRoot: "<new private directory outside sourceRoot>",
      sourceRoot: "<frozen repository>", runner: "<sourceRoot>/scripts/run-acceptance.mjs",
      node: "<node executable>", adapter: "<trusted adapter.mjs>", reviewer: "<independent reviewer.mjs>",
      artifactRoots: ["<additional frozen dependency tree, e.g. exact installed dependencies>"],
      manifest: "<compiled manifest.json>", oracles: "<original oracles.json>", scope: "<authorized scope.json>",
      caseIds: ["<selected case ID>"], live: true,
      env: { OPENCLAW_STATE_DIR: "<state directory>", OPENCLAW_CONFIG_PATH: "<host config.json>",
        DSH_ACCEPTANCE_GATEWAY_CONFIG: "<explicit gateway config.json>",
        DSH_ACCEPTANCE_REVIEW_GATEWAY_CONFIG: "<explicit reviewer config.json>" },
      pins: { "<every runner/node/adapter/reviewer/manifest/oracles/scope/policy and host config path>": "<sha256>" },
      health: { url: "<explicit HTTP(S) readiness URL>", headers: {},
        totalWaitMs: "<positive integer>", requestTimeoutMs: "<positive integer>",
        initialBackoffMs: "<positive integer>", maxBackoffMs: "<positive integer>", goodSamples: 3 },
      heartbeatMs: "<positive integer>", runnerTimeoutMs: "<positive integer>",
      budget: {
        accountRoot: "<existing private shared account directory; reuse across ALL campaigns/controllers>",
        authorizationPath: "<pinned private authorization.json>", authorizationSha256: "<sha256>",
        baselinePath: "<pinned private verified baseline.json>", baselineSha256: "<sha256>",
        caseSetupMs: "<integer >25; headroom in addition to T native durations>",
        reviewSetupMs: "<integer >25; headroom in addition to one native duration>",
      },
    }, null, 2),
    "",
    "The built-in durable budget policy is the default; budget settings and both file pins are REQUIRED.",
    "Authorization JSON: {version:1,accountId,accountRoot,limits:{userTurns,modelRequests,inputTokens,outputTokens}}.",
    "Baseline JSON: {version:1,accountId,verified:true,knownActual:{all four counters},retainedExposure:{all four counters}}.",
    "All counters must be explicit nonnegative safe integers (authorization limits positive); no null/empty values.",
    "The authorization binds its one accountRoot; never copy/reset that account for another run.",
    "Baseline bytes are verified by SHA-256. Account identity, authorization and baseline cannot be rebound.",
    "Scope must declare attemptBudget and reviewAttemptBudget (legacy operationalBudget keys are accepted).",
    "Each isolated DUT root is T native attempts, reviewer one extra. Shared userTurns counts DUT inputs ONLY;",
    "the local reviewer sees userTurns=1 while the shared review pool is 0. Physical requests/input/cache/output",
    "from both pools still count against shared totals; native caps stay unchanged. Shared input+cache reserves",
    "still happen ONCE, not three or six times, while report ceilings each allow the full aggregate cap.",
    "Generated isolated limits replace source case/suite report allocations; source/oracles remain untouched.",
    "Pinned host config must explicitly enumerate full model contextWindow for each primary/fallback route.",
    "prepare and start preflight actual effective global/exact-agent native caps OFFLINE, before health/model.",
    "runnerTimeoutMs must exceed the sum of case and reviewer durations plus operator-chosen setup headroom.",
    "Reserve is fsynced BEFORE child dispatch. Unknown/missing proof retains exposure even at lower-bound zero.",
    "Accounting overflow latches a fatal account event; it never discards usage or authorizes more dispatches.",
    "All campaign accounting lives in controller.jsonl; shared account membership indexes those same journals.",
    "Do not remove account members, locks, journals or baselines. Interrupted writes fail closed; no TTL releases.",
    "Advanced alternative: a pinned policyModule exporting createCampaignPolicy (mutually exclusive with budget).",
    "createCampaignPolicy({campaignId,campaignRoot,config}) returns:",
    "  preflight({events,append}) [optional, static checks only]; planCase({caseId}) [optional, isolated limits/scope]",
    "  audit({campaignId,events,append}) -> {safeToContinue:true,...proof}",
    "  reserve({campaignId,events,append,context,testCase,scope}) -> {admitted:true,reservation:{...}}",
    "    or a confirmed denial {admitted:false} with no reservation field and no durable reservation append",
    "  settle({campaignId,events,append,context,result}) -> {settled:true,accountingComplete:true,quiescent:true,...}",
    "Hooks must be offline/idempotent by context.dispatchId; reserve must not dispatch.",
    "Any reserve interruption, false-plus-reservation, nonboolean falsy admitted, or reservation-related append",
    "must remain fenced for explicit operator review; only confirmed denial may be retried on explicit resume.",
    "append(name,object) fsyncs a budget.name event into the SAME controller journal.",
    "Policy owns historical authorization/admission/settlement; no automatic historical zero or new authorization.",
    "Library seams: executor.execute(context,{onStarted}), executor.audit(context), policy, identify, inspect,",
    "health.{now,delay,probe}; tests never need a model or a Gateway.",
  ].join("\n");
}

function argumentsFor(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) return { command: "help" };
  const [command, ...rest] = argv;
  if (!["prepare", "start", "resume", "status", "_worker"].includes(command)) throw new CampaignError("invalid-command");
  const args = { command, detach: false };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === "--detach" && !args.detach) args.detach = true;
    else if (["--config", "--root", "--epoch", "--controller-id"].includes(flag)) {
      const key = flag.slice(2);
      if (args[key] !== undefined || !rest[index + 1] || rest[index + 1].startsWith("--")) {
        throw new CampaignError("invalid-arguments");
      }
      args[key] = rest[++index];
    } else throw new CampaignError("invalid-arguments");
  }
  const allowed = command === "prepare" ? ["command", "config", "detach"] :
    command === "_worker" ? ["command", "root", "epoch", "controller-id", "detach"] : ["command", "root", "detach"];
  if (Object.keys(args).some((key) => !allowed.includes(key)) ||
      (args.detach && !["start", "resume"].includes(command))) throw new CampaignError("invalid-arguments");
  const path = command === "prepare" ? args.config : args.root;
  if (typeof path !== "string" || !isAbsolute(path)) throw new CampaignError("absolute-path-required");
  return args;
}

async function detachedStart(root, resume) {
  const claim = await claimCampaign(root, { resume, detached: true });
  const meta = await readJson(join(root, "campaign.json"), true);
  const config = await readJson(meta.configPath, true);
  const logPath = join(root, "receipts", `controller-${claim.controllerId}.log`);
  const log = await open(logPath, "wx", 0o600);
  let child;
  try {
    await log.sync();
    await syncDirectory(join(root, "receipts"));
    child = spawn(config.node, [fileURLToPath(import.meta.url), "_worker", "--root", root,
      "--epoch", String(claim.epoch), "--controller-id", claim.controllerId],
    { cwd: config.sourceRoot, env: config.env, detached: true, shell: false, windowsHide: true,
      stdio: ["ignore", log.fd, log.fd] });
    await new Promise((done, reject) => { child.once("spawn", done); child.once("error", reject); });
    child.unref();
    // The worker records its own OS creation identity before loading any policy or executing a case.
    return { status: "launch-requested", campaignId: claim.campaignId, controllerId: claim.controllerId,
      pid: child.pid, root, note: "Use status; a launch request is not proof of a running controller." };
  } catch {
    await immutable(join(root, "receipts", `launch-failed-${claim.controllerId}.json`),
      { controllerId: claim.controllerId, status: "paused", reason: "launch-unproven" });
    throw new CampaignError("launch-unproven");
  } finally { await log.close(); }
}

export async function campaignCli(argv) {
  const args = argumentsFor(argv);
  if (args.command === "help") return { code: 0, output: campaignHelp() };
  if (args.command === "prepare") {
    const root = await prepareCampaign(resolve(args.config));
    return { code: 0, output: { status: "prepared", root } };
  }
  const root = resolve(args.root);
  if (args.command === "status") return { code: 0, output: await campaignStatus(root) };
  if (args.detach) return { code: 0, output: await detachedStart(root, args.command === "resume") };
  let claim;
  if (args.command === "_worker") {
    if (!/^(0|[1-9]\d*)$/.test(args.epoch ?? "") || !args["controller-id"]) {
      throw new CampaignError("invalid-worker-claim");
    }
    claim = await readJson(join(root, "locks", `epoch-${args.epoch.padStart(8, "0")}.json`), true);
    if (claim.controllerId !== args["controller-id"] || claim.mode !== "detached") {
      throw new CampaignError("invalid-worker-claim");
    }
  }
  const result = await runCampaign(root, { resume: args.command === "resume", claim });
  return { code: result.status === "completed" ? 0 : 1, output: result };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await campaignCli(process.argv.slice(2));
    console.log(typeof result.output === "string" ? result.output : JSON.stringify(result.output));
    process.exitCode = result.code;
  } catch (error) {
    console.error(JSON.stringify({ status: "failed", reason: error instanceof CampaignError ? error.code :
      error.code === "EEXIST" ? "exclusive-claim-exists" : "campaign-operation-failed" }));
    process.exitCode = 1;
  }
}
