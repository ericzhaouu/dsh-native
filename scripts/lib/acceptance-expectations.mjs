import { isDeepStrictEqual } from "node:util";

export const acceptedOutcomes = ["completed", "correctly_blocked"];
export const acceptedModes = ["chat", "clarify", "draft", "execute"];

export function assertExpectationSet(values, allowed, label) {
  if (!Array.isArray(values) || !values.length || new Set(values).size !== values.length ||
      values.some((value) => !allowed.includes(value))) {
    throw new TypeError(`${label} must be a non-empty unique subset of ${allowed.join(", ")}`);
  }
}

export function compileTurnExpectation(expected, submissionId) {
  assertExpectationSet(expected?.permittedOutcomes, acceptedOutcomes, "permittedOutcomes");
  assertExpectationSet(expected?.modes, acceptedModes, "modes");
  if (typeof submissionId !== "string" || !submissionId) throw new TypeError("submissionId is required");
  return { submissionId, allowedOutcomes: [...expected.permittedOutcomes], allowedModes: [...expected.modes] };
}

export function compileExpectationContract(reviews, ids) {
  const turnExpectations = reviews.map((review, index) => compileTurnExpectation(review.expected, ids[index]));
  if (!turnExpectations.length || new Set(ids).size !== turnExpectations.length) throw new TypeError("Unique turn submissionIds are required");
  const final = turnExpectations.at(-1);
  return {
    contractVersion: 2,
    allowedOutcomes: [...final.allowedOutcomes],
    allowedModes: [...final.allowedModes],
    turnExpectations,
  };
}

export function expectationContract(expected) {
  return Object.fromEntries(["contractVersion", "allowedOutcomes", "allowedModes", "turnExpectations"]
    .map((key) => [key, expected?.[key]]));
}

export function assertCaseExpectation(testCase) {
  const expected = testCase.expected;
  if (expected?.contractVersion !== 2) throw new TypeError("expected.contractVersion must be 2");
  if (Object.hasOwn(expected, "executionStatus") || Object.hasOwn(expected, "businessResult") || testCase.mode !== undefined) {
    throw new TypeError("v2 expectations cannot contain scalar outcomes or mode");
  }
  assertExpectationSet(expected.allowedOutcomes, acceptedOutcomes, "allowedOutcomes");
  assertExpectationSet(expected.allowedModes, acceptedModes, "allowedModes");
  const turns = expected.turnExpectations;
  if (!Array.isArray(turns) || turns.length !== (testCase.turns?.length ?? 1)) throw new TypeError("turnExpectations must align with every input turn");
  const ids = new Set();
  for (const turn of turns) {
    if (typeof turn?.submissionId !== "string" || !turn.submissionId || ids.has(turn.submissionId)) throw new TypeError("turnExpectations require unique submissionIds");
    ids.add(turn.submissionId);
    assertExpectationSet(turn.allowedOutcomes, acceptedOutcomes, "turn allowedOutcomes");
    assertExpectationSet(turn.allowedModes, acceptedModes, "turn allowedModes");
  }
  for (const name of ["allowedModes", "allowedOutcomes"]) {
    if (!isDeepStrictEqual([...expected[name]].sort(), [...turns.at(-1)[name]].sort())) throw new TypeError(`final turn ${name} does not match case expectation`);
  }
}

const fixtureKinds = {
  "synthetic-article": "synthetic-document",
  "feishu-table": "synthetic-table",
  "golden-search": "static-search",
  "scoped-file": "scoped-file",
  "poisonous-sample-canaries": "inert-sample",
  "private-feishu-canary-map": "live-channel",
};

export function compileFixtureScope(item) {
  const fixtures = (item.fixtures ?? []).map((id) => {
    if (!fixtureKinds[id]) throw new TypeError(`Unrecognized acceptance fixture ${id}`);
    return { id, evidenceKind: fixtureKinds[id], grantsWriteAuthority: false };
  });
  const requiredCapabilities = [];
  if (fixtures.some((fixture) => fixture.evidenceKind === "live-channel")) requiredCapabilities.push("live-channel-delivery");
  if (item.prerequisites?.includes("test-write-authorization-required")) requiredCapabilities.push("authorized-test-write");
  return { version: 1, fixtures, requiredCapabilities, grantsWriteAuthority: false };
}

export function fixtureScopeAssertion(scope) {
  const descriptions = scope.fixtures.map(({ id, evidenceKind }) => `${id}=${evidenceKind}`).join(", ") || "only user-supplied text";
  return `Evidence scope: ${descriptions}. Static/synthetic evidence proves only fixture-scoped results, not live search, live business reads or writes. Fixture availability grants no write authority; live actions require separately authorized, correlated receipts.`;
}
