/**
 * Preserve operator-budget failures as model-independent host failures. The
 * pinned SDK's unscoped preflight identity stops provider fallback; a harness
 * scope would instead permit an ownership change. Do not classify other errors.
 */
export function isBudgetFailure(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return code === "DSH_BUDGET_EXCEEDED" || code === "DSH_BUDGET_UNCERTAIN";
}

export async function rethrowBudgetFailure(error: unknown): Promise<never> {
  if (!isBudgetFailure(error)) throw error;
  const code = (error as { code: string }).code;
  const { AgentHarnessPreflightError } = await import("openclaw/plugin-sdk/agent-harness-runtime");
  if (error instanceof AgentHarnessPreflightError && error.scope === undefined) throw error;
  throw Object.assign(new AgentHarnessPreflightError(
    code === "DSH_BUDGET_UNCERTAIN"
      ? "DSH operational budget has unresolved work; inspect retained evidence before any new attempt."
      : "DSH operator-defined operational budget prevents further work.",
    { cause: error },
  ), { code });
}
