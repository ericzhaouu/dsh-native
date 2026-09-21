#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recomputeReport, validateReportShape } from "./lib/acceptance-evaluator.mjs";

function usage() { return "Usage: node scripts\\evaluate-acceptance.mjs --report <report.json>"; }

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--report") args.report = argv[++index];
    else if (argv[index] === "--help" || argv[index] === "-h") { console.log(usage()); process.exit(0); }
    else throw new TypeError(`Unknown argument ${argv[index]}\n${usage()}`);
  }
  if (!args.report) throw new TypeError(`--report is required\n${usage()}`);
  return args;
}

export async function evaluateAcceptance(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const reportPath = resolve(args.report);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const shapeErrors = validateReportShape(report);
  let rebuilt;
  try { rebuilt = recomputeReport(report); }
  catch (error) { shapeErrors.push(`report recomputation failed: ${error.message}`); }
  const recomputedGates = rebuilt?.gates ?? {};
  const failedGates = Object.entries(recomputedGates).filter(([, status]) => status !== "passed");
  if (shapeErrors.length) failedGates.push(["reportIntegrity", "failed"]);
  const totals = rebuilt?.totals ?? {};
  const legacyClean = report?.version !== 1 || ((totals.blocked ?? 0) === 0 && (totals.failed ?? 0) === 0);
  const ok = shapeErrors.length === 0 && failedGates.length === 0 && rebuilt?.passed === true && legacyClean;
  return { code: ok ? 0 : 1, reportPath, shapeErrors, failedGates, recomputedGates, blocked: totals.blocked ?? 0, failed: totals.failed ?? 0 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  evaluateAcceptance().then((result) => { console.log(JSON.stringify(result)); process.exitCode = result.code; }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
