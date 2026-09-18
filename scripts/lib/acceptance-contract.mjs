import { readFile, realpath, lstat, chmod } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import Ajv from "ajv";

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const packageRootReal = realpathSync.native(packageRoot);
export const schemaPath = resolve(packageRoot, "tests", "acceptance", "manifest.schema.json");
export const executionStatuses = ["completed", "correctly_blocked", "failed", "infrastructure_blocked"];
export const businessResults = ["passed", "partial", "failed", "not_applicable"];
export const authorityResults = ["passed", "failed"];
export const budgetFields = ["modelRequests", "inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "toolCalls", "userTurns"];
export const gateVersion = "acceptance-core-2";

export async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function compileManifestValidator() {
  const schema = await loadJson(schemaPath);
  return new Ajv({
    allErrors: true,
    strict: true,
    allowUnionTypes: true,
    validateFormats: false,
    validateSchema: false,
  }).compile(schema);
}

export async function loadManifest(path) {
  const absolute = resolve(path);
  const manifest = await loadJson(absolute);
  const validate = await compileManifestValidator();
  if (!validate(manifest)) {
    const message = validate.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
    throw new TypeError(`Manifest validation failed: ${message}`);
  }
  const ids = new Set();
  for (const testCase of manifest.cases) {
    if (ids.has(testCase.id)) throw new TypeError(`Duplicate case id: ${testCase.id}`);
    ids.add(testCase.id);
  }
  return { manifest, manifestPath: absolute, manifestSha256: await sha256File(absolute) };
}

function isUnder(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

export function ensureAbsoluteRunRoot(runRoot) {
  if (!runRoot || !isAbsolute(runRoot)) throw new TypeError("--run-root must be an absolute path");
  const resolved = resolve(runRoot);
  const artifactsRoot = resolve(packageRoot, "artifacts");
  if (resolved === packageRoot) throw new TypeError("--run-root cannot be the repository root");
  if (isUnder(packageRoot, resolved) && !isUnder(artifactsRoot, resolved)) {
    throw new TypeError("--run-root inside the repository must be under ignored artifacts\\");
  }
  return resolved;
}

async function resolveFuturePath(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new TypeError("run path contains a dangling symlink");
    } catch (entryError) {
      if (entryError.code !== "ENOENT") throw entryError;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await resolveFuturePath(parent), relative(parent, path));
  }
}

export async function ensureSafeRunRoot(runRoot) {
  const realRoot = await resolveFuturePath(runRoot);
  const artifactsRootReal = resolve(packageRootReal, "artifacts");
  if (realRoot === packageRootReal) throw new TypeError("--run-root cannot resolve to the repository root");
  if (isUnder(packageRootReal, realRoot) && !isUnder(artifactsRootReal, realRoot)) {
    throw new TypeError("--run-root real path inside the repository must stay under artifacts\\");
  }
  if (isUnder(resolve(packageRoot, "artifacts"), runRoot) && !isUnder(artifactsRootReal, realRoot)) {
    throw new TypeError("--run-root symlink/junction escapes artifacts\\");
  }
  return realRoot;
}

export async function hardenPrivatePath(path, directory = false) {
  await chmod(path, directory ? 0o700 : 0o600);
}

export function assertAbsoluteAdapter(adapterPath) {
  if (!adapterPath || !isAbsolute(adapterPath)) throw new TypeError("--adapter must be an absolute path");
  return resolve(adapterPath);
}

export function makeRunId(suiteId, now = new Date(), random = randomUUID()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${suiteId}-${stamp}-${random}`;
}

const credentialKey = /^(?:secret|api[_-]?key|access[_-]?token|refresh[_-]?token|credential|password|private[_-]?key|authorization|cookie|set-cookie)$/i;
const secretPatterns = [
  /\b(?:sk|ghp|github_pat|pat|key|token)_[A-Za-z0-9_=-]{8,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
];
export function redact(value) {
  if (typeof value === "string") {
    let output = value.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]");
    for (const pattern of secretPatterns) output = output.replace(pattern, "[redacted-secret]");
    return output;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const clean = {};
    for (const [key, item] of Object.entries(value)) clean[key] = credentialKey.test(key) ? "[redacted]" : redact(item);
    return clean;
  }
  return value;
}

export async function importAdapter(adapterPath) {
  const module = await import(pathToFileURL(assertAbsoluteAdapter(adapterPath)).href);
  const factory = module.createAdapter ?? module.default;
  if (typeof factory !== "function") throw new TypeError("Adapter module must export createAdapter() or default function");
  const adapter = await factory();
  if (!adapter || typeof adapter.executeCase !== "function") throw new TypeError("Adapter must return an object with executeCase(case, context)");
  if (typeof adapter.cleanupCase !== "function") throw new TypeError("Adapter must implement cleanupCase(case, context) and return an explicit cleanup receipt");
  return adapter;
}

export function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function stableCaseRunId(runId, caseId) {
  return `${runId}${sep}${caseId}`;
}

export function zeroUsage() {
  return Object.fromEntries(budgetFields.map((field) => [field, 0]));
}

export function validateUsageShape(usage, { requirePricing = true } = {}) {
  const errors = [];
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return ["usage must be an object"];
  for (const field of budgetFields) if (!nonNegativeInteger(usage[field])) errors.push(`usage.${field} must be a finite non-negative integer`);
  if (requirePricing) {
    if (usage.priced !== true && usage.priced !== false) errors.push("usage.priced must explicitly declare priced/unpriced");
  }
  if (usage.priced === true && !nonNegativeInteger(usage.currencyMicros)) errors.push("usage.currencyMicros is required for priced usage");
  if (usage.priced === false && Object.hasOwn(usage, "currencyMicros")) errors.push("usage.currencyMicros must be omitted for unpriced usage");
  return errors;
}

export function usageExceeds(usage, caps) {
  const errors = [];
  for (const field of budgetFields) if (Number.isFinite(caps?.[field]) && usage[field] > caps[field]) errors.push(`usage.${field} ${usage[field]} exceeds cap ${caps[field]}`);
  if ((caps?.priced === true || Number.isFinite(caps?.currencyMicros)) &&
      (usage.priced !== true || !nonNegativeInteger(usage.currencyMicros))) {
    errors.push("priced budget requires priced usage with a finite currencyMicros value");
  }
  if (usage.priced === true && Number.isFinite(caps?.currencyMicros) && usage.currencyMicros > caps.currencyMicros) errors.push(`usage.currencyMicros ${usage.currencyMicros} exceeds cap ${caps.currencyMicros}`);
  return errors;
}
