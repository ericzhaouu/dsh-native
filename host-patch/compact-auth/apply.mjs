import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHostPatcher } from "../engine.mjs";
import * as spec from "./spec.mjs";

export const { inspectHost, patchHost } = createHostPatcher(spec);

if (process.argv[1] && fileURLToPath(import.meta.url) === await realpath(process.argv[1])) {
  const args = process.argv.slice(2);
  const actions = args.filter((arg) => ["--check", "--apply", "--restore"].includes(arg));
  const rootFlag = args.indexOf("--root");
  const allowed = new Set(["--check", "--apply", "--restore", "--root", "--offline-confirmed", "--recover-stale-lock"]);
  if (actions.length > 1 || rootFlag < 0 || !args[rootFlag + 1] ||
      args.some((arg, index) => index !== rootFlag + 1 && !allowed.has(arg))) {
    console.error("Usage: node host-patch/compact-auth/apply.mjs --root <OpenClaw package directory> --check|--apply|--restore [--offline-confirmed] [--recover-stale-lock]");
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await patchHost(args[rootFlag + 1], {
        action: actions[0]?.slice(2) ?? "check",
        offlineConfirmed: args.includes("--offline-confirmed"),
        recoverStaleLock: args.includes("--recover-stale-lock"),
      }), null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
