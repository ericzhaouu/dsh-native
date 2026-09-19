import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const allowedKinds = new Set(["file", "table", "inline"]);
const allowedFields = new Set(["kind", "agents", "path", "url", "description", "pageSize", "modelVisible", "sha256"]);
const hiddenKeyPattern = /^(?:__proto__|constructor|prototype|oracle|expected|answerKey|groundTruth|forbiddenOutputSubstrings|forbiddenSubstrings|resultIds)$/i;
const credentialQueryPattern = /(?:secret|api[_-]?key|access[_-]?token|refresh[_-]?token|credential|password|private[_-]?key|authorization|cookie)/i;
const secretValuePatterns = [
  /\b(?:sk|ghp|github_pat|pat|key|token)_[A-Za-z0-9_=-]{8,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i,
];
const maxInlineBytes = 16 * 1024;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function stableJson(value) {
  return JSON.stringify(value, (_key, item) => item, 2);
}

function assertNoSecretString(value, location) {
  if (typeof value !== "string") return;
  for (const pattern of secretValuePatterns) {
    if (pattern.test(value)) throw new TypeError(`${location} contains a secret-looking value`);
  }
}

function assertDescription(value, fixtureId) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${fixtureId}.description must be a string`);
  if (value.length > 1000) throw new TypeError(`${fixtureId}.description is too long`);
  assertNoSecretString(value, `${fixtureId}.description`);
  return value;
}

function assertAgents(value, fixtureId, agentId) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${fixtureId}.agents must be a non-empty allowlist`);
  for (const agent of value) {
    if (typeof agent !== "string" || agent.length === 0 || agent.length > 128) throw new TypeError(`${fixtureId}.agents contains an invalid agent id`);
    assertNoSecretString(agent, `${fixtureId}.agents`);
  }
  if (!value.includes(agentId)) throw new TypeError(`${fixtureId} is not allowed for agent ${agentId}`);
  return [...value];
}

function agentIdFromProfile(agentProfile) {
  if (typeof agentProfile === "string" && agentProfile) return agentProfile;
  if (!isPlainObject(agentProfile)) return undefined;
  for (const key of ["agentId", "id", "profileId", "name"]) {
    if (typeof agentProfile[key] === "string" && agentProfile[key]) return agentProfile[key];
  }
  return undefined;
}

function isUnder(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

async function assertRegularNoLink(path, label) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new TypeError(`${label} must not be a symlink or junction`);
  if (!stat.isFile()) throw new TypeError(`${label} must be an existing regular file`);
  return stat;
}

async function loadMapFromPath(resourceMapPath) {
  if (typeof resourceMapPath !== "string" || !isAbsolute(resourceMapPath)) throw new TypeError("scope.resourceMapPath must be an absolute path");
  const mapPath = resolve(resourceMapPath);
  await assertRegularNoLink(mapPath, "scope.resourceMapPath");
  const doc = JSON.parse(await readFile(mapPath, "utf8"));
  if (!isPlainObject(doc) || doc.version !== 1 || !isPlainObject(doc.resources)) {
    throw new TypeError("resourceMapPath JSON must have shape {version:1, resources:{...}}");
  }
  return doc.resources;
}

function selectResource(raw, fixtureId, agentId) {
  if (!isPlainObject(raw)) throw new TypeError(`${fixtureId} resource must be an object`);
  if (typeof raw.kind === "string") return raw;
  const selected = raw[agentId];
  if (selected === undefined) throw new TypeError(`${fixtureId} has no resource selection for agent ${agentId}`);
  if (!isPlainObject(selected)) throw new TypeError(`${fixtureId}.${agentId} resource must be an object`);
  return selected;
}

function assertWhitelisted(record, fixtureId) {
  for (const key of Object.keys(record)) {
    if (!allowedFields.has(key)) throw new TypeError(`${fixtureId} has unsupported field ${key}`);
  }
}

function validateVisibleJson(value, location, seen = new Set()) {
  if (value === null) return;
  const type = typeof value;
  if (type === "string") {
    if (value.length > 4000) throw new TypeError(`${location} string is too long`);
    assertNoSecretString(value, location);
    return;
  }
  if (type === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${location} number must be finite`);
    return;
  }
  if (type === "boolean") return;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError(`${location} must be acyclic JSON`);
    if (value.length > 200) throw new TypeError(`${location} array is too large`);
    seen.add(value);
    value.forEach((item, index) => validateVisibleJson(item, `${location}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) throw new TypeError(`${location} must be acyclic JSON`);
    const entries = Object.entries(value);
    if (entries.length > 100) throw new TypeError(`${location} object has too many keys`);
    seen.add(value);
    for (const [key, item] of entries) {
      if (hiddenKeyPattern.test(key)) throw new TypeError(`${location}.${key} is hidden-oracle metadata and cannot be model-visible`);
      if (credentialQueryPattern.test(key)) throw new TypeError(`${location}.${key} looks credential-related`);
      validateVisibleJson(item, `${location}.${key}`, seen);
    }
    seen.delete(value);
    return;
  }
  throw new TypeError(`${location} must be JSON-serializable primitive data`);
}

function validateSha256(value, fixtureId) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) throw new TypeError(`${fixtureId}.sha256 must be a 64-character hex string`);
  return value.toLowerCase();
}

async function validatePath(path, fixtureId, scope) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new TypeError(`${fixtureId}.path must be absolute`);
  const resolved = resolve(path);
  await assertRegularNoLink(resolved, `${fixtureId}.path`);
  const roots = scope.allowedFixtureRoots;
  if (!Array.isArray(roots) || roots.length === 0) throw new TypeError("scope.allowedFixtureRoots is required for file/table path fixtures");
  const realPath = await realpath(resolved);
  let contained = false;
  for (const root of roots) {
    if (typeof root !== "string" || !isAbsolute(root)) throw new TypeError("scope.allowedFixtureRoots entries must be absolute paths");
    const realRoot = await realpath(resolve(root));
    if (isUnder(realRoot, realPath)) contained = true;
  }
  if (!contained) throw new TypeError(`${fixtureId}.path is outside allowedFixtureRoots`);
  return resolved;
}

async function verifyHash(path, expected, fixtureId) {
  if (!expected) return undefined;
  const actual = createHash("sha256").update(await readFile(path)).digest("hex");
  if (actual !== expected) throw new TypeError(`${fixtureId}.sha256 mismatch`);
  return actual;
}

function validateUrl(value, fixtureId, scope) {
  if (typeof value !== "string") throw new TypeError(`${fixtureId}.url must be a string`);
  let parsed;
  try { parsed = new URL(value); } catch {
    throw new TypeError(`${fixtureId}.url must be a valid URL`);
  }
  if (parsed.protocol !== "https:") throw new TypeError(`${fixtureId}.url must use https`);
  if (parsed.username || parsed.password) throw new TypeError(`${fixtureId}.url must not embed credentials`);
  for (const key of parsed.searchParams.keys()) {
    if (credentialQueryPattern.test(key)) throw new TypeError(`${fixtureId}.url query contains credential-like parameter ${key}`);
  }
  if (Array.isArray(scope.resourceHosts) && scope.resourceHosts.length > 0) {
    const hosts = new Set(scope.resourceHosts.map((host) => String(host).toLowerCase()));
    if (!hosts.has(parsed.hostname.toLowerCase())) throw new TypeError(`${fixtureId}.url host is not approved`);
  }
  return parsed.href;
}

function validatePageSize(value, fixtureId) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new TypeError(`${fixtureId}.pageSize must be an integer from 1 to 1000`);
  return value;
}

async function validateRecord(record, fixtureId, agentId, scope) {
  assertWhitelisted(record, fixtureId);
  const kind = record.kind;
  if (!allowedKinds.has(kind)) throw new TypeError(`${fixtureId}.kind must be file, table, or inline`);
  assertAgents(record.agents, fixtureId, agentId);
  const description = assertDescription(record.description, fixtureId);
  const sha256 = validateSha256(record.sha256, fixtureId);
  const pageSize = validatePageSize(record.pageSize, fixtureId);

  if (kind === "inline") {
    if (!Object.hasOwn(record, "modelVisible")) throw new TypeError(`${fixtureId}.modelVisible is required for inline resources`);
    if (record.path !== undefined || record.url !== undefined || record.sha256 !== undefined || record.pageSize !== undefined) {
      throw new TypeError(`${fixtureId} inline resource cannot declare path, url, sha256, or pageSize`);
    }
    validateVisibleJson(record.modelVisible, `${fixtureId}.modelVisible`);
    if (Buffer.byteLength(JSON.stringify(record.modelVisible), "utf8") > maxInlineBytes) throw new TypeError(`${fixtureId}.modelVisible exceeds ${maxInlineBytes} bytes`);
    return {
      binding: { fixtureId, kind },
      visible: { fixtureId, kind, description, modelVisible: record.modelVisible },
    };
  }

  if (record.modelVisible !== undefined) throw new TypeError(`${fixtureId}.${kind} resource must not inline modelVisible content`);
  if (kind === "file") {
    if (record.url !== undefined || record.pageSize !== undefined) throw new TypeError(`${fixtureId} file resource cannot declare url or pageSize`);
    const path = await validatePath(record.path, fixtureId, scope);
    const actualSha = await verifyHash(path, sha256, fixtureId);
    return {
      binding: { fixtureId, kind, path, sha256: actualSha ?? sha256 },
      visible: { fixtureId, kind, path, description },
    };
  }

  const hasPath = record.path !== undefined;
  const hasUrl = record.url !== undefined;
  if (hasPath === hasUrl) throw new TypeError(`${fixtureId} table resource must declare exactly one of path or url`);
  const address = hasPath ? { path: await validatePath(record.path, fixtureId, scope) } : { url: validateUrl(record.url, fixtureId, scope) };
  const actualSha = hasPath ? await verifyHash(address.path, sha256, fixtureId) : undefined;
  const effectivePageSize = pageSize ?? 10;
  return {
    binding: { fixtureId, kind, ...address, pageSize: effectivePageSize, sha256: actualSha ?? sha256 },
    visible: { fixtureId, kind, ...address, description, pageSize: effectivePageSize },
  };
}

export async function loadAcceptanceResources(scope, { agentProfile, fixtureNames, runId } = {}) {
  if (!isPlainObject(scope)) throw new TypeError("scope must be an object");
  const agentId = agentIdFromProfile(agentProfile);
  if (!agentId) throw new TypeError("agentProfile must identify a logical agent");
  if (!Array.isArray(fixtureNames) || fixtureNames.length === 0) throw new TypeError("fixtureNames must be a non-empty array");
  for (const name of fixtureNames) {
    if (typeof name !== "string" || name.length === 0) throw new TypeError("fixtureNames entries must be non-empty strings");
  }

  const resources = scope.resourceMapPath !== undefined ? await loadMapFromPath(scope.resourceMapPath) : scope.resourceMap;
  if (!isPlainObject(resources)) throw new TypeError("scope.resourceMap or scope.resourceMapPath is required");

  const bindings = [];
  const visibleResources = [];
  for (const fixtureId of fixtureNames) {
    if (!Object.hasOwn(resources, fixtureId)) throw new TypeError(`requested fixture ${fixtureId} is missing from resource map`);
    const selected = selectResource(resources[fixtureId], fixtureId, agentId);
    const normalized = await validateRecord(selected, fixtureId, agentId, scope);
    bindings.push(Object.fromEntries(Object.entries(normalized.binding).filter(([, value]) => value !== undefined)));
    visibleResources.push(Object.fromEntries(Object.entries(normalized.visible).filter(([, value]) => value !== undefined)));
  }

  const modelVisibleContext = [
    "Acceptance resource references for this run are addresses, not blanket authority. Use them only when the current turn scope authorizes the matching tool/resource action.",
    stableJson({ agentProfile: agentId, resources: visibleResources }),
  ].join("\n");

  return {
    modelVisibleContext,
    bindings,
    observations: {
      runId: typeof runId === "string" ? runId : undefined,
      agentProfile: agentId,
      fixtureCount: bindings.length,
      fixtureNames: [...fixtureNames],
    },
  };
}
