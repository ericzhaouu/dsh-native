import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [mode, checkpoint] = process.argv.slice(2);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
process.on("SIGTERM", () => {});
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "run") {
    let descendant;
    if (mode === "grandchild") {
      descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
        { stdio: "ignore" });
    }
    writeFileSync(checkpoint, JSON.stringify({ pid: process.pid, descendant: descendant?.pid }));
  }
});
send({ jsonrpc: "2.0", method: "event", params: { type: "ready", version: 1, dshVersion: "0.1.2-alpha.2" } });
setInterval(() => {}, 1000);
