import { assert, assertEquals, assertThrows } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
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

Deno.test("findCommitMessages: a SHA-256 repository's 64-character object id", () => {
  const sha = "a".repeat(64);
  const lines = [`commit ${sha}`, "Author: A B <a@b>", "", "    Subject", ""];
  const msgs = findCommitMessages(lines);
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].sha, sha);
  assertEquals([msgs[0].start, msgs[0].end], [3, 3]);
});

Deno.test("commitSubjects: an email Subject wrapped over continuation lines", () => {
  const full = "0123456789abcdef0123456789abcdef01234567";
  const subjects = commitSubjects([
    `From ${full} Mon Sep 17 00:00:00 2001`,
    "From: A B <a@b.example>",
    "Date: Wed, 1 Jul 2026 12:00:00 -0700",
    "Subject: [PATCH v2 2/3] Rework the reconciliation path so that it",
    " no longer drops pending writes",
    "",
    "diff --git a/f b/f",
  ]);
  assertEquals(
    subjects.get(full),
    "Rework the reconciliation path so that it no longer drops pending writes",
  );
});

Deno.test({
  name: "realGit: preserves whitespace in a relative core.hooksPath",
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
      const hooksName = " custom-hooks ";
      await git(root, ["config", "core.hooksPath", hooksName]);
      const hooks = `${root}/${hooksName}`;
      await Deno.mkdir(hooks);
      const marker = `${root}/post-commit-ran`;
      const hook = `${hooks}/post-commit`;
      await Deno.writeTextFile(
        hook,
        `#!/bin/sh\nprintf ran > ${shellQuote(marker)}\n`,
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

describe("realGit binary input", () => {
  it("rejects binary commit blobs before merging them as text", async () => {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      const nulPath = `${root}/payload.data`;
      const namedBinaryPath = `${root}/asset.png`;
      await Deno.writeFile(
        nulPath,
        new Uint8Array([98, 101, 102, 111, 114, 101, 10, 0, 97]),
      );
      await Deno.writeTextFile(namedBinaryPath, "printable source text\n");
      await git(root, ["add", "payload.data", "asset.png"]);
      await git(root, ["commit", "-q", "-m", "binary inputs"]);
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");

      expect(() => runner.fileAtCommit(head, nulPath)).toThrow(
        "Binary data is shown as a hex dump",
      );
      expect(() => runner.fileAtCommit(head, namedBinaryPath)).toThrow(
        "Binary data is shown as a hex dump",
      );
      expect(() =>
        runner.amendCommit(
          null,
          new Map([[nulPath, "edited text\n"]]),
          head,
        )
      ).toThrow("Binary data is shown as a hex dump");
      expect(runner.headSha()).toBe(head);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("preserves a UTF-8 BOM when amended text is re-encoded", async () => {
    const root = await Deno.makeTempDir();
    try {
      await git(root, ["init", "-q"]);
      await git(root, ["config", "user.email", "t@t.test"]);
      await git(root, ["config", "user.name", "Test"]);
      const path = `${root}/value.ts`;
      await Deno.writeFile(
        path,
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...new TextEncoder().encode("export const value = 1;\n"),
        ]),
      );
      await git(root, ["add", "value.ts"]);
      await git(root, ["commit", "-q", "-m", "initial"]);
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");
      expect(runner.fileAtCommit(head, path)).toBe(
        "export const value = 1;\n",
      );

      runner.amendCommit(
        null,
        new Map([[path, "export const value = 2;\n"]]),
        head,
      );
      const shown = await new Deno.Command("git", {
        cwd: root,
        args: ["show", "HEAD:value.ts"],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(shown.success, new TextDecoder().decode(shown.stderr));
      expect(shown.stdout).toEqual(
        new Uint8Array([
          0xef,
          0xbb,
          0xbf,
          ...new TextEncoder().encode("export const value = 2;\n"),
        ]),
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

Deno.test("realGit: amends reftable commits and preserves staged state", async () => {
  const root = await Deno.makeTempDir();
  try {
    if (!await initReftable(root)) return;

    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await Deno.writeTextFile(`${root}/selected.txt`, "original selected\n");
    await Deno.writeTextFile(`${root}/unrelated.txt`, "original unrelated\n");
    await git(root, ["add", "selected.txt", "unrelated.txt"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    const marker = `${root}/hook-ran`;
    await installHook(root, "pre-commit", `touch ${shellQuote(marker)}`);
    await Deno.writeTextFile(`${root}/selected.txt`, "amended selected\n");
    await Deno.writeTextFile(`${root}/unrelated.txt`, "staged unrelated\n");
    await git(root, ["add", "unrelated.txt"]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    const result = runner.amendCommit(
      "amended",
      new Map([[`${root}/selected.txt`, "amended selected\n"]]),
      head,
    );

    assert(result.head !== head, "the reftable commit was replaced");
    assertEquals(runner.headSha(), result.head);
    assertEquals(
      (await git(root, ["log", "-1", "--format=%s"])).trim(),
      "amended",
    );
    assertEquals(
      await git(root, ["show", "HEAD:selected.txt"]),
      "amended selected\n",
    );
    assertEquals(
      await git(root, ["show", "HEAD:unrelated.txt"]),
      "original unrelated\n",
    );
    assertEquals(
      await git(root, ["show", ":unrelated.txt"]),
      "staged unrelated\n",
    );
    await Deno.stat(marker);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: preserves pager insertion order around a workspace insertion", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    const runner = realGit(root);
    assert(runner.applyFileChanges, "the real Git runner applies file changes");
    assertEquals(
      runner.applyFileChanges(
        "A\nB\n",
        "A\nX\nB\n",
        "A\nP\nX\nQ\nB\n",
        `${root}/f.txt`,
      ),
      "A\nP\nQ\nB\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("realGit: reads and writes selected files through clean filters", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await git(root, ["config", "filter.caps.clean", "tr a-z A-Z"]);
    await git(root, ["config", "filter.caps.smudge", "tr A-Z a-z"]);
    await Deno.writeTextFile(`${root}/.gitattributes`, "*.dat filter=caps\n");
    const path = `${root}/f.dat`;
    await Deno.writeTextFile(path, "original\n");
    await git(root, ["add", ".gitattributes", "f.dat"]);
    await git(root, ["commit", "-q", "-m", "original"]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    assertEquals(runner.fileAtCommit(head, path), "original\n");
    runner.amendCommit("amended", new Map([[path, "pager\n"]]), head);

    assertEquals(await git(root, ["show", "HEAD:f.dat"]), "PAGER\n");
    assertEquals(await git(root, ["show", ":f.dat"]), "PAGER\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "realGit: rolls back a nested commit made by a post-commit hook",
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
      const marker = `${root}/.git/nested-hook-ran`;
      await installHook(
        root,
        "post-commit",
        `if test ! -e ${shellQuote(marker)}; then
  touch ${shellQuote(marker)}
  git commit --allow-empty -q -m nested
fi`,
      );

      let error = "";
      try {
        runner.amendCommit("amended", new Map(), head);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      assert(error.includes("HEAD changed"), error || "the amend did not fail");
      assertEquals(runner.headSha(), head);
      assertEquals(
        (await git(root, ["rev-list", "--count", "HEAD"])).trim(),
        "1",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("realGit: rejects a stale expected HEAD", async () => {
  const root = await Deno.makeTempDir();
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "t@t.test"]);
    await git(root, ["config", "user.name", "Test"]);
    await git(root, ["commit", "-q", "--allow-empty", "-m", "original"]);
    const runner = realGit(root);
    const head = runner.headSha();
    assert(head, "repository has a HEAD commit");

    assertThrows(
      () => runner.amendCommit("amended", new Map(), "0".repeat(head.length)),
      Error,
      "HEAD moved before",
    );
    assertEquals(runner.headSha(), head);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "realGit: rejects two journal claims for the amended commit",
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
    printf '%s %s %s\n%s %s %s\n' "$old" "$object" refs/heads/claim-a "$old" "$object" refs/heads/claim-b > "$(dirname "$GIT_INDEX_FILE")/reference-transactions"
  fi
fi`,
      );
      const runner = realGit(root);
      const head = runner.headSha();
      assert(head, "repository has a HEAD commit");

      assertThrows(
        () => runner.amendCommit("amended", new Map(), head),
        Error,
        "more than one possible amended commit",
      );
      assert(
        runner.headSha() !== head,
        "ambiguous ownership leaves the new ref untouched",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
