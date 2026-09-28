import { isAbsolute } from "node:path";

export function campaignEnvironment(platform, root) {
  if (platform === "linux" && !root) {
    throw new Error("Linux campaign tests require explicit DSH_CAMPAIGN_TEST_ROOT; refusing to skip coverage");
  }
  if (root && !isAbsolute(root)) throw new Error("DSH_CAMPAIGN_TEST_ROOT must be absolute");
  return { root, skip: !root && "Filesystem tests require explicit DSH_CAMPAIGN_TEST_ROOT" };
}
