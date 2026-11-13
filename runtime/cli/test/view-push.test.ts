import { join } from "@std/path";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { EditableSource } from "../lib/view/editsource.ts";
import type {
  CreateRequest,
  GitHubApi,
  MergeRequest,
} from "../lib/view/github.ts";
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
  fakeRelay,
  frameRows,
  mouseKey,
  parseDocument,
  pullRequestPayload,
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
  session.beginTask("Push", () => {});
  return cellOf(drawnRows(session), "Abort");
}

const RELAY = "relay.example.test:8081";

const PULL_REQUEST = "https://github.com/commonfabric/labs/pull/7";

/** The address of pull request 7 of the repository {@link UPSTREAM} names. */
const OCTO_PULL_REQUEST = "https://github.com/octo/repo/pull/7";

/** The settings that quit the viewer once the pushed branch's pull request
 * opens. */
const QUITTING = {
  "cf-view.quitOnPullRequest": "true",
  "cf-view.webhookRelay": RELAY,
};

/** Answers for a checkout whose `upstream` remote is `octo/repo` on GitHub,
 * whose branch's first commit that `upstream`'s `main` lacks is `c1`. */
const UPSTREAM: Readonly<Record<string, string | null>> = {
  "remote get-url upstream": "https://github.com/octo/repo.git\n",
  "symbolic-ref --quiet refs/remotes/upstream/HEAD":
    "refs/remotes/upstream/main\n",
  [
    "rev-list --reverse --no-merges --right-only --cherry-pick " +
    "--end-of-options refs/remotes/upstream/main...HEAD --"
  ]: "c1\n",
  "-c log.showSignature=false log -1 --format=%s%x00%b c1 --":
    "Fix the frobnicator\0It was broken.\n",
};

/** A step that never ends, for a run that ends by quitting. */
const forever = () => new Promise<void>(() => {});

/**
 * A git for the viewer's own questions, which answers as a checkout of
 * `feature` at `c0ffee` pushing to `origin` on GitHub would, with the
 * settings `config` holds, as git's configuration variables, and records
 * each `git config --global` that sets one in `config`. `answers` replaces
 * its answers.
 */
function viewerGit(
  config: Record<string, string> = {
    "cf-view.quitOnPullRequest": "true",
    "cf-view.webhookRelay": RELAY,
  },
  answers: Readonly<Record<string, string | null>> = {},
) {
  const fixed: Readonly<Record<string, string | null>> = {
    "remote get-url --push origin": "git@github.com:fork/repo.git\n",
    "symbolic-ref --quiet HEAD": "refs/heads/feature\n",
    "rev-parse --verify --quiet HEAD": "c0ffee\n",
    ...answers,
  };
  return (args: readonly string[]): string | null => {
    const asked = args.join(" ");
    if (asked in fixed) return fixed[asked];
    const [command, ...rest] = args;
    if (command !== "config") return null;
    if (rest[0] === "--global") {
      config[rest[1]] = rest[2];
      return "";
    }
    const value = config[rest.at(-1) ?? ""];
    if (value === undefined) return null;
    return rest[0] === "--show-scope" ? `global\t${value}\n` : `${value}\n`;
  };
}

/**
 * Returns the SGR mouse report of the primary button going down or coming up
 * at a zero-based cell.
 */
function mouseReport(down: boolean, at: { x: number; y: number }): string {
  return `\x1b[<0;${at.x + 1};${at.y + 1}${down ? "M" : "m"}`;
}

/** A GitHub API that finds no open pull request, says the merge method is
 * squashing, and fails each other request. */
const unusedGitHub: GitHubApi = {
  find: () => Promise.resolve(null),
  mergeMethod: () => Promise.resolve("squash"),
  create: () => Promise.reject(new Error("this test creates nothing")),
  merge: () => Promise.reject(new Error("this test merges nothing")),
};

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
 * something. `git` answers the viewer's questions about the repository,
 * `relay` connects it to the webhook relay, `open` opens pages, `github` and
 * `touchGate` create and merge pull requests, `pullRequestList` lists the
 * open ones, and `source` makes the document editable. `handlers` holds the
 * process signal handlers the pager adds, and `exits` the codes it exits
 * with.
 */
function pagerHarness(
  pushIo: (signal: AbortSignal) => PushIo,
  {
    git = () => null,
    relay = () => undefined,
    open = () => true,
    github = unusedGitHub,
    touchGate = () => unusedGitHub,
    pullRequestList = () => Promise.resolve(null),
    source,
  }:
    & Partial<
      Pick<
        PagerDeps,
        "git" | "relay" | "open" | "github" | "touchGate" | "pullRequestList"
      >
    >
    & { readonly source?: EditableSource } = {},
) {
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
      git,
      relay,
      open,
      github,
      touchGate,
      pullRequestList,
      blame: () => Promise.reject(new Error("these tests blame nothing")),
    };
    await runPager(
      parseDocument("const a = 1;\n"),
      { color: false, showLineNumbers: false },
      undefined,
      source,
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

    it("hands what follows the push to its callback, with no page when the server offers none, and appends what it says", async () => {
      const handed: Array<[string, string | null]> = [];
      const then = (branch: string, url: string | null) => {
        handed.push([branch, url]);
        return url === null ? "" : "Then this.";
      };

      expect(await pushBranch(fakeIo().io, undefined, then)).toBe(
        "Pushed feature to origin.",
      );
      expect(
        await pushBranch(
          fakeIo({ pushOutput: GITHUB_OFFER }).io,
          undefined,
          then,
        ),
      ).toBe("Pushed feature to origin. Then this.");
      expect(handed).toEqual([
        ["feature", null],
        ["feature", "https://github.com/fork/repo/pull/new/feature"],
      ]);
    });

    it("opens the pull request page the server offers", async () => {
      const { io, opened } = fakeIo({ pushOutput: GITHUB_OFFER });

      expect(await pushBranch(io)).toBe(
        "Pushed feature to origin. Opened " +
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

    it("ends the address at the first character that is not printable ASCII", () => {
      expect(
        offeredPullRequestUrl(
          "remote: Create a pull request by visiting:\n" +
            "remote:   https://example.test/pull/new/b\x1b]0;owned\x07\u202e\n",
        ),
      ).toBe("https://example.test/pull/new/b");
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
          "Pushed feature to origin. Opened " +
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
      session.beginTask("Push", () => {});

      session.appendTaskOutput("Writing  50%\r");
      session.appendTaskOutput("Writing 100%\nTo origin\r");
      session.appendTaskOutput("\n * [new branch] feature\n");

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
      session.beginTask("Push", () => {});

      session.appendTaskOutput("To origin\n * [new branch] feature\n");

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
      session.beginTask("Push", () => {});
      const word = "x".repeat(80);

      session.appendTaskOutput(`  ${word}\n`);

      expect(session.view().dialog!.body.slice(0, 3)).toEqual([
        `  ${word.slice(0, 70)}`,
        word.slice(70),
        "",
      ]);
    });

    it("keeps an address no wider than the dialog on one row", () => {
      const session = editableSession();
      session.resize(200, 60);
      session.beginTask("Push", () => {});
      const url = "https://github.com/commonfabric/labs/pull/new/feature";

      session.appendTaskOutput(`remote:      ${url}\n`);
      session.finishTask(`Pushed feature to origin. Opened ${url}`);

      expect(session.view().dialog!.body.slice(0, 5)).toEqual([
        `remote:      ${url}`,
        "",
        "Pushed feature to origin. Opened",
        url,
        "",
      ]);
    });

    it("drops the spaces git pads a server's lines with, which would wrap onto a row of their own", () => {
      const session = editableSession();
      session.beginTask("Push", () => {});
      const offer =
        "remote:      https://github.com/commonfabric/labs/pull/new/" +
        "a-branch-name";
      expect(offer.length).toBe(72);

      session.appendTaskOutput(`${offer}        \nTo origin\n`);

      expect(session.view().dialog!.body.slice(0, 3)).toEqual([
        offer,
        "To origin",
        "",
      ]);
    });

    it("shows the end of output longer than the dialog", () => {
      const session = editableSession();
      session.beginTask("Push", () => {});

      session.appendTaskOutput(
        Array.from({ length: 9 }, (_, i) => `line ${i}\n`).join(""),
      );

      expect(
        session.view().dialog!.body.map((line) => line.trimEnd()),
      ).toEqual(["line 4", "line 5", "line 6", "line 7", "line 8"]);
    });

    it("wraps a line wider than the dialog after its last space that fits, breaking a word wider than the dialog", () => {
      const session = editableSession();
      session.beginTask("Push", () => {});
      const url = "https://github.com/commonfabric/labs/pull/new/" +
        "a-branch-whose-name-runs-on-and-on";

      session.finishTask(`Pushed feature to origin. Opened ${url}`);

      expect(session.view().dialog!.body.slice(0, 4)).toEqual([
        "",
        "Pushed feature to origin. Opened",
        url.slice(0, 72),
        url.slice(72),
      ]);
    });

    it("aborts a running push on an interrupt, keeping the dialog up", () => {
      const session = editableSession();
      let aborted = 0;
      session.beginTask("Push", () => aborted++);

      expect(session.requestQuitFromSignal()).toBe(true);

      expect(aborted).toBe(1);
      expect(session.view().dialog?.title).toBe("Push");
      expect(session.quit).toBe(false);
    });

    it("offers Abort, which stops the push and leaves the dialog up", () => {
      const session = editableSession();
      let aborted = 0;
      session.beginTask("Push", () => aborted++);

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
      session.beginTask("Push", () => aborted++);
      session.appendTaskOutput("To origin\n");

      session.finishTask("Pushed feature to origin.");

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
      session.beginTask("Push", () => {});

      session.handleKey({ name: "Q", char: "Q" });
      expect(session.quit).toBe(false);
      expect(session.view().dialog?.title).toBe("Push");

      session.finishTask("Pushed feature to origin.");
      session.handleKey({ name: "q", char: "q" });
      expect(session.quit).toBe(false);
      expect(session.view().dialog?.title).toBe("Push");
      session.handleKey({ name: "Q", char: "Q" });

      expect(session.quit).toBe(true);
    });

    it("lets go of a held Abort when the push ends, so a release on Close closes nothing", () => {
      const session = editableSession();
      session.beginTask("Push", () => {});

      session.handleKey(mouseKey(true, abortCell()));
      expect(session.view().dialog!.pushed).toBe(0);
      session.finishTask("Pushed feature to origin.");
      expect(session.view().dialog!.pushed).toBe(-1);
      session.handleKey(mouseKey(false, cellOf(drawnRows(session), "Close")));

      expect(session.view().dialog?.title).toBe("Push");
    });

    it("lets go of a held Close when an interrupt opens the save prompt, so a release on its Cancel cancels nothing", () => {
      const session = editableSession();
      session.handleKey({ name: "e", char: "e" });
      session.handleKey({ name: "X", char: "X" });
      session.handleKey({ name: "escape" });
      session.beginTask("Push", () => {});
      session.finishTask("Pushed feature to origin.");

      session.handleKey(mouseKey(true, cellOf(drawnRows(session), "Close")));
      session.requestQuitFromSignal();
      expect(session.view().dialog?.title).toBe("Save Changes");
      expect(session.view().dialog!.pushed).toBe(-1);
      session.handleKey(mouseKey(false, cellOf(drawnRows(session), "Cancel")));

      expect(session.view().dialog?.title).toBe("Save Changes");
    });

    it("closes on a click on Close once the push ends, and quits on a click on Quit", () => {
      const session = editableSession();
      session.beginTask("Push", () => {});
      session.finishTask("Pushed feature to origin.");
      const close = cellOf(drawnRows(session), "Close");
      const quit = cellOf(drawnRows(session), "Quit");

      session.handleKey(mouseKey(true, close));
      session.handleKey(mouseKey(false, close));
      expect(session.view().dialog).toBeNull();
      expect(session.view().message).toBe("Pushed feature to origin.");
      expect(session.quit).toBe(false);

      session.beginTask("Push", () => {});
      session.finishTask("Pushed feature to origin.");
      session.handleKey(mouseKey(true, quit));
      session.handleKey(mouseKey(false, quit));
      expect(session.quit).toBe(true);
    });

    it("shows what it says about watching for the pull request under the output, at the same size", () => {
      const session = editableSession();
      session.beginTask("Push", () => {});
      const rows = session.view().dialog!.body.length;

      session.appendTaskOutput(
        Array.from({ length: 9 }, (_, i) => `line ${i}\n`).join(""),
      );
      session.setPullRequestWatch("Quitting when the pull request opens.");

      expect(session.view().dialog!.body.map((line) => line.trimEnd()))
        .toEqual([
          "line 6",
          "line 7",
          "line 8",
          "",
          "Quitting when the pull request opens.",
        ]);
      expect(session.view().dialog!.body.length).toBe(rows);
      session.beginTask("Push", () => {});
      expect(session.view().dialog!.body.join("")).toBe("");
    });

    it("keeps the buttons on a screen too short for the output and what it says about the watch", () => {
      const session = editableSession();
      session.resize(30, 11);
      session.beginTask("Push", () => {});
      session.appendTaskOutput("To origin\n");
      session.finishTask("Pushed feature to origin.");

      session.setPullRequestWatch(
        "Not watching for the pull request: no webhook relay is set in the " +
          "settings.",
      );

      const dialog = session.view().dialog!;
      expect(dialog.body.length).toBe(4);
      expect(dialog.body[0]).not.toBe("");
      expect(drawnRows(session).join("\n")).toContain(" Close ");
    });

    it("closes the dialog and quits, keeping the address to print, when the pull request opens while it is up", () => {
      const session = editableSession();
      session.beginTask("Push", () => {});
      session.finishTask("Pushed feature to origin.");
      expect(session.exitMessage).toBeNull();

      session.quitForPullRequest(PULL_REQUEST);

      expect(session.taskDialogUp).toBe(false);
      expect(session.view().message).toBe("Pushed feature to origin.");
      expect(session.quit).toBe(true);
      expect(session.exitMessage).toBe(PULL_REQUEST);
    });

    it("waits for a push still running to end before quitting for the pull request", () => {
      const session = editableSession();
      session.beginTask("Push", () => {});

      session.quitForPullRequest(PULL_REQUEST);
      expect(session.taskDialogUp).toBe(true);
      expect(session.quit).toBe(false);
      session.finishTask("Pushed feature to origin.");

      expect(session.view().message).toBe("Pushed feature to origin.");
      expect(session.quit).toBe(true);
      expect(session.exitMessage).toBe(PULL_REQUEST);
    });

    it("does nothing when the pull request opens once the dialog is down", () => {
      const session = editableSession();
      session.beginTask("Push", () => {});
      session.finishTask("Pushed feature to origin.");
      session.handleKey({ name: "c", char: "c" });

      session.quitForPullRequest(PULL_REQUEST);

      expect(session.quit).toBe(false);
      session.beginTask("Push", () => {});
      session.finishTask("Pushed feature to origin.");
      expect(session.quit).toBe(false);
    });

    it("asks to save unsaved edits before the pull request opening quits", () => {
      const session = editableSession();
      session.handleKey({ name: "e", char: "e" });
      session.handleKey({ name: "X", char: "X" });
      session.handleKey({ name: "escape" });
      session.beginTask("Push", () => {});
      session.finishTask("Pushed feature to origin.");

      session.quitForPullRequest(PULL_REQUEST);

      expect(session.quit).toBe(false);
      expect(session.view().dialog?.title).toBe("Save Changes");
      session.handleKey({ name: "d", char: "d" });
      expect(session.exitMessage).toBe(PULL_REQUEST);
    });

    it("prints no address on a later quit once the save prompt the pull request raised is cancelled", () => {
      const session = editableSession();
      session.handleKey({ name: "e", char: "e" });
      session.handleKey({ name: "X", char: "X" });
      session.handleKey({ name: "escape" });
      session.beginTask("Push", () => {});
      session.finishTask("Pushed feature to origin.");
      session.quitForPullRequest(PULL_REQUEST);

      session.handleKey({ name: "c", char: "c" });
      session.handleKey({ name: "q", char: "q" });
      session.handleKey({ name: "d", char: "d" });

      expect(session.quit).toBe(true);
      expect(session.exitMessage).toBeNull();
    });

    it("asks to save unsaved edits before Quit quits", () => {
      const session = editableSession();
      session.handleKey({ name: "e", char: "e" });
      session.handleKey({ name: "X", char: "X" });
      session.handleKey({ name: "escape" });
      session.beginTask("Push", () => {});
      session.finishTask("Pushed feature to origin.");

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

    describe("watching for the pull request", () => {
      it("connects once the push succeeds and before the page opens, and quits printing the address once the pull request opens", async () => {
        const relay = fakeRelay();
        let connectedBeforePush = true;
        let connectedBeforePage = false;
        const harness = pagerHarness(
          () => ({
            ...fakeIo().io,
            run: () => {
              connectedBeforePush = relay.connections === 1;
              return Promise.resolve({ success: true, output: GITHUB_OFFER });
            },
            open: () => {
              connectedBeforePage = relay.connections === 1;
              return true;
            },
          }),
          {
            git: viewerGit(),
            relay: (address) => address === RELAY ? relay.connect : undefined,
          },
        );
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run([
          "P",
          async () => {
            await closable;
            await relay.connected;
            relay.deliver("pull_request", pullRequestPayload({ branch: "x" }));
            relay.deliver("pull_request", pullRequestPayload());
            await relay.closed();
          },
        ]);

        expect(connectedBeforePush).toBe(false);
        expect(connectedBeforePage).toBe(true);
        const shown = harness.writes.find((text) => text.includes(" Close "))!;
        expect(shown).toContain("Quitting when the pull request opens.");
        expect(harness.writes.at(-1)).toMatch(
          new RegExp(`\\x1b\\[\\?1049l${PULL_REQUEST}\\n$`),
        );
      });

      it("asks to save unsaved edits once the pull request opens, and prints the address once they are saved", async () => {
        const relay = fakeRelay();
        const saved: string[] = [];
        const harness = pagerHarness(
          () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
          {
            git: viewerGit(),
            relay: () => relay.connect,
            source: {
              label: "main.ts",
              editable: true,
              path: "/work/main.ts",
              parse: (text) => parseDocument(text, "/work/main.ts"),
              save: (text) => {
                saved.push(text);
                return "saved";
              },
            },
          },
        );
        const closable = harness.frame((text) => text.includes(" Close "));
        const asked = harness.frame((text) => text.includes("Save Changes"));

        await harness.run([
          "e",
          "X",
          "\x1b",
          "P",
          async () => {
            await closable;
            await relay.connected;
            relay.deliver("pull_request", pullRequestPayload());
            await asked;
          },
          "s",
        ]);

        expect(saved).toHaveLength(1);
        expect(harness.writes.at(-1)).toMatch(
          new RegExp(`\\x1b\\[\\?1049l${PULL_REQUEST}\\n$`),
        );
      });

      it("connects to nothing when the push fails", async () => {
        const relay = fakeRelay();
        const harness = pagerHarness(
          () => fakeIo({ pushSucceeds: false, pushOutput: GITHUB_OFFER }).io,
          { git: viewerGit(), relay: () => relay.connect },
        );
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["P", () => closable, "c"]);

        expect(relay.connections).toBe(0);
        expect(harness.writes.join("")).not.toContain("pull request opens");
      });

      it("connects to nothing when the server offers no page for creating a pull request", async () => {
        const relay = fakeRelay();
        const harness = pagerHarness(() => fakeIo().io, {
          git: viewerGit(),
          relay: () => relay.connect,
        });
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["P", () => closable, "c"]);

        expect(relay.connections).toBe(0);
        expect(harness.writes.join("")).not.toContain("pull request opens");
      });

      it("says it is connecting, and opens the page only once the connection is open", async () => {
        const relay = fakeRelay();
        const connecting = Promise.withResolvers<void>();
        const opened: boolean[] = [];
        const harness = pagerHarness(
          () => ({
            ...fakeIo({ pushOutput: GITHUB_OFFER }).io,
            open: () => {
              opened.push(relay.connections === 1);
              return true;
            },
          }),
          {
            git: viewerGit(),
            relay: () => async () => {
              await connecting.promise;
              return relay.connect();
            },
          },
        );
        const waiting = harness.frame((text) =>
          text.includes("Connecting to the webhook relay.")
        );
        const watching = harness.frame((text) =>
          text.includes("Quitting when the pull request opens.")
        );
        let openedWhileConnecting: number | undefined;

        await harness.run([
          "P",
          async () => {
            await waiting;
            openedWhileConnecting = opened.length;
            connecting.resolve();
            await watching;
          },
          "c",
        ]);

        expect(openedWhileConnecting).toBe(0);
        expect(opened).toEqual([true]);
      });

      it("gives up on the connection and opens the page when Abort is pressed while it connects", async () => {
        const opened: string[] = [];
        let abandoned: AbortSignal | undefined;
        const harness = pagerHarness(
          () => ({
            ...fakeIo({ pushOutput: GITHUB_OFFER }).io,
            open: (url) => {
              opened.push(url);
              return true;
            },
          }),
          {
            git: viewerGit(),
            // A connect that never settles, whatever its signal does.
            relay: () => (signal) => {
              abandoned = signal;
              return new Promise(() => {});
            },
          },
        );
        const waiting = harness.frame((text) =>
          text.includes("Connecting to the webhook relay.")
        );
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["P", () => waiting, "a", () => closable, "c"]);

        expect(abandoned?.aborted).toBe(true);
        expect(opened).toEqual([
          "https://github.com/fork/repo/pull/new/feature",
        ]);
        const shown = harness.writes.find((text) => text.includes(" Close "))!;
        expect(shown).toContain(
          "Not watching for the pull request: the watch was aborted.",
        );
        expect(shown).toContain("Pushed feature to origin. Opened");
      });

      it("opens the page and says why once the connection fails", async () => {
        const opened: string[] = [];
        const harness = pagerHarness(
          () => ({
            ...fakeIo({ pushOutput: GITHUB_OFFER }).io,
            open: (url) => {
              opened.push(url);
              return true;
            },
          }),
          {
            git: viewerGit(),
            relay: () => () => Promise.reject(new Error("connection refused")),
          },
        );
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["P", () => closable, "c"]);

        expect(opened).toEqual([
          "https://github.com/fork/repo/pull/new/feature",
        ]);
        expect(harness.writes.join("")).toContain(
          "Not watching for the pull request: connection refused.",
        );
      });

      it("connects to nothing when Abort was pressed during a push that succeeded anyway", async () => {
        const relay = fakeRelay();
        const harness = pagerHarness(
          (signal) => ({
            ...fakeIo({ pushOutput: GITHUB_OFFER }).io,
            run: () =>
              new Promise((resolve) =>
                signal.addEventListener(
                  "abort",
                  () => resolve({ success: true, output: GITHUB_OFFER }),
                )
              ),
          }),
          { git: viewerGit(), relay: () => relay.connect },
        );
        const running = harness.frame((text) => text.includes(" Abort "));
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["P", () => running, "a", () => closable, "c"]);

        expect(relay.connections).toBe(0);
        expect(harness.writes.find((text) => text.includes(" Close ")))
          .toContain(
            "the watch was aborted.",
          );
      });

      it("says why it is not watching when git fails as the watch starts, and reports the push as it went", async () => {
        const harness = pagerHarness(
          () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
          {
            git: () => {
              throw new Error("git is gone");
            },
          },
        );
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["P", () => closable, "c"]);

        const shown = harness.writes.find((text) => text.includes(" Close "))!;
        expect(shown).toContain(
          "Not watching for the pull request: git is gone.",
        );
        expect(shown).toContain("Pushed feature to origin. Opened");
      });

      it("stops the watch of a push whose dialog closed in the same read that pushes again, though the second push fails", async () => {
        const relay = fakeRelay();
        let pushes = 0;
        const harness = pagerHarness(
          () =>
            fakeIo({ pushOutput: GITHUB_OFFER, pushSucceeds: pushes++ === 0 })
              .io,
          { git: viewerGit(), relay: () => relay.connect },
        );
        const closable = harness.frame((text) => text.includes(" Close "));
        let first: Promise<void> | undefined;
        const failed = harness.frame((text) =>
          text.includes("Pushing feature to origin failed.")
        );

        await harness.run([
          "P",
          async () => {
            await closable;
            await relay.connected;
            first = relay.closed();
          },
          "cP",
          async () => {
            await first;
            await failed;
          },
          "c",
        ]);

        expect(relay.connections).toBe(1);
        expect(harness.writes.at(-1)).not.toContain(PULL_REQUEST);
      });

      it("connects to nothing while the setting is off", async () => {
        const relay = fakeRelay();
        const harness = pagerHarness(
          () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
          {
            git: viewerGit({ "cf-view.webhookRelay": RELAY }),
            relay: () => relay.connect,
          },
        );
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["P", () => closable, "c"]);

        expect(relay.connections).toBe(0);
        expect(harness.writes.join("")).not.toContain("pull request:");
      });

      it("says why it is not watching when no relay is set, or origin is not on GitHub", async () => {
        for (
          const [git, reason] of [
            [
              viewerGit({ "cf-view.quitOnPullRequest": "true" }),
              "no webhook relay is set",
            ],
            [
              viewerGit(undefined, { "remote get-url --push origin": null }),
              "origin is not a GitHub",
            ],
          ] as const
        ) {
          const harness = pagerHarness(
            () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
            {
              git,
              relay: (address) =>
                address === "" ? undefined : fakeRelay().connect,
            },
          );
          const closable = harness.frame((text) => text.includes(" Close "));

          await harness.run(["P", () => closable, "c"]);

          expect(harness.writes.join("")).toContain(
            `Not watching for the pull request: ${reason}`,
          );
        }
      });

      it("says it stopped watching when the connection ends", async () => {
        const relay = fakeRelay();
        const harness = pagerHarness(
          () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
          {
            git: viewerGit(),
            relay: () => relay.connect,
          },
        );
        const closable = harness.frame((text) => text.includes(" Close "));
        const ended = harness.frame((text) =>
          text.includes("the webhook relay closed")
        );

        await harness.run([
          "P",
          async () => {
            await closable;
            await relay.connected;
            relay.end();
            await ended;
          },
          "c",
        ]);

        expect(harness.writes.join("")).toContain(
          "Not watching for the pull request: the webhook relay closed the",
        );
      });

      it("stops watching once the dialog closes, and prints nothing", async () => {
        const relay = fakeRelay();
        const harness = pagerHarness(
          () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
          {
            git: viewerGit(),
            relay: () => relay.connect,
          },
        );
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run([
          "P",
          () => closable,
          "c",
          async () => {
            await relay.closed();
            relay.deliver("pull_request", pullRequestPayload());
          },
        ]);

        expect(harness.writes.at(-1)).not.toContain(PULL_REQUEST);
      });
    });

    describe("creating the pull request", () => {
      it("creates it with GitHub's API from upstream's default branch, titled as the branch's first commit, and quits printing its address", async () => {
        const created: CreateRequest[] = [];
        const opened: string[] = [];
        const harness = pagerHarness(
          () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
          {
            git: viewerGit(
              { "cf-view.pullRequestTool": "api", ...QUITTING },
              UPSTREAM,
            ),
            open: (url) => opened.push(url) > 0,
            github: {
              ...unusedGitHub,
              create: (request) => {
                created.push(request);
                return Promise.resolve(OCTO_PULL_REQUEST);
              },
            },
          },
        );

        await harness.run(["P", forever]);

        expect(created).toEqual([{
          repository: "octo/repo",
          head: "fork:feature",
          base: "main",
          title: "Fix the frobnicator",
          body: "It was broken.",
        }]);
        expect(opened).toEqual([]);
        expect(harness.writes.at(-1)).toMatch(
          new RegExp(`\\x1b\\[\\?1049l${OCTO_PULL_REQUEST}\\n$`),
        );
      });

      it("creates it with touch-gate and the token the settings name, showing what the touch approves, and stays up while quitting is off", async () => {
        const tokens: string[] = [];
        const harness = pagerHarness(
          () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
          {
            git: viewerGit(
              {
                "cf-view.pullRequestTool": "touch-gate",
                "cf-view.touchGateToken": "mine",
              },
              UPSTREAM,
            ),
            touchGate: (token) => {
              tokens.push(token);
              return {
                ...unusedGitHub,
                create: (_request, write) => {
                  write("Touch the security key.\n");
                  return Promise.resolve(OCTO_PULL_REQUEST);
                },
              };
            },
          },
        );
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["P", () => closable, "c"]);

        expect(tokens).toEqual(["mine"]);
        const shown = harness.writes.find((text) => text.includes(" Close "))!;
        expect(shown).toContain("Touch the security key.");
        expect(shown).toContain(
          `Pushed feature to origin. Created ${OCTO_PULL_REQUEST}`,
        );
        expect(harness.writes.at(-1)).not.toContain(`${OCTO_PULL_REQUEST}\n`);
      });

      it("creates it after a push that had nothing new, which the server offers no page for, unless one is open", async () => {
        for (const listed of [false, true]) {
          const created: CreateRequest[] = [];
          const harness = pagerHarness(
            () => fakeIo({ pushOutput: "Everything up-to-date\n" }).io,
            {
              git: viewerGit({ "cf-view.pullRequestTool": "api" }, UPSTREAM),
              pullRequestList: () =>
                Promise.resolve(listed ? "octo/repo\tfeature\t7\n" : ""),
              github: {
                ...unusedGitHub,
                create: (request) => {
                  created.push(request);
                  return Promise.resolve(OCTO_PULL_REQUEST);
                },
              },
            },
          );
          const closable = harness.frame((text) => text.includes(" Close "));

          await harness.run(["P", () => closable, "c"]);

          expect(created.length).toBe(listed ? 0 : 1);
          const shown = harness.writes.find((text) =>
            text.includes(" Close ")
          )!;
          expect(shown).toContain(
            listed
              ? "Pushed feature to origin. Pull request 7 is open:"
              : `Pushed feature to origin. Created ${OCTO_PULL_REQUEST}`,
          );
          expect(shown).toContain(OCTO_PULL_REQUEST);
        }
      });

      it("creates nothing when GitHub, asked because the list names none, says one is open", async () => {
        const harness = pagerHarness(
          () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
          {
            git: viewerGit({ "cf-view.pullRequestTool": "api" }, UPSTREAM),
            github: {
              ...unusedGitHub,
              find: () =>
                Promise.resolve({ number: 7, url: OCTO_PULL_REQUEST }),
            },
          },
        );
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["P", () => closable, "c"]);

        const shown = harness.writes.find((text) => text.includes(" Close "))!;
        expect(shown).toContain("Pull request 7 is open:");
        expect(shown).toContain(OCTO_PULL_REQUEST);
      });

      it("tries again with the settings as they are when Create PR is pressed, and says when they no longer create pull requests", async () => {
        const config: Record<string, string> = {
          "cf-view.pullRequestTool": "touch-gate",
          "cf-view.touchGateToken": "typo",
        };
        const tokens: string[] = [];
        const harness = pagerHarness(
          () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
          {
            git: viewerGit(config, UPSTREAM),
            touchGate: (token) => {
              tokens.push(token);
              return {
                ...unusedGitHub,
                create: () => Promise.reject(new Error("no such token")),
              };
            },
          },
        );
        const failed = harness.frame((text) => text.includes("P Create PR"));
        const refailed = harness.frame((text) =>
          text.includes(" Create PR ═") && text.includes("P Create PR")
        );
        const declined = harness.frame((text) =>
          text.includes("The settings no longer create pull requests.")
        );

        await harness.run([
          "P",
          async () => {
            await failed;
            config["cf-view.touchGateToken"] = "mine";
          },
          "p",
          async () => {
            await refailed;
            config["cf-view.pullRequestTool"] = "link";
          },
          "p",
          () => declined,
          "c",
        ]);

        expect(tokens).toEqual(["typo", "mine"]);
      });

      it("says it created the pull request, in the service's words, when the service gives no address", async () => {
        const harness = pagerHarness(
          () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
          {
            git: viewerGit(
              {
                "cf-view.pullRequestTool": "touch-gate",
                "cf-view.touchGateToken": "mine",
              },
              UPSTREAM,
            ),
            touchGate: () => ({
              ...unusedGitHub,
              create: () => Promise.resolve("it was made"),
            }),
          },
        );
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["P", () => closable, "c"]);

        expect(harness.writes.join("")).toContain(
          "Pushed feature to origin. Created the pull request: it was made",
        );
      });

      it("says why when it cannot create it, and watches for nothing", async () => {
        const relay = fakeRelay();
        const harness = pagerHarness(
          () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
          {
            git: viewerGit(
              { "cf-view.pullRequestTool": "api", ...QUITTING },
              UPSTREAM,
            ),
            relay: () => relay.connect,
            github: {
              ...unusedGitHub,
              create: () => Promise.reject(new Error("it exists")),
            },
          },
        );
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["P", () => closable, "c"]);

        const shown = harness.writes.find((text) => text.includes(" Close "))!;
        expect(shown).toContain("Creating the pull request failed: it exists.");
        expect(shown).toContain("To retry, press Create PR.");
        expect(shown).toContain("P Create PR");
        expect(relay.connections).toBe(0);
      });

      it("tries the creation again, and only that, on Create PR, offering no retry once it succeeds", async () => {
        let attempts = 0;
        let pushes = 0;
        const harness = pagerHarness(
          () => ({
            ...fakeIo({ pushOutput: GITHUB_OFFER }).io,
            run: () => {
              pushes++;
              return Promise.resolve({ success: true, output: GITHUB_OFFER });
            },
          }),
          {
            git: viewerGit({ "cf-view.pullRequestTool": "api" }, UPSTREAM),
            github: {
              ...unusedGitHub,
              create: () =>
                attempts++ === 0
                  ? Promise.reject(new Error("timed out"))
                  : Promise.resolve(OCTO_PULL_REQUEST),
            },
          },
        );
        const failed = harness.frame((text) => text.includes("P Create PR"));
        const created = harness.frame((text) =>
          text.includes(`Created ${OCTO_PULL_REQUEST}`)
        );

        await harness.run(["P", () => failed, "p", () => created, "c"]);

        expect(attempts).toBe(2);
        expect(pushes).toBe(1);
        const shown = harness.writes.find((text) =>
          text.includes(`Created ${OCTO_PULL_REQUEST}`)
        )!;
        expect(shown).toContain(" Create PR ═");
        expect(shown).not.toContain("P Create PR");
        expect(shown).not.toContain("To retry");
      });

      it("says the creation was aborted when Abort stops it", async () => {
        const harness = pagerHarness(
          () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
          {
            git: viewerGit({ "cf-view.pullRequestTool": "api" }, UPSTREAM),
            github: {
              ...unusedGitHub,
              create: (_request, write, signal) => {
                write("Creating.\n");
                return new Promise((_, reject) =>
                  signal.addEventListener("abort", () => reject(signal.reason))
                );
              },
            },
          },
        );
        const creating = harness.frame((text) => text.includes("Creating."));
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["P", () => creating, "a", () => closable, "c"]);

        expect(harness.writes.join("")).toContain(
          "Creating the pull request was aborted.",
        );
      });

      it("gives the page's address without opening it when the settings say to link to it, and creates nothing", async () => {
        const opened: string[] = [];
        const harness = pagerHarness(
          () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
          {
            git: viewerGit({ "cf-view.pullRequestTool": "link" }, UPSTREAM),
            open: (url) => opened.push(url) > 0,
          },
        );
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["P", () => closable, "c"]);

        expect(opened).toEqual([]);
        const shown = harness.writes.find((text) => text.includes(" Close "))!;
        expect(shown).toContain(
          "Pushed feature to origin. Create a pull request at",
        );
        expect(shown).toContain(
          "https://github.com/fork/repo/pull/new/feature",
        );
      });
    });

    describe("landing", () => {
      it("links to the branch's pull request that the user's list names, asking GitHub nothing, when the settings say to", async () => {
        const harness = pagerHarness(() => fakeIo().io, {
          git: viewerGit({ "cf-view.pullRequestTool": "link" }, UPSTREAM),
          pullRequestList: () => Promise.resolve("octo/repo\tfeature\t7\n"),
        });
        const answered = harness.frame((text) => text.includes("Pull request"));

        await harness.run(["L", () => answered]);

        expect(harness.writes.join("")).toContain(
          `Pull request 7: ${OCTO_PULL_REQUEST}`,
        );
      });

      it("asks GitHub for the pull request when the user's list does not name it", async () => {
        const harness = pagerHarness(() => fakeIo().io, {
          git: viewerGit({ "cf-view.pullRequestTool": "link" }, UPSTREAM),
          pullRequestList: () => Promise.resolve("octo/repo\tother\t3\n"),
          github: {
            ...unusedGitHub,
            find: () => Promise.resolve({ number: 7, url: OCTO_PULL_REQUEST }),
          },
        });
        const answered = harness.frame((text) => text.includes("Pull request"));

        await harness.run(["L", () => answered]);

        expect(harness.writes.join("")).toContain(
          `Pull request 7: ${OCTO_PULL_REQUEST}`,
        );
      });

      it("asks GitHub for the pull request when there is no list, and says when the branch has none", async () => {
        const asked: string[] = [];
        const harness = pagerHarness(() => fakeIo().io, {
          git: viewerGit({}, UPSTREAM),
          github: {
            ...unusedGitHub,
            find: (target) => {
              asked.push(
                `${target.repository} ${target.owner}:${target.branch}`,
              );
              return Promise.resolve(null);
            },
          },
        });
        const answered = harness.frame((text) => text.includes("no open"));

        await harness.run(["L", () => answered]);

        expect(asked).toEqual(["octo/repo fork:feature"]);
        expect(harness.writes.join("")).toContain(
          "feature has no open pull request in octo/repo.",
        );
      });

      it("opens the pull request in the browser, or links to it when it cannot, as the settings say", async () => {
        for (const opens of [true, false]) {
          const opened: string[] = [];
          const harness = pagerHarness(() => fakeIo().io, {
            git: viewerGit({}, UPSTREAM),
            open: (url) => opened.push(url) > 0 && opens,
            pullRequestList: () => Promise.resolve("octo/repo\tfeature\t7\n"),
          });
          const message = opens
            ? `Opened ${OCTO_PULL_REQUEST}`
            : `Pull request 7: ${OCTO_PULL_REQUEST}`;
          const answered = harness.frame((text) => text.includes(message));

          await harness.run(["L", () => answered]);

          expect(opened).toEqual([OCTO_PULL_REQUEST]);
        }
      });

      it("asks whether to merge by the method GitHub's page would use, and merges with GitHub's API, if the head is still the checked-out commit", async () => {
        const merged: MergeRequest[] = [];
        const asked: string[] = [];
        const harness = pagerHarness(() => fakeIo().io, {
          git: viewerGit({ "cf-view.pullRequestTool": "api" }, UPSTREAM),
          pullRequestList: () => Promise.resolve("octo/repo\tfeature\t7\n"),
          github: {
            ...unusedGitHub,
            mergeMethod: (repository) => {
              asked.push(repository);
              return Promise.resolve("rebase");
            },
            merge: (request) => {
              merged.push(request);
              return Promise.resolve(`Merged ${OCTO_PULL_REQUEST}`);
            },
          },
        });
        const asking = harness.frame((text) =>
          text.includes("Rebase and merge pull request 7 of octo/repo,")
        );
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["L", () => asking, "m", () => closable, "c"]);

        expect(asked).toEqual(["octo/repo"]);

        expect(merged).toEqual([
          {
            repository: "octo/repo",
            number: 7,
            method: "rebase",
            sha: "c0ffee",
          },
        ]);
        const shown = harness.writes.find((text) => text.includes(" Close "))!;
        expect(shown).toContain(
          "Merging pull request 7 of octo/repo by rebase.",
        );
        expect(shown).toContain(`Merged ${OCTO_PULL_REQUEST}`);
      });

      it("merges with touch-gate and the token the settings name without asking first, and says why when it cannot", async () => {
        const tokens: string[] = [];
        const merged: MergeRequest[] = [];
        const harness = pagerHarness(() => fakeIo().io, {
          git: viewerGit(
            {
              "cf-view.pullRequestTool": "touch-gate",
              "cf-view.touchGateToken": "mine",
            },
            UPSTREAM,
          ),
          pullRequestList: () => Promise.resolve("octo/repo\tfeature\t7\n"),
          touchGate: (token) => {
            tokens.push(token);
            return {
              ...unusedGitHub,
              merge: (request) => {
                merged.push(request);
                return Promise.reject(new Error("touch-gate refused: no"));
              },
            };
          },
        });
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["L", () => closable, "c"]);

        expect(tokens).toEqual(["mine"]);
        expect(merged).toEqual([
          {
            repository: "octo/repo",
            number: 7,
            method: "squash",
            sha: "c0ffee",
          },
        ]);
        expect(harness.writes.join("")).not.toContain("and merge pull request");
        expect(harness.writes.join("")).toContain(
          "Landing failed: touch-gate refused: no",
        );
      });

      it("says the merge was aborted when Abort stops it", async () => {
        const harness = pagerHarness(() => fakeIo().io, {
          git: viewerGit({ "cf-view.pullRequestTool": "api" }, UPSTREAM),
          pullRequestList: () => Promise.resolve("octo/repo\tfeature\t7\n"),
          github: {
            ...unusedGitHub,
            merge: (_request, _write, signal) =>
              new Promise((_, reject) =>
                signal.addEventListener("abort", () => reject(signal.reason))
              ),
          },
        });
        const asking = harness.frame((text) =>
          text.includes("Squash and merge pull request 7")
        );
        const merging = harness.frame((text) => text.includes(" Abort "));
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run([
          "L",
          () => asking,
          "m",
          () => merging,
          "a",
          () => closable,
          "c",
        ]);

        expect(harness.writes.join("")).toContain("Landing aborted.");
      });

      it("shows the land dialog while it looks for the pull request, ignoring the land button's letter typed meanwhile, and stops looking on Cancel", async () => {
        const found = Promise.withResolvers<null>();
        let stopped: AbortSignal | undefined;
        const harness = pagerHarness(() => fakeIo().io, {
          git: viewerGit({ "cf-view.pullRequestTool": "api" }, UPSTREAM),
          github: {
            ...unusedGitHub,
            find: (_target, signal) => {
              stopped = signal;
              return found.promise;
            },
          },
        });
        const looking = harness.frame((text) =>
          text.includes("Looking for the pull request of feature in octo/repo.")
        );

        await harness.run(["L", () => looking, "m", "\x1b"]);
        found.resolve(null);

        expect(stopped?.aborted).toBe(true);
        expect(harness.writes.join("")).not.toContain("and merge pull request");
        expect(harness.writes.join("")).not.toContain("no open pull request");
      });

      it("starts only the first of two tasks whose keys arrive in one read, the second key reaching its dialog", async () => {
        const looked: string[] = [];
        const harness = pagerHarness(() => fakeIo().io, {
          git: viewerGit({ "cf-view.pullRequestTool": "link" }, UPSTREAM),
          github: {
            ...unusedGitHub,
            find: (target) => {
              looked.push(target.branch);
              return Promise.resolve(null);
            },
          },
        });
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["PL", () => closable, "c"]);

        expect(looked).toEqual([]);
        expect(harness.writes.join("")).not.toContain("Looking for");
      });

      it("merges with the service the settings named when the land dialog asked, though they change meanwhile", async () => {
        const config: Record<string, string> = {
          "cf-view.pullRequestTool": "api",
        };
        const merged: string[] = [];
        const harness = pagerHarness(() => fakeIo().io, {
          git: viewerGit(config, UPSTREAM),
          pullRequestList: () => Promise.resolve("octo/repo\tfeature\t7\n"),
          github: {
            ...unusedGitHub,
            merge: () => {
              merged.push("api");
              return Promise.resolve("Merged");
            },
          },
          touchGate: () => ({
            ...unusedGitHub,
            merge: () => {
              merged.push("touch-gate");
              return Promise.resolve("Merged");
            },
          }),
        });
        const asking = harness.frame((text) =>
          text.includes("Squash and merge pull request 7")
        );
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run([
          "L",
          async () => {
            await asking;
            config["cf-view.pullRequestTool"] = "touch-gate";
          },
          "m",
          () => closable,
          "c",
        ]);

        expect(merged).toEqual(["api"]);
      });

      it("merges nothing when Cancel stops the search while GitHub is asked how the repository merges", async () => {
        const method = Promise.withResolvers<"squash">();
        const merged: string[] = [];
        const asking = Promise.withResolvers<void>();
        const harness = pagerHarness(() => fakeIo().io, {
          git: viewerGit(
            {
              "cf-view.pullRequestTool": "touch-gate",
              "cf-view.touchGateToken": "mine",
            },
            UPSTREAM,
          ),
          pullRequestList: () => Promise.resolve("octo/repo\tfeature\t7\n"),
          github: {
            ...unusedGitHub,
            mergeMethod: () => {
              asking.resolve();
              return method.promise;
            },
          },
          touchGate: () => ({
            ...unusedGitHub,
            merge: () => {
              merged.push("touch-gate");
              return Promise.resolve("Merged");
            },
          }),
        });

        await harness.run([
          "L",
          () => asking.promise,
          "\x1b",
          async () => {
            method.resolve("squash");
            await method.promise;
          },
        ]);

        expect(merged).toEqual([]);
        expect(harness.writes.join("")).not.toContain("Merging");
      });

      it("says why it cannot land when GitHub cannot say how the repository merges", async () => {
        const harness = pagerHarness(() => fakeIo().io, {
          git: viewerGit({ "cf-view.pullRequestTool": "api" }, UPSTREAM),
          pullRequestList: () => Promise.resolve("octo/repo\tfeature\t7\n"),
          github: {
            ...unusedGitHub,
            mergeMethod: () => Promise.reject(new Error("there is no token")),
          },
        });
        const answered = harness.frame((text) => text.includes("Cannot land"));

        await harness.run(["L", () => answered]);

        expect(harness.writes.join("")).toContain(
          "Cannot land: there is no token",
        );
      });

      it("merges nothing when the land dialog is cancelled", async () => {
        const harness = pagerHarness(() => fakeIo().io, {
          git: viewerGit({ "cf-view.pullRequestTool": "api" }, UPSTREAM),
          pullRequestList: () => Promise.resolve("octo/repo\tfeature\t7\n"),
        });
        const asking = harness.frame((text) =>
          text.includes("Squash and merge pull request 7")
        );

        await harness.run(["L", () => asking, "\x1b"]);

        expect(harness.writes.at(-2)).not.toContain("and merge pull request");
        expect(harness.writes.join("")).not.toContain("Merging");
      });

      it("says why it cannot land off a branch, without origin on GitHub, or with nothing checked out", async () => {
        const cases = [
          [
            { "symbolic-ref --quiet HEAD": null },
            "this checkout is not on a branch",
          ],
          [
            { "remote get-url --push origin": null },
            "origin is not a GitHub repository",
          ],
          [
            { "rev-parse --verify --quiet HEAD": null },
            "nothing is checked out",
          ],
        ] as const;
        for (const [answers, reason] of cases) {
          const harness = pagerHarness(() => fakeIo().io, {
            git: viewerGit(
              { "cf-view.pullRequestTool": "api" },
              { ...UPSTREAM, ...answers },
            ),
            pullRequestList: () => Promise.resolve("octo/repo\tfeature\t7\n"),
          });
          const answered = harness.frame((text) =>
            text.includes("Cannot land")
          );

          await harness.run(["L", () => answered]);

          expect(harness.writes.join("")).toContain(`Cannot land: ${reason}`);
        }
      });
    });

    describe("the settings dialog", () => {
      it("shows the settings git's configuration holds, and saves what OK shows", async () => {
        const config: Record<string, string> = {
          "cf-view.webhookRelay": RELAY,
        };
        const harness = pagerHarness(() => fakeIo().io, {
          git: viewerGit(config),
        });
        const shown = harness.frame((text) => text.includes(" Settings "));

        await harness.run(["O", () => shown, "q", "\r"]);

        expect(config).toEqual({
          "cf-view.webhookRelay": RELAY,
          "cf-view.quitOnPullRequest": "true",
        });
        expect(harness.writes.at(-2)).toContain("Settings saved.");
      });

      it("says so when git fails as the settings dialog opens", async () => {
        const harness = pagerHarness(() => fakeIo().io, {
          git: () => {
            throw new Error("git is gone");
          },
        });

        await harness.run(["O"]);

        expect(harness.writes.at(-2)).toContain("Git failed: git is gone");
      });

      it("says so when git cannot save the settings", async () => {
        const harness = pagerHarness(() => fakeIo().io, { git: () => null });
        const shown = harness.frame((text) => text.includes(" Settings "));

        await harness.run(["O", () => shown, "q", "\r"]);

        expect(harness.writes.at(-2)).toContain(
          "Git could not save the settings.",
        );
      });
    });
  });
});
