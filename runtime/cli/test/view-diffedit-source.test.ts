/**
 * Tests for the diff editable source (`lib/view/diffedit.ts`): its hunk lookup,
 * blame targets for files the workspace does not hold, revert when the edited
 * diff has lost a file, context expansion that keeps a header's section text,
 * and the amend that refuses a changed hunk it cannot rebuild.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";

import type { GitRunner } from "../lib/view/commitmsg.ts";
import { parseDiff } from "../lib/view/diff.ts";
import { buildDiffDocument, type DiffWorkspace } from "../lib/view/diffdoc.ts";
import { diffSource } from "../lib/view/diffedit.ts";
import { describe, it } from "@commonfabric/test-support/test";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const FILE = "const x = 1;\nconst y = 2;\nconst z = 3;\n";

const DIFF = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,3 +1,3 @@
 const x = 1;
-const y = 0;
+const y = 2;
 const z = 3;
`;

/** DIFF as `git show` prints it, under a commit header and message. */
const SHOW = `commit ${SHA}
Author: A <a@example.com>
Date:   Mon Jan 5 10:00:00 2026 +0000

    change y

${DIFF}`;

/** A workspace in a fresh directory holding `files`. */
function workspace(files: Record<string, string>): {
  root: string;
  ws: DiffWorkspace;
  done: () => void;
} {
  const root = Deno.makeTempDirSync();
  for (const [name, text] of Object.entries(files)) {
    Deno.writeTextFileSync(join(root, name), text);
  }
  const ws: DiffWorkspace = {
    resolve: (path) => join(root, path),
    read: (abs) => {
      try {
        return Deno.readTextFileSync(abs);
      } catch {
        return null;
      }
    },
  };
  return { root, ws, done: () => Deno.removeSync(root, { recursive: true }) };
}

function sourceFor(diff: string, ws: DiffWorkspace, git?: GitRunner) {
  const { edit } = buildDiffDocument(diff, parseDiff(diff)!, ws);
  return diffSource(ws, edit, undefined, git);
}

/** A git whose HEAD is SHA, recording what it is asked to amend. */
function headGit(repoRoot: () => string | null = () => null): {
  git: GitRunner;
  amends: ReadonlyMap<string, string>[];
} {
  const amends: ReadonlyMap<string, string>[] = [];
  return {
    git: {
      headSha: () => SHA,
      repoRoot,
      fileAtCommit: () => FILE,
      applyFileChanges: (_committed, _before, after) => after,
      amendCommit: (_message, files, expectedHead) => {
        amends.push(files);
        return { status: "Amended the commit", head: expectedHead };
      },
    },
    amends,
  };
}

describe("view-diffedit-source", () => {
  describe("policy.hunkAt()", () => {
    it("returns the hunk holding a body row", () => {
      const { ws, done } = workspace({ "m.ts": FILE });
      try {
        const policy = sourceFor(DIFF, ws).policy!;
        const found = policy.hunkAt!(DIFF.split("\n"), 6);
        expect(found?.hunk).toMatchObject({ headerLine: 3, endLine: 7 });
        expect(policy.hunkAt!(DIFF.split("\n"), 3)).toBeNull();
      } finally {
        done();
      }
    });

    it("returns null for text that is not a diff", () => {
      const { ws, done } = workspace({ "m.ts": FILE });
      try {
        const policy = sourceFor(DIFF, ws).policy!;
        expect(policy.hunkAt!(["just text", "more text"], 1)).toBeNull();
      } finally {
        done();
      }
    });
  });

  describe("blameTargets()", () => {
    it("blames a commit's file outside the workspace from the repository root", () => {
      const { root, ws, done } = workspace({});
      try {
        let asked = 0;
        const { git } = headGit(() => {
          asked++;
          return "/repo";
        });
        const source = sourceFor(SHOW, ws, git);
        const outside: DiffWorkspace = { ...ws, resolve: () => null };
        const blamed = sourceFor(SHOW, outside, git);
        expect(source.blameTargets!(SHOW, SHOW)[12]).toEqual({
          request: { cwd: root, path: "m.ts", rev: SHA },
          line: 1,
          text: "const y = 2;",
        });
        const targets = blamed.blameTargets!(SHOW, SHOW);
        expect(targets[12]).toEqual({
          request: { cwd: "/repo", path: "m.ts", rev: SHA },
          line: 1,
          text: "const y = 2;",
        });
        expect(targets[11]).toBeNull();
        // Each source asks for the repository root once, however often it
        // finds blame targets.
        const askedBefore = asked;
        blamed.blameTargets!(SHOW, SHOW);
        expect(askedBefore).toBe(2);
        expect(asked).toBe(askedBefore);
      } finally {
        done();
      }
    });

    it("blames nothing outside the workspace without a repository root", () => {
      const { ws, done } = workspace({});
      try {
        const outside: DiffWorkspace = { ...ws, resolve: () => null };
        const targets = sourceFor(SHOW, outside).blameTargets!(SHOW, SHOW);
        expect(targets.every((target) => target === null)).toBe(true);
      } finally {
        done();
      }
    });

    it("returns no targets for a deleted file or text that is not a diff", () => {
      const { ws, done } = workspace({ "m.ts": FILE });
      try {
        const deleted = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-const gone = 1;
${DIFF}`;
        const source = sourceFor(deleted, ws);
        const targets = source.blameTargets!(deleted, deleted);
        expect(targets.slice(0, 6)).toEqual([
          null,
          null,
          null,
          null,
          null,
          null,
        ]);
        expect(targets[12]?.text).toBe("const y = 2;");
        expect(source.blameTargets!("plain\ntext", "plain\ntext")).toEqual([
          null,
          null,
        ]);
      } finally {
        done();
      }
    });
  });

  describe("revert()", () => {
    it("restores the whole original when the edited diff has lost a file", () => {
      const { ws, done } = workspace({ "m.ts": FILE, "n.ts": FILE });
      try {
        const two = `${DIFF}${DIFF.replaceAll("m.ts", "n.ts")}`;
        const source = sourceFor(two, ws);
        const lost = `${DIFF.replace("+const y = 2;", "+const y = 22;")}`;
        const endings = source.lineEndingProvenance!(lost);
        const result = source.revert!(two, lost, 6, "all", endings);
        expect(result?.text).toBe(two);
        expect(result?.lineEndings?.length).toBe(two.split("\n").length);
      } finally {
        done();
      }
    });

    it("restores the whole original when a file has lost a hunk", () => {
      const file = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
        .join("\n") + "\n";
      const first = `@@ -2,1 +2,1 @@
-old 2
+line 2
`;
      const second = `@@ -18,1 +18,1 @@
-old 18
+line 18
`;
      const header = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n";
      const { ws, done } = workspace({ "f.txt": file });
      try {
        const original = `${header}${first}${second}`;
        const source = sourceFor(original, ws);
        const lost = `${header}${first.replace("+line 2", "+line two")}`;
        const endings = source.lineEndingProvenance!(lost);
        const result = source.revert!(original, lost, 5, "all", endings);
        expect(result?.text).toBe(original);
        expect(result?.lineEndings?.length).toBe(
          original.split("\n").length,
        );
      } finally {
        done();
      }
    });
  });

  describe("expandContext()", () => {
    it("keeps the header's section text and grows its ranges", () => {
      const file = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`)
        .join("\n") + "\n";
      const diff = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -6,2 +6,2 @@ section text
-old 6
+line 6
 line 7
`;
      const { ws, done } = workspace({ "f.txt": file });
      try {
        const source = sourceFor(diff, ws);
        const up = source.expandContext!(diff, diff, 5, true);
        expect(up?.text.split("\n").slice(3, 6)).toEqual([
          "@@ -1,7 +1,7 @@ section text",
          " line 1",
          " line 2",
        ]);
        const down = source.expandContext!(diff, diff, 6, false);
        expect(down?.text.split("\n")[3]).toBe(
          "@@ -6,7 +6,7 @@ section text",
        );
      } finally {
        done();
      }
    });
  });

  describe("save()", () => {
    it("refuses to amend a changed commit hunk that does not match the file", () => {
      const { ws, done } = workspace({ "m.ts": "something else\n" });
      try {
        const { git, amends } = headGit();
        const source = sourceFor(SHOW, ws, git);
        const edited = SHOW.replace("+const y = 2;", "+const y = 3;");
        const lineEndings = source.lineEndingProvenance!(edited);
        expect(() => source.save(edited, lineEndings, SHOW)).toThrow(
          /^Could not rebuild .*m\.ts for the amended commit\.$/,
        );
        expect(amends).toEqual([]);
      } finally {
        done();
      }
    });
  });
});
