import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  findCommitHeaders,
  findCommitMessages,
  realGit,
  sameCommit,
} from "../lib/view/commitmsg.ts";
import {
  git,
  initReftable,
  installHook,
  shellQuote,
} from "./view-commitmsg-test-helpers.ts";

Deno.test("findCommitMessages: a commit with no message body yields no region", () => {
  const lines = ["commit deadbeef", "Author: A", "", "diff --git a/f b/f"];
  assertEquals(findCommitMessages(lines).length, 0);
  assertEquals(findCommitHeaders(lines), [{ sha: "deadbeef", line: 0 }]);
});

Deno.test("sameCommit: matches Git's four-character minimum abbreviation", () => {
  assert(sameCommit("0123456", "0123456789abcdef"), "7-char abbrev matches");
  assert(sameCommit("0123", "0123456789abcdef"), "4-char abbrev matches");
  assert(sameCommit("0123456789abcdef", "0123456"), "either side may be short");
  assert(!sameCommit("0123456", "0123999"), "different prefix");
  assert(!sameCommit("012", "0123456"), "under four chars never matches");
});

Deno.test("realGit: accepts an amend that reproduces the same commit object", async () => {
  const root = await Deno.makeTempDir();
  const authorDate = Deno.env.get("GIT_AUTHOR_DATE");
  const committerDate = Deno.env.get("GIT_COMMITTER_DATE");
  try {
    const fixedDate = "2001-01-01T00:00:00+00:00";
    Deno.env.set("GIT_AUTHOR_DATE", fixedDate);
    Deno.env.set("GIT_COMMITTER_DATE", fixedDate);
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    // A signature records its own creation time, so a signed commit hashes
    // differently every second. Pin the switch an inherited configuration may
    // have turned on, leaving the object id a function of the content alone.
    await git(root, ["config", "commit.gpgsign", "false"]);
    await Deno.writeTextFile(`${root}/f.txt`, "same\n");
    await git(root, ["add", "f.txt"]);
    await git(root, ["commit", "-q", "-m", "same"]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    const result = runner.amendCommit("same", new Map(), head);

    assertEquals(result.head, head);
    assertEquals(runner.headSha(), head);
    assert(result.status.includes("Amended"), result.status);
  } finally {
    if (authorDate === undefined) Deno.env.delete("GIT_AUTHOR_DATE");
    else Deno.env.set("GIT_AUTHOR_DATE", authorDate);
    if (committerDate === undefined) Deno.env.delete("GIT_COMMITTER_DATE");
    else Deno.env.set("GIT_COMMITTER_DATE", committerDate);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "realGit: rolls back without a reflog when hook validation fails",
  ignore: Deno.build.os === "windows",
  async fn() {
    for (const storage of ["files", "reftable"] as const) {
      const root = await Deno.makeTempDir();
      try {
        if (storage === "reftable") {
          if (!await initReftable(root)) continue;
        } else {
          await git(root, ["init", "-q"]);
        }
        await git(root, ["config", "user.email", "t@t.test"]);
        await git(root, ["config", "user.name", "Test"]);
        const path = `${root}/f.txt`;
        await Deno.writeTextFile(path, "original\n");
        await git(root, ["add", "f.txt"]);
        await git(root, ["commit", "-q", "-m", "original"]);
        await installHook(
          root,
          "post-commit",
          `git reflog expire --expire=now --all\nprintf 'hook change\\n' > ${
            shellQuote(path)
          }`,
        );
        const runner = realGit(root);
        const original = runner.headSha();
        assert(original, "repository has a HEAD commit");

        assertThrows(
          () =>
            runner.amendCommit(
              "amended",
              new Map(),
              original,
              undefined,
              new Map([[path, "original\n"]]),
            ),
          Error,
          "changed while commit hooks ran",
        );

        assertEquals(runner.headSha(), original);
        assertEquals(await Deno.readTextFile(path), "hook change\n");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    }
  },
});

Deno.test("realGit: merges content through a staged executable mode change", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    const path = `${root}/selected.txt`;
    await Deno.writeTextFile(path, "original\n");
    await git(root, ["add", "selected.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    await git(root, ["update-index", "--chmod=+x", "selected.txt"]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    runner.amendCommit(
      "amended",
      new Map([[path, "pager\n"]]),
      head,
    );

    assertEquals(await git(root, ["show", "HEAD:selected.txt"]), "pager\n");
    assert(
      (await git(root, ["ls-files", "--stage", "selected.txt"])).startsWith(
        "100755 ",
      ),
    );
    assertEquals(await git(root, ["show", ":selected.txt"]), "pager\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "realGit: refuses to overwrite a selected path staged during hooks",
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
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");
      await installHook(
        root,
        "pre-commit",
        `printf 'concurrent staged\\n' > f.txt\nGIT_INDEX_FILE=${
          shellQuote(`${root}/.git/index`)
        } git add -- f.txt`,
      );

      let error = "";
      try {
        runner.amendCommit("amended", new Map([[path, "pager\n"]]), head);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      assert(
        error.includes("index changed"),
        error || "the amend did not fail",
      );
      assertEquals(runner.headSha(), head);
      assertEquals(await git(root, ["show", ":f.txt"]), "concurrent staged\n");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("realGit: amendCommit throws when git fails (not a repository)", () => {
  const root = Deno.makeTempDirSync();
  try {
    let threw = false;
    try {
      realGit(root).amendCommit("x", new Map(), "0000000");
    } catch {
      threw = true;
    }
    assert(threw, "amend outside a repo throws");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("realGit: fallback merge rejects a deletion inside a pager replacement", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);

    assertThrows(
      () =>
        realGit(root).applyFileChanges(
          "A\nB\nC\nD\n",
          "A\nD\n",
          "P\n",
          `${root}/selected.txt`,
        ),
      Error,
      "overlap workspace changes",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "realGit: rolls back when the real index is locked after hooks",
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
      const lock = `${root}/.git/index.lock`;
      await installHook(root, "post-commit", `: > ${shellQuote(lock)}`);
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
        "index is locked",
      );
      assertEquals(runner.headSha(), head);
      assertEquals(
        await git(root, ["show", "HEAD:selected.txt"]),
        "original\n",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
