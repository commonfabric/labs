import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  commitSubjects,
  findCommitMessages,
  realGit,
} from "../lib/view/commitmsg.ts";
import {
  git,
  initReftable,
  installHook,
  shellQuote,
} from "./view-commitmsg-test-helpers.ts";

Deno.test("findCommitMessages: a commit line without an object id yields no region", () => {
  const lines = ["commit not-a-sha", "Author: A", "", "    Subject", ""];
  assertEquals(findCommitMessages(lines).length, 0);
});

Deno.test("commitSubjects: a header after the email Subject ends it", () => {
  const full = "0123456789abcdef0123456789abcdef01234567";
  const subjects = commitSubjects([
    `From ${full} Mon Sep 17 00:00:00 2001`,
    "From: A B <a@b.example>",
    "Date: Wed, 1 Jul 2026 12:00:00 -0700",
    "Subject: [PATCH] Fix it",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "diff --git a/f b/f",
  ]);
  assertEquals(subjects.get(full), "Fix it");
});

Deno.test({
  name: "realGit: source hooks observe their configured hooks path",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
      const hooksName = "custom hooks";
      await git(root, ["config", "core.hooksPath", hooksName]);
      const hooks = `${root}/${hooksName}`;
      await Deno.mkdir(hooks);
      const marker = `${root}/pre-commit-ran`;
      const hook = `${hooks}/pre-commit`;
      await Deno.writeTextFile(
        hook,
        `#!/bin/sh
test "$(git config --get core.hooksPath)" = ${shellQuote(hooksName)} || exit 41
printf ran > ${shellQuote(marker)}
`,
      );
      await Deno.chmod(hook, 0o755);
      const runner = realGit(root);
      const original = runner.headSha();
      assert(original, "repository has a HEAD commit");

      runner.amendCommit("amended", new Map(), original);

      assertEquals(await Deno.readTextFile(marker), "ran");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("realGit: amends a detached reftable HEAD", async () => {
  const root = await Deno.makeTempDir();
  try {
    if (!await initReftable(root)) return;
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await Deno.writeTextFile(`${root}/f.txt`, "original\n");
    await git(root, ["add", "f.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    const branch = (await git(root, ["symbolic-ref", "HEAD"])).trim();
    const original = (await git(root, ["rev-parse", "HEAD"])).trim();
    await git(root, ["checkout", "-q", "--detach"]);
    const runner = realGit(root);

    const result = runner.amendCommit(
      "detached amend",
      new Map([[`${root}/f.txt`, "amended\n"]]),
      original,
      "HEAD",
    );

    assert(result.head !== original, "the detached commit was replaced");
    assertEquals(runner.headRef!(), "HEAD");
    assertEquals(runner.headSha(), result.head);
    assertEquals((await git(root, ["rev-parse", branch])).trim(), original);
    assertEquals(await git(root, ["show", "HEAD:f.txt"]), "amended\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: rejects an insertion at a hidden deletion boundary", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    const runner = realGit(root);

    assertThrows(
      () =>
        runner.applyFileChanges(
          "A\nX\nB\n",
          "A\nB\n",
          "A\nP\nB\n",
          `${root}/f.txt`,
        ),
      Error,
      "overlap workspace changes",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "realGit: handles an index path beginning with a stage prefix",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      const path = `${root}/1:f.txt`;
      await Deno.writeTextFile(path, "original\n");
      await git(root, ["add", "--", "1:f.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");

      runner.amendCommit("amended", new Map([[path, "pager\n"]]), head);
      assertEquals(await git(root, ["show", "HEAD:1:f.txt"]), "pager\n");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "realGit: rollback preserves a concurrent update to the original branch",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await Deno.writeTextFile(`${root}/f.txt`, "original\n");
      await git(root, ["add", "f.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      await git(root, ["branch", "topic"]);
      const runner = realGit(root);
      const branch = runner.headRef!();
      const head = runner.headSha();
      assert(branch && head, "repository has a branch and HEAD commit");
      const tree = (await git(root, ["rev-parse", `${head}^{tree}`])).trim();
      const concurrent = (await git(
        root,
        ["commit-tree", tree, "-p", head],
        "concurrent\n",
      )).trim();
      await installHook(
        root,
        "pre-commit",
        `git --git-dir=${shellQuote(`${root}/.git`)} update-ref ${
          shellQuote(branch)
        } ${shellQuote(concurrent)} ${shellQuote(head)}\ngit checkout -q topic`,
      );

      let error = "";
      try {
        runner.amendCommit("amended", new Map(), head, branch);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      assert(error.length > 0, "the raced amend failed");
      assertEquals(await git(root, ["rev-parse", branch]), `${concurrent}\n`);
      assertEquals(
        await git(root, ["rev-parse", "refs/heads/topic"]),
        `${head}\n`,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("realGit: preserves a selected path staged for deletion", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    const path = `${root}/selected.txt`;
    await Deno.writeTextFile(path, "original\n");
    await git(root, ["add", "selected.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    await git(root, ["rm", "-q", "--cached", "selected.txt"]);
    await Deno.writeTextFile(path, "workspace\n");
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    runner.amendCommit(
      "amended",
      new Map([[path, "committed by pager\n"]]),
      head,
    );

    assertEquals(
      await git(root, ["show", "HEAD:selected.txt"]),
      "committed by pager\n",
    );
    assertEquals(
      await git(root, ["ls-files", "--stage", "--", "selected.txt"]),
      "",
    );
    assertEquals(await Deno.readTextFile(path), "workspace\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name:
    "realGit: reports when a hook restores the old ref before ownership is established",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
      const runner = realGit(root);
      const branch = runner.headRef!();
      const head = runner.headSha();
      assert(branch && head, "repository has a branch and HEAD commit");
      await installHook(
        root,
        "reference-transaction",
        `if test "\${1-}" = committed; then
  rm -f "$(dirname "$GIT_INDEX_FILE")/reference-transactions"
fi`,
      );
      await installHook(
        root,
        "post-commit",
        `git update-ref ${shellQuote(branch)} ${shellQuote(head)}`,
      );

      assertThrows(
        () => runner.amendCommit("amended", new Map(), head),
        Error,
        "did not publish the amended commit",
      );
      assertEquals(runner.headSha(), head);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
