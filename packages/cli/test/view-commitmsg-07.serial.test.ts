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
} from "./view-commitmsg-test-helpers.ts";

Deno.test("findCommitHeaders: email message text is not a compact header", () => {
  const full = "0123456789abcdef0123456789abcdef01234567";
  const lines = [
    `From ${full} Mon Sep 17 00:00:00 2001`,
    "From: A B <a@b.example>",
    "Date: Wed, 1 Jul 2026 12:00:00 -0700",
    "Subject: [PATCH] Subject",
    "",
    "ffff ordinary body line",
    "commit deadbeef",
    `From ${"f".repeat(40)} Mon Sep 17 00:00:00 2001`,
    "From: Fake Author <fake@example.test>",
    "Date: Wed, 1 Jul 2026 12:00:00 -0700",
    "Subject: [PATCH] Embedded envelope",
    "",
    "diff --git a/f b/f",
  ];

  assertEquals(findCommitHeaders(lines), [{ sha: full, line: 0 }]);
});

Deno.test("commit messages ignore CRLF transport carriage returns", () => {
  const lines = [
    "commit 0123456789abcdef0123456789abcdef01234567",
    "Author: A B <a@b.example>",
    "Date:   Wed Jul 1 12:00:00 2026 -0700",
    "",
    "    Subject line",
    "    ",
    "    Body paragraph.",
    "",
  ].join("\r\n").split("\n");
  const messages = findCommitMessages(lines);

  assertEquals(messages.length, 1);
  assertEquals(
    extractMessage(lines, messages[0]),
    "Subject line\n\nBody paragraph.",
  );
});

Deno.test({
  name: "realGit: hook-spawned Git uses a linked worktree's hooks",
  ignore: Deno.build.os === "windows",
  async fn() {
    const parent = await Deno.makeTempDir();
    const root = `${parent}/root`;
    const linked = `${parent}/linked`;
    try {
      await Deno.mkdir(root);
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
      await git(root, ["worktree", "add", "-q", "-b", "linked", linked]);
      await git(root, ["config", "extensions.worktreeConfig", "true"]);
      await git(root, [
        "config",
        "--worktree",
        "core.hooksPath",
        ".root-hooks",
      ]);
      await git(linked, [
        "config",
        "--worktree",
        "core.hooksPath",
        ".linked-hooks",
      ]);
      await Deno.mkdir(`${root}/.root-hooks`);
      await Deno.mkdir(`${linked}/.linked-hooks`);
      const rootMarker = `${root}/pre-commit-ran`;
      const linkedMarker = `${linked}/pre-commit-ran`;
      await Deno.writeTextFile(
        `${root}/.root-hooks/pre-commit`,
        `#!/bin/sh
test ! -e ${shellQuote(rootMarker)} || exit 44
printf ran > ${shellQuote(rootMarker)}
`,
      );
      await Deno.chmod(`${root}/.root-hooks/pre-commit`, 0o755);
      await Deno.writeTextFile(
        `${linked}/.linked-hooks/pre-commit`,
        `#!/bin/sh
printf ran > ${shellQuote(linkedMarker)}
`,
      );
      await Deno.chmod(`${linked}/.linked-hooks/pre-commit`, 0o755);
      await Deno.writeTextFile(
        `${root}/.root-hooks/post-commit`,
        `#!/bin/sh
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX
git -C ${shellQuote(linked)} commit --allow-empty -q -m nested
`,
      );
      await Deno.chmod(`${root}/.root-hooks/post-commit`, 0o755);
      const runner = realGit(root);
      const original = runner.headSha();
      assert(original, "source repository has a HEAD commit");

      runner.amendCommit("amended", new Map(), original);

      assertEquals(await Deno.readTextFile(rootMarker), "ran");
      assertEquals(await Deno.readTextFile(linkedMarker), "ran");
      assertEquals(
        (await git(linked, ["rev-list", "--count", "HEAD"])).trim(),
        "2",
      );
    } finally {
      await Deno.remove(parent, { recursive: true });
    }
  },
});

Deno.test({
  name: "realGit: accepts an amend after a hook expires its reflog entry",
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
        await installHook(
          root,
          "post-commit",
          "git reflog expire --expire=now --all",
        );
        const runner = realGit(root);
        const original = runner.headSha();
        assert(original, "repository has a HEAD commit");

        const result = runner.amendCommit("amended", new Map(), original);

        assert(result.head !== original, `${storage} replaced the commit`);
        assertEquals(runner.headSha(), result.head);
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

Deno.test("realGit: refuses to merge content into a staged file type change", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    const path = `${root}/selected.txt`;
    await Deno.writeTextFile(path, "target");
    await git(root, ["add", "selected.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    const linkObject =
      (await git(root, ["hash-object", "-w", "--stdin"], "target"))
        .trim();
    await git(root, [
      "update-index",
      "--cacheinfo",
      `120000,${linkObject},selected.txt`,
    ]);
    const stagedBefore = await git(root, [
      "ls-files",
      "--stage",
      "selected.txt",
    ]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    assertThrows(
      () =>
        runner.amendCommit(
          "amended",
          new Map([[path, "TARGET"]]),
          head,
        ),
      Error,
      "staged file type change",
    );

    assertEquals(runner.headSha(), head);
    assertEquals(await git(root, ["show", "HEAD:selected.txt"]), "target");
    assertEquals(
      await git(root, ["ls-files", "--stage", "selected.txt"]),
      stagedBefore,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "realGit: a concurrent branch update wins the compare-and-swap",
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
      const tree = (await git(root, ["rev-parse", `${head}^{tree}`])).trim();
      const concurrent = (await git(
        root,
        ["commit-tree", tree, "-p", head],
        "concurrent\n",
      )).trim();
      assert(concurrent, "created the concurrent commit");
      const branch = (await git(root, ["symbolic-ref", "HEAD"])).trim();
      await installHook(
        root,
        "pre-commit",
        `git --git-dir=${shellQuote(`${root}/.git`)} update-ref ${
          shellQuote(branch)
        } ${shellQuote(concurrent)} ${shellQuote(head)}`,
      );

      let error = "";
      try {
        runner.amendCommit("amended", new Map([[path, "pager\n"]]), head);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      assert(error.length > 0, "the raced amend failed");
      assertEquals(runner.headSha(), concurrent);
      assertEquals(await git(root, ["show", "HEAD:f.txt"]), "original\n");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("realGit: headSha is null outside a repository", () => {
  const root = Deno.makeTempDirSync();
  try {
    assertEquals(realGit(root).headSha(), null);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("realGit: fallback merge handles insertions around added and empty content", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    const runner = realGit(root);
    const path = `${root}/selected.txt`;

    assertEquals(
      runner.applyFileChanges(
        "A\nB\nC\n",
        "A\nX\nB\nC\n",
        "P\nA\nQ\nX\nR\nB\nC\n",
        path,
      ),
      "P\nA\nQ\nR\nB\nC\n",
    );
    assertEquals(
      runner.applyFileChanges("", "X\n", "P\nX\nQ\n", path),
      "P\nQ",
    );
    assertEquals(
      runner.applyFileChanges("\n", "\nX\n", "P\n\nX\nQ\n", path),
      "P\n\nQ\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name:
    "realGit: reports a reference lock created after Git publishes the amend",
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
      const refPath = (await git(root, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        branch,
      ])).trim();
      const lock = `${refPath}.lock`;
      await installHook(root, "post-commit", `: > ${shellQuote(lock)}`);

      const error = assertThrows(
        () => runner.amendCommit("amended", new Map(), head),
        Error,
        "reference is locked",
      );
      assert(error.message.includes("rollback failed"), error.message);
      assert(runner.headSha() !== head, "the lock also prevented rollback");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
