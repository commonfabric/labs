import { join } from "@std/path";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { EditableSource } from "../lib/view/editsource.ts";
import { type PagerDeps, runPager } from "../lib/view/pager.ts";
import {
  offeredPullRequestUrl,
  pushBranch,
  type PushIo,
  realPushIo,
} from "../lib/view/push.ts";
import { dialogBox } from "../lib/view/render.ts";
import { Session } from "../lib/view/session.ts";
import {
  cellOf,
  drawnRows,
  frameRows,
  mouseKey,
  parseDocument,
} from "./view-helpers.ts";

/** Query answers for a checkout of `feature` whose `origin` has `main` as its
 * default branch. */
const FEATURE_CHECKOUT: Readonly<Record<string, string | null>> = {
  "rev-parse --absolute-git-dir": "/work/.git\n",
  "symbolic-ref --quiet HEAD": "refs/heads/feature\n",
  "symbolic-ref --quiet refs/remotes/origin/HEAD": "refs/remotes/origin/main\n",
};

const PUSH_FEATURE = "push --force-with-lease --force-if-includes --progress " +
  "origin HEAD:refs/heads/feature";

const GITHUB_OFFER = [
  "Enumerating objects: 5, done.",
  "remote: ",
  "remote: Create a pull request for 'feature' on GitHub by visiting:",
  "remote:      https://github.com/fork/repo/pull/new/feature",
  "remote: ",
  "To github.com:fork/repo.git",
  " * [new branch]      HEAD -> feature",
].join("\n");

interface FakeIoOptions {
  /** Query answers that replace those of {@link FEATURE_CHECKOUT}. */
  readonly answers?: Readonly<Record<string, string | null>>;

  readonly pushSucceeds?: boolean;
  readonly pushOutput?: string;
  readonly pagedGitDir?: string;
  readonly opens?: boolean;
}

/** A push's operations against a scripted repository, and what it did. */
function fakeIo(options: FakeIoOptions = {}) {
  const answers = { ...FEATURE_CHECKOUT, ...options.answers };
  const ran: string[] = [];
  const opened: string[] = [];
  const io: PushIo = {
    query: (args) => answers[args.join(" ")] ?? null,
    run: (args) => {
      ran.push(args.join(" "));
      return Promise.resolve({
        success: options.pushSucceeds ?? true,
        output: options.pushOutput ?? "",
      });
    },
    pagedGitDir: () => options.pagedGitDir ?? null,
    open: (url) => {
      opened.push(url);
      return options.opens ?? true;
    },
  };
  return { io, ran, opened };
}

const decoder = new TextDecoder();

/** Runs git in `cwd` with exactly `env`, returning its standard output. */
function git(cwd: string, env: Record<string, string>, ...args: string[]) {
  const result = new Deno.Command("git", {
    args,
    cwd,
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  if (!result.success) {
    throw new Error(`git ${args.join(" ")}: ${decoder.decode(result.stderr)}`);
  }
  return decoder.decode(result.stdout).trim();
}

/**
 * Real repositories: `origin.git`, whose post-receive hook offers a pull
 * request page as a hosting service does, a `work` clone of it on a `feature`
 * branch, and a `seed` clone that can push to it as someone else would.
 */
function repositories() {
  const root = Deno.realPathSync(Deno.makeTempDirSync());
  const env = {
    PATH: Deno.env.get("PATH") ?? "",
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_AUTHOR_NAME: "Author",
    GIT_AUTHOR_EMAIL: "author@example.test",
    GIT_COMMITTER_NAME: "Author",
    GIT_COMMITTER_EMAIL: "author@example.test",
  };
  Deno.writeTextFileSync(env.GIT_CONFIG_GLOBAL, "");
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const work = join(root, "work");
  const commit = (cwd: string, file: string) => {
    Deno.writeTextFileSync(join(cwd, file), `${file}\n`);
    git(cwd, env, "add", file);
    git(cwd, env, "commit", "--quiet", "-m", file);
  };
  git(root, env, "init", "--quiet", "--bare", "-b", "main", origin);
  const hook = join(origin, "hooks", "post-receive");
  Deno.writeTextFileSync(
    hook,
    "#!/bin/sh\n" +
      "echo \"Create a pull request for 'feature' by visiting:\"\n" +
      "echo '     https://example.test/pull/new/feature'\n",
  );
  Deno.chmodSync(hook, 0o755);
  git(root, env, "init", "--quiet", "-b", "main", seed);
  commit(seed, "first.txt");
  git(seed, env, "push", "--quiet", origin, "main");
  git(root, env, "clone", "--quiet", origin, work);
  git(work, env, "switch", "--quiet", "-c", "feature");
  commit(work, "feature.txt");
  return { root, env, origin, seed, work };
}

const PATH_ONLY = { PATH: Deno.env.get("PATH") ?? "" };

/** A session over an editable file, ready for keys. */
function editableSession(): Session {
  const source: EditableSource = {
    label: "main.ts",
    editable: true,
    path: "/work/main.ts",
    parse: (text) => parseDocument(text, "/work/main.ts"),
    save: () => "saved",
  };
  return new Session(
    parseDocument("const a = 1;\n", "/work/main.ts"),
    { color: false, showLineNumbers: false },
    { width: 80, height: 12 },
    undefined,
    source,
  );
}

/**
 * Returns the cell a running push dialog's Abort label starts at, on the 80 by
 * 12 screen that {@link editableSession} and the pager harness share.
 */
function abortCell(): { x: number; y: number } {
  const session = editableSession();
  session.beginBranchPush(() => {});
  return cellOf(drawnRows(session), "Abort");
}

/**
 * Returns the SGR mouse report of the primary button going down or coming up
 * at a zero-based cell.
 */
function mouseReport(down: boolean, at: { x: number; y: number }): string {
  return `\x1b[<0;${at.x + 1};${at.y + 1}${down ? "M" : "m"}`;
}

/** A promise and the function that resolves it. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => resolve = done);
  return { promise, resolve };
}

/**
 * Drives {@link runPager} with a push whose operations `pushIo` returns, and
 * whose git prints two progress reports, the second over the first, before it
 * runs. `run(steps)` reads each string step as a keystroke and awaits each
 * function step before the next read. `frame(test)` resolves at the first
 * write that passes `test`, which is how a step waits for the push to show
 * something. `handlers` holds the process signal handlers the pager adds, and
 * `exits` the codes it exits with.
 */
function pagerHarness(pushIo: (signal: AbortSignal) => PushIo) {
  const writes: string[] = [];
  const watchers: Array<{ test: (text: string) => boolean; done: () => void }> =
    [];
  const signals: AbortSignal[] = [];
  const handlers = new Map<Deno.Signal, () => void>();
  const exits: number[] = [];
  const frame = (test: (text: string) => boolean) => {
    const { promise, resolve } = deferred();
    watchers.push({ test, done: resolve });
    return promise;
  };
  const run = async (
    steps: ReadonlyArray<string | (() => Promise<unknown>)>,
  ) => {
    const pending = [...steps];
    const deps: PagerDeps = {
      openTty: () => ({
        read: async (buffer) => {
          for (;;) {
            const step = pending.shift();
            if (step === undefined) return null;
            if (typeof step === "function") {
              await step();
              continue;
            }
            buffer.set(new TextEncoder().encode(step));
            return step.length;
          }
        },
        setRaw: () => {},
        close: () => {},
      }),
      write: (text) => {
        writes.push(text);
        for (const watcher of watchers.splice(0)) {
          if (watcher.test(text)) watcher.done();
          else watchers.push(watcher);
        }
      },
      consoleSize: () => ({ columns: 80, rows: 12 }),
      env: () => undefined,
      addSignalListener: (signal, handler) => handlers.set(signal, handler),
      removeSignalListener: () => {},
      exit: (code) => {
        exits.push(code);
        throw new Error(`exit ${code}`);
      },
      setTimer: (handler) => {
        let live = true;
        queueMicrotask(() => {
          if (live) handler();
        });
        return () => live = false;
      },
      delay: () => Promise.resolve(),
      onGrammarLoad: () => () => {},
      pushIo: (write, signal) => {
        signals.push(signal);
        const io = pushIo(signal);
        return {
          ...io,
          run: (args) => {
            write("Writing objects:  50% (1/2)\r");
            write("Writing objects: 100% (2/2), done.\nTo origin\n");
            return io.run(args);
          },
        };
      },
      blame: () => Promise.reject(new Error("these tests blame nothing")),
    };
    await runPager(
      parseDocument("const a = 1;\n"),
      { color: false, showLineNumbers: false },
      undefined,
      undefined,
      deps,
    );
  };
  return { run, frame, writes, signals, handlers, exits };
}

describe("view-push", () => {
  describe("pushBranch()", () => {
    it("force-pushes the checked-out branch to origin as it stands", async () => {
      const { io, ran, opened } = fakeIo();

      expect(await pushBranch(io)).toBe("Pushed feature to origin.");
      expect(ran).toEqual([PUSH_FEATURE]);
      expect(opened).toEqual([]);
    });

    it("opens the pull request page the server offers", async () => {
      const { io, opened } = fakeIo({ pushOutput: GITHUB_OFFER });

      expect(await pushBranch(io)).toBe(
        "Pushed feature to origin and opened " +
          "https://github.com/fork/repo/pull/new/feature",
      );
      expect(opened).toEqual(["https://github.com/fork/repo/pull/new/feature"]);
    });

    it("returns the offered page's address when the browser cannot open", async () => {
      const { io } = fakeIo({ pushOutput: GITHUB_OFFER, opens: false });

      expect(await pushBranch(io)).toBe(
        "Pushed feature to origin. Create a pull request at " +
          "https://github.com/fork/repo/pull/new/feature",
      );
    });

    it("says the push was aborted when it failed after its signal aborted", async () => {
      const { io } = fakeIo({ pushSucceeds: false });

      expect(await pushBranch(io, AbortSignal.abort())).toBe("Push aborted.");
    });

    it("says the branch was pushed when the push succeeded although its signal aborted", async () => {
      const { io } = fakeIo();

      expect(await pushBranch(io, AbortSignal.abort())).toBe(
        "Pushed feature to origin.",
      );
    });

    it("reports a failed push and opens nothing", async () => {
      const { io, opened } = fakeIo({
        pushSucceeds: false,
        pushOutput: GITHUB_OFFER,
      });

      expect(await pushBranch(io)).toBe("Pushing feature to origin failed.");
      expect(opened).toEqual([]);
    });

    it("runs nothing outside a git repository", async () => {
      const { io, ran } = fakeIo({
        answers: { "rev-parse --absolute-git-dir": null },
      });

      expect(await pushBranch(io)).toBe("This is not a git repository.");
      expect(ran).toEqual([]);
    });

    it("runs nothing when git is paging output for another repository", async () => {
      const { io, ran } = fakeIo({ pagedGitDir: "/elsewhere/.git" });

      expect(await pushBranch(io)).toBe(
        "Not pushing: git is paging output for /elsewhere/.git, but the " +
          "viewer is running in /work/.git.",
      );
      expect(ran).toEqual([]);
    });

    it("pushes when git is paging output for the same repository", async () => {
      const { io } = fakeIo({ pagedGitDir: "/work/.git" });

      expect(await pushBranch(io)).toBe("Pushed feature to origin.");
    });

    it("runs nothing on a detached checkout", async () => {
      const { io, ran } = fakeIo({
        answers: { "symbolic-ref --quiet HEAD": null },
      });

      expect(await pushBranch(io)).toBe(
        "This checkout is not on a branch. Check out or create a branch first.",
      );
      expect(ran).toEqual([]);
    });

    it("runs nothing on the branch origin names as its default", async () => {
      const { io, ran } = fakeIo({
        answers: {
          "symbolic-ref --quiet HEAD": "refs/heads/trunk\n",
          "symbolic-ref --quiet refs/remotes/origin/HEAD":
            "refs/remotes/origin/trunk\n",
        },
      });

      expect(await pushBranch(io)).toBe(
        "Rename the branch first. You were about to push your trunk branch.",
      );
      expect(ran).toEqual([]);
    });

    it("runs nothing when origin names no default branch", async () => {
      const { io, ran } = fakeIo({
        answers: { "symbolic-ref --quiet refs/remotes/origin/HEAD": null },
      });

      expect(await pushBranch(io)).toBe(
        "Not pushing: origin's default branch is unknown. " +
          "`git remote set-head origin --auto` finds it.",
      );
      expect(ran).toEqual([]);
    });
  });

  describe("offeredPullRequestUrl()", () => {
    it("returns the address on the line after GitHub's offer", () => {
      expect(offeredPullRequestUrl(GITHUB_OFFER)).toBe(
        "https://github.com/fork/repo/pull/new/feature",
      );
    });

    it("returns the address on the line of GitLab's merge request offer", () => {
      expect(
        offeredPullRequestUrl(
          "remote: To create a merge request for feature, visit: " +
            "https://gitlab.example.test/repo/-/merge_requests/new\r\n",
        ),
      ).toBe("https://gitlab.example.test/repo/-/merge_requests/new");
    });

    it("finds the offer among progress lines ended by carriage returns", () => {
      expect(
        offeredPullRequestUrl(
          "Writing objects:  50% (1/2)\rWriting objects: 100% (2/2), done.\r" +
            "remote: Create a pull request for 'b' on GitHub by visiting:\r" +
            "remote:   https://github.com/fork/repo/pull/new/b\r",
        ),
      ).toBe("https://github.com/fork/repo/pull/new/b");
    });

    it("returns null for an address the server sent before any offer", () => {
      expect(
        offeredPullRequestUrl(
          "remote: See https://example.test/docs\n" +
            "remote: Create a pull request by visiting:\n",
        ),
      ).toBeNull();
    });

    it("returns null for an address the server sent after the line following its offer", () => {
      expect(
        offeredPullRequestUrl(
          "remote: Create a pull request by visiting:\n" +
            "remote:\n" +
            "remote: See https://example.test/docs\n",
        ),
      ).toBeNull();
    });

    it("returns null for an offer that is not from the server", () => {
      expect(
        offeredPullRequestUrl(
          "Create a pull request by visiting:\n" +
            "  https://example.test/pull/new/b\n",
        ),
      ).toBeNull();
    });
  });

  describe("realPushIo()", () => {
    it("pushes the branch to origin and opens the offered page", async () => {
      const { root, env, origin, work } = repositories();
      try {
        // The opener runs on its own, and says what it opened through a pipe.
        const opened = join(root, "opened");
        new Deno.Command("mkfifo", { args: [opened] }).outputSync();
        const opener = join(root, "opener");
        Deno.writeTextFileSync(
          opener,
          `#!/bin/sh\nprintf '%s' "$1" > '${opened}'\n`,
        );
        Deno.chmodSync(opener, 0o755);
        // A tag sharing the branch's name qualifies its short name.
        git(work, env, "tag", "feature");
        const written: string[] = [];

        const summary = await pushBranch(
          realPushIo({
            cwd: work,
            env,
            opener,
            write: (text) => written.push(text),
          }),
        );

        expect(summary).toBe(
          "Pushed feature to origin and opened " +
            "https://example.test/pull/new/feature",
        );
        expect(await Deno.readTextFile(opened)).toBe(
          "https://example.test/pull/new/feature",
        );
        expect(git(origin, env, "rev-parse", "refs/heads/feature")).toBe(
          git(work, env, "rev-parse", "HEAD"),
        );
        expect(git(origin, env, "for-each-ref", "--format=%(refname)")).toBe(
          "refs/heads/feature\nrefs/heads/main",
        );
        expect(written.join("")).toContain(
          "remote: Create a pull request for 'feature' by visiting:",
        );
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("does not overwrite commits on origin that the repository has not fetched", async () => {
      const { root, env, origin, seed, work } = repositories();
      try {
        const io = realPushIo({ cwd: work, env, opener: "true", write() {} });
        await pushBranch(io);
        git(
          seed,
          env,
          "push",
          "--quiet",
          "--force",
          origin,
          "main:refs/heads/feature",
        );
        const theirs = git(origin, env, "rev-parse", "feature");
        Deno.writeTextFileSync(join(work, "more.txt"), "more\n");
        git(work, env, "add", "more.txt");
        git(work, env, "commit", "--quiet", "-m", "more");

        expect(await pushBranch(io)).toBe("Pushing feature to origin failed.");
        expect(git(origin, env, "rev-parse", "feature")).toBe(theirs);
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("does not overwrite commits on origin that the branch never included, even once fetched", async () => {
      const { root, env, origin, work } = repositories();
      try {
        const io = realPushIo({ cwd: work, env, opener: "true", write() {} });
        await pushBranch(io);
        const other = join(root, "other");
        git(root, env, "clone", "--quiet", "-b", "feature", origin, other);
        Deno.writeTextFileSync(join(other, "theirs.txt"), "theirs\n");
        git(other, env, "add", "theirs.txt");
        git(other, env, "commit", "--quiet", "-m", "theirs");
        git(other, env, "push", "--quiet", "origin", "feature");
        const theirs = git(origin, env, "rev-parse", "feature");
        git(work, env, "fetch", "--quiet", "origin");
        Deno.writeTextFileSync(join(work, "more.txt"), "more\n");
        git(work, env, "add", "more.txt");
        git(work, env, "commit", "--quiet", "-m", "more");

        expect(await pushBranch(io)).toBe("Pushing feature to origin failed.");
        expect(git(origin, env, "rev-parse", "feature")).toBe(theirs);
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("works on the repository at its directory when git exports another", async () => {
      const { root, env, origin, seed, work } = repositories();
      try {
        const io = realPushIo({
          cwd: work,
          env: { ...env, GIT_DIR: join(seed, ".git") },
          opener: "true",
          write: () => {},
        });

        expect(io.query(["rev-parse", "--absolute-git-dir"])?.trim()).toBe(
          join(work, ".git"),
        );
        expect(io.pagedGitDir()).toBe(join(seed, ".git"));
        expect(await pushBranch(io)).toBe(
          `Not pushing: git is paging output for ${join(seed, ".git")}, ` +
            `but the viewer is running in ${join(work, ".git")}.`,
        );
        expect(git(origin, env, "branch", "--list", "feature")).toBe("");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("runs git with no terminal prompts, keeping the user's askpass program", () => {
      const printPromptEnv = [
        "-c",
        "alias.prompts=!printf '%s,' " +
        '"$GIT_TERMINAL_PROMPT" "$SSH_ASKPASS" "$SSH_ASKPASS_REQUIRE"',
        "prompts",
      ];

      expect(
        realPushIo({ env: PATH_ONLY, write() {} }).query(printPromptEnv),
      ).toBe("0,false,force,");
      expect(
        realPushIo({
          env: { ...PATH_ONLY, SSH_ASKPASS: "my-askpass" },
          write() {},
        }).query(printPromptEnv),
      ).toBe("0,my-askpass,force,");
    });

    it("stops a running git when its signal aborts", async () => {
      const controller = new AbortController();
      const io = realPushIo({
        env: PATH_ONLY,
        signal: controller.signal,
        write: (text) => {
          if (text.includes("started")) controller.abort();
        },
      });

      const result = await io.run([
        "-c",
        "alias.hang=!echo started; exec tail -f /dev/null",
        "hang",
      ]);

      expect(result.success).toBe(false);
      expect(result.output).toContain("started");
    });

    it("returns no paged repository when git did not start the viewer", () => {
      expect(realPushIo({ env: PATH_ONLY, write() {} }).pagedGitDir())
        .toBeNull();
    });

    it("returns an exported git directory that git cannot resolve as it is", () => {
      const io = realPushIo({
        env: { ...PATH_ONLY, GIT_DIR: "/cf-view-no-such-git-dir" },
        write() {},
      });

      expect(io.pagedGitDir()).toBe("/cf-view-no-such-git-dir");
    });

    it("returns false from `open()` when there is no program to open with", () => {
      const io = realPushIo({ opener: "cf-view-no-such-opener", write() {} });

      expect(io.open("https://example.test/")).toBe(false);
    });

    it("runs git from the process's own directory and environment by default", async () => {
      const written: string[] = [];
      const io = realPushIo({ write: (text) => written.push(text) });

      expect(io.query(["--version"])).toMatch(/^git version /);
      const result = await io.run(["--version"]);
      expect(result.success).toBe(true);
      expect(result.output).toMatch(/^git version /);
      expect(written.join("")).toBe(result.output);
    });
  });

  describe("Session", () => {
    it("requests a push when `P` is pressed", () => {
      const session = editableSession();

      session.handleKey({ name: "P", char: "P" });

      expect(session.branchPushRequested).toBe(true);
    });

    it("shows the output in a dialog shrunk to fit the screen, a carriage return starting a line over", () => {
      const session = editableSession();
      session.beginBranchPush(() => {});

      session.appendPushOutput("Writing  50%\r");
      session.appendPushOutput("Writing 100%\nTo origin\r");
      session.appendPushOutput("\n * [new branch] feature\n");

      const dialog = session.view().dialog!;
      expect(dialog.title).toBe("Push");
      expect(dialog.output).toBe(true);
      expect(dialog.body.map((line) => line.trimEnd())).toEqual([
        "Writing 100%",
        "To origin",
        " * [new branch] feature",
        "",
        "",
      ]);
    });

    it("sizes the dialog to a typical push on a screen larger than that", () => {
      const session = editableSession();
      session.resize(200, 60);
      session.beginBranchPush(() => {});

      session.appendPushOutput("To origin\n * [new branch] feature\n");

      const view = session.view();
      const dialog = view.dialog!;
      expect(dialog.body.length).toBe(16);
      expect(dialog.body.slice(0, 3)).toEqual([
        "To origin",
        " * [new branch] feature",
        "",
      ]);
      const box = dialogBox(view, dialog);
      expect([box.boxW, box.boxH]).toEqual([86, 22]);
      expect([box.x, box.y]).toEqual([57, 19]);
    });

    it("breaks an indented word wider than the dialog without leaving an empty row", () => {
      const session = editableSession();
      session.beginBranchPush(() => {});
      const word = "x".repeat(80);

      session.appendPushOutput(`  ${word}\n`);

      expect(session.view().dialog!.body.slice(0, 3)).toEqual([
        `  ${word.slice(0, 70)}`,
        word.slice(70),
        "",
      ]);
    });

    it("keeps an address no wider than the dialog on one row", () => {
      const session = editableSession();
      session.resize(200, 60);
      session.beginBranchPush(() => {});
      const url = "https://github.com/commonfabric/labs/pull/new/feature";

      session.appendPushOutput(`remote:      ${url}\n`);
      session.finishBranchPush(`Pushed feature to origin and opened ${url}`);

      expect(session.view().dialog!.body.slice(0, 5)).toEqual([
        `remote:      ${url}`,
        "",
        "Pushed feature to origin and opened",
        url,
        "",
      ]);
    });

    it("drops the spaces git pads a server's lines with, which would wrap onto a row of their own", () => {
      const session = editableSession();
      session.beginBranchPush(() => {});
      const offer =
        "remote:      https://github.com/commonfabric/labs/pull/new/" +
        "a-branch-name";
      expect(offer.length).toBe(72);

      session.appendPushOutput(`${offer}        \nTo origin\n`);

      expect(session.view().dialog!.body.slice(0, 3)).toEqual([
        offer,
        "To origin",
        "",
      ]);
    });

    it("shows the end of output longer than the dialog", () => {
      const session = editableSession();
      session.beginBranchPush(() => {});

      session.appendPushOutput(
        Array.from({ length: 9 }, (_, i) => `line ${i}\n`).join(""),
      );

      expect(
        session.view().dialog!.body.map((line) => line.trimEnd()),
      ).toEqual(["line 4", "line 5", "line 6", "line 7", "line 8"]);
    });

    it("wraps a line wider than the dialog after its last space that fits, breaking a word wider than the dialog", () => {
      const session = editableSession();
      session.beginBranchPush(() => {});
      const url = "https://github.com/commonfabric/labs/pull/new/" +
        "a-branch-whose-name-runs-on-and-on";

      session.finishBranchPush(`Pushed feature to origin and opened ${url}`);

      expect(session.view().dialog!.body.slice(0, 4)).toEqual([
        "",
        "Pushed feature to origin and opened",
        url.slice(0, 72),
        url.slice(72),
      ]);
    });

    it("aborts a running push on an interrupt, keeping the dialog up", () => {
      const session = editableSession();
      let aborted = 0;
      session.beginBranchPush(() => aborted++);

      expect(session.requestQuitFromSignal()).toBe(true);

      expect(aborted).toBe(1);
      expect(session.view().dialog?.title).toBe("Push");
      expect(session.quit).toBe(false);
    });

    it("offers Abort, which stops the push and leaves the dialog up", () => {
      const session = editableSession();
      let aborted = 0;
      session.beginBranchPush(() => aborted++);

      expect(session.view().dialog!.buttons.map((b) => b.label)).toEqual([
        "Abort",
      ]);
      session.handleKey({ name: "enter" });
      expect(aborted).toBe(0);
      session.handleKey({ name: "escape" });
      session.handleKey({ name: "a", char: "a" });

      expect(aborted).toBe(2);
      expect(session.view().dialog?.title).toBe("Push");
    });

    it("offers Close once the push ends, which leaves the summary in the status line", () => {
      const session = editableSession();
      let aborted = 0;
      session.beginBranchPush(() => aborted++);
      session.appendPushOutput("To origin\n");

      session.finishBranchPush("Pushed feature to origin.");

      const dialog = session.view().dialog!;
      expect(dialog.buttons.map((b) => b.label)).toEqual(["Close", "Quit"]);
      expect(dialog.body.slice(0, 3).map((line) => line.trimEnd())).toEqual([
        "To origin",
        "",
        "Pushed feature to origin.",
      ]);
      session.handleKey({ name: "enter" });
      expect(session.view().dialog).toBeNull();
      expect(session.view().message).toBe("Pushed feature to origin.");
      expect(session.quit).toBe(false);
      expect(aborted).toBe(0);
    });

    it("quits on `Q` once the push ends, and not on `q` or while it runs", () => {
      const session = editableSession();
      session.beginBranchPush(() => {});

      session.handleKey({ name: "Q", char: "Q" });
      expect(session.quit).toBe(false);
      expect(session.view().dialog?.title).toBe("Push");

      session.finishBranchPush("Pushed feature to origin.");
      session.handleKey({ name: "q", char: "q" });
      expect(session.quit).toBe(false);
      expect(session.view().dialog?.title).toBe("Push");
      session.handleKey({ name: "Q", char: "Q" });

      expect(session.quit).toBe(true);
    });

    it("lets go of a held Abort when the push ends, so a release on Close closes nothing", () => {
      const session = editableSession();
      session.beginBranchPush(() => {});

      session.handleKey(mouseKey(true, abortCell()));
      expect(session.view().dialog!.pushed).toBe(0);
      session.finishBranchPush("Pushed feature to origin.");
      expect(session.view().dialog!.pushed).toBe(-1);
      session.handleKey(mouseKey(false, cellOf(drawnRows(session), "Close")));

      expect(session.view().dialog?.title).toBe("Push");
    });

    it("lets go of a held Close when an interrupt opens the save prompt, so a release on its Cancel cancels nothing", () => {
      const session = editableSession();
      session.handleKey({ name: "e", char: "e" });
      session.handleKey({ name: "X", char: "X" });
      session.handleKey({ name: "escape" });
      session.beginBranchPush(() => {});
      session.finishBranchPush("Pushed feature to origin.");

      session.handleKey(mouseKey(true, cellOf(drawnRows(session), "Close")));
      session.requestQuitFromSignal();
      expect(session.view().dialog?.title).toBe("Save Changes");
      expect(session.view().dialog!.pushed).toBe(-1);
      session.handleKey(mouseKey(false, cellOf(drawnRows(session), "Cancel")));

      expect(session.view().dialog?.title).toBe("Save Changes");
    });

    it("closes on a click on Close once the push ends, and quits on a click on Quit", () => {
      const session = editableSession();
      session.beginBranchPush(() => {});
      session.finishBranchPush("Pushed feature to origin.");
      const close = cellOf(drawnRows(session), "Close");
      const quit = cellOf(drawnRows(session), "Quit");

      session.handleKey(mouseKey(true, close));
      session.handleKey(mouseKey(false, close));
      expect(session.view().dialog).toBeNull();
      expect(session.view().message).toBe("Pushed feature to origin.");
      expect(session.quit).toBe(false);

      session.beginBranchPush(() => {});
      session.finishBranchPush("Pushed feature to origin.");
      session.handleKey(mouseKey(true, quit));
      session.handleKey(mouseKey(false, quit));
      expect(session.quit).toBe(true);
    });

    it("asks to save unsaved edits before Quit quits", () => {
      const session = editableSession();
      session.handleKey({ name: "e", char: "e" });
      session.handleKey({ name: "X", char: "X" });
      session.handleKey({ name: "escape" });
      session.beginBranchPush(() => {});
      session.finishBranchPush("Pushed feature to origin.");

      session.handleKey({ name: "Q", char: "Q" });

      expect(session.quit).toBe(false);
      expect(session.view().dialog?.title).toBe("Save Changes");
      session.handleKey({ name: "d", char: "d" });
      expect(session.quit).toBe(true);
    });
  });

  describe("runPager()", () => {
    it("shows git's output in the dialog as it arrives, then Close on a successful push", async () => {
      const push = deferred<{ success: boolean; output: string }>();
      const harness = pagerHarness(() => ({
        ...fakeIo().io,
        run: () => push.promise,
      }));
      const running = harness.frame((text) => text.includes("To origin"));
      const closable = harness.frame((text) => text.includes(" Close "));

      await harness.run([
        "P",
        () => running,
        () => {
          push.resolve({ success: true, output: "" });
          return closable;
        },
        "c",
      ]);

      const runningFrame = harness.writes.find((text) =>
        text.includes("To origin")
      )!;
      expect(runningFrame).toContain(" Abort ");
      expect(runningFrame).toMatch(/╔═{30,} Push ═{30,}╗/);
      expect(runningFrame).toContain("║  Writing objects: 100%");
      expect(runningFrame).toContain("Writing objects: 100% (2/2), done.");
      expect(runningFrame).not.toContain("Writing objects:  50%");
      const last = harness.writes.at(-2)!;
      expect(last).toContain("Pushed feature to origin.");
      expect(last).not.toContain(" Close ");
    });

    it("stops the push when Abort is pressed", async () => {
      const harness = pagerHarness((signal) => ({
        ...fakeIo().io,
        run: () =>
          new Promise((resolve) =>
            signal.addEventListener(
              "abort",
              () => resolve({ success: false, output: "" }),
            )
          ),
      }));
      const running = harness.frame((text) => text.includes(" Abort "));
      const closable = harness.frame((text) => text.includes(" Close "));

      await harness.run(["P", () => running, "a", () => closable, "c"]);

      expect(harness.signals[0].aborted).toBe(true);
      expect(harness.writes.at(-2)).toContain("Push aborted.");
    });

    it("stops the push when Abort is clicked, on the release and not the press", async () => {
      const harness = pagerHarness((signal) => ({
        ...fakeIo().io,
        run: () =>
          new Promise((resolve) =>
            signal.addEventListener(
              "abort",
              () => resolve({ success: false, output: "" }),
            )
          ),
      }));
      const at = abortCell();
      const running = harness.frame((text) => text.includes(" Abort "));
      const pressed = harness.frame((text) =>
        text.includes(" Abort ") &&
        cellOf(frameRows(text), "Abort").x === at.x + 1
      );
      const closable = harness.frame((text) => text.includes(" Close "));
      let abortedWhilePressed: boolean | undefined;

      await harness.run([
        "P",
        () => running,
        mouseReport(true, at),
        async () => {
          await pressed;
          abortedWhilePressed = harness.signals[0].aborted;
        },
        mouseReport(false, at),
        () => closable,
        "c",
      ]);

      expect(abortedWhilePressed).toBe(false);
      expect(harness.signals[0].aborted).toBe(true);
      expect(harness.writes.at(-2)).toContain("Push aborted.");
    });

    it("stops a running push when the viewer closes, and draws nothing after", async () => {
      const ended = deferred();
      const harness = pagerHarness((signal) => ({
        ...fakeIo().io,
        run: () =>
          new Promise((resolve) =>
            signal.addEventListener("abort", () => {
              resolve({ success: false, output: "" });
              ended.resolve();
            })
          ),
      }));

      await harness.run(["P"]);
      const writesAtClose = harness.writes.length;
      await ended.promise;

      expect(harness.signals[0].aborted).toBe(true);
      expect(harness.writes).toHaveLength(writesAtClose);
      expect(harness.writes.at(-1)).toContain("\x1b[?1049l");
    });

    it("stops a running push when a signal ends the viewer", async () => {
      const harness = pagerHarness((signal) => ({
        ...fakeIo().io,
        run: () =>
          new Promise((resolve) =>
            signal.addEventListener(
              "abort",
              () => resolve({ success: false, output: "" }),
            )
          ),
      }));
      const running = harness.frame((text) => text.includes(" Abort "));

      await harness.run([
        "P",
        () => running,
        () => {
          expect(() => harness.handlers.get("SIGTERM")!()).toThrow("exit 143");
          return Promise.resolve();
        },
      ]);

      expect(harness.exits).toEqual([143]);
      expect(harness.signals[0].aborted).toBe(true);
    });

    it("reports a push whose operations cannot be set up", async () => {
      const harness = pagerHarness(() => {
        throw new Error("no git");
      });
      const closable = harness.frame((text) => text.includes(" Close "));

      await harness.run(["P", () => closable, "c"]);

      expect(harness.writes.at(-2)).toContain("Push failed: no git");
    });
  });
});
