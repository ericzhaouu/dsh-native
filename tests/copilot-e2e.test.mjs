import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("OpenClaw native GPT Responses completes, resumes and disables in an offline fixture", { timeout: 620000 }, async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./native-e2e.test.mjs", import.meta.url))], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("NODE_TEST"))),
      DSH_NATIVE_E2E_PROVIDER: "github-copilot" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject); child.once("close", resolve);
  });
  assert.equal(code, 0, output);
  assert.match(output, /actual OpenClaw selects native DSH/);
});
