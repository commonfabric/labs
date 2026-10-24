import { assert, assertEquals, assertMatch } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  gitShaForCliLibDir,
  relateShasIn,
  resolveCliGitSha,
} from "../lib/build-info.ts";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { success, stdout, stderr } = await new Deno.Command("git", {
    args: [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@test.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`,
    );
  }
  return new TextDecoder().decode(stdout).trim();
}

/** A repository shaped like a labs checkout: its own git directory and a
 * committed packages/cli/lib tree. Returns its HEAD. */
async function makeLabsLikeRepo(root: string): Promise<string> {
  await Deno.mkdir(join(root, "packages", "cli", "lib"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "packages", "cli", "lib", "build-info.ts"),
    "// fixture\n",
  );
  await git(root, "init");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  return await git(root, "rev-parse", "HEAD");
}

Deno.test("gitShaForCliLibDir", async (t) => {
  const tempDir = await Deno.makeTempDir({ prefix: "build-info-git-" });
  try {
    await t.step("reports HEAD for a real labs checkout", async () => {
      const root = join(tempDir, "labs");
      const head = await makeLabsLikeRepo(root);
      assertEquals(
        await gitShaForCliLibDir(join(root, "packages", "cli", "lib")),
        head,
      );
    });

    await t.step("reports HEAD for a linked worktree", async () => {
      const root = join(tempDir, "labs"); // created above
      const worktree = join(tempDir, "labs-worktree");
      await git(root, "worktree", "add", worktree);
      assertEquals(
        await gitShaForCliLibDir(join(worktree, "packages", "cli", "lib")),
        await git(worktree, "rev-parse", "HEAD"),
      );
    });

    await t.step(
      "vendored labs without its own git directory reports unknown, not the host repo's HEAD",
      async () => {
        // <host>/vendor/labs has no .git, so rev-parse resolves the HOST
        // repository — whose HEAD must not be reported. The host even has a
        // packages/cli/lib of its own to make sure the guard compares
        // locations, not mere existence.
        const host = join(tempDir, "host");
        await makeLabsLikeRepo(host);
        const vendoredLib = join(
          host,
          "vendor",
          "labs",
          "packages",
          "cli",
          "lib",
        );
        await Deno.mkdir(vendoredLib, { recursive: true });
        assertEquals(await gitShaForCliLibDir(vendoredLib), null);
      },
    );

    await t.step(
      "a directory outside any repository reports unknown",
      async () => {
        const bare = join(tempDir, "bare");
        await Deno.mkdir(bare, { recursive: true });
        assertEquals(await gitShaForCliLibDir(bare), null);
      },
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("relateShasIn", async (t) => {
  const repo = await Deno.makeTempDir({ prefix: "build-info-relate-" });
  try {
    // main: A -> B (HEAD); branch "other": A -> C.
    await Deno.writeTextFile(join(repo, "f"), "a\n");
    await git(repo, "init");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "A");
    const shaA = await git(repo, "rev-parse", "HEAD");
    await Deno.writeTextFile(join(repo, "f"), "b\n");
    await git(repo, "commit", "-am", "B");
    const shaB = await git(repo, "rev-parse", "HEAD");
    await git(repo, "checkout", "-b", "other", shaA);
    await Deno.writeTextFile(join(repo, "f"), "c\n");
    await git(repo, "commit", "-am", "C");
    const shaC = await git(repo, "rev-parse", "HEAD");
    await git(repo, "checkout", "-");

    await t.step("server behind cf: cli-ahead with a distance", async () => {
      assertEquals(await relateShasIn(repo, shaB, shaA), {
        kind: "cli-ahead",
        serverBehindBy: 1,
      });
    });

    await t.step("server ahead of cf: cli-behind", async () => {
      assertEquals(await relateShasIn(repo, shaA, shaB), {
        kind: "cli-behind",
      });
    });

    await t.step(
      "sibling branches with a provable base: diverged",
      async () => {
        assertEquals(await relateShasIn(repo, shaB, shaC), {
          kind: "diverged",
        });
      },
    );

    await t.step(
      "no provable common base (disjoint roots): unknown, not diverged",
      async () => {
        // An orphan branch models the shallow/disjoint-history case: both
        // commits exist, both ancestry probes answer "no", but the graph
        // cannot prove they truly diverged — merge-base has no answer.
        await git(repo, "checkout", "--orphan", "rootless");
        await Deno.writeTextFile(join(repo, "f"), "d\n");
        await git(repo, "add", ".");
        await git(repo, "commit", "-m", "D");
        const shaD = await git(repo, "rev-parse", "HEAD");
        assertEquals(await relateShasIn(repo, shaB, shaD), {
          kind: "unknown",
        });
      },
    );

    await t.step("a commit the history has never seen: unknown", async () => {
      assertEquals(
        await relateShasIn(repo, shaB, "deadbeef".repeat(5)),
        { kind: "unknown" },
      );
    });

    await t.step("a directory outside any repository: unknown", async () => {
      const bare = await Deno.makeTempDir({ prefix: "build-info-bare-" });
      try {
        assertEquals(await relateShasIn(bare, shaB, shaA), {
          kind: "unknown",
        });
      } finally {
        await Deno.remove(bare, { recursive: true });
      }
    });
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("resolveCliGitSha reports this checkout's HEAD for a source run", async () => {
  // Under `deno test` this is a source run (`Deno.build.standalone` false),
  // so resolution must come from git against the checkout containing
  // lib/build-info.ts — this repository (itself a worktree in worktree-based
  // setups, which this covers by construction).
  const sha = await resolveCliGitSha();
  assert(sha !== null, "source run in a checkout should resolve a commit");
  assertMatch(sha, /^[0-9a-f]{40}$/);
  const moduleDir = fromFileUrl(new URL("../lib", import.meta.url));
  assertEquals(sha, await git(moduleDir, "rev-parse", "HEAD"));
});
