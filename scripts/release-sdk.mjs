#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APPROVED_SDK_SHA256 } from "./lib/release-manifest.mjs";

export function approvedSdkSource(value, pin) {
  if (pin?.toLowerCase() !== APPROVED_SDK_SHA256) throw new Error("Approved SDK SHA-256 is required.");
  let url;
  try { url = new URL(value); } catch { throw new Error("Approved official SDK URL is required."); }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash) {
    throw new Error("SDK URL must be credential-free HTTPS without query or fragment.");
  }
  if (url.href === "https://registry.npmjs.org/openclaw/-/openclaw-2026.9.2.tgz") {
    return { url: url.href, kind: "tgz" };
  }
  if (url.hostname === "github.com" && /^\/openclaw\/openclaw\/releases\/download\/[^/%]+\/[^/%]+\.tgz$/.test(url.pathname)) {
    return { url: url.href, kind: "tgz" };
  }
  const api = url.hostname === "api.github.com" &&
    /^\/repos\/openclaw\/openclaw\/actions\/(?:runs\/[0-9]+\/)?artifacts\/([0-9]+)(?:\/zip)?$/.exec(url.pathname);
  const web = url.hostname === "github.com" &&
    /^\/openclaw\/openclaw\/actions\/runs\/[0-9]+\/artifacts\/([0-9]+)$/.exec(url.pathname);
  const match = api || web;
  if (!match) throw new Error("SDK source is not an approved official release or artifact URL.");
  return { url: `https://api.github.com/repos/openclaw/openclaw/actions/artifacts/${match[1]}/zip`, kind: "zip" };
}

export async function downloadSdkBytes(source, token, fetcher = fetch) {
  let url = source.url;
  for (let hop = 0; hop < 6; hop++) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Unsafe SDK redirect.");
    const headers = { "User-Agent": "dsh-native-sdk-validation" };
    // Credentials go only to the initial official API request, never to a redirect.
    if (hop === 0 && source.kind === "zip" && parsed.hostname === "api.github.com" && token) {
      headers.Authorization = `Bearer ${token}`;
      headers.Accept = "application/vnd.github+json";
    }
    let response;
    try { response = await fetcher(url, { headers, redirect: "manual", signal: AbortSignal.timeout(120000) }); }
    catch { throw new Error("SDK download unavailable; no URL or credential details recorded."); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("SDK redirect has no destination.");
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`SDK download failed (HTTP ${response.status}).`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 512 * 1024 * 1024) throw new Error("SDK download exceeds the size limit.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new Error("SDK redirect limit exceeded.");
}

function tarballs(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new Error("SDK artifact contains a link.");
    const path = join(directory, entry.name);
    return entry.isDirectory() ? tarballs(path) : entry.isFile() && entry.name.endsWith(".tgz") ? [path] : [];
  });
}

async function main() {
  const source = approvedSdkSource(process.env.SDK_URL, process.env.SDK_SHA256);
  const parent = resolve("artifacts", "release-private");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "sdk-"));
  const bytes = await downloadSdkBytes(source, process.env.SDK_TOKEN);
  let sdkPackage = join(directory, "openclaw-sdk.tgz");
  if (source.kind === "tgz") writeFileSync(sdkPackage, bytes, { flag: "wx" });
  else {
    const zip = join(directory, "sdk.zip");
    const unpacked = join(directory, "unpacked");
    writeFileSync(zip, bytes, { flag: "wx" });
    // Expand-Archive rejects traversal; paths are environment values, not interpolated commands.
    execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:SDK_ZIP -DestinationPath $env:SDK_UNPACKED"], {
      env: { ...process.env, SDK_TOKEN: "", SDK_URL: "", SDK_ZIP: zip, SDK_UNPACKED: unpacked },
      stdio: "pipe",
    });
    const matches = tarballs(unpacked);
    if (matches.length !== 1) throw new Error("Expected exactly one SDK .tgz inside the official artifact.");
    [sdkPackage] = matches;
  }
  const actual = createHash("sha256").update(readFileSync(sdkPackage)).digest("hex");
  if (actual !== APPROVED_SDK_SHA256) throw new Error("SDK SHA-256 mismatch; downloaded bytes are not approved.");
  if (!process.env.GITHUB_ENV) throw new Error("This download command requires the CI environment file.");
  appendFileSync(process.env.GITHUB_ENV, `SDK_PACKAGE=${sdkPackage}\n`);
  console.log(JSON.stringify({ ok: true, sdkSha256: actual }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("Approved SDK unavailable or invalid. No SDK bytes or credential diagnostics will be uploaded.");
    process.exitCode = 1;
  });
}
