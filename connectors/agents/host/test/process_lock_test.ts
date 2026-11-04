import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { join, resolve } from "@std/path";
import {
  AgentsHostProcessLock,
  defaultAgentsHostLockDirectory,
  defaultTargetProcessLockPath,
} from "../src/process-lock.ts";

Deno.test("agent host process-lock directories honor runtime settings", () => {
  assertEquals(
    defaultAgentsHostLockDirectory((key) =>
      key === "CF_AGENTS_HOST_LOCK_DIR" ? " ./locks " : undefined
    ),
    resolve("./locks"),
  );
  assertEquals(
    defaultAgentsHostLockDirectory((key) =>
      key === "XDG_RUNTIME_DIR" ? "/runtime" : undefined
    ),
    join(resolve("/runtime"), "commonfabric", "agents-host"),
  );
  if (Deno.build.os !== "windows") {
    assertEquals(
      defaultAgentsHostLockDirectory((key) =>
        key === "TMPDIR" ? "/private/runtime" : undefined
      ),
      join(
        resolve("/private/runtime"),
        `commonfabric-agents-host-${Deno.uid()}`,
      ),
    );
  }
});

Deno.test("target process locks use the canonical API and resolved space", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const first = await defaultTargetProcessLockPath(
      "https://user:secret@FABRIC.example.test:443/",
      "did:key:space",
      "did:key:owner",
      directory,
    );
    const equivalent = await defaultTargetProcessLockPath(
      "https://fabric.example.test/ignored-api-path",
      "did:key:space",
      "did:key:owner",
      directory,
    );
    const differentSpace = await defaultTargetProcessLockPath(
      "https://fabric.example.test/",
      "did:key:other-space",
      "did:key:owner",
      directory,
    );
    const differentOwner = await defaultTargetProcessLockPath(
      "https://fabric.example.test/",
      "did:key:space",
      "did:key:other-owner",
      directory,
    );

    assertEquals(first, equivalent);
    assertNotEquals(first, differentSpace);
    assertNotEquals(first, differentOwner);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("AgentsHostProcessLock excludes another host process and releases cleanly", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "agents.lock");
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-sys=uid",
      join(import.meta.dirname!, "process-lock-holder.ts"),
      path,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    assertEquals(new TextDecoder().decode(ready.value).trim(), "locked");

    await assertRejects(
      () => AgentsHostProcessLock.acquire(path),
      Error,
      "another agent host holds the process lock",
    );

    const writer = child.stdin.getWriter();
    await writer.write(new Uint8Array([10]));
    await writer.close();
    assertEquals((await child.status).success, true);

    const acquired = await AgentsHostProcessLock.acquire(path);
    await assertRejects(
      () => AgentsHostProcessLock.acquire(path),
      Error,
      "another agent host holds the process lock",
    );
    await acquired.release();
    await acquired.release();
  } finally {
    await child.stdin.close().catch(() => undefined);
    await child.status;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("AgentsHostProcessLock rejects symbolic links", async () => {
  if (Deno.build.os === "windows") return;
  const directory = await Deno.makeTempDir();
  const target = join(directory, "target");
  const path = join(directory, "agents.lock");
  try {
    await Deno.writeTextFile(target, "do not replace\n", { mode: 0o600 });
    await Deno.symlink(target, path);
    await assertRejects(
      () => AgentsHostProcessLock.acquire(path),
      Error,
      "process lock file cannot be a symbolic link",
    );
    assertEquals(await Deno.readTextFile(target), "do not replace\n");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("AgentsHostProcessLock rejects shared lock directories", async () => {
  if (Deno.build.os === "windows") return;
  const root = await Deno.makeTempDir();
  const directory = join(root, "shared");
  try {
    await Deno.mkdir(directory, { mode: 0o755 });
    await Deno.chmod(directory, 0o755);
    await assertRejects(
      () => AgentsHostProcessLock.acquire(join(directory, "agents.lock")),
      Error,
      "process lock directory permits access by other users",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("AgentsHostProcessLock rejects invalid existing lock files", async () => {
  if (Deno.build.os === "windows") return;
  const directory = await Deno.makeTempDir();
  const path = join(directory, "agents.lock");
  try {
    await Deno.writeTextFile(path, "shared\n", { mode: 0o600 });
    await Deno.chmod(path, 0o644);
    await assertRejects(
      () => AgentsHostProcessLock.acquire(path),
      Error,
      "process lock file permits access by other users",
    );

    await Deno.remove(path);
    await Deno.mkdir(path, { mode: 0o700 });
    await assertRejects(
      () => AgentsHostProcessLock.acquire(path),
      Error,
      "process lock file is not a file",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
