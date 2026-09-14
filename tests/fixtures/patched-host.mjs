import { cp, mkdir, readFile, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { patchHost } from "../../host-patch/apply.mjs";

export const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export async function createPatchedHostFixture(root) {
  const pluginSource = process.env.DSH_NATIVE_PACKAGED_ROOT ?? projectRoot;
  const source = join(projectRoot, "node_modules", "openclaw");
  const host = join(root, "openclaw");
  await mkdir(host);
  for (const name of ["package.json", "openclaw.mjs", "node-version.mjs", "dist", "docs"]) {
    await cp(join(source, name), join(host, name), { recursive: true });
  }
  await symlink(join(projectRoot, "node_modules"), join(host, "node_modules"), "junction");
  await patchHost(host, { action: "apply", offlineConfirmed: true });
  const plugin = join(root, "plugin");
  await mkdir(plugin);
  for (const name of ["package.json", "openclaw.plugin.json", "dist"]) {
    await cp(join(pluginSource, name), join(plugin, name), { recursive: true });
  }
  const pkg = JSON.parse(await readFile(join(pluginSource, "package.json"), "utf8"));
  for (const name of [...Object.keys(pkg.dependencies), "openclaw"]) {
    const target = join(plugin, "node_modules", ...name.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await symlink(name === "openclaw" ? host : join(projectRoot, "node_modules", ...name.split("/")), target, "junction");
  }
  return { host, plugin };
}
