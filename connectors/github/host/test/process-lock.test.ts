import { basename, join, resolve } from "@std/path";
import { assertEquals, assertRejects } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  defaultGithubHostLockDirectory,
  GithubHostProcessLock,
  githubTargetProcessLockPath,
} from "../src/process-lock.ts";

describe("GitHub host process-lock paths", () => {
  it("uses configured and platform-specific private directories", () => {
    expect(defaultGithubHostLockDirectory(
      (key) => key === "CF_GITHUB_HOST_LOCK_DIR" ? " ./locks " : undefined,
    )).toBe(resolve("./locks"));
    expect(defaultGithubHostLockDirectory(
      (key) => key === "XDG_RUNTIME_DIR" ? "/runtime" : undefined,
    )).toBe(join(resolve("/runtime"), "commonfabric", "github-host"));
    expect(defaultGithubHostLockDirectory(
      (key) => key === "LOCALAPPDATA" ? "C:\\Users\\test\\AppData" : undefined,
      "windows",
      () => {
        throw new Error("uid must not be read on Windows");
      },
    )).toBe(
      join(resolve("C:\\Users\\test\\AppData"), "CommonFabric", "github-host"),
    );
  });

  it("rejects Windows hosts without a private runtime directory", () => {
    expect(() =>
      defaultGithubHostLockDirectory(
        () => undefined,
        "windows",
        () => 1,
      )
    ).toThrow("CF_GITHUB_HOST_LOCK_DIR is required");
  });

  it("derives stable credential-free keys from the complete target", async () => {
    const first = await githubTargetProcessLockPath(
      "https://user:secret@example.com/graphql?token=secret",
      "did:key:space",
      "GitHub.com/IanH",
      "/locks",
    );
    const same = await githubTargetProcessLockPath(
      "https://example.com/other",
      "did:key:space",
      "github.com/ianh",
      "/locks",
    );
    const other = await githubTargetProcessLockPath(
      "https://example.com/other",
      "did:key:other",
      "github.com/ianh",
      "/locks",
    );
    const otherApi = await githubTargetProcessLockPath(
      "https://other.example.com/graphql",
      "did:key:space",
      "github.com/ianh",
      "/locks",
    );
    const otherSource = await githubTargetProcessLockPath(
      "https://example.com/graphql",
      "did:key:space",
      "github.com/other",
      "/locks",
    );

    expect(first).toBe(same);
    expect(other).not.toBe(first);
    expect(otherApi).not.toBe(first);
    expect(otherSource).not.toBe(first);
    expect(basename(first)).toBe(
      "target-995ecb2de29f639f6f8e1138044198df1c73f8aab870f137a8bf773e7f12a225.lock",
    );
    expect(basename(first)).toMatch(/^target-[0-9a-f]{64}\.lock$/);
    expect(first.includes("secret")).toBe(false);
  });

  it("rejects line breaks in lock identity components", () => {
    expect(() =>
      githubTargetProcessLockPath(
        "https://example.com/\nignored",
        "did:key:space",
        "github.com/ianh",
        "/locks",
      )
    ).toThrow("must not contain line breaks");
    expect(() =>
      githubTargetProcessLockPath(
        "https://example.com",
        "did:key:space\nother",
        "rest",
        "/locks",
      )
    ).toThrow("must not contain line breaks");
    expect(() =>
      githubTargetProcessLockPath(
        "https://example.com",
        "did:key:space",
        "other\nrest",
        "/locks",
      )
    ).toThrow("must not contain line breaks");
    expect(() =>
      githubTargetProcessLockPath(
        "https://example.com",
        "did:key:space",
        "github.com/ianh\rignored",
        "/locks",
      )
    ).toThrow("must not contain line breaks");
  });
});

Deno.test("GitHub process locks exclude peers and release cleanly", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "github.lock");
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
      () => GithubHostProcessLock.acquire(path),
      Error,
      "another GitHub host holds the process lock",
    );

    const writer = child.stdin.getWriter();
    await writer.write(new Uint8Array([10]));
    await writer.close();
    assertEquals((await child.status).success, true);

    const acquired = await GithubHostProcessLock.acquire(path);
    await assertRejects(
      () => GithubHostProcessLock.acquire(path),
      Error,
      "another GitHub host holds the process lock",
    );
    await acquired.release();
    await acquired.release();
  } finally {
    await child.stdin.close().catch(() => undefined);
    await child.status;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("GitHub process locks reject symbolic links", async () => {
  if (Deno.build.os === "windows") return;
  const directory = await Deno.makeTempDir();
  const target = join(directory, "target");
  const path = join(directory, "github.lock");
  try {
    await Deno.writeTextFile(target, "do not replace\n", { mode: 0o600 });
    await Deno.symlink(target, path);
    await assertRejects(
      () => GithubHostProcessLock.acquire(path),
      Error,
      "process lock is not a regular file",
    );
    assertEquals(await Deno.readTextFile(target), "do not replace\n");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("GitHub process locks reject shared lock files", async () => {
  if (Deno.build.os === "windows") return;
  const directory = await Deno.makeTempDir();
  const path = join(directory, "github.lock");
  try {
    await Deno.writeTextFile(path, "", { mode: 0o666 });
    await Deno.chmod(path, 0o666);
    await assertRejects(
      () => GithubHostProcessLock.acquire(path),
      Error,
      "process lock is accessible by other users",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
