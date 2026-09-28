import { basename } from "node:path";

export const CAMPAIGN_FILES = [
  "acceptance-campaign.test.mjs",
  "acceptance-campaign-budget.test.mjs",
  "acceptance-campaign-executor.test.mjs",
];
export const LINUX_MAX_SKIPPED = 1;
const windowsOnly = "Windows rejects an overlong child cwd before spawning or creating a binding";

export function verifyLinuxCoverage(report) {
  const counts = report?.counts;
  if (!counts || !Number.isInteger(counts.tests) || counts.tests <= 0 ||
      counts.passed !== counts.tests - counts.skipped || counts.failed !== 0 ||
      counts.cancelled !== 0 || counts.todo !== 0 || !Number.isInteger(counts.skipped) ||
      counts.skipped < 0 || counts.skipped > LINUX_MAX_SKIPPED ||
      !Array.isArray(report.skips) || report.skips.length !== counts.skipped ||
      report.skips.some((item) => item.file !== "runtime-failure.test.mjs" || item.name !== windowsOnly) ||
      CAMPAIGN_FILES.some((file) => !Number.isInteger(report.campaign?.[file]) || report.campaign[file] <= 0) ||
      CAMPAIGN_FILES.reduce((sum, file) => sum + report.campaign[file], 0) < 321) {
    throw new Error("Required Linux test coverage failed: missing campaign cases, failures, or unexpected skips.");
  }
  return { ...report, maxSkipped: LINUX_MAX_SKIPPED, ok: true };
}

export default async function* releaseTestReporter(events) {
  const report = { counts: null, skips: [], campaign: Object.fromEntries(CAMPAIGN_FILES.map((file) => [file, 0])) };
  for await (const { type, data } of events) {
    if (type === "test:pass" || type === "test:fail") {
      const file = basename(data.file ?? "");
      if (data.skip) report.skips.push({ file, name: data.name });
      else if (type === "test:pass" && !data.todo && CAMPAIGN_FILES.includes(file)) report.campaign[file]++;
    }
    if (type === "test:summary" && !data.file) report.counts = data.counts;
  }
  yield `${JSON.stringify(report, null, 2)}\n`;
}
