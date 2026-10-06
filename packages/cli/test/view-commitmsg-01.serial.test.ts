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
  SHOW,
  withGitShim,
} from "./view-commitmsg-test-helpers.ts";

Deno.test("findCommitMessages: the indented block after the header, ending at the diff", () => {
  const msgs = findCommitMessages(SHOW);
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].sha, "0123456789abcdef0123456789abcdef01234567");
  assertEquals(msgs[0].start, 4, "starts at the first indented line");
  assertEquals(msgs[0].end, 6, "ends at the last indented line");
});

Deno.test("commitSubjects: the Subject header of an email patch, prefix stripped", () => {
  const full = "0123456789abcdef0123456789abcdef01234567";
  const subjects = commitSubjects([
    `From ${full} Mon Sep 17 00:00:00 2001`,
    "From: A B <a@b.example>",
    "Date: Wed, 1 Jul 2026 12:00:00 -0700",
    "Subject: [PATCH] Fix the alignment",
    "",
    "diff --git a/f b/f",
  ]);
  assertEquals(subjects.get(full), "Fix the alignment");
});

Deno.test({
  name: "realGit: preserves hook paths and hooks installed during the amend",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
      const helperMarker = `${root}/helper-ran`;
      const helper = `${root}/.git/check`;
      await Deno.writeTextFile(
        helper,
        `#!/bin/sh\nprintf ran > ${shellQuote(helperMarker)}\n`,
      );
      await Deno.chmod(helper, 0o755);
      const commitMessageHook = `${root}/.git/hooks/commit-msg`;
      await installHook(
        root,
        "pre-commit",
        `"$(dirname "$0")/../check"
printf '#!/bin/sh\\nexit 1\\n' > ${shellQuote(commitMessageHook)}
chmod +x ${shellQuote(commitMessageHook)}`,
      );
      const runner = realGit(root);
      const original = runner.headSha();
      assert(original, "repository has a HEAD commit");

      assertThrows(
        () => runner.amendCommit("amended", new Map(), original),
        Error,
      );

      assertEquals(await Deno.readTextFile(helperMarker), "ran");
      assertEquals(runner.headSha(), original);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("realGit: amends a valid empty commit", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    const result = runner.amendCommit("amended", new Map(), head);

    assert(result.head !== head, "the empty commit was replaced");
    assertEquals(
      (await git(root, ["log", "-1", "--format=%s"])).trim(),
      "amended",
    );
    assertEquals((await git(root, ["show", "--format=", "--stat"])).trim(), "");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "realGit: restores a checked-out ref deleted by a hook",
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
        await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
        const runner = realGit(root);
        const original = runner.headSha();
        const branch = runner.headRef!();
        assert(original && branch, "repository has a branch and HEAD commit");
        await installHook(
          root,
          "post-commit",
          `git update-ref -d ${shellQuote(branch)}
git reflog expire --expire=now --all`,
        );

        const error = assertThrows(
          () => runner.amendCommit("amended", new Map(), original),
          Error,
          "HEAD changed",
        );
        assert(!error.message.includes("rollback failed"), error.message);

        assertEquals(runner.headSha(), original, storage);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    }
  },
});

Deno.test({
  name: "realGit: keeps a symlinked directory's lexical Git path",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await Deno.mkdir(`${root}/subalias`);
      await Deno.writeTextFile(`${root}/f.txt`, "root head\n");
      await Deno.writeTextFile(`${root}/subalias/f.txt`, "alias head\n");
      await git(root, ["add", "f.txt", "subalias/f.txt"]);
      await git(root, ["commit", "-q", "-m", "head"]);
      const head = (await git(root, ["rev-parse", "HEAD"])).trim();
      await Deno.remove(`${root}/subalias`, { recursive: true });
      await Deno.symlink(".", `${root}/subalias`);

      realGit(root).amendCommit(
        "head",
        new Map([[`${root}/subalias/f.txt`, "pager\n"]]),
        head,
      );

      assertEquals(await git(root, ["show", "HEAD:subalias/f.txt"]), "pager\n");
      assertEquals(await git(root, ["show", "HEAD:f.txt"]), "root head\n");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: a branch switch during hooks leaves both branches unamended",
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
      await installHook(root, "pre-commit", "git checkout -q topic");

      let error = "";
      try {
        runner.amendCommit("amended", new Map(), head, branch);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      assert(error.length > 0, "the branch-switching amend failed");
      assertEquals(runner.headRef!(), "refs/heads/topic");
      assertEquals(await git(root, ["rev-parse", branch]), `${head}\n`);
      assertEquals(
        await git(root, ["rev-parse", "refs/heads/topic"]),
        `${head}\n`,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("realGit: reports unavailable optional Git queries", () => {
  const root = Deno.makeTempDirSync();
  try {
    const runner = realGit(root);

    assertEquals(runner.headRef!(), null);
    assertEquals(runner.resolveCommit!("not-an-object"), null);
    assertEquals(runner.resolveCommit!("abcd"), null);
    assertEquals(
      runner.commitMatchesDiff!("abcd", "old", "new", "bad", "cafe"),
      false,
    );
    assertEquals(
      runner.commitMatchesDiff!("abcd", "old", "new", "beef", "cafe"),
      false,
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test({
  name: "realGit: ignores a journal transition to a missing commit",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
      await installHook(
        root,
        "reference-transaction",
        `if test "\${1-}" = committed; then
  read old object ref
  if test "$old" != 0000000000000000000000000000000000000000 && test "$object" != 0000000000000000000000000000000000000000; then
    printf '%s %s %s\n' "$old" ffffffffffffffffffffffffffffffffffffffff "$ref" > "$(dirname "$GIT_INDEX_FILE")/reference-transactions"
  fi
fi`,
      );
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");

      const result = runner.amendCommit("amended", new Map(), head);

      assert(result.head !== head, "the commit summary recovered ownership");
      assertEquals(runner.headSha(), result.head);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "realGit: reports injected ref-storage, hook setup, and staged merge failures",
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
      const head = (await git(root, ["rev-parse", "HEAD"])).trim();

      await withGitShim(
        `if test "$1" = config && test "$2" = --get && test "$3" = extensions.refStorage; then
  printf '%s\\n' future-format
  exit 0
fi`,
        () =>
          assertThrows(
            () => realGit(root).amendCommit("amended", new Map(), head),
            Error,
            "cannot be amended safely",
          ),
      );
      await withGitShim(
        `if test "$1" = rev-parse && test "$2" = --path-format=absolute && test "$3" = --absolute-git-dir; then
  printf '%s\\n' 'forced hook setup failure' >&2
  exit 1
fi`,
        () =>
          assertThrows(
            () => realGit(root).amendCommit("amended", new Map(), head),
            Error,
            "Could not prepare Git hooks",
          ),
      );

      await Deno.writeTextFile(path, "staged\n");
      await git(root, ["add", "selected.txt"]);
      await withGitShim(
        `if test "$1" = merge-file; then
  printf '%s\\n' 'forced staged merge failure' >&2
  exit 128
fi`,
        () =>
          assertThrows(
            () =>
              realGit(root).amendCommit(
                "amended",
                new Map([[path, "pager\n"]]),
                head,
              ),
            Error,
            "forced staged merge failure",
          ),
      );
      assertEquals((await git(root, ["rev-parse", "HEAD"])).trim(), head);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
