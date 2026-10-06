import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  findCommitMessages,
  messageAt,
  realGit,
} from "../lib/view/commitmsg.ts";
import {
  git,
  initReftable,
  installHook,
  shellQuote,
  SHOW,
} from "./view-commitmsg-test-helpers.ts";

Deno.test("findCommitMessages: several commits (git log -p) each get a region", () => {
  const lines = [
    "commit aaaaaaa",
    "Author: A",
    "",
    "    first",
    "",
    "commit bbbbbbb",
    "Author: B",
    "",
    "    second",
    "",
  ];
  const msgs = findCommitMessages(lines);
  assertEquals(msgs.map((m) => m.sha), ["aaaaaaa", "bbbbbbb"]);
  assertEquals(msgs.map((m) => [m.start, m.end]), [[3, 3], [8, 8]]);
});

Deno.test("messageAt: maps a row to its region or null", () => {
  const msgs = findCommitMessages(SHOW);
  assertEquals(messageAt(msgs, 4)?.start, 4, "inside");
  assertEquals(messageAt(msgs, 6)?.end, 6, "inside at the end");
  assertEquals(messageAt(msgs, 3), null, "the blank separator is outside");
  assertEquals(messageAt(msgs, 9), null, "the diff is outside");
});

Deno.test({
  name: "realGit: hook-spawned Git uses the other repository's hooks",
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
      await installHook(other, "pre-commit", "exit 1");
      await installHook(
        root,
        "post-commit",
        `unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX
git -C ${shellQuote(other)} commit --allow-empty -q -m nested`,
      );
      const runner = realGit(root);
      const original = runner.headSha();
      const otherOriginal = (await git(other, ["rev-parse", "HEAD"])).trim();
      assert(original && otherOriginal, "both repositories have HEAD commits");

      const result = runner.amendCommit("amended", new Map(), original);

      assert(result.head !== original, "the source commit was amended");
      assertEquals(
        (await git(other, ["rev-parse", "HEAD"])).trim(),
        otherOriginal,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(other, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: rolls back a reftable amend rewritten by a hook",
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
      await installHook(
        root,
        "commit-msg",
        `printf '\\nHook-Trailer: added\\n' >> "$1"`,
      );

      assertThrows(
        () => runner.amendCommit("amended", new Map(), original),
        Error,
        "hook changed",
      );

      assertEquals(runner.headSha(), original);
      assertEquals(
        (await git(root, ["log", "-1", "--format=%s"])).trim(),
        "original",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("realGit: commits exact pager contents while preserving staged and unstaged edits in the same file", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    const path = `${root}/selected.txt`;
    await Deno.writeTextFile(path, "one\ntwo\nthree\nfour\nfive\n");
    await git(root, ["add", "selected.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);

    // Line one is staged. Line five is only in the working tree. The pager
    // edit to line four belongs in HEAD, the index, and the working tree.
    await Deno.writeTextFile(path, "ONE\ntwo\nthree\nfour\nfive\n");
    await git(root, ["add", "selected.txt"]);
    await Deno.writeTextFile(path, "ONE\ntwo\nthree\nFOUR\nFIVE\n");

    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");
    const status = runner.amendCommit(
      "amended",
      new Map([[path, "one\ntwo\nthree\nFOUR\nfive\n"]]),
      head,
    );
    assert(status.status.includes("Amended"), status.status);
    assertEquals(
      await git(root, ["show", "HEAD:selected.txt"]),
      "one\ntwo\nthree\nFOUR\nfive\n",
    );
    assertEquals(
      await git(root, ["show", ":selected.txt"]),
      "ONE\ntwo\nthree\nFOUR\nfive\n",
    );
    assertEquals(
      await Deno.readTextFile(path),
      "ONE\ntwo\nthree\nFOUR\nFIVE\n",
    );
    assertEquals(
      await git(root, ["status", "--porcelain"]),
      "MM selected.txt\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "realGit: rejects a commit tree changed by a hook",
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
      await installHook(
        root,
        "pre-commit",
        `printf 'hook\\n' > "$GIT_WORK_TREE/f.txt"\ngit add -- f.txt`,
      );
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");

      let error = "";
      try {
        runner.amendCommit("amended", new Map([[path, "pager\n"]]), head);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      assert(error.includes("hook changed"), error || "the amend did not fail");
      assertEquals(runner.headSha(), head);
      assertEquals(await git(root, ["show", "HEAD:f.txt"]), "original\n");
      assertEquals(await git(root, ["show", ":f.txt"]), "original\n");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: rejects a commit message rewritten by a hook",
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
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");
      await installHook(
        root,
        "commit-msg",
        `printf '\\nHook-Trailer: added\\n' >> "$1"`,
      );

      let error = "";
      try {
        runner.amendCommit("amended", new Map(), head);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      assert(error.includes("hook changed"), error || "the amend did not fail");
      assertEquals(runner.headSha(), head);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("realGit: rejects a selected path that HEAD does not contain", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
    const path = `${root}/new.txt`;
    await Deno.writeTextFile(path, "workspace\n");
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    assertThrows(
      () =>
        runner.amendCommit(
          "amended",
          new Map([[path, "pager\n"]]),
          head,
        ),
      Error,
      "does not contain new.txt",
    );
    assertEquals(runner.headSha(), head);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name:
    "realGit: uses the commit summary when hook journals and reflogs are gone",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
      const journalMarker = `${root}/journal-removed`;
      const reflogMarker = `${root}/reflogs-removed`;
      await installHook(
        root,
        "reference-transaction",
        `if test "\${1-}" = committed; then
  journal="$(dirname "$GIT_INDEX_FILE")/reference-transactions"
  rm -f "$journal" || exit 1
  test ! -e "$journal" || exit 1
  printf ran > ${shellQuote(journalMarker)}
fi`,
      );
      await installHook(
        root,
        "post-commit",
        `git reflog expire --expire=now --all || exit 1
test -z "$(git reflog show --all)" || exit 1
printf ran > ${shellQuote(reflogMarker)}`,
      );
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");

      const result = runner.amendCommit("amended", new Map(), head);

      assert(result.head !== head, "the summary identified the amended commit");
      assertEquals(await Deno.readTextFile(journalMarker), "ran");
      assertEquals(await Deno.readTextFile(reflogMarker), "ran");
      assertEquals((await git(root, ["reflog", "show", "--all"])).trim(), "");
      assertEquals(runner.headSha(), result.head);
      assertEquals(
        (await git(root, ["log", "-1", "--format=%s"])).trim(),
        "amended",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
