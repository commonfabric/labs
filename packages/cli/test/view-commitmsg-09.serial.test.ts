import { assert, assertEquals, assertThrows } from "@std/assert";
import { commitSubjects, realGit } from "../lib/view/commitmsg.ts";
import {
  git,
  initReftable,
  installHook,
  shellQuote,
  SHOW,
  withGitShim,
} from "./view-commitmsg-test-helpers.ts";

Deno.test("commitSubjects: the first indented body line of a standard commit", () => {
  const subjects = commitSubjects(SHOW);
  assertEquals(
    subjects.get("0123456789abcdef0123456789abcdef01234567"),
    "Subject line",
  );
});

Deno.test("realGit: reads HEAD and amends the message, keeping the tree", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await Deno.writeTextFile(`${root}/f.txt`, "a\nb\n");
    await git(root, ["add", "f.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);

    const g = realGit(root);
    const head = g.headSha();
    assert(head && head.length === 40, `HEAD is a full hash: ${head}`);

    // Stage an unrelated change to prove the amend does not fold it in.
    await Deno.writeTextFile(`${root}/f.txt`, "a\nb\nc\n");
    await git(root, ["add", "f.txt"]);

    const status = g.amendCommit(
      "new subject\n\nnew body",
      new Map(),
      head,
    );
    assert(status.status.includes("Amended"), status.status);
    assertEquals(
      (await git(root, ["log", "-1", "--format=%B"])).trim(),
      "new subject\n\nnew body",
    );
    assert(g.headSha() !== head, "amending produced a new commit");
    // The committed tree still has two lines; the staged `c` was not included.
    assertEquals(await git(root, ["show", "HEAD:f.txt"]), "a\nb\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: preserves non-UTF-8 commit message bytes", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await git(root, ["config", "i18n.commitEncoding", "ISO-8859-1"]);
    const file = `${root}/f.txt`;
    await Deno.writeTextFile(file, "before\n");
    await git(root, ["add", "f.txt"]);
    const messagePath = `${root}/message`;
    await Deno.writeFile(messagePath, new Uint8Array([0xff, 0x0a]));
    await git(root, [
      "commit",
      "-q",
      "--allow-empty",
      "--cleanup=verbatim",
      "-F",
      messagePath,
    ]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");
    await git(root, ["config", "--unset", "i18n.commitEncoding"]);
    await Deno.writeTextFile(file, "after\n");

    runner.amendCommit(null, new Map([[file, "after\n"]]), head);

    const output = await new Deno.Command("git", {
      args: ["cat-file", "commit", "HEAD"],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(output.success, "the amended commit can be read");
    let separator = -1;
    for (let index = 0; index + 1 < output.stdout.length; index++) {
      if (output.stdout[index] === 10 && output.stdout[index + 1] === 10) {
        separator = index;
        break;
      }
    }
    assert(separator >= 0, "the commit has a message separator");
    assertEquals(
      output.stdout.slice(separator + 2),
      new Uint8Array([0xff, 0x0a]),
    );
    assertEquals(await git(root, ["show", "HEAD:f.txt"]), "after\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "realGit: rolls back nested commits after hooks expire reflogs",
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
        const marker = `${root}/.git/nested-expiry-hook-ran`;
        await installHook(
          root,
          "post-commit",
          `if test ! -e ${shellQuote(marker)}; then
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
  name: "realGit: amends a POSIX path containing a literal backslash",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      const path = `${root}/back\\slash.txt`;
      await Deno.writeTextFile(path, "old\n");
      await git(root, ["add", "--", "back\\slash.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");

      runner.amendCommit("amended", new Map([[path, "pager\n"]]), head);
      assertEquals(
        await git(root, ["show", "HEAD:back\\slash.txt"]),
        "pager\n",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: branch-aware hooks see the branch being amended",
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
      const branch = runner.headRef!();
      const head = runner.headSha();
      assert(branch && head, "repository has a branch and HEAD commit");
      await installHook(
        root,
        "pre-commit",
        `test "$(git branch --show-current)" = ${shellQuote(branch.slice(11))}`,
      );

      runner.amendCommit("amended", new Map(), head, branch);
      assert(runner.headSha() !== head, "the branch-aware hook allowed amend");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("realGit: headSha is null when git cannot run (bad cwd)", () => {
  // A cwd that does not exist makes the git subprocess fail to launch; the
  // runner catches it and reports no HEAD rather than throwing.
  assertEquals(realGit("/no/such/directory/really").headSha(), null);
});

Deno.test("realGit: preserves a staged version that already matches the pager", async () => {
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
    await git(root, ["add", "selected.txt"]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    runner.amendCommit(
      "amended",
      new Map([[path, "pager\n"]]),
      head,
    );

    assertEquals(await git(root, ["show", "HEAD:selected.txt"]), "pager\n");
    assertEquals(await git(root, ["show", ":selected.txt"]), "pager\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "realGit: surfaces malformed repository and tree responses from Git",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      const path = `${root}/tracked.txt`;
      await Deno.writeTextFile(path, "tracked\n");
      await git(root, ["add", "tracked.txt"]);
      await git(root, ["commit", "-q", "-m", "original"]);
      const head = (await git(root, ["rev-parse", "HEAD"])).trim();

      await withGitShim(
        `if test "$1" = rev-parse && test "$2" = --show-toplevel; then
  exit 0
fi`,
        () =>
          assertThrows(
            () => realGit(root).fileAtCommit(head, path),
            Error,
            "repository root is unavailable",
          ),
      );
      await withGitShim(
        `if test "$1" = rev-parse && test "$2" = --show-toplevel; then
  printf '%s\\n' /definitely/missing/cf-view-root
  exit 0
fi`,
        () =>
          assertThrows(
            () => realGit(root).fileAtCommit(head, path),
            Error,
            "outside the repository",
          ),
      );
      assertThrows(
        () => realGit(root).fileAtCommit(head, `${root}/missing/child.txt`),
        Error,
      );
      await withGitShim(
        `if test "$1" = --literal-pathspecs && test "$2" = ls-tree; then
  printf '100644 blob aaaa\\ttracked.txt\\000100644 blob bbbb\\ttracked.txt\\000'
  exit 0
fi`,
        () =>
          assertThrows(
            () => realGit(root).fileAtCommit(head, path),
            Error,
            "more than one entry",
          ),
      );
      await withGitShim(
        `if test "$1" = --literal-pathspecs && test "$2" = ls-tree; then
  printf 'malformed\\000'
  exit 0
fi`,
        () =>
          assertThrows(
            () => realGit(root).fileAtCommit(head, path),
            Error,
            "tree entry is invalid",
          ),
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
