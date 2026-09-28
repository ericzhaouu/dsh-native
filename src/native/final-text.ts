import { createRequire } from "node:module";
import { dirname } from "node:path";

export async function assertFinalTextCompanion(): Promise<void> {
  try {
    const require = createRequire(import.meta.url);
    const root = dirname(dirname(dirname(require.resolve("openclaw/plugin-sdk/agent-harness-runtime"))));
    const patcherUrl = new URL("../../host-patch/chat-final-text/apply.mjs", import.meta.url);
    const { patchHost } = await import(patcherUrl.href) as {
      patchHost(root: string): Promise<{ status: string }>;
    };
    if ((await patchHost(root)).status !== "applied") throw new Error("companion is not fully applied");
  } catch (cause) {
    throw new Error("dsh-native: chat-final-text companion required; stop the Gateway, apply the companion, and restart", { cause });
  }
}
