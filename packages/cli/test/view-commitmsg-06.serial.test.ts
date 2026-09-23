import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  extractMessage,
  findCommitHeaders,
  findCommitMessages,
  realGit,
} from "../lib/view/commitmsg.ts";
import {
  git,
  initReftable,
  installHook,
  shellQuote,
  SHOW,
} from "./view-commitmsg-test-helpers.ts";

Deno.test("findCommitHeaders: compact, reference, and email formats", () => {
  const full = "0123456789abcdef0123456789abcdef01234567";
  assertEquals(findCommitHeaders([`${full} Subject`]), [
    { sha: full, line: 0 },
  ]);
  assertEquals(
    findCommitHeaders(["89abcdef (Reference subject, 2026-07-20)"]),
    [{ sha: "89abcdef", line: 0 }],
  );
  assertEquals(
    findCommitHeaders([
      `From ${full} Mon Sep 17 00:00:00 2001`,
      "From: A B <a@b.example>",
      "Date: Wed, 1 Jul 2026 12:00:00 -0700",
      "Subject: [PATCH] Subject",
      "",
    ]),
    [{ sha: full, line: 0 }],
  );
  assertEquals(
    findCommitHeaders([`${full} Empty HEAD`, "89abcdef Parent with a patch"]),
    [{ sha: full, line: 0 }, { sha: "89abcdef", line: 1 }],
  );
});

Deno.test("extractMessage: strips the four-space indent and joins", () => {
  const msgs = findCommitMessages(SHOW);
  assertEquals(
    extractMessage(SHOW, msgs[0]),
    "Subject line\n\nBody paragraph.",
  );
});

Deno.test({
  name: "realGit: preserves nested Git configuration for another repository",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    const other = await Deno.makeTempDir();
    try {
      for (const repository of [root, other]) {
        await git(repository, ["init", "-q"]);
        await git(repository, ["config", "user.email", "t@t.test"]);
        await git(repository, ["config", "user.name", "Test"]);
        await git(repository, [
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "original",
        ]);
      }
      const marker = `${other}/pre-commit-ran`;
      await installHook(
        other,
        "pre-commit",
        `test "$(git config --get nested.flag)" = yes || exit 43
printf ran > ${shellQuote(marker)}`,
      );
      await installHook(
        root,
        "post-commit",
        `unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX
git -C ${
          shellQuote(other)
        } -c nested.flag=yes commit --allow-empty -q -m nested`,
      );
      const runner = realGit(root);
      const original = runner.headSha();
      assert(original, "source repository has a HEAD commit");

      runner.amendCommit("amended", new Map(), original);

      assertEquals(await Deno.readTextFile(marker), "ran");
      assertEquals(
        (await git(other, ["rev-list", "--count", "HEAD"])).trim(),
        "2",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(other, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: rolls back nested reftable commits made by a hook",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      if (!await initReftable(root)) return;
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await Deno.writeTextFile(`${root}/f.txt`, "original\n");
      await git(root, ["add", "f.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      const runner = realGit(root);
      const original = runner.headSha();
      assert(original, "repository has a HEAD commit");
      const marker = `${root}/.git/nested-reftable-hook-ran`;
      await installHook(
        root,
        "post-commit",
        `if test ! -e ${shellQuote(marker)}; then
  touch ${shellQuote(marker)}
  git commit --allow-empty -q -m nested
fi`,
      );

      assertThrows(
        () => runner.amendCommit("amended", new Map(), original),
        Error,
        "HEAD changed",
      );

      assertEquals(runner.headSha(), original);
      assertEquals(
        (await git(root, ["rev-list", "--count", "HEAD"])).trim(),
        "1",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("realGit: refuses a pager edit that conflicts with a staged edit", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    const path = `${root}/selected.txt`;
    await Deno.writeTextFile(path, "one\ntwo\nthree\n");
    await git(root, ["add", "selected.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    await Deno.writeTextFile(path, "one\nSTAGED\nthree\n");
    await git(root, ["add", "selected.txt"]);

    let error = "";
    try {
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");
      runner.amendCommit(
        "amended",
        new Map([[path, "one\nPAGER\nthree\n"]]),
        head,
      );
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    assert(error.includes("conflict"), error || "the amend did not fail");
    assertEquals(
      await git(root, ["show", "HEAD:selected.txt"]),
      "one\ntwo\nthree\n",
    );
    assertEquals(
      await git(root, ["show", ":selected.txt"]),
      "one\nSTAGED\nthree\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "realGit: rejects a selected working file changed by a hook",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      const path = `${root}/f.txt`;
      await Deno.writeTextFile(path, "original\n");
      await git(root, ["add", "f.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      await installHook(root, "pre-commit", "printf 'hook\\n' > f.txt");
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");

      assertThrows(
        () =>
          runner.amendCommit(
            "amended",
            new Map([[path, "pager\n"]]),
            head,
            undefined,
            new Map([[path, "pager\n"]]),
          ),
        Error,
        "changed while commit hooks ran",
      );

      assertEquals(runner.headSha(), head);
      assertEquals(await git(root, ["show", "HEAD:f.txt"]), "original\n");
      assertEquals(await git(root, ["show", ":f.txt"]), "original\n");
      assertEquals(await Deno.readTextFile(path), "hook\n");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("realGit: Git refuses amend while resolving a conflicted merge", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await Deno.writeTextFile(`${root}/f.txt`, "base\n");
    await git(root, ["add", "f.txt"]);
    await git(root, ["commit", "-q", "-m", "base"]);
    await git(root, ["checkout", "-q", "-b", "side"]);
    await Deno.writeTextFile(`${root}/f.txt`, "side\n");
    await git(root, ["commit", "-qam", "side"]);
    await git(root, ["checkout", "-q", "-"]);
    await Deno.writeTextFile(`${root}/f.txt`, "main\n");
    await git(root, ["commit", "-qam", "main"]);
    await git(root, ["merge", "side"]);
    await Deno.stat(`${root}/.git/MERGE_HEAD`);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    assertThrows(
      () => runner.amendCommit("amended", new Map(), head),
      Error,
      "middle of a merge",
    );
    assertEquals(runner.headSha(), head);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: a no-op pager change keeps the committed contents", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    const runner = realGit(root);

    assertEquals(
      runner.applyFileChanges(
        "committed\n",
        "workspace\n",
        "workspace\n",
        `${root}/f.txt`,
      ),
      "committed\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name:
    "realGit: rolls back when a selected workspace file disappears in a hook",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      const path = `${root}/selected.txt`;
      await Deno.writeTextFile(path, "original\n");
      await git(root, ["add", "selected.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      await Deno.writeTextFile(path, "pager\n");
      await installHook(root, "post-commit", `rm -f ${shellQuote(path)}`);
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");

      assertThrows(
        () =>
          runner.amendCommit(
            "amended",
            new Map([[path, "pager\n"]]),
            head,
            undefined,
            new Map([[path, "pager\n"]]),
          ),
        Error,
        "could not be read after commit hooks ran",
      );
      assertEquals(runner.headSha(), head);
      assertEquals(
        await git(root, ["show", "HEAD:selected.txt"]),
        "original\n",
      );
      assertEquals(await git(root, ["show", ":selected.txt"]), "original\n");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
