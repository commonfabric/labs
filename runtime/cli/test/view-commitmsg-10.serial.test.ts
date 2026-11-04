import { assert, assertEquals, assertThrows } from "@std/assert";
import { commitSubjects, realGit } from "../lib/view/commitmsg.ts";
import {
  git,
  initReftable,
  installHook,
  shellQuote,
  withGitShim,
} from "./view-commitmsg-test-helpers.ts";

Deno.test("commitSubjects: the text after the hash of a compact header", () => {
  const full = "0123456789abcdef0123456789abcdef01234567";
  assertEquals(
    commitSubjects([`${full} Add the feature`, "diff --git a/f b/f"]).get(full),
    "Add the feature",
  );
});

Deno.test({
  name: "realGit: preserves a configured reference-transaction hook",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
      const journal = `${root}/hook-journal`;
      await installHook(
        root,
        "reference-transaction",
        `printf '%s\\n' "$1" >> ${shellQuote(journal)}
cat >> ${shellQuote(journal)}`,
      );
      const runner = realGit(root);
      const original = runner.headSha();
      assert(original, "repository has a HEAD commit");

      runner.amendCommit("amended", new Map(), original);

      const hookOutput = await Deno.readTextFile(journal);
      assert(hookOutput.includes("prepared\n"), hookOutput);
      assert(hookOutput.includes("committed\n"), hookOutput);
      assert(hookOutput.includes(" refs/heads/"), hookOutput);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("realGit: labels edited commit messages as UTF-8", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await git(root, ["config", "i18n.commitEncoding", "ISO-8859-1"]);
    await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    runner.amendCommit("é edited", new Map(), head);

    const raw = await git(root, ["cat-file", "commit", "HEAD"]);
    assert(!raw.includes("encoding ISO-8859-1\n"), raw);
    assertEquals(
      await git(root, [
        "-c",
        "i18n.logOutputEncoding=UTF-8",
        "log",
        "-1",
        "--format=%B",
      ]),
      "é edited\n\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "realGit: journals nested commits from a reference-transaction hook",
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
        const marker = `${root}/.git/reference-hook-ran`;
        await installHook(
          root,
          "reference-transaction",
          `if test "$1" = committed && test ! -e ${shellQuote(marker)}; then
  touch ${shellQuote(marker)}
  git commit --allow-empty -q -m nested
  git reflog expire --expire=now --all
fi`,
        );
        const runner = realGit(root);
        const original = runner.headSha();
        assert(original, "repository has a HEAD commit");

        const error = assertThrows(
          () => runner.amendCommit("amended", new Map(), original),
          Error,
          "HEAD changed",
        );
        assert(!error.message.includes("rollback failed"), error.message);

        assertEquals(runner.headSha(), original, storage);
        assertEquals(
          (await git(root, ["rev-list", "--count", "HEAD"])).trim(),
          "1",
          storage,
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    }
  },
});

Deno.test({
  name: "realGit: keeps an in-repository symlink's lexical Git path",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      const link = `${root}/link.txt`;
      const target = `${root}/target.txt`;
      Deno.writeTextFileSync(link, "link head\n");
      Deno.writeTextFileSync(target, "target head\n");
      await git(root, ["add", "link.txt", "target.txt"]);
      await git(root, ["commit", "-q", "-m", "head"]);
      const head = (await git(root, ["rev-parse", "HEAD"])).trim();
      Deno.removeSync(link);
      Deno.symlinkSync("target.txt", link);

      realGit(root).amendCommit(
        "head",
        new Map([[link, "pager\n"]]),
        head,
      );

      assertEquals(await git(root, ["show", "HEAD:link.txt"]), "pager\n");
      assertEquals(
        await git(root, ["show", "HEAD:target.txt"]),
        "target head\n",
      );
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  },
});

Deno.test("realGit: refuses a different branch at the same commit", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await Deno.writeTextFile(`${root}/f.txt`, "original\n");
    await git(root, ["add", "f.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    const runner = realGit(root);
    const branch = runner.headRef!();
    const head = runner.headSha();
    assert(branch && head, "repository has a branch and HEAD commit");
    await git(root, ["checkout", "-q", "-b", "topic"]);

    assertThrows(
      () => runner.amendCommit("amended", new Map(), head, branch),
      Error,
      "different branch",
    );
    assertEquals(await git(root, ["rev-parse", branch]), `${head}\n`);
    assertEquals(
      await git(root, ["rev-parse", "refs/heads/topic"]),
      `${head}\n`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: validates selected paths before reading commit contents", async () => {
  const root = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await Deno.writeTextFile(`${root}/tracked.txt`, "tracked\n");
    await git(root, ["add", "tracked.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    await Deno.writeTextFile(`${outside}/outside.txt`, "outside\n");
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    assertThrows(
      () => runner.fileAtCommit(head, "tracked.txt"),
      Error,
      "not absolute",
    );
    assertThrows(
      () => runner.fileAtCommit(head, `${outside}/outside.txt`),
      Error,
      "outside the repository",
    );
    assertEquals(runner.fileAtCommit(head, `${root}/missing.txt`), null);

    if (Deno.build.os !== "windows") {
      await Deno.symlink(outside, `${root}/escape`);
      assertThrows(
        () => runner.fileAtCommit(head, `${root}/escape/outside.txt`),
        Error,
        "outside the repository",
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test({
  name: "realGit: recovers amend ownership from file and reftable reflogs",
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
        const marker = `${root}/fallback-hook-ran`;
        await installHook(
          root,
          "reference-transaction",
          `if test "\${1-}" = committed; then
  journal="$(dirname "$GIT_INDEX_FILE")/reference-transactions"
  rm -f "$journal" || exit 1
  test ! -e "$journal" || exit 1
  printf ran > ${shellQuote(marker)}
fi`,
        );
        const runner = realGit(root);
        const head = runner.headSha();
        assert(head, `${storage} repository has a HEAD commit`);

        const result = runner.amendCommit("amended", new Map(), head);

        assert(result.head !== head, `${storage} HEAD was amended`);
        assertEquals(await Deno.readTextFile(marker), "ran");
        assertEquals(
          (await git(root, ["log", "-1", "--format=%s"])).trim(),
          "amended",
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    }
  },
});

Deno.test({
  name: "realGit: reports failures and malformed output from merge helpers",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      const path = `${root}/selected.txt`;
      await withGitShim(
        `if test "$1" = merge-file; then
  printf '%s\\n' 'forced merge failure' >&2
  exit 128
fi`,
        () =>
          assertThrows(
            () => realGit(root).applyFileChanges("A\n", "B\n", "C\n", path),
            Error,
            "forced merge failure",
          ),
      );
      await withGitShim(
        `if test "$1" = diff; then
  printf '%s\\n' 'forced diff failure' >&2
  exit 2
fi`,
        () =>
          assertThrows(
            () =>
              realGit(root).applyFileChanges(
                "A\nB\nC\nD\n",
                "A\nD\n",
                "P\n",
                path,
              ),
            Error,
            "forced diff failure",
          ),
      );
      await withGitShim(
        `if test "$1" = diff; then
  printf '@@ -1,2 +1,2 @@\\n-old\\n+new\\n'
  exit 1
fi`,
        () =>
          assertThrows(
            () =>
              realGit(root).applyFileChanges(
                "A\nB\nC\nD\n",
                "A\nD\n",
                "P\n",
                path,
              ),
            Error,
            "Could not parse pager edits",
          ),
      );
      const calls = `${root}/diff-calls`;
      await withGitShim(
        `if test "$1" = diff; then
  if test ! -e ${shellQuote(calls)}; then
    : > ${shellQuote(calls)}
    exit 0
  fi
  printf '@@ -1 +1 @@\\n-A\\n+P\\n'
  exit 1
fi`,
        () =>
          assertThrows(
            () => realGit(root).applyFileChanges("X\n", "A\n", "P\n", path),
            Error,
            "overlap committed changes",
          ),
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
