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

Deno.test("findCommitMessages: a Merge header line is skipped", () => {
  const lines = [
    "commit abcdef1234567",
    "Merge: 111 222",
    "Author: A B <a@b>",
    "Date:   today",
    "",
    "    Merge branch 'x'",
    "",
  ];
  const msgs = findCommitMessages(lines);
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].start, 5);
  assertEquals(msgs[0].end, 5);
});

Deno.test("commitSubjects: a commit with no discernible subject is absent", () => {
  const lines = ["commit deadbeef", "Author: A", "", "diff --git a/f b/f"];
  assertEquals(commitSubjects(lines).has("deadbeef"), false);
});

Deno.test({
  name: "realGit: preserves an explicitly empty core.hooksPath",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
      const marker = `${root}/post-commit-ran`;
      await installHook(
        root,
        "post-commit",
        `printf ran > ${shellQuote(marker)}`,
      );
      await git(root, ["config", "core.hooksPath", ""]);
      const runner = realGit(root);
      const original = runner.headSha();
      assert(original, "repository has a HEAD commit");

      runner.amendCommit("amended", new Map(), original);

      let hookRan = true;
      try {
        await Deno.stat(marker);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) hookRan = false;
        else throw error;
      }
      assert(!hookRan, "the disabled hook did not run");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("realGit: amends reftable commits in a linked worktree", async () => {
  const parent = await Deno.makeTempDir();
  const root = `${parent}/repository`;
  const linked = `${parent}/linked`;
  try {
    await Deno.mkdir(root);
    if (!await initReftable(root)) return;
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await Deno.writeTextFile(`${root}/f.txt`, "original\n");
    await git(root, ["add", "f.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    await git(root, ["worktree", "add", "-q", "-b", "topic", linked]);
    const runner = realGit(linked);
    const original = runner.headSha();
    const branch = runner.headRef!();
    assert(original && branch, "the linked worktree has a branch and commit");

    const result = runner.amendCommit(
      "linked amend",
      new Map([[`${linked}/f.txt`, "linked\n"]]),
      original,
      branch,
    );

    assert(result.head !== original, "the linked-worktree commit was replaced");
    assertEquals(runner.headSha(), result.head);
    assertEquals(await git(linked, ["show", "HEAD:f.txt"]), "linked\n");
    assertEquals((await git(root, ["rev-parse", branch])).trim(), result.head);
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("realGit: amends selected files and preserves unrelated staged changes", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await Deno.writeTextFile(`${root}/selected.txt`, "old selected\n");
    await Deno.writeTextFile(`${root}/unrelated.txt`, "old unrelated\n");
    await git(root, ["add", "selected.txt", "unrelated.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);

    await Deno.writeTextFile(`${root}/selected.txt`, "new selected\n");
    await Deno.writeTextFile(`${root}/unrelated.txt`, "staged unrelated\n");
    await git(root, ["add", "unrelated.txt"]);

    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");
    const status = runner.amendCommit(
      "amended",
      new Map([[`${root}/selected.txt`, "new selected\n"]]),
      head,
    );
    assert(status.status.includes("Amended"), status.status);
    assertEquals(
      await git(root, ["show", "HEAD:selected.txt"]),
      "new selected\n",
    );
    assertEquals(
      await git(root, ["show", "HEAD:unrelated.txt"]),
      "old unrelated\n",
    );
    assertEquals(
      await git(root, ["show", ":unrelated.txt"]),
      "staged unrelated\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: preserves assume-unchanged and skip-worktree index flags", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await Deno.writeTextFile(`${root}/assume.txt`, "old assume\n");
    await Deno.writeTextFile(`${root}/skip.txt`, "old skip\n");
    await git(root, ["add", "assume.txt", "skip.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    await git(root, ["update-index", "--assume-unchanged", "assume.txt"]);
    await git(root, ["update-index", "--skip-worktree", "skip.txt"]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    runner.amendCommit(
      "amended",
      new Map([
        [`${root}/assume.txt`, "pager assume\n"],
        [`${root}/skip.txt`, "pager skip\n"],
      ]),
      head,
    );
    assert(
      (await git(root, ["ls-files", "-v", "assume.txt"])).startsWith("h "),
    );
    assert((await git(root, ["ls-files", "-t", "skip.txt"])).startsWith("S "));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "realGit: reflog ownership distinguishes a hook's replacement commit",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await Deno.writeTextFile(`${root}/f.txt`, "base\n");
      await git(root, ["add", "f.txt"]);
      await git(root, ["commit", "-q", "-m", "base"]);
      await Deno.writeTextFile(`${root}/f.txt`, "original\n");
      await git(root, ["commit", "-qam", "original"]);
      await git(root, ["branch", "topic"]);

      const runner = realGit(root);
      const branch = runner.headRef!();
      const head = runner.headSha();
      assert(branch && head, "repository has a branch and HEAD commit");
      const parent = (await git(root, ["rev-parse", `${head}^`])).trim();
      const tree = (await git(root, ["rev-parse", `${head}^{tree}`])).trim();
      const authorName = (await git(root, [
        "show",
        "-s",
        "--format=%an",
        head,
      ])).trim();
      const authorEmail = (await git(root, [
        "show",
        "-s",
        "--format=%ae",
        head,
      ])).trim();
      const authorDate = (await git(root, [
        "show",
        "-s",
        "--format=%aI",
        head,
      ])).trim();
      const replacement = (await git(
        root,
        ["commit-tree", tree, "-p", parent],
        "amended\n",
        {
          GIT_AUTHOR_NAME: authorName,
          GIT_AUTHOR_EMAIL: authorEmail,
          GIT_AUTHOR_DATE: authorDate,
          GIT_COMMITTER_DATE: "2001-01-01T00:00:00+00:00",
        },
      )).trim();
      assert(replacement !== head, "the hook replacement is a new commit");
      await installHook(
        root,
        "post-commit",
        `git update-ref refs/heads/topic ${shellQuote(replacement)} ${
          shellQuote(head)
        }\ngit checkout -q topic`,
      );

      let error = "";
      try {
        runner.amendCommit("amended", new Map(), head, branch);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      assert(error.length > 0, "the branch-switching amend failed");
      assertEquals(await git(root, ["rev-parse", branch]), `${head}\n`);
      assertEquals(
        await git(root, ["rev-parse", "refs/heads/topic"]),
        `${replacement}\n`,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("realGit: rejects both multi-stage and lone unmerged index entries", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    const path = `${root}/selected.txt`;
    await Deno.writeTextFile(path, "original\n");
    await git(root, ["add", "selected.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    const object = (await git(root, ["rev-parse", "HEAD:selected.txt"])).trim();
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head && object, "repository has a committed file");

    await git(root, ["update-index", "--force-remove", "selected.txt"]);
    await git(
      root,
      ["update-index", "--index-info"],
      `100644 ${object} 1\tselected.txt\n100644 ${object} 2\tselected.txt\n`,
    );
    assertThrows(
      () =>
        runner.amendCommit(
          "amended",
          new Map([[path, "pager\n"]]),
          head,
        ),
      Error,
      "unmerged entries",
    );

    await git(root, ["update-index", "--force-remove", "selected.txt"]);
    await git(
      root,
      ["update-index", "--index-info"],
      `100644 ${object} 1\tselected.txt\n`,
    );
    assertThrows(
      () =>
        runner.amendCommit(
          "amended",
          new Map([[path, "pager\n"]]),
          head,
        ),
      Error,
      "unmerged entry",
    );
    assertEquals(runner.headSha(), head);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name:
    "realGit: follows a marked journal chain when rolling back nested commits",
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
      const marker = `${root}/nested-hook-ran`;
      await installHook(
        root,
        "post-commit",
        `if test ! -e ${shellQuote(marker)}; then
  : > ${shellQuote(marker)}
  amended=$(git rev-parse HEAD)
  git commit --allow-empty -q -m nested
  printf '%s %s %s\n' ${shellQuote(head)} "$amended" ${
          shellQuote(branch)
        } > "$(dirname "$GIT_INDEX_FILE")/reference-transactions"
fi`,
      );

      const error = assertThrows(
        () => runner.amendCommit("amended", new Map(), head),
        Error,
        "HEAD changed during the amend",
      );
      assert(!error.message.includes("rollback failed"), error.message);
      assertEquals(runner.headSha(), head);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
