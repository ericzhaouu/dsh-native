import { zeroUsage } from "./acceptance-contract.mjs";

export function createAdapter() {
  return {
    async executeCase(testCase, context) {
      if ((testCase.stage ?? context.manifestInfo.stage ?? "offline") !== "offline") {
        return {
          executionStatus: "infrastructure_blocked",
          businessResult: "failed",
          policyFacts: { adapter: "local-fixture", blockedReason: "fixture adapter only supports offline stage" },
          sideEffects: [],
          usage: { ...zeroUsage(), priced: false },
        };
      }
      await Promise.resolve();
      if (context.signal.aborted) throw context.signal.reason ?? new Error("aborted");
      if (typeof context.reportUsage === "function") context.reportUsage({ ...zeroUsage(), userTurns: 0 });
      return structuredClone(context.fixtureEvidence ?? {
        executionStatus: "completed",
        businessResult: "passed",
        outputText: "offline fixture completed",
        policyFacts: { adapter: "local-fixture" },
        sideEffects: [],
        usage: { ...zeroUsage(), priced: false },
      });
    },
    async cleanupCase() {
      return { cleaned: true, adapter: "local-fixture", receipt: "local-fixture-clean" };
    },
  };
}
