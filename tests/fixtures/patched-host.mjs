import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { patchHost } from "../../host-patch/apply.mjs";

export const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const safeDirectoryMode = 0o755;
const safeFileMode = 0o644;

async function chmodIfSupported(path, mode) {
  try {
    await chmod(path, mode);
  } catch (error) {
    if (process.platform === "win32" && ["EINVAL", "EPERM", "ENOSYS"].includes(error.code)) return;
    throw error;
  }
}

export async function securePluginModes(path) {
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) throw new Error(`Linked plugin fixture artifact: ${path}`);
  if (entry.isDirectory()) {
    await chmodIfSupported(path, safeDirectoryMode);
    for (const name of await readdir(path)) await securePluginModes(join(path, name));
    await chmodIfSupported(path, safeDirectoryMode);
    return;
  }
  if (entry.isFile()) await chmodIfSupported(path, safeFileMode);
}

export async function assertSafePluginArtifact(path) {
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) throw new Error(`Linked plugin fixture artifact: ${path}`);
  const unsafeWriteBits = entry.mode & 0o022;
  if (process.platform !== "win32" && unsafeWriteBits !== 0) throw new Error(`Unsafe writable plugin fixture mode ${((entry.mode & 0o777).toString(8))}: ${path}`);
  if (entry.isDirectory()) {
    for (const name of await readdir(path)) await assertSafePluginArtifact(join(path, name));
  }
}

async function assertRegularArtifactTree(path) {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) {
    throw new Error(`Plugin fixture artifact must be a regular file or directory: ${path}`);
  }
  if (entry.isDirectory()) {
    for (const name of await readdir(path)) await assertRegularArtifactTree(join(path, name));
  }
}

export async function copySafePluginTree(source, destination) {
  await assertRegularArtifactTree(source);
  try {
    await assertRegularArtifactTree(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await cp(source, destination, { recursive: true });
  await securePluginModes(destination);
  await assertSafePluginArtifact(destination);
}

export async function createPatchedHostFixture(root, { compactionAuth = false } = {}) {
  const source = join(projectRoot, "node_modules", "openclaw");
  const host = join(root, "openclaw");
  await mkdir(host);
  for (const name of ["package.json", "openclaw.mjs", "node-version.mjs", "dist", "docs"]) {
    await cp(join(source, name), join(host, name), { recursive: true });
  }
  // A separately installed optional SDK has its own dependency tree.
  await symlink(dirname(await realpath(source)), join(host, "node_modules"), "junction");
  await patchHost(host, { action: "apply", offlineConfirmed: true });
  const { patchHost: patchSourceReply } = await import("../../host-patch/source-reply/apply.mjs");
  await patchSourceReply(host, { action: "apply", offlineConfirmed: true });
  const { patchHost: patchTablePolicy } = await import("../../host-patch/table-policy/apply.mjs");
  await patchTablePolicy(host, { action: "apply", offlineConfirmed: true });
  if (compactionAuth) {
    const { patchHost: patchCompactionAuth } = await import("../../host-patch/compact-auth/apply.mjs");
    await patchCompactionAuth(host, { action: "apply", offlineConfirmed: true });
  }
  return { host, plugin: await createPluginFixture(root, host) };
}

export async function createPluginFixture(root, host) {
  const pluginSource = process.env.DSH_NATIVE_PACKAGED_ROOT ?? projectRoot;
  const plugin = join(root, "plugin");
  await mkdir(plugin, { mode: safeDirectoryMode });
  for (const name of ["package.json", "openclaw.plugin.json", "dist"]) {
    await copySafePluginTree(join(pluginSource, name), join(plugin, name));
  }
  await securePluginModes(plugin);
  await assertSafePluginArtifact(plugin);
  const pkg = JSON.parse(await readFile(join(pluginSource, "package.json"), "utf8"));
  for (const name of [...Object.keys(pkg.dependencies), "openclaw"]) {
    const target = join(plugin, "node_modules", ...name.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: safeDirectoryMode });
    await symlink(name === "openclaw" ? host : join(projectRoot, "node_modules", ...name.split("/")), target, "junction");
  }
  return plugin;
}
