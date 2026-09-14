import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { parseDshConfig } from "./config.js";
import { createDshRuntime } from "./runtime.js";
import { createNativeHarness } from "./native/harness.js";

export { createNativeHarness } from "./native/harness.js";

export default definePluginEntry({
  id: "dsh-native",
  name: "DeepSeek Harness Native",
  description: "Explicit-only AgentHarnessV2 using DSH with policy-bound OpenClaw coding tools.",
  configSchema: { parse: parseDshConfig },
  register(api) {
    const config = parseDshConfig(api.pluginConfig);
    const harness = createNativeHarness(config, createDshRuntime(config));
    api.registerAgentHarness(harness);
    api.lifecycle.registerRuntimeLifecycle({
      id: "dsh-native-runtime",
      cleanup: async ({ reason, sessionKey }) => {
        if (reason === "disable" || reason === "restart") await harness.dispose?.();
        else if (sessionKey) await harness.reset?.({ sessionKey, reason: reason === "delete" ? "deleted" : "reset" });
      },
    });
  },
});
