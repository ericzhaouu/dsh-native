import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const v1Corpus = new Map(Object.entries({
  "single-turn.json": {
    materialized: "b243b803327f12f2540ddf2d744cbe7e049b64024059d57a4db508dfc3991371",
    lfBlob: "1acd08406520d35fce48e37f5781bf17208f584ada3e6ba8422c9500c2b2cade",
  },
  "multi-turn.json": {
    materialized: "48eba442c548f4b4ad6454c52fb09e47131ff0729ceecd82c5d7b0661bee4b5e",
    lfBlob: "e5e2fda0cd3443bffc62632696349a6dd75cd6cc1e9d6ae880c01d665ca39e54",
  },
  "feishu-canary.json": {
    materialized: "4665b07d194424c4905eb6f2513beb5296af95481709fe82608205a3b4d4cc19",
    lfBlob: "1bde4a5c4ecb1c642a84814f0d67adbdf8f568b46c79fefff9896c1cdefa5fb8",
  },
}));

const versionedCorpus = new Map(Object.entries({
  "v2/single-turn.json": {
    materialized: "c959002b2e85d10a335ddb88147845316012a6471f13963aa15c848657066863",
    lfBlob: "8f9fc3b1da6db645fee797ec61ef794bb509a483705f6ff7ec703bee6521488f",
  },
  "v3/single-turn.json": {
    materialized: "5343a40b68abde23ab35fa0b6d76d7bc13dd29b1f511192fff656e70ab2816e6",
    crlfCheckout: "c5464eb0e73f724f47ca2c6babcd46c3b0004d33c4e2af25c89933428b1c35db",
  },
  "v3/multi-turn.json": {
    materialized: "4c24294d3b7c4bb0f8f6f1cab8bbf257c504665a56431757e197358c80b8472c",
    crlfCheckout: "b55e3a183407017c07ca692c2596b0178fdbbab63d1990921ddbe26d02d63967",
  },
  "v4/single-turn.json": {
    materialized: "aa796ae19fb5bd73e34b3e3acdf15b7b28ab04497f6da159efb8a5d101d3508d",
    crlfCheckout: "0d2be6ae8d3d7db4b2c7ca8dbc61daefeedba1dc07b5ea230dbd795e37f43e64",
  },
  "v4/multi-turn.json": {
    materialized: "2641c95b23f09db0a50b4f0baeed16e54c1032c853177c5c6cfe848c5db9731d",
    crlfCheckout: "c9091c3dcf15d4cfb3b734a5abf5141ee7daaa2608461a1c1e36325885f3b0c4",
  },
  "v4/feishu-canary.json": {
    materialized: "9521bf74b79c4c0d899f38ce4e4e58eda741525dea93bd8d7954a884501acedb",
    crlfCheckout: "4ca9f021845a21b49306020615936d71fe7fa865b477ce84a63eff453df232dd",
  },
  "v4/review-map.json": {
    materialized: "4309b53d74e49dc00983941035793f7533822e34641a27248d527a7bcd732789",
    crlfCheckout: "2d95f3105b53000fc58aea5857666e5046e45936dba185260ef2466ac5ebf6ff",
  },
}));

const acceptanceFixtures = new Map(Object.entries({
  "synthetic-article.txt": {
    materialized: "453747775d22ae05035142a823b35097855be8a86c438b4c59d0e7f86f2b98df",
    crlfCheckout: "40255cc5470fe5215cacd8f8a59000e92fcb1cf3db83a3b38369711ba2562bd1",
  },
  "golden-search.json": {
    materialized: "1f8f3c1e0b4e8afb667d0584701585bfef5eeff1ac63bb45e26ffd1fa4b03395",
    crlfCheckout: "211c937df35e79b87ff26436f3ca6e4f238d9bf26a2b286019c8430cb39cda35",
  },
  "poisonous-sample-canaries.json": {
    materialized: "004107008a154fc7fd78c5e137b8a73a34c1e5831ff03e17b77dc6be9d030176",
    crlfCheckout: "a9e8f1dcf5b1429248abd8a6de18b1e6a5d69371dd39655dbff365b2d54a3ec3",
  },
  "feishu-table.json": {
    materialized: "5445bfbd5f31398749fdf894beb730d73ac5665f4cc73696359e9f586ecaebc4",
    crlfCheckout: "60b53d130a6a5ff3338c8dabe6f5337dd97e76ffb74a07896980ff8ad46932ac",
  },
  "scoped-file.json": {
    materialized: "2a2de9875491171990bfa654418e5e658d0de7cd7ef2fbded9d605c318a72f8f",
    crlfCheckout: "e6a0a3fb85b9db3c7efb377ec65b8ad17c41c3559e7625fe3b1b1a04e2b80c8f",
  },
}));

export const acceptanceByteContract = Object.freeze({
  v1Corpus: Object.freeze(Object.fromEntries([...v1Corpus].map(([name, contract]) => [name, Object.freeze({ ...contract })]))),
  versionedCorpus: Object.freeze(Object.fromEntries([...versionedCorpus].map(([name, contract]) => [name, Object.freeze({ ...contract })]))),
  fixtures: Object.freeze(Object.fromEntries([...acceptanceFixtures].map(([name, contract]) => [name, Object.freeze({ ...contract })]))),
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function toCrLf(bytes) {
  return Buffer.from(bytes.toString("utf8").replace(/\r?\n/g, "\r\n"), "utf8");
}

function toLf(bytes) {
  return Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
}

function materializeReviewedBytes(name, bytes, contract, convert, sourceDescription) {
  const actual = sha256(bytes);
  if (actual === contract.materialized) return bytes;
  const converted = convert(bytes);
  if (sha256(converted) === contract.materialized &&
      Object.values(contract).includes(actual)) return converted;
  throw new Error(`Acceptance byte contract mismatch for ${sourceDescription} ${name}`);
}

export function materializeAcceptanceCorpusBytes(name, bytes) {
  const contract = v1Corpus.get(name);
  if (contract) return materializeReviewedBytes(name, bytes, contract, toCrLf, "corpus");
  const versioned = versionedCorpus.get(name);
  if (!versioned) throw new Error(`Unknown acceptance corpus byte contract ${name}`);
  return materializeReviewedBytes(name, bytes, versioned, name.startsWith("v2/") ? toCrLf : toLf, "corpus");
}

export function materializeAcceptanceFixtureBytes(name, bytes) {
  const contract = acceptanceFixtures.get(name);
  if (!contract) throw new Error(`Unknown acceptance fixture byte contract ${name}`);
  return materializeReviewedBytes(name, bytes, contract, toLf, "fixture");
}

export async function readAcceptanceCorpusBytes(url, name) {
  return materializeAcceptanceCorpusBytes(name, await readFile(url));
}

export async function readAcceptanceFixtureBytes(url, name) {
  return materializeAcceptanceFixtureBytes(name, await readFile(url));
}
