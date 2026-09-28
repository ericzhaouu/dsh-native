import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  CampaignError, assertRealPath, exists, hash, immutable, inspectProcess, privateDirectory,
  processIdentity, readBytes, readJournal, readJson,
} from "./acceptance-campaign-state.mjs";
import { planCampaignBudgets } from "./acceptance-campaign-budget-plan.mjs";

export const accountFields = ["userTurns", "modelRequests", "inputTokens", "outputTokens"];
const poolNames = ["dut", "review"];
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => typeof v === "string" && v.trim().length > 0;
const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const requireValue = (v, code) => { if (!v) throw new CampaignError(code); };
const zero = () => Object.fromEntries(accountFields.map((key) => [key, 0]));
const zeroPools = () => Object.fromEntries(poolNames.map((name) => [name, zero()]));
const maximum = (...values) => Object.fromEntries(accountFields.map((key) =>
  [key, Math.max(...values.map((value) => value[key]))]));
const maximumPools = (left, right) => Object.fromEntries(poolNames.map((name) =>
  [name, maximum(left[name], right[name])]));
const proofError = (error) => error instanceof CampaignError &&
  ["budget-usage-incomplete", "budget-proof-identity"].includes(error.code);
const unreadableProof = (error) => error instanceof SyntaxError ||
  (error instanceof CampaignError &&
    ["unsafe-path", "private-permissions-required", "file-changed"].includes(error.code)) ||
  ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EISDIR", "ERR_ENCODING_INVALID_ENCODED_DATA"].includes(error.code);
const sumCounter = (values) => {
  const total = values.reduce((sum, value) => sum + value, 0);
  requireValue(Number.isSafeInteger(total), "budget-accounting-overflow");
  return total;
};
const sharedUsage = (value, name) => ({ ...value, userTurns: name === "dut" ? value.userTurns : 0 });
const atLeast = (value, lowerBound) => accountFields.every((key) => value[key] >= lowerBound[key]);

function accountPools(value, code) {
  requireValue(object(value) && poolNames.every((name) => Object.hasOwn(value, name)) &&
    Object.keys(value).every((name) => poolNames.includes(name)), code);
  const pools = Object.fromEntries(poolNames.map((name) => [name, accountVector(value[name])]));
  requireValue(pools.review.userTurns === 0, code);
  return pools;
}

function aggregatePools(value) {
  return addAccount(...poolNames.map((name) => value[name]));
}

function retainedExposureForPools(pools, observedLowerBounds) {
  return aggregatePools(Object.fromEntries(poolNames.map((name) =>
    [name, maximum(pools[name], observedLowerBounds[name])])));
}

export function accountVector(value) {
  requireValue(object(value) && accountFields.every((key) =>
    Number.isSafeInteger(value[key]) && value[key] >= 0) &&
    Object.keys(value).every((key) => accountFields.includes(key)), "invalid-account-vector");
  return structuredClone(value);
}

export function addAccount(...values) {
  values.forEach(accountVector);
  return accountVector(Object.fromEntries(accountFields.map((key) =>
    [key, sumCounter(values.map((value) => value[key]))])));
}

export function validateCampaignBudgetConfig(value) {
  requireValue(object(value), "explicit-campaign-budget-required");
  for (const key of ["accountRoot", "authorizationPath", "baselinePath"]) {
    requireValue(text(value[key]) && isAbsolute(value[key]), `absolute-budget-${key}-required`);
  }
  for (const key of ["authorizationSha256", "baselineSha256"]) {
    requireValue(digest(value[key]), `explicit-budget-${key}-required`);
  }
  for (const key of ["caseSetupMs", "reviewSetupMs"]) {
    requireValue(Number.isSafeInteger(value[key]) && value[key] > 25, `invalid-budget-${key}`);
  }
  return structuredClone(value);
}

export async function readBudgetAuthorization(settings) {
  validateCampaignBudgetConfig(settings);
  const readPinned = async (path, sha, code) => {
    const bytes = await readBytes(path, true);
    requireValue(hash(bytes) === sha, "budget-authorization-drift");
    try { return JSON.parse(bytes); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new CampaignError(code);
    }
  };
  const authorization = await readPinned(settings.authorizationPath, settings.authorizationSha256,
    "invalid-budget-authorization");
  const baseline = await readPinned(settings.baselinePath, settings.baselineSha256, "unverified-budget-baseline");
  requireValue(object(authorization) && authorization.version === 1 && text(authorization.accountId) &&
    authorization.accountRoot === resolve(settings.accountRoot), "invalid-budget-authorization");
  const limits = accountVector(authorization.limits);
  requireValue(accountFields.every((key) => limits[key] > 0), "invalid-budget-authorization");
  requireValue(object(baseline) && baseline.version === 1 && baseline.verified === true &&
    baseline.accountId === authorization.accountId, "unverified-budget-baseline");
  addAccount(baseline.knownActual, baseline.retainedExposure);
  return { authorization, baseline };
}

function reportUsage(value) {
  const fields = ["userTurns", "modelRequests", "inputTokens", "cacheReadTokens",
    "cacheWriteTokens", "outputTokens", "toolCalls"];
  requireValue(object(value) && fields.every((key) =>
    Number.isInteger(value[key]) && value[key] >= 0), "budget-usage-incomplete");
  requireValue(fields.every((key) => Number.isSafeInteger(value[key])), "budget-accounting-overflow");
  return accountVector({ userTurns: value.userTurns, modelRequests: value.modelRequests,
    inputTokens: sumCounter([value.inputTokens, value.cacheReadTokens, value.cacheWriteTokens]),
    outputTokens: value.outputTokens });
}

function proofSection(accounting, name) {
  const section = accounting?.[name];
  requireValue(object(accounting) && object(section) && Array.isArray(section.cases) &&
    section.cases.every(object), "budget-usage-incomplete");
  return section;
}

function settlementAccounting(result, context) {
  const complete = result?.status === "settled" && result.accountingComplete === true &&
    result.quiescent === true && digest(result.reportSha256) && text(result.reportPath);
  const actualPools = zeroPools();
  const lowerBoundPools = zeroPools();
  // Collect every identity-bound observation before testing completeness. One incomplete
  // pool must not hide another pool's overage or make its observed usage disappear.
  for (const name of ["dut", "review"]) {
    try {
      const section = proofSection(result?.accounting, name);
      requireValue(section.cases.length === 1 && section.cases[0].caseId === context.caseId,
        "budget-proof-identity");
      lowerBoundPools[name] = sharedUsage(reportUsage(section.observedLowerBound), name);
    } catch (error) {
      if (!proofError(error)) throw error;
    }
  }
  try {
    for (const name of ["dut", "review"]) {
      const section = proofSection(result?.accounting, name);
      for (const value of [section, ...section.cases, ...section.cases.map((entry) =>
        entry.hardLimits?.attestation)].filter(Boolean)) {
        requireValue(object(value) && !value.pending && !value.aborted && !value.liveUnknown && !value.unknownEffects &&
          !value.error && ["reserved", "outstandingReservations", "unresolvedExposure"].every((key) =>
            value[key] === undefined || (object(value[key]) &&
              Object.values(value[key]).every((amount) => amount === 0))), "budget-usage-incomplete");
      }
      if (section.status === "not_started") {
        requireValue(section.cases.length === 0 && section.totals === null &&
          isDeepStrictEqual(reportUsage(section.observedLowerBound), zero()) &&
          isDeepStrictEqual(reportUsage(section.completeUsage), zero()), "budget-usage-incomplete");
        continue;
      }
      requireValue(section.cases.length === 1 && section.cases[0].caseId === context.caseId,
        "budget-proof-identity");
      const entry = section.cases[0];
      const observed = reportUsage(section.observedLowerBound);
      requireValue(complete && section.status === "complete" && entry.status === "complete" &&
        entry.executionSettled === true && entry.aborted === false &&
        isDeepStrictEqual(observed, reportUsage(section.totals)) &&
        isDeepStrictEqual(observed, reportUsage(section.completeUsage)) &&
        isDeepStrictEqual(observed, reportUsage(entry.observedLowerBound)) &&
        entry.hardLimits?.status === "adapter-attested" &&
        entry.hardLimits.attestation?.quiescent === true &&
        entry.hardLimits.attestation?.hardLimitsVerified === true, "budget-usage-incomplete");
      actualPools[name] = sharedUsage(observed, name);
    }
    requireValue(complete, "budget-usage-incomplete");
    const knownActual = aggregatePools(actualPools);
    return { complete: true, knownActual, observedLowerBound: knownActual,
      poolObservedLowerBounds: actualPools };
  } catch (error) {
    if (!proofError(error)) throw error;
    // Lower bounds are evidence, not settlement. No reservation is released on this path.
    return { complete: false, knownActual: zero(), observedLowerBound: aggregatePools(lowerBoundPools),
      poolObservedLowerBounds: lowerBoundPools };
  }
}

export function reduceBudgetJournal(events, binding) {
  const reservations = new Map();
  let bound = false;
  for (const row of events) {
    if (!row.event.startsWith("budget.account-")) continue;
    const data = row.data;
    if (row.event === "budget.account-bound") {
      requireValue(!bound && isDeepStrictEqual(data, binding), "budget-account-binding-mismatch");
      bound = true;
      continue;
    }
    requireValue(bound && data.accountId === binding.accountId &&
      data.campaignId === binding.campaignId && text(data.dispatchId), "budget-account-binding-mismatch");
    if (row.event === "budget.account-reserved") {
      requireValue(!reservations.has(data.dispatchId) && text(data.caseId) &&
        digest(data.manifestSha256) && digest(data.scopeSha256), "budget-duplicate-reservation");
      const amount = accountVector(data.amount);
      const pools = accountPools(data.pools, "budget-reservation-pools-invalid");
      requireValue(isDeepStrictEqual(aggregatePools(pools), amount), "budget-reservation-pools-invalid");
      reservations.set(data.dispatchId, { ...data, amount, pools, knownActual: zero(),
        observedLowerBound: zero(), poolObservedLowerBounds: zeroPools(),
        retainedExposure: amount, status: "reserved" });
    } else if (row.event === "budget.account-fatal") {
      const reservation = reservations.get(data.dispatchId);
      requireValue(reservation && reservation.caseId === data.caseId &&
        reservation.manifestSha256 === data.manifestSha256 && reservation.scopeSha256 === data.scopeSha256 &&
        reservation.status !== "settled" && digest(data.proofSha256) &&
        data.reason === "budget-accounting-overflow", "budget-settlement-identity");
      throw new CampaignError(data.reason);
    } else if (row.event === "budget.account-settled" || row.event === "budget.account-unknown") {
      const reservation = reservations.get(data.dispatchId);
      requireValue(reservation && reservation.caseId === data.caseId &&
        reservation.manifestSha256 === data.manifestSha256 &&
        reservation.scopeSha256 === data.scopeSha256 && reservation.status !== "settled" &&
        !Object.hasOwn(data, "amount") && !Object.hasOwn(data, "pools"),
      "budget-settlement-identity");
      requireValue(digest(data.proofSha256), "budget-settlement-identity");
      const knownActual = accountVector(data.knownActual);
      const observedLowerBound = accountVector(data.observedLowerBound);
      const retainedExposure = accountVector(data.retainedExposure);
      const poolObservedLowerBounds = accountPools(data.poolObservedLowerBounds, "budget-pool-accounting-corrupt");
      requireValue(poolNames.every((name) =>
        atLeast(poolObservedLowerBounds[name], reservation.poolObservedLowerBounds[name])),
      "budget-exposure-released");
      requireValue(isDeepStrictEqual(observedLowerBound, aggregatePools(poolObservedLowerBounds)),
        "budget-pool-accounting-corrupt");
      if (row.event === "budget.account-unknown") {
        requireValue(isDeepStrictEqual(knownActual, zero()) &&
          isDeepStrictEqual(retainedExposure,
            retainedExposureForPools(reservation.pools, poolObservedLowerBounds)),
        "budget-exposure-released");
      } else {
        requireValue(isDeepStrictEqual(retainedExposure, zero()) &&
          isDeepStrictEqual(knownActual, observedLowerBound),
        "budget-settlement-incomplete");
      }
      Object.assign(reservation, data, { knownActual, observedLowerBound, retainedExposure,
        poolObservedLowerBounds, status: row.event.endsWith("-settled") ? "settled" : "unknown" });
    } else throw new CampaignError("unknown-budget-event");
  }
  return { bound, reservations };
}

async function ensureDirectory(path) {
  try { await privateDirectory(path); }
  catch (error) { if (error.code !== "EEXIST") throw error; await assertRealPath(path, true, true); }
}

// The account contains only immutable membership/locking metadata. Accounting stays in each
// controller journal, so a crash cannot commit a dispatch without its corresponding reservation.
export async function createCampaignPolicy({ campaignId, campaignRoot, config }, {
  identify = processIdentity, inspect = inspectProcess, planner = planCampaignBudgets,
} = {}) {
  const settings = validateCampaignBudgetConfig(config.budget);
  const { authorization, baseline } = await readBudgetAuthorization(settings);
  const root = resolve(settings.accountRoot);
  requireValue(root !== resolve(campaignRoot), "separate-account-root-required");
  await assertRealPath(root, true, true);
  for (const name of ["locks", "members"]) await ensureDirectory(join(root, name));
  const account = { version: 1, accountId: authorization.accountId,
    authorizationPath: resolve(settings.authorizationPath), authorizationSha256: settings.authorizationSha256,
    baselinePath: resolve(settings.baselinePath), baselineSha256: settings.baselineSha256 };
  const accountPath = join(root, "account.json");
  if (!await exists(accountPath)) {
    try { await immutable(accountPath, account); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  requireValue(isDeepStrictEqual(await readJson(accountPath, true), account), "budget-account-rebinding");
  const binding = { ...account, campaignId, campaignRoot: resolve(campaignRoot) };
  const memberPath = join(root, "members", `${hash(campaignId)}.json`);

  const locked = async (operation) => {
    await readBudgetAuthorization(settings);
    requireValue(isDeepStrictEqual(await readJson(accountPath, true), account), "budget-account-rebinding");
    const locks = (await readdir(join(root, "locks"))).filter((name) => name.endsWith(".lock.json")).sort();
    for (const [index, name] of locks.entries()) {
      requireValue(name === `${String(index).padStart(12, "0")}.lock.json`, "budget-lock-chain-corrupt");
    }
    if (locks.length) {
      let old;
      try { old = await readJson(join(root, "locks", locks.at(-1)), true); }
      catch (error) {
        if (!unreadableProof(error)) throw error;
        throw new CampaignError("budget-account-busy");
      }
      const released = join(root, "locks", `${old.id}.released.json`);
      if (await exists(released)) {
        requireValue(isDeepStrictEqual(await readJson(released, true), old), "budget-lock-chain-corrupt");
      } else requireValue(await inspect(old.identity) === "gone", "budget-account-busy");
    }
    const identity = await identify(process.pid);
    requireValue(Number.isSafeInteger(identity?.pid) && identity.pid > 0 && text(identity.startId),
      "budget-lock-identity-unavailable");
    const lock = { id: randomUUID(), identity, campaignId };
    try {
      await immutable(join(root, "locks", `${String(locks.length).padStart(12, "0")}.lock.json`), lock);
    } catch (error) {
      if (error.code === "EEXIST") throw new CampaignError("budget-account-busy");
      throw error;
    }
    try { return await operation(); }
    finally { await immutable(join(root, "locks", `${lock.id}.released.json`), lock); }
  };

  const register = async ({ events, append }) => {
    if (!await exists(memberPath)) await immutable(memberPath, binding);
    requireValue(isDeepStrictEqual(await readJson(memberPath, true), binding), "budget-account-binding-mismatch");
    const state = reduceBudgetJournal(events, binding);
    if (!state.bound) await append("account-bound", binding);
  };
  const snapshot = async () => {
    let knownActual = accountVector(baseline.knownActual);
    let retainedExposure = accountVector(baseline.retainedExposure);
    let observedLowerBound = zero();
    const pending = [];
    let own;
    for (const name of (await readdir(join(root, "members"))).sort()) {
      const member = await readJson(join(root, "members", name), true);
      requireValue(name === `${hash(member.campaignId)}.json` &&
        isDeepStrictEqual({ ...member, campaignId, campaignRoot: resolve(campaignRoot) }, binding),
      "budget-account-binding-mismatch");
      const meta = await readJson(join(member.campaignRoot, "campaign.json"), true);
      requireValue(meta.campaignId === member.campaignId, "budget-account-binding-mismatch");
      const state = reduceBudgetJournal(await readJournal(member.campaignRoot), member);
      // An interrupted registration has no dispatch authority; it still prevents admission
      // until that campaign repairs its binding rather than silently disappearing.
      requireValue(state.bound, "budget-member-unbound");
      for (const reservation of state.reservations.values()) {
        knownActual = addAccount(knownActual, reservation.knownActual);
        retainedExposure = addAccount(retainedExposure, reservation.retainedExposure);
        observedLowerBound = addAccount(observedLowerBound, reservation.observedLowerBound);
        if (reservation.status !== "settled") pending.push({
          campaignId: member.campaignId, dispatchId: reservation.dispatchId, status: reservation.status,
        });
      }
      if (member.campaignId === campaignId) own = state;
    }
    const committed = addAccount(knownActual, retainedExposure);
    return { knownActual, retainedExposure, observedLowerBound, committed, pending, own,
      overage: Object.fromEntries(accountFields.map((key) => [key,
        Math.max(0, committed[key] - authorization.limits[key])])) };
  };
  const summary = ({ own, ...value }) => value;
  let plans;
  const policy = {
    async preflight() {
      await readBudgetAuthorization(settings);
      plans = await planner(config);
    },
    async planCase({ caseId }) {
      requireValue(plans?.has(caseId), "budget-preflight-required");
      return structuredClone(plans.get(caseId));
    },
    async audit(hook) {
      return locked(async () => {
        await register(hook);
        const state = await snapshot();
        return { safeToContinue: !state.pending.some((item) => item.campaignId === campaignId) &&
          accountFields.every((key) => state.overage[key] === 0), ...summary(state) };
      });
    },
    async reserve(hook) {
      return locked(async () => {
        await register(hook);
        const { context, testCase, scope } = hook;
        requireValue(context.campaignId === campaignId && plans?.has(context.caseId), "budget-preflight-required");
        const plan = plans.get(context.caseId);
        requireValue(isDeepStrictEqual(testCase.limits, plan.testCase.limits) &&
          ["caseBudget", "attemptBudget", "reviewCaseBudget", "reviewAttemptBudget", "budgets", "reviewBudgets"]
            .every((key) => isDeepStrictEqual(scope[key], plan.scope[key])), "budget-case-plan-mismatch");
        requireValue(hash(await readBytes(context.manifestPath, true)) === context.manifestSha256 &&
          hash(await readBytes(context.scopePath, true)) === context.hashes[context.scopePath], "budget-case-input-drift");
        const state = await snapshot();
        const previous = state.own.reservations.get(context.dispatchId);
        const amount = accountVector(plan.reservation);
        const pools = accountPools(plan.pools, "budget-reservation-pools-invalid");
        requireValue(isDeepStrictEqual(aggregatePools(pools), amount), "budget-reservation-pools-invalid");
        const reservation = { accountId: authorization.accountId, campaignId, caseId: context.caseId,
          dispatchId: context.dispatchId, manifestSha256: context.manifestSha256,
          scopeSha256: context.hashes[context.scopePath], amount, pools };
        if (previous) {
          requireValue(Object.keys(reservation).every((key) => isDeepStrictEqual(reservation[key], previous[key])) &&
            previous.status === "reserved", "budget-reservation-replay");
          return { admitted: true, reservation };
        }
        const committed = addAccount(state.committed, reservation.amount);
        if (accountFields.some((key) => committed[key] > authorization.limits[key])) {
          return { admitted: false, accounting: summary(state), reason: "authorization-exhausted" };
        }
        await hook.append("account-reserved", reservation);
        return { admitted: true, reservation };
      });
    },
    async settle(hook) {
      return locked(async () => {
        const { context, result } = hook;
        requireValue(context.campaignId === campaignId, "budget-settlement-identity");
        const state = await snapshot();
        const reservation = state.own?.reservations.get(context.dispatchId);
        requireValue(reservation && reservation.caseId === context.caseId &&
          reservation.manifestSha256 === context.manifestSha256 &&
          reservation.scopeSha256 === context.hashes[context.scopePath], "budget-settlement-identity");
        const proofSha256 = hash(JSON.stringify(result));
        if (reservation.status === "settled") {
          requireValue(reservation.proofSha256 === proofSha256, "budget-settlement-replay");
          return { settled: true, accountingComplete: true, quiescent: true };
        }
        if (reservation.status === "unknown" && reservation.proofSha256 === proofSha256) {
          return { settled: false, accountingComplete: false, quiescent: false };
        }
        let accounting;
        try { accounting = settlementAccounting(result, context); }
        catch (error) {
          if (error instanceof CampaignError && error.code === "budget-accounting-overflow") {
            await hook.append("account-fatal", { accountId: authorization.accountId, campaignId,
              caseId: context.caseId, dispatchId: context.dispatchId, manifestSha256: reservation.manifestSha256,
              scopeSha256: reservation.scopeSha256, proofSha256, reason: error.code });
          }
          throw error;
        }
        if (accounting.complete) {
          try {
            const reportBytes = await readBytes(result.reportPath, true);
            const report = JSON.parse(reportBytes);
            requireValue(hash(reportBytes) === result.reportSha256 && object(report) &&
              report.manifestSha256 === context.manifestSha256 && Array.isArray(report.cases) &&
              report.cases.length === 1 && report.cases[0]?.id === context.caseId &&
              isDeepStrictEqual(report.budgetAccounting, result.accounting), "budget-report-identity");
          } catch (error) {
            if (!unreadableProof(error) &&
                !(error instanceof CampaignError && error.code === "budget-report-identity")) throw error;
            accounting = { complete: false, knownActual: zero(),
              observedLowerBound: accounting.observedLowerBound,
              poolObservedLowerBounds: accounting.poolObservedLowerBounds };
          }
        }
        let data;
        try {
          if (accounting.complete && !poolNames.every((name) =>
            atLeast(accounting.poolObservedLowerBounds[name], reservation.poolObservedLowerBounds[name]))) {
            accounting.complete = false;
            accounting.knownActual = zero();
          }
          if (!accounting.complete) {
            accounting.poolObservedLowerBounds =
              maximumPools(accounting.poolObservedLowerBounds, reservation.poolObservedLowerBounds);
          }
          accounting.observedLowerBound = aggregatePools(accounting.poolObservedLowerBounds);
          data = { accountId: authorization.accountId, campaignId, caseId: context.caseId,
            dispatchId: context.dispatchId, manifestSha256: reservation.manifestSha256,
            scopeSha256: reservation.scopeSha256, proofSha256,
            knownActual: accounting.complete ? accounting.observedLowerBound : accounting.knownActual,
            observedLowerBound: accounting.observedLowerBound,
            poolObservedLowerBounds: accounting.poolObservedLowerBounds,
            retainedExposure: accounting.complete ? zero() :
              retainedExposureForPools(reservation.pools, accounting.poolObservedLowerBounds) };
        } catch (error) {
          if (error instanceof CampaignError && error.code === "budget-accounting-overflow") {
            await hook.append("account-fatal", { accountId: authorization.accountId, campaignId,
              caseId: context.caseId, dispatchId: context.dispatchId, manifestSha256: reservation.manifestSha256,
              scopeSha256: reservation.scopeSha256, proofSha256, reason: error.code });
          }
          throw error;
        }
        // A numeric overage is a fact, not a value to clamp to the reservation.
        await hook.append(accounting.complete ? "account-settled" : "account-unknown", data);
        return { settled: accounting.complete, accountingComplete: accounting.complete,
          quiescent: accounting.complete, ...data, accounting: summary(await snapshot()) };
      });
    },
  };
  policy.retain = (hook) => policy.settle({ ...hook,
    result: { ...hook.result, status: "unknown", accountingComplete: false, quiescent: false } });
  return policy;
}
