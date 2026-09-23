import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertSafePluginArtifact, copySafePluginTree } from "./fixtures/patched-host.mjs";

const project = dirname(dirname(fileURLToPath(import.meta.url)));

test("plugin fixture copies are made non-writable before gateway launch", async (t) => {
  const root = join(project, "artifacts", `plugin-fixture-modes-${process.pid}-${randomUUID()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const destination = join(root, "plugin", "dist");
  await mkdir(join(source, "nested"), { recursive: true });
  await writeFile(join(source, "index.js"), "export {};\n");
  await writeFile(join(source, "nested", "chunk.js"), "export {};\n");
  if (process.platform !== "win32") {
    await chmod(source, 0o777);
    await chmod(join(source, "nested"), 0o777);
    await chmod(join(source, "index.js"), 0o777);
    await chmod(join(source, "nested", "chunk.js"), 0o777);
  }

  await copySafePluginTree(source, destination);
  await assertSafePluginArtifact(dirname(destination));

  if (process.platform !== "win32") {
    assert.equal((await stat(destination)).mode & 0o777, 0o755);
    assert.equal((await stat(join(destination, "nested"))).mode & 0o777, 0o755);
    assert.equal((await stat(join(destination, "index.js"))).mode & 0o777, 0o644);
    assert.equal((await stat(join(destination, "nested", "chunk.js"))).mode & 0o777, 0o644);
  }
});

test("plugin artifact copies reject linked source trees without changing the external target", async (t) => {
  const root = join(project, "artifacts", `plugin-fixture-links-${process.pid}-${randomUUID()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const external = join(root, "external");
  const source = join(root, "source");
  await mkdir(external, { recursive: true });
  await mkdir(source);
  await writeFile(join(external, "index.js"), "external fixture bytes");
  await symlink(external, join(source, "linked-dist"), process.platform === "win32" ? "junction" : "dir");
  const before = (await stat(join(external, "index.js"))).mode;
  await assert.rejects(copySafePluginTree(source, join(root, "destination")), /regular file or directory/);
  assert.equal(await readFile(join(external, "index.js"), "utf8"), "external fixture bytes");
  assert.equal((await stat(join(external, "index.js"))).mode, before);
  await assert.rejects(assertSafePluginArtifact(join(source, "linked-dist")), /Linked plugin fixture/);
});
