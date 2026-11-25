/**
 * Tests for `cf view`'s blame column: parsing and labeling `git blame` output,
 * running it against a real repository, and the pager session that loads it
 * for the lines in view and draws it at the right of the screen.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";

import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { describe, it } from "@commonfabric/test-support/test";
import { term } from "../lib/view/ansi.ts";
import { visibleWidth } from "../lib/view/width.ts";
import {
  BLAME_WIDTH,
  blameAge,
  blameLabel,
  type BlameLine,
  type BlameRequest,
  blameRunner,
  githubRepositoryPage,
  parseBlamePorcelain,
  parseCommitLine,
} from "../lib/view/blame.ts";
import { realGit } from "../lib/view/commitmsg.ts";
import { parseDiff } from "../lib/view/diff.ts";
import { buildDiffDocument, realWorkspace } from "../lib/view/diffdoc.ts";
import { diffSource } from "../lib/view/diffedit.ts";
import { type EditableSource, fileSource } from "../lib/view/editsource.ts";
import { languageForFile } from "../lib/view/languages/language.ts";
import { _internal, renderFrame } from "../lib/view/render.ts";
import { Session } from "../lib/view/session.ts";

/** A signal that never aborts. */
const NEVER = new AbortController().signal;

/** The time the tests' ages are measured to. */
const NOW = Date.UTC(2026, 9, 21, 10);

const ALICE = "a".repeat(40);
const BOB = "b".repeat(40);

/** Porcelain output for a three-line file: lines 1 and 3 from Alice's commit,
 * line 2 from Bob's. Alice's headers are written once, as git writes them. */
const PORCELAIN = [
  `${ALICE} 1 1 1`,
  "author Alice Example",
  "author-mail <alice@example.com>",
  "author-time 1767312000",
  "author-tz +0100",
  "summary First",
  "filename f.ts",
  "\tone",
  `${BOB} 2 2 1`,
  "author Bob",
  "author-mail <bob@example.com>",
  "author-time 1767312000",
  "author-tz -0800",
  "summary Second",
  "previous " + ALICE + " f.ts",
  "filename f.ts",
  "\ttwo",
  `${ALICE} 3 3`,
  "\tthree",
  "",
].join("\n");

/** A repository whose `f.ts` has its first and third lines from Alice's
 * commit and its second from Bob's later one. */
async function repository(): Promise<{ root: string; path: string }> {
  // The path git reports, which on macOS is not the one the temporary
  // directory is created at, so that the viewer's commit requests, which run
  // at the path git reports, and its file requests name the same directory.
  const root = await Deno.realPath(await Deno.makeTempDir());
  const path = join(root, "f.ts");
  const commit = async (author: string, date: string) => {
    await git(root, ["add", "f.ts"]);
    await git(root, ["commit", "-q", "-m", `by ${author}`], {
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: `${author.toLowerCase()}@example.com`,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: author,
      GIT_COMMITTER_EMAIL: `${author.toLowerCase()}@example.com`,
      GIT_COMMITTER_DATE: date,
    });
  };
  await git(root, ["init", "-q"]);
  await Deno.writeTextFile(path, "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  await commit("Alice", "2025-03-04T10:00:00+00:00");
  await Deno.writeTextFile(path, "const a = 1;\nconst b = 20;\nconst c = 3;\n");
  await commit("Bob", "2026-05-06T10:00:00+00:00");
  return { root, path };
}

async function git(
  root: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<string> {
  const output = await new Deno.Command("git", {
    args: [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    cwd: root,
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }
  return new TextDecoder().decode(output.stdout);
}

/** The environment for a commit by Carol, written twenty days before
 * {@link NOW}. */
function carol(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: "Carol",
    GIT_AUTHOR_EMAIL: "carol@example.com",
    GIT_AUTHOR_DATE: "2026-10-01T10:00:00+00:00",
    GIT_COMMITTER_NAME: "Carol",
    GIT_COMMITTER_EMAIL: "carol@example.com",
    GIT_COMMITTER_DATE: "2026-10-01T10:00:00+00:00",
  };
}

/** Blame `request` with a runner of its own, which finds the GitHub page
 * afresh. */
function runBlame(request: BlameRequest): Promise<BlameLine[]> {
  return blameRunner()(request, NEVER);
}

function press(session: Session, ...names: string[]): void {
  for (const name of names) {
    session.handleKey(
      name.length === 1 ? { name, char: name } : { name },
    );
  }
}

function fileSession(
  path: string,
  width = 80,
  height = 10,
  color = false,
): Session {
  const source = fileSource(path, languageForFile(path));
  const text = Deno.readTextFileSync(path);
  return new Session(
    source.parse(text),
    { color, showLineNumbers: false, now: () => NOW },
    { width, height },
    undefined,
    source,
  );
}

/** Draw a frame and run every blame load it asks for, as the pager does. */
async function loadBlames(session: Session): Promise<number> {
  session.view();
  const loads = session.takeBlameLoads();
  for (const load of loads) {
    try {
      session.finishBlameLoad(load, await runBlame(load.request));
    } catch (error) {
      session.failBlameLoad(
        load,
        describeFailure(error),
      );
    }
  }
  return loads.length;
}

/** The blame column of each content row, trimmed. */
function blameColumn(session: Session): string[] {
  const view = session.view();
  return renderFrame(session.displayDoc(), view).slice(0, view.height - 1)
    .map((row) => row.slice(view.width - BLAME_WIDTH).trim());
}

describe("blame", () => {
  describe("parseBlamePorcelain()", () => {
    it("returns each line's commit, author, time and text in file order", () => {
      const lines = parseBlamePorcelain(PORCELAIN);
      expect(lines.map((line) => [line.commit, line.author, line.text]))
        .toEqual([
          [ALICE, "Alice Example", "one"],
          [BOB, "Bob", "two"],
          [ALICE, "Alice Example", "three"],
        ]);
      expect(lines[2].time).toBe(1767312000);
    });

    it("throws for output that is not porcelain", () => {
      expect(() => parseBlamePorcelain("fatal: no such path\n")).toThrow(
        "Unexpected git blame line",
      );
      expect(() => parseBlamePorcelain(`${ALICE} 1 1 1\nauthor A`)).toThrow(
        "Truncated",
      );
    });
  });

  describe("parseCommitLine()", () => {
    it("returns a commit's hash, author and author time", () => {
      expect(parseCommitLine(`${BOB}\n1767312000\nBob Example\n`)).toEqual({
        commit: BOB,
        author: "Bob Example",
        time: 1767312000,
        text: "",
      });
    });

    it("throws for output that is not a commit's line", () => {
      expect(() => parseCommitLine(`${BOB}\nBob\n1767312000\n`)).toThrow(
        "Unexpected git show output",
      );
    });
  });

  describe("blameAge()", () => {
    const ago = (seconds: number) => blameAge(NOW / 1000 - seconds, NOW);
    const day = 24 * 60 * 60;

    it("returns seconds under a minute, minutes under an hour, and so on", () => {
      expect(ago(0)).toBe("0s");
      expect(ago(30)).toBe("30s");
      expect(ago(59)).toBe("59s");
      expect(ago(90)).toBe("2m");
      expect(ago(59 * 60)).toBe("59m");
      expect(ago(5 * 60 * 60)).toBe("5h");
      expect(ago(3 * day)).toBe("3d");
      expect(ago(364 * day)).toBe("364d");
      expect(ago(596 * day)).toBe("2y");
      expect(ago(9999 * 365 * day)).toBe("9999y");
    });

    it("moves to the next unit when rounding reaches it", () => {
      expect(ago(59.6)).toBe("1m");
      expect(ago(23.6 * 60 * 60)).toBe("1d");
      expect(ago(364.6 * day)).toBe("1y");
      expect(ago(23.4 * 60 * 60)).toBe("23h");
    });

    it("returns 0s for a time after now", () => {
      expect(ago(-100)).toBe("0s");
    });
  });

  describe("blameLabel()", () => {
    const line: BlameLine = {
      commit: ALICE,
      author: "Alice",
      time: NOW / 1000 - 3 * 24 * 60 * 60,
      text: "",
    };

    it("returns the age in four columns, then the author", () => {
      expect(blameLabel(line, NOW)).toBe("  3d Alice");
    });

    it("returns uncommitted for a line no commit has", () => {
      expect(blameLabel({ ...line, commit: "0".repeat(40) }, NOW)).toBe(
        "uncommitted",
      );
    });
  });

  describe("githubRepositoryPage()", () => {
    it("returns the page of a repository GitHub hosts", () => {
      for (
        const remote of [
          "git@github.com:owner/repo.git",
          "git@github.com:owner/repo",
          "https://github.com/owner/repo.git",
          "https://github.com/owner/repo",
          "ssh://git@github.com/owner/repo.git",
          "ssh://git@github.com:22/owner/repo.git",
          "https://user@github.com/owner/repo.git",
          "git://github.com/owner/repo.git",
          "git@GitHub.com:owner/repo.git",
        ]
      ) {
        expect(githubRepositoryPage(remote)).toBe(
          "https://github.com/owner/repo",
        );
      }
    });

    it("returns null for a remote elsewhere", () => {
      for (
        const remote of [
          "git@gitlab.com:owner/repo.git",
          "https://example.com/github.com/owner/repo",
          "https://github.com.example.com/owner/repo",
          "git@github.com:owner/repo/extra",
          "/srv/git/repo.git",
          "origin",
        ]
      ) {
        expect(githubRepositoryPage(remote)).toBeNull();
      }
    });
  });

  describe("runBlame()", () => {
    it("attributes each line of a file to the commit that last changed it", async () => {
      const { root } = await repository();
      try {
        const lines = await runBlame({ cwd: root, path: "f.ts" });
        expect(lines.map((line) => line.author)).toEqual([
          "Alice",
          "Bob",
          "Alice",
        ]);
        expect(lines[1].text).toBe("const b = 20;");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("attributes text given in place of the file, and a commit's version", async () => {
      const { root } = await repository();
      try {
        const contents = new TextEncoder().encode(
          "const a = 1;\nconst b = 20;\nconst z = 9;\n",
        );
        const edited = await runBlame({ cwd: root, path: "f.ts", contents });
        expect(blameLabel(edited[2], NOW)).toBe("uncommitted");
        expect(edited[0].author).toBe("Alice");

        const first = (await git(root, ["rev-list", "--max-parents=0", "HEAD"]))
          .trim();
        const old = await runBlame({ cwd: root, path: "f.ts", rev: first });
        expect(old.map((line) => line.author)).toEqual([
          "Alice",
          "Alice",
          "Alice",
        ]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("attributes a commit to its own author and author time", async () => {
      const { root } = await repository();
      try {
        const head = (await git(root, ["rev-parse", "HEAD"])).trim();
        const first = (await git(root, ["rev-parse", "HEAD~"])).trim();
        expect(await runBlame({ cwd: root, rev: "HEAD" })).toEqual([{
          commit: head,
          author: "Bob",
          time: Date.parse("2026-05-06T10:00:00Z") / 1000,
          text: "",
        }]);
        expect(await runBlame({ cwd: root, rev: first.slice(0, 7) })).toEqual([{
          commit: first,
          author: "Alice",
          time: Date.parse("2025-03-04T10:00:00Z") / 1000,
          text: "",
        }]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("names a commit's author as the repository's mailmap does", async () => {
      const { root } = await repository();
      try {
        await Deno.writeTextFile(
          join(root, ".mailmap"),
          "Robert Real <bob@example.com>\n",
        );
        const [commit] = await runBlame({ cwd: root, rev: "HEAD" });
        const lines = await runBlame({ cwd: root, path: "f.ts" });
        expect(commit.author).toBe("Robert Real");
        expect(lines[1].author).toBe("Robert Real");
        expect(lines[0].author).toBe("Alice");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("rejects with git's message for an object that is missing or not a commit", async () => {
      const { root } = await repository();
      try {
        const blob = (await git(root, ["rev-parse", "HEAD:f.ts"])).trim();
        await expect(runBlame({ cwd: root, rev: blob })).rejects.toThrow(
          "blob",
        );
        await expect(runBlame({ cwd: root, rev: "f".repeat(40) })).rejects
          .toThrow("bad revision");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("blames each file in its own repository when git has named a linked worktree's", async () => {
      // Git exports GIT_DIR, without GIT_WORK_TREE, to the pager it starts at
      // the top of a linked worktree.
      const { root } = await repository();
      const other = await repository();
      try {
        await Deno.mkdir(join(root, "sub"));
        await Deno.writeTextFile(join(root, "sub", "g.ts"), "const g = 1;\n");
        await git(root, ["add", "sub/g.ts"]);
        await git(root, ["commit", "-q", "-m", "g"], carol());
        await git(root, ["remote", "add", "origin", "git@github.com:own/g"]);
        await git(other.root, [
          "remote",
          "add",
          "origin",
          "git@github.com:x/y",
        ]);
        // The settings `git -c` passed on still reach git.
        const mailmap = join(root, "mailmap");
        await Deno.writeTextFile(mailmap, "Carol Real <carol@example.com>\n");
        const run = blameRunner({
          ...Deno.env.toObject(),
          GIT_DIR: join(root, ".git"),
          GIT_CONFIG_PARAMETERS: `'mailmap.file'='${mailmap}'`,
        }, root);
        const [line] = await run(
          { cwd: join(root, "sub"), path: "g.ts" },
          NEVER,
        );
        expect(line.author).toBe("Carol Real");
        expect(line.text).toBe("const g = 1;");
        expect(line.url).toContain("https://github.com/own/g/commit/");
        const [elsewhere] = await run({ cwd: other.root, path: "f.ts" }, NEVER);
        expect(elsewhere.author).toBe("Alice");
        expect(elsewhere.url).toContain("https://github.com/x/y/commit/");
      } finally {
        await Deno.remove(root, { recursive: true });
        await Deno.remove(other.root, { recursive: true });
      }
    });

    it("blames a file in the working tree git has named inside its repository", async () => {
      // As `git --work-tree=alt` does from inside the repository, where git
      // would otherwise find the repository's own working tree.
      const { root } = await repository();
      try {
        await Deno.mkdir(join(root, "sub"));
        await Deno.writeTextFile(join(root, "sub", "g.ts"), "const g = 1;\n");
        await git(root, ["add", "sub/g.ts"]);
        await git(root, ["commit", "-q", "-m", "g"], carol());
        const alt = join(root, "alt");
        await Deno.mkdir(join(alt, "sub"), { recursive: true });
        await Deno.writeTextFile(join(alt, "sub", "g.ts"), "const g = 1;\n");
        const run = blameRunner({
          ...Deno.env.toObject(),
          GIT_DIR: join(root, ".git"),
          GIT_WORK_TREE: alt,
        }, alt);
        const [line] = await run(
          { cwd: join(alt, "sub"), path: "g.ts" },
          NEVER,
        );
        expect(line.author).toBe("Carol");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("blames a file in a repository that git has named by its directories", async () => {
      // As `git --git-dir=../dot.git --work-tree=.` does, which leaves no
      // .git in the working tree for git to find.
      const base = await Deno.realPath(await Deno.makeTempDir());
      try {
        const home = join(base, "home");
        await Deno.mkdir(join(home, "sub"), { recursive: true });
        await git(base, ["init", "-q", "--bare", "dot.git"]);
        const named = { GIT_DIR: join(base, "dot.git"), GIT_WORK_TREE: home };
        await Deno.writeTextFile(join(home, "sub", "h.ts"), "const h = 1;\n");
        await git(home, ["add", "sub/h.ts"], named);
        await git(home, ["commit", "-q", "-m", "h"], { ...named, ...carol() });
        const run = blameRunner({
          ...Deno.env.toObject(),
          GIT_DIR: "../dot.git",
          GIT_WORK_TREE: ".",
        }, home);
        const [line] = await run(
          { cwd: join(home, "sub"), path: "h.ts" },
          NEVER,
        );
        expect(line.author).toBe("Carol");
        const [commit] = await run({ cwd: home, rev: "HEAD" }, NEVER);
        expect(commit.commit).toBe(line.commit);
      } finally {
        await Deno.remove(base, { recursive: true });
      }
    });

    it("rejects with git's message for a file git does not track", async () => {
      const { root } = await repository();
      try {
        await Deno.writeTextFile(join(root, "new.ts"), "x\n");
        await expect(runBlame({ cwd: root, path: "new.ts" })).rejects.toThrow(
          "no such path",
        );
        // Text larger than a pipe holds, which git exits without reading.
        const contents = new TextEncoder().encode("x\n".repeat(1 << 20));
        await expect(runBlame({ cwd: root, path: "new.ts", contents })).rejects
          .toThrow("no such path");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("links committed lines to their commits when the remote is on GitHub", async () => {
      const { root } = await repository();
      try {
        const contents = new TextEncoder().encode(
          "const a = 1;\nconst b = 20;\nconst z = 9;\n",
        );
        const unlinked = await runBlame({ cwd: root, path: "f.ts", contents });
        expect(unlinked.map((line) => line.url)).toEqual([
          undefined,
          undefined,
          undefined,
        ]);

        await git(root, [
          "remote",
          "add",
          "origin",
          "git@github.com:owner/repo.git",
        ]);
        const linked = await runBlame({ cwd: root, path: "f.ts", contents });
        expect(linked.map((line) => line.url)).toEqual([
          `https://github.com/owner/repo/commit/${linked[0].commit}`,
          `https://github.com/owner/repo/commit/${linked[1].commit}`,
          undefined,
        ]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("finds a directory's GitHub page once", async () => {
      const { root } = await repository();
      try {
        const runner = blameRunner();
        const before = await runner({ cwd: root, path: "f.ts" }, NEVER);
        expect(before[0].url).toBeUndefined();
        await git(root, [
          "remote",
          "add",
          "origin",
          "git@github.com:owner/repo.git",
        ]);
        const after = await runner({ cwd: root, path: "f.ts" }, NEVER);
        expect(after[0].url).toBeUndefined();
        const fresh = await blameRunner()({ cwd: root, path: "f.ts" }, NEVER);
        expect(fresh[0].url).toContain("https://github.com/owner/repo/");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("falls back to origin, then to another remote on GitHub", async () => {
      const { root } = await repository();
      try {
        // A branch tracking a local branch fetches from `.`.
        await git(root, ["branch", "-M", "main"]);
        await git(root, ["switch", "-q", "-c", "topic", "--track", "main"]);
        await git(root, ["remote", "add", "fork", "git@github.com:me/fork"]);
        const fromFork = await runBlame({ cwd: root, path: "f.ts" });
        expect(fromFork[0].url).toContain("https://github.com/me/fork/");

        await git(root, [
          "remote",
          "add",
          "origin",
          "https://github.com/owner/repo",
        ]);
        const fromOrigin = await runBlame({ cwd: root, path: "f.ts" });
        expect(fromOrigin[0].url).toContain("https://github.com/owner/repo/");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("rejects with git's message for a file outside a repository", async () => {
      const dir = await Deno.makeTempDir();
      try {
        await Deno.writeTextFile(join(dir, "f.ts"), "x\n");
        const contents = new TextEncoder().encode("x\n".repeat(1 << 20));
        await expect(runBlame({ cwd: dir, path: "f.ts", contents })).rejects
          .toThrow("not a git repository");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });

  describe("the pager session", () => {
    it("toggles the column with b and B, and no longer pages up with them", async () => {
      const { root, path } = await repository();
      try {
        const session = fileSession(path, 80, 3);
        press(session, "space");
        const top = session.view().top;
        expect(top).toBeGreaterThan(0);

        press(session, "b");
        expect(session.view().message).toBe("Blame on");
        expect(session.view().top).toBe(top);
        expect(session.view().blame).not.toBeNull();

        press(session, "B");
        expect(session.view().message).toBe("Blame off");
        expect(session.view().blame).toBeNull();
        expect(session.view().top).toBe(top);

        press(session, "pageup");
        expect(session.view().top).toBe(0);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("loads the file's blame once and labels each run of lines once", async () => {
      const { root, path } = await repository();
      try {
        const session = fileSession(path);
        expect(session.takeBlameLoads()).toEqual([]);
        expect(blameColumn(session).every((cell) => cell === "")).toBe(true);

        press(session, "b");
        expect(blameColumn(session).slice(0, 3)).toEqual(["", "", ""]);
        expect(await loadBlames(session)).toBe(1);
        expect(blameColumn(session).slice(0, 3)).toEqual([
          "2y Alice",
          "168d Bob",
          "2y Alice",
        ]);
        expect(await loadBlames(session)).toBe(0);

        // The column takes the right of the screen from the text.
        const row = renderFrame(session.displayDoc(), session.view())[1];
        expect(row.length).toBe(80);
        expect(row.slice(0, 80 - BLAME_WIDTH).trimEnd()).toBe("const b = 20;");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("shows the label once for adjacent lines from one commit", async () => {
      const { root, path } = await repository();
      try {
        await Deno.writeTextFile(
          path,
          "const a = 1;\nconst b = 20;\nconst c = 3;\nconst d = 4;\n",
        );
        await git(root, ["commit", "-q", "-am", "d"], {
          GIT_AUTHOR_NAME: "Carol",
          GIT_AUTHOR_EMAIL: "carol@example.com",
          GIT_AUTHOR_DATE: "2026-07-08T10:00:00+00:00",
          GIT_COMMITTER_NAME: "Carol",
          GIT_COMMITTER_EMAIL: "carol@example.com",
        });
        await Deno.writeTextFile(
          path,
          "const a = 1;\nconst b = 20;\nconst c = 3;\nconst d = 4;\n" +
            "const e = 5;\nconst f = 6;\n",
        );
        await git(root, ["commit", "-q", "-am", "ef"], {
          GIT_AUTHOR_NAME: "Dan",
          GIT_AUTHOR_EMAIL: "dan@example.com",
          GIT_AUTHOR_DATE: "2026-08-09T10:00:00+00:00",
          GIT_COMMITTER_NAME: "Dan",
          GIT_COMMITTER_EMAIL: "dan@example.com",
        });
        const session = fileSession(path, 80, 3);
        press(session, "b");
        await loadBlames(session);
        press(session, "G");
        // Line 6 starts the screen, so it is labeled though line 5, above it
        // and off the screen, comes from the same commit.
        expect(blameColumn(session)).toEqual(["73d Dan", ""]);
        press(session, "k");
        expect(blameColumn(session)).toEqual(["73d Dan", ""]);
        press(session, "k");
        expect(blameColumn(session)).toEqual([
          "105d Carol",
          "73d Dan",
        ]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("blames edited text again, and reads edited lines as uncommitted", async () => {
      const { root, path } = await repository();
      try {
        const session = fileSession(path);
        press(session, "b");
        await loadBlames(session);
        press(session, "e", "end");
        session.handleKey({ name: "x", char: "x" });
        // Until the edited text's blame lands, its lines show nothing.
        expect(blameColumn(session).slice(0, 3)).toEqual(["", "", ""]);
        expect(await loadBlames(session)).toBe(1);
        expect(blameColumn(session).slice(0, 3)).toEqual([
          "uncommitted",
          "168d Bob",
          "2y Alice",
        ]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("drops a result for text that has changed since its load started", async () => {
      const { root, path } = await repository();
      try {
        const session = fileSession(path);
        press(session, "b");
        session.view();
        const [stale] = session.takeBlameLoads();
        press(session, "e", "end");
        session.handleKey({ name: "x", char: "x" });
        session.finishBlameLoad(stale, await runBlame(stale.request));
        // The stale result is not shown, and the edited text is loaded.
        expect(blameColumn(session).slice(0, 3)).toEqual(["", "", ""]);
        expect(await loadBlames(session)).toBe(1);
        expect(blameColumn(session)[0]).toBe("uncommitted");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("reports why git could not blame the file", async () => {
      const { root } = await repository();
      try {
        const path = join(root, "new.ts");
        await Deno.writeTextFile(path, "x\n");
        const session = fileSession(path);
        press(session, "b");
        session.view();
        await loadBlames(session);
        expect(session.view().message).toContain("Blame: ");
        expect(session.view().message).toContain("no such path");
        expect(blameColumn(session)[0]).toBe("");
        expect(await loadBlames(session)).toBe(0);

        // Editing the file does not try it again.
        press(session, "e", "end");
        session.handleKey({ name: "y", char: "y" });
        expect(await loadBlames(session)).toBe(0);
        expect(session.view().message).not.toContain("Blame");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("leaves a narrow screen to the text", async () => {
      const { root, path } = await repository();
      try {
        const session = fileSession(path, 2 * BLAME_WIDTH - 1);
        press(session, "b");
        expect(session.view().message).toBe(
          "Blame on; the screen is too narrow to show it",
        );
        expect(await loadBlames(session)).toBe(0);
        const row = renderFrame(session.displayDoc(), session.view())[0];
        expect(row.trimEnd()).toBe("const a = 1;");

        // Widening the screen shows it.
        session.resize(2 * BLAME_WIDTH, 10);
        expect(await loadBlames(session)).toBe(1);
        expect(blameColumn(session)[0]).toBe("2y Alice");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("draws each label as a link to its commit when color is on", async () => {
      const { root, path } = await repository();
      try {
        await git(root, [
          "remote",
          "add",
          "origin",
          "https://github.com/owner/repo.git",
        ]);
        const alice = (await git(root, ["rev-list", "--max-parents=0", "HEAD"]))
          .trim();
        const colored = fileSession(path, 80, 10, true);
        press(colored, "b");
        await loadBlames(colored);
        const row = renderFrame(colored.displayDoc(), colored.view())[0];
        expect(row).toContain(
          term.hyperlink(
            `https://github.com/owner/repo/commit/${alice}`,
            "2y Alice",
          ),
        );

        const plain = fileSession(path);
        press(plain, "b");
        await loadBlames(plain);
        const plainRow = renderFrame(plain.displayDoc(), plain.view())[0];
        expect(plainRow).toContain("2y Alice");
        expect(plainRow).not.toContain("\x1b");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("keeps every row's width when a dialog covers linked labels", async () => {
      const { root, path } = await repository();
      try {
        await git(root, [
          "remote",
          "add",
          "origin",
          "https://github.com/owner/repo.git",
        ]);
        const session = fileSession(path, 50, 8, true);
        press(session, "b");
        await loadBlames(session);
        press(session, "e", "end");
        session.handleKey({ name: "x", char: "x" });
        press(session, "escape", "j", "Q");
        await loadBlames(session);
        const view = session.view();
        expect(view.dialog).toBeTruthy();
        const rows = renderFrame(session.displayDoc(), view);
        expect(rows.some((row) => row.includes("\x1b]8;;https://"))).toBe(
          true,
        );
        for (const row of rows) {
          expect(visibleWidth(row)).toBe(50);
          expect(row.split("\x1b]8;;").length % 2).toBe(1);
        }
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("keeps a link's columns when part of a row is cut away", () => {
      const row = "ab" + term.hyperlink("https://example.com/", "cd") + "ef";
      expect(_internal.padTo(row, 8)).toBe(row + "  ");
      const middle = _internal.sliceVisible(row, 1, 5);
      expect(middle).toBe(
        "b" + term.hyperlink("https://example.com/", "cd") + "e",
      );
    });

    it("says so when the view has no file to blame", () => {
      const source: EditableSource = {
        label: null,
        editable: false,
        parse: () => {
          throw new Error("unused");
        },
        save: () => "",
      };
      const session = new Session(
        fileSource("x.ts").parse("const a = 1;\n"),
        { color: false, showLineNumbers: false, now: () => NOW },
        { width: 80, height: 10 },
        undefined,
        source,
      );
      press(session, "b");
      expect(session.view().message).toBe("No line here can be blamed");
      expect(session.view().blame).toBeNull();
    });

    it("hands the source the text as last saved with the current text", () => {
      const baselines: string[] = [];
      const target = { request: { cwd: "/", path: "x.ts" }, line: 0 };
      const source: EditableSource = {
        label: null,
        editable: true,
        parse: (text) => fileSource("x.ts").parse(text),
        save: () => "Saved",
        blameTargets: (text, baseline) => {
          baselines.push(baseline);
          return text.split("\n").map(() => target);
        },
      };
      const session = new Session(
        source.parse("one\n"),
        { color: false, showLineNumbers: false, now: () => NOW },
        { width: 80, height: 10 },
        undefined,
        source,
      );
      press(session, "b", "e", "end");
      session.handleKey({ name: "x", char: "x" });
      session.view();
      expect(baselines.at(-1)).toBe("one\n");
      press(session, "f3");
      session.view();
      // The save leaves the text as it was, and changes only the baseline.
      expect(baselines.at(-1)).toBe("onex\n");
    });

    it("labels the top row of a wrapped line whose start is above the screen", async () => {
      const { root, path } = await repository();
      try {
        await Deno.writeTextFile(
          path,
          `const a = 1;\nconst b = 20; // ${"x".repeat(100)}\nconst c = 3;\n`,
        );
        await git(root, ["commit", "-q", "-am", "long"], {
          GIT_AUTHOR_NAME: "Bob",
          GIT_AUTHOR_EMAIL: "bob@example.com",
          GIT_AUTHOR_DATE: "2026-05-07T10:00:00+00:00",
          GIT_COMMITTER_NAME: "Bob",
          GIT_COMMITTER_EMAIL: "bob@example.com",
        });
        const session = fileSession(path, 60, 4);
        press(session, "\\", "b");
        await loadBlames(session);
        expect(blameColumn(session)).toEqual([
          "2y Alice",
          "167d Bob",
          "",
        ]);
        press(session, "j", "j");
        // The top row continues line 2, whose first row is off the screen.
        expect(blameColumn(session)).toEqual([
          "167d Bob",
          "",
          "2y Alice",
        ]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("draws control characters in an author's name as pictures", async () => {
      const { root, path } = await repository();
      try {
        // Git refuses control characters in a name it is given, so the
        // commit is written as a raw object.
        await Deno.writeTextFile(path, "const e = 1;\n");
        await git(root, ["commit", "-q", "-am", "esc"], {
          GIT_AUTHOR_NAME: "E",
          GIT_AUTHOR_EMAIL: "e@example.com",
          GIT_AUTHOR_DATE: "2026-09-10T10:00:00+00:00",
          GIT_COMMITTER_NAME: "E",
          GIT_COMMITTER_EMAIL: "e@example.com",
        });
        const object = (await git(root, ["cat-file", "commit", "HEAD"]))
          .replace(/^author E </m, "author \x1b[2J <");
        const written = new Deno.Command("git", {
          args: ["hash-object", "-t", "commit", "-w", "--stdin"],
          cwd: root,
          stdin: "piped",
          stdout: "piped",
        }).spawn();
        const writer = written.stdin.getWriter();
        await writer.write(new TextEncoder().encode(object));
        await writer.close();
        const sha = new TextDecoder().decode((await written.output()).stdout)
          .trim();
        await git(root, ["update-ref", "HEAD", sha]);
        const session = fileSession(path);
        press(session, "b");
        await loadBlames(session);
        const view = session.view();
        expect(view.blame?.lines[0]?.author).toBe("\x1b[2J");
        const row = renderFrame(session.displayDoc(), view)[0];
        expect(row).not.toContain("\x1b");
        expect(row).toContain("41d \u241b[2J");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  });

  describe("a diff", () => {
    async function diffSession(
      cwd: string,
      diff: string,
      { width = 100, blame = true }: { width?: number; blame?: boolean } = {},
    ): Promise<Session> {
      const ws = realWorkspace(cwd);
      const model = parseDiff(diff)!;
      const { doc, edit } = buildDiffDocument(diff, model, ws);
      const session = new Session(
        doc,
        { color: false, showLineNumbers: false, now: () => NOW },
        { width, height: 60 },
        undefined,
        diffSource(ws, edit, undefined, realGit(cwd)),
      );
      if (blame) press(session, "b");
      await loadBlames(session);
      return session;
    }

    /** The blame entry on the line of `session`'s document whose text is
     * `text`. */
    function blameOf(session: Session, text: string): string | null {
      const line = session.doc.lines.findIndex((l) => l.text === text);
      expect(line).toBeGreaterThanOrEqual(0);
      const blame = session.view().blame;
      const entry = blame?.lines[line];
      return blame && entry ? blameLabel(entry, blame.now).trim() : null;
    }

    it("blames a commit's lines as of that commit", async () => {
      const { root, path } = await repository();
      try {
        const show = await git(root, ["show", "--format=medium", "HEAD"]);
        // The working tree moves on; the commit's lines still come from it.
        await Deno.writeTextFile(path, "rewritten\n");
        const session = await diffSession(root, show);
        expect(blameOf(session, "+const b = 20;")).toBe("168d Bob");
        expect(blameOf(session, " const a = 1;")).toBe("2y Alice");
        expect(blameOf(session, "-const b = 2;")).toBeNull();
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("attributes each commit's header and message to that commit", async () => {
      const { root } = await repository();
      try {
        const log = await git(root, ["log", "-p", "--format=medium"]);
        const session = await diffSession(root, log);
        const head = (await git(root, ["rev-parse", "HEAD"])).trim();
        const first = (await git(root, ["rev-parse", "HEAD~"])).trim();
        expect(blameOf(session, `commit ${head}`)).toBe("168d Bob");
        expect(blameOf(session, "    by Bob")).toBe("168d Bob");
        expect(blameOf(session, `commit ${first}`)).toBe("2y Alice");
        expect(blameOf(session, "    by Alice")).toBe("2y Alice");
        expect(blameOf(session, "diff --git a/f.ts b/f.ts")).toBeNull();
        // The header's run of lines from one commit is labeled once.
        const column = blameColumn(session);
        expect(column[0]).toBe("168d Bob");
        expect(column.slice(1, 4)).toEqual(["", "", ""]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("attributes a one-line commit header to its commit", async () => {
      const { root } = await repository();
      try {
        const log = await git(root, ["log", "-p", "--oneline", "-1"]);
        const session = await diffSession(root, log);
        const head = (await git(root, ["rev-parse", "--short", "HEAD"]))
          .trim();
        expect(blameOf(session, `${head} by Bob`)).toBe("168d Bob");
        expect(blameOf(session, "diff --git a/f.ts b/f.ts")).toBeNull();
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("blames a file the working tree no longer has as of its commit", async () => {
      const { root } = await repository();
      try {
        await Deno.writeTextFile(join(root, "g.ts"), "const g = 1;\n");
        await git(root, ["add", "g.ts"]);
        await git(root, ["commit", "-q", "-m", "add g"], carol());
        await git(root, ["rm", "-q", "g.ts"]);
        await git(root, ["commit", "-q", "-m", "remove g"], carol());
        const log = await git(root, ["log", "-p", "--format=medium", "-2"]);
        const session = await diffSession(root, log);
        expect(blameOf(session, "+const g = 1;")).toBe("20d Carol");
        expect(blameOf(session, "-const g = 1;")).toBeNull();
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("attributes a patch email's header to its commit", async () => {
      const { root } = await repository();
      try {
        const patch = await git(root, ["format-patch", "-1", "--stdout"]);
        const session = await diffSession(root, patch);
        expect(blameOf(session, "Subject: [PATCH] by Bob")).toBe("168d Bob");
        expect(blameOf(session, "diff --git a/f.ts b/f.ts")).toBeNull();
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("attributes an edited message line to no commit", async () => {
      const { root } = await repository();
      try {
        const show = await git(root, ["show", "--format=medium", "HEAD"]);
        const session = await diffSession(root, show);
        expect(blameOf(session, "    by Bob")).toBe("168d Bob");
        press(session, "e", "down", "down", "down", "down", "end");
        session.handleKey({ name: "x", char: "x" });
        await loadBlames(session);
        expect(session.doc.lines[4].text).toBe("    by Bobx");
        expect(blameOf(session, "    by Bobx")).toBeNull();
        expect(blameOf(session, "Author: Bob <bob@example.com>")).toBe(
          "168d Bob",
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("compares a commit's lines with its saved lines only up to a bound", async () => {
      const { root } = await repository();
      try {
        const show = await git(root, ["show", "--format=medium", "HEAD"]);
        const head = (await git(root, ["rev-parse", "HEAD"])).trim();
        const message = (prefix: string, count: number, shared: number) =>
          Array.from(
            { length: count },
            (_, i) => i === shared ? "    shared" : `    ${prefix}${i}`,
          ).join("\n");
        const targets = (count: number) => {
          const text = show.replace("    by Bob", message("x", count, 7));
          const baseline = show.replace("    by Bob", message("y", count, 7));
          const ws = realWorkspace(root);
          const { edit } = buildDiffDocument(text, parseDiff(text)!, ws);
          const source = diffSource(ws, edit, undefined, realGit(root));
          const lines = text.split("\n");
          const at = (line: string) =>
            source.blameTargets!(text, baseline)[
              lines.indexOf(line)
            ];
          return { at, request: { cwd: root, rev: head } };
        };
        const small = targets(2000);
        expect(small.at(`commit ${head}`)?.request).toEqual(small.request);
        expect(small.at("    shared")?.request).toEqual(small.request);
        expect(small.at("    x8")).toBeNull();
        // Past the bound, only the lines shared at either end are compared.
        const large = targets(2100);
        expect(large.at(`commit ${head}`)?.request).toEqual(large.request);
        expect(large.at("    shared")).toBeNull();
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("attributes a copy of a message line to no commit", async () => {
      const { root } = await repository();
      try {
        const show = await git(root, ["show", "--format=medium", "HEAD"]);
        const session = await diffSession(root, show);
        press(session, "e", "down", "down", "down", "down", "end", "enter");
        for (const char of "by Bob") session.handleKey({ name: char, char });
        await loadBlames(session);
        expect(session.doc.lines[4].text).toBe("    by Bob");
        expect(session.doc.lines[5].text).toBe("    by Bob");
        const blame = session.view().blame;
        expect(blame?.lines[4]?.author).toBe("Bob");
        expect(blame?.lines[5]).toBeNull();
        expect(blame?.lines[6]?.author).toBe("Bob");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("keeps the entry of a message line between two edited ones", async () => {
      const { root, path } = await repository();
      try {
        await Deno.writeTextFile(path, "const a = 2;\n");
        await git(
          root,
          ["commit", "-q", "-am", "subject", "-m", "l1\nl2\nl3"],
          carol(),
        );
        const show = await git(root, ["show", "--format=medium", "HEAD"]);
        const session = await diffSession(root, show);
        expect(session.doc.lines.slice(6, 9).map((l) => l.text)).toEqual([
          "    l1",
          "    l2",
          "    l3",
        ]);
        press(session, "e", ...new Array(6).fill("down"), "end");
        session.handleKey({ name: "x", char: "x" });
        press(session, "down", "down", "end");
        session.handleKey({ name: "x", char: "x" });
        await loadBlames(session);
        expect(blameOf(session, "    l1x")).toBeNull();
        expect(blameOf(session, "    l2")).toBe("20d Carol");
        expect(blameOf(session, "    l3x")).toBeNull();
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("keeps the entries of the message lines around a deleted one", async () => {
      const { root, path } = await repository();
      try {
        await Deno.writeTextFile(path, "const a = 2;\n");
        await git(
          root,
          ["commit", "-q", "-am", "subject", "-m", "l1\nl2\nl3"],
          carol(),
        );
        const show = await git(root, ["show", "--format=medium", "HEAD"]);
        const session = await diffSession(root, show);
        press(session, "e", ...new Array(7).fill("down"));
        press(session, "ctrl-a", "ctrl-k", "backspace");
        await loadBlames(session);
        expect(session.doc.lines.slice(6, 8).map((l) => l.text)).toEqual([
          "    l1",
          "    l3",
        ]);
        expect(blameOf(session, "    l1")).toBe("20d Carol");
        expect(blameOf(session, "    l3")).toBe("20d Carol");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("attributes each copy of a merge's header that git log -m prints", async () => {
      const { root } = await repository();
      try {
        const main = (await git(root, ["branch", "--show-current"])).trim();
        await git(root, ["switch", "-q", "-c", "side", "HEAD~"]);
        await Deno.writeTextFile(join(root, "s.ts"), "const s = 1;\n");
        await git(root, ["add", "s.ts"]);
        await git(root, ["commit", "-q", "-m", "side"], carol());
        await git(root, ["switch", "-q", main]);
        await git(
          root,
          ["merge", "-q", "--no-ff", "-m", "merge", "side"],
          carol(),
        );
        const log = await git(root, ["log", "-p", "-m", "-1"]);
        const session = await diffSession(root, log);
        const headers = session.doc.lines.flatMap((line, index) =>
          line.text.startsWith("commit ") ? [index] : []
        );
        expect(headers.length).toBe(2);
        const blame = session.view().blame;
        for (const line of headers) {
          expect(blame?.lines[line]?.author).toBe("Carol");
        }
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("ends a commit's attribution at a merge's combined diff", async () => {
      const { root, path } = await repository();
      try {
        const main = (await git(root, ["branch", "--show-current"])).trim();
        await git(root, ["switch", "-q", "-c", "side", "HEAD~"]);
        await Deno.writeTextFile(
          path,
          "const a = 1;\nconst b = 99;\nconst c = 3;\n",
        );
        await git(root, ["commit", "-q", "-am", "side"], carol());
        await git(root, ["switch", "-q", main]);
        // The merge keeps neither side's line, so its combined diff shows it.
        await git(
          root,
          ["merge", "-q", "-s", "ours", "--no-commit", "side"],
          carol(),
        );
        await Deno.writeTextFile(
          path,
          "const a = 1;\nconst b = 42;\nconst c = 3;\n",
        );
        await git(root, ["commit", "-q", "-am", "merge"], carol());
        const log = await git(root, ["log", "-p", "--cc", "-2"]);
        const session = await diffSession(root, log);
        const head = (await git(root, ["rev-parse", "HEAD"])).trim();
        expect(blameOf(session, `commit ${head}`)).toBe("20d Carol");
        expect(blameOf(session, "    merge")).toBe("20d Carol");
        expect(blameOf(session, "diff --cc f.ts")).toBeNull();
        expect(blameOf(session, "++const b = 42;")).toBeNull();
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("blames a file named undefined apart from its commit", async () => {
      const { root } = await repository();
      try {
        await Deno.writeTextFile(join(root, "undefined"), "content\n");
        await git(root, ["add", "undefined"]);
        await git(root, ["commit", "-q", "-m", "u"], carol());
        const show = await git(root, ["show", "--format=medium", "HEAD"]);
        const session = await diffSession(root, show);
        expect(blameOf(session, "+content")).toBe("20d Carol");
        expect(blameOf(session, "    u")).toBe("20d Carol");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("attributes nothing to a commit viewed outside a repository", async () => {
      const { root } = await repository();
      const elsewhere = await Deno.makeTempDir();
      try {
        const show = await git(root, ["show", "--format=medium", "HEAD"]);
        const ws = realWorkspace(elsewhere);
        const { doc, edit } = buildDiffDocument(show, parseDiff(show)!, ws);
        const session = new Session(
          doc,
          { color: false, showLineNumbers: false, now: () => NOW },
          { width: 100, height: 20 },
          undefined,
          diffSource(ws, edit, undefined, realGit(elsewhere)),
        );
        press(session, "b");
        expect(session.view().message).toBe("No line here can be blamed");
        expect(session.view().blame).toBeNull();
      } finally {
        await Deno.remove(root, { recursive: true });
        await Deno.remove(elsewhere, { recursive: true });
      }
    });

    it("says so when it turns on with no line in view to blame", async () => {
      const { root, path } = await repository();
      try {
        // A removed file sorts first, so the screen holds only its removed
        // lines, which have nothing to blame; the edited file below does.
        const removed = join(root, "a.ts");
        await Deno.writeTextFile(removed, "removed\n".repeat(20));
        await git(root, ["add", "a.ts"]);
        await git(root, ["commit", "-q", "-m", "a"], carol());
        await Deno.remove(removed);
        await Deno.writeTextFile(path, "const a = 1;\nconst b = 21;\n");
        const diff = await git(root, ["diff"]);
        const ws = realWorkspace(root);
        const { doc, edit } = buildDiffDocument(diff, parseDiff(diff)!, ws);
        const session = new Session(
          doc,
          { color: false, showLineNumbers: false, now: () => NOW },
          { width: 100, height: 10 },
          undefined,
          diffSource(ws, edit, undefined, realGit(root)),
        );
        press(session, "b");
        expect(session.view().message).toBe(
          "Blame on; no line in view can be blamed",
        );
        expect(session.view().blame).not.toBeNull();
        press(session, "G", "b", "b");
        expect(session.view().message).toBe("Blame on");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("draws the diff's end mark beside the blame column", async () => {
      const { root, path } = await repository();
      try {
        await Deno.writeTextFile(
          path,
          "const a = 1;\nconst b = 20;\nconst c = 30;\n",
        );
        const diff = await git(root, ["diff"]);
        const frame = (session: Session) =>
          renderFrame(session.displayDoc(), session.view());
        const blamed = frame(await diffSession(root, diff));
        const narrower = frame(
          await diffSession(root, diff, {
            width: 100 - BLAME_WIDTH,
            blame: false,
          }),
        );
        const ends = blamed.flatMap((row, index) =>
          row.includes("❦") ? [index] : []
        );
        expect(ends.length).toBeGreaterThan(0);
        for (const index of ends) {
          expect(blamed[index]).toBe(
            narrower[index] + " ".repeat(BLAME_WIDTH),
          );
        }
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("blames a working-tree diff as the working tree", async () => {
      const { root, path } = await repository();
      try {
        await Deno.writeTextFile(
          path,
          "const a = 1;\nconst b = 20;\nconst c = 30;\n",
        );
        const diff = await git(root, ["diff"]);
        const session = await diffSession(root, diff);
        expect(blameOf(session, "+const c = 30;")).toBe("uncommitted");
        expect(blameOf(session, " const b = 20;")).toBe("168d Bob");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("blames only the files in view", async () => {
      const { root, path } = await repository();
      try {
        await Deno.writeTextFile(join(root, "g.ts"), "const g = 1;\n");
        await git(root, ["add", "g.ts"]);
        await git(root, ["commit", "-q", "-m", "g"], {
          GIT_AUTHOR_NAME: "Gus",
          GIT_AUTHOR_EMAIL: "gus@example.com",
          GIT_COMMITTER_NAME: "Gus",
          GIT_COMMITTER_EMAIL: "gus@example.com",
        });
        await Deno.writeTextFile(path, "const a = 10;\nconst b = 20;\n");
        await Deno.writeTextFile(join(root, "g.ts"), "const g = 2;\n");
        const diff = await git(root, ["diff", "-U0"]);
        const ws = realWorkspace(root);
        const { doc, edit } = buildDiffDocument(diff, parseDiff(diff)!, ws);
        const session = new Session(
          doc,
          { color: false, showLineNumbers: false, now: () => NOW },
          { width: 100, height: 9 },
          undefined,
          diffSource(ws, edit, undefined, realGit(root)),
        );
        press(session, "b");
        session.view();
        expect(session.displayDoc().lines.slice(0, 8).map((l) => l.text))
          .not.toContain("+++ b/g.ts");
        expect(session.takeBlameLoads().map((load) => load.request.path))
          .toEqual(["f.ts"]);
        press(session, "G");
        session.view();
        expect(session.takeBlameLoads().map((load) => load.request.path))
          .toEqual(["g.ts"]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("blames only working-tree hunks their file still holds", async () => {
      const { root } = await repository();
      try {
        // The working tree's second line is `const b = 20;`, so the first
        // hunk no longer matches it; the second hunk does.
        const diff = [
          "diff --git a/f.ts b/f.ts",
          "--- a/f.ts",
          "+++ b/f.ts",
          "@@ -1,2 +1,2 @@",
          " const a = 1;",
          "-const b = 0;",
          "+const b = 99;",
          "@@ -3 +3 @@",
          "-const c = 0;",
          "+const c = 3;",
          "",
        ].join("\n");
        const session = await diffSession(root, diff);
        expect(blameOf(session, " const a = 1;")).toBeNull();
        expect(blameOf(session, "+const b = 99;")).toBeNull();
        expect(blameOf(session, "+const c = 3;")).toBe("2y Alice");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("blames each commit's hunks as of that commit", async () => {
      const { root } = await repository();
      try {
        const log = await git(root, ["log", "-p", "--format=medium"]);
        const session = await diffSession(root, log);
        expect(blameOf(session, "+const b = 20;")).toBe("168d Bob");
        expect(blameOf(session, "+const b = 2;")).toBe("2y Alice");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("blames paths relative to the directory the viewer runs in", async () => {
      const { root } = await repository();
      try {
        const sub = join(root, "sub");
        await Deno.mkdir(sub);
        await Deno.writeTextFile(join(sub, "g.ts"), "const s = 1;\n");
        await git(root, ["add", "sub/g.ts"]);
        await git(root, ["commit", "-q", "-m", "sub"], {
          GIT_AUTHOR_NAME: "Sue",
          GIT_AUTHOR_EMAIL: "sue@example.com",
          GIT_AUTHOR_DATE: "2026-06-07T10:00:00+00:00",
          GIT_COMMITTER_NAME: "Sue",
          GIT_COMMITTER_EMAIL: "sue@example.com",
        });
        await Deno.writeTextFile(join(sub, "g.ts"), "const s = 1;\nconst t;\n");
        const diff = await git(sub, ["diff", "--relative"]);
        expect(diff).toContain("+++ b/g.ts");
        const session = await diffSession(sub, diff);
        expect(blameOf(session, " const s = 1;")).toBe("136d Sue");
        expect(blameOf(session, "+const t;")).toBe("uncommitted");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("reports that a diff outside any repository cannot be blamed", async () => {
      const dir = await Deno.makeTempDir();
      try {
        await Deno.writeTextFile(join(dir, "f.ts"), "const a = 1;\n");
        const diff = [
          "--- a/f.ts",
          "+++ b/f.ts",
          "@@ -1 +1 @@",
          "-const a = 0;",
          "+const a = 1;",
          "",
        ].join("\n");
        const session = await diffSession(dir, diff);
        expect(session.view().message).toContain(
          "Blame: fatal: not a git repository",
        );
        expect(blameOf(session, "+const a = 1;")).toBeNull();
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });
});
