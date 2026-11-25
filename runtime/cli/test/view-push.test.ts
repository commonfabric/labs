import { join } from "@std/path";
import { expect } from "@std/expect";

import { sgr, stripAnsi, term } from "../lib/view/ansi.ts";
import type { EditableSource } from "../lib/view/editsource.ts";
import {
  type CreateRequest,
  type GitHubApi,
  GitHubRefusal,
  type MergeRequest,
} from "../lib/view/github.ts";
import { type PagerDeps, runPager } from "../lib/view/pager.ts";
import {
  describePush,
  offeredPullRequestUrl,
  pushBranch,
  type PushedBranch,
  pushedBranch,
  type PushIo,
  pushRefused,
  realPushIo,
  relayText,
  settleBoth,
} from "../lib/view/push.ts";
import { realFileGateway } from "../lib/view/filegateway.ts";
import { dialogBox } from "../lib/view/render.ts";
import { Session } from "../lib/view/session.ts";
import { ui } from "../lib/view/theme.ts";
import {
  type BeginStep,
  link,
  plainText,
  quote,
  say,
  words,
} from "../lib/view/tasklog.ts";
import {
  cellOf,
  drawnRows,
  fakeRelay,
  frameRows,
  mergedPayload,
  mouseKey,
  parseDocument,
  pullRequestPayload,
  relayFrame,
} from "./view-helpers.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** The question that asks `origin`'s server which branch is its default. */
const ASK_ORIGIN_DEFAULT = "ls-remote --symref origin HEAD";

/** The step that asks `origin`'s server which branch is its default. */
const ASKED_ORIGIN = "Asking origin which branch is its default";

/** What `git ls-remote --symref` prints for a repository whose default
 * branch is `branch`. */
function symrefListing(branch: string): string {
  return `ref: refs/heads/${branch}\tHEAD\n0123456789abcdef\tHEAD\n`;
}

/** Query answers for a checkout of `feature` whose `origin` and `upstream`
 * have `main` as their default branch, on their servers and, for `origin`, as
 * git cached it on cloning. */
const FEATURE_CHECKOUT: Readonly<Record<string, string | null>> = {
  "rev-parse --absolute-git-dir": "/work/.git\n",
  "symbolic-ref --quiet HEAD": "refs/heads/feature\n",
  "symbolic-ref --quiet refs/remotes/origin/HEAD": "refs/remotes/origin/main\n",
  [ASK_ORIGIN_DEFAULT]: symrefListing("main"),
  "ls-remote --symref upstream HEAD": symrefListing("main"),
};

const PUSH_FEATURE = "push --force-with-lease --force-if-includes --progress " +
  "origin HEAD:refs/heads/feature";

/** The query that counts the commits on each side of `origin`'s `feature`
 * and the checkout. */
const COUNT_FEATURE =
  "rev-list --left-right --count refs/remotes/origin/feature...HEAD";

/** Query answers for a checkout of `feature` that `origin` has at
 * `0123456789abcdef`, with a commit the checkout lacks, and lacking two of
 * the checkout's. */
const FEATURE_PUSHED: Readonly<Record<string, string | null>> = {
  "rev-parse --verify --quiet refs/remotes/origin/feature":
    "0123456789abcdef\n",
  [COUNT_FEATURE]: "1\t2\n",
};

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

/** A push's operations against a scripted repository, and what it did:
 * `shown` holds what it wrote, and each step it began, as plain text ending
 * in three dots, and `done` each step it showed was done. */
function fakeIo(options: FakeIoOptions = {}) {
  const answers = { ...FEATURE_CHECKOUT, ...options.answers };
  const ran: string[] = [];
  const opened: string[] = [];
  const shown: string[] = [];
  const done: string[] = [];
  const io: PushIo = {
    query: (args) => answers[args.join(" ")] ?? null,
    queryAsync: (args) => {
      const answer = answers[args.join(" ")] ?? null;
      if (answer === null) shown.push(`fatal: no answer to git ${args[0]}\n`);
      return Promise.resolve(answer);
    },
    run: (args) => {
      ran.push(args.join(" "));
      return Promise.resolve({
        success: options.pushSucceeds ?? true,
        output: options.pushOutput ?? "",
      });
    },
    write: (text) => shown.push(text),
    step: (text) => {
      shown.push(`${plainText(text)}...`);
      return () => done.push(plainText(text));
    },
    pagedGitDir: () => options.pagedGitDir ?? null,
    open: (url) => {
      opened.push(url);
      return options.opens ?? true;
    },
  };
  return { io, ran, opened, shown, done };
}

/** `io`, with `controller` aborting as its push starts. */
function abortingPush(io: PushIo, controller: AbortController): PushIo {
  return {
    ...io,
    run: (args) => {
      controller.abort();
      return io.run(args);
    },
  };
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

/** The step the push dialog shows while git pushes `feature` to `origin`,
 * which it draws just before git starts. */
const PUSHING = "Pushing feature to origin...";

/** How a push of `feature` to `origin` that succeeded ends. */
const PUSHED = say`Pushed ${"feature"} to ${"origin"}.`;

/** Shows no step. */
const NO_STEP: BeginStep = () => () => {};

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
 * process signal handlers the pager adds, `exits` the codes it exits
 * with, `timers` how long each timer it set was for, `cancelled` how long
 * each it cancelled before it ran was for, and `spinners` each frame of the
 * spinner it set a timer for, and whether it cancelled it. Each timer runs
 * as soon as the code that set it yields, unless `holdTimers` holds them
 * until `releaseTimers()` runs them. A spinner's timer is always held, so
 * that a step left running does not turn its spinner forever.
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
    holdTimers = false,
  }:
    & Partial<
      Pick<
        PagerDeps,
        "git" | "relay" | "open" | "github" | "touchGate" | "pullRequestList"
      >
    >
    & {
      readonly source?: EditableSource;
      readonly holdTimers?: boolean;
    } = {},
) {
  const writes: string[] = [];
  const watchers: Array<{ test: (text: string) => boolean; done: () => void }> =
    [];
  const signals: AbortSignal[] = [];
  const handlers = new Map<Deno.Signal, () => void>();
  const exits: number[] = [];
  const timers: number[] = [];
  const cancelled: number[] = [];
  const spinners: Array<{ cancelled: boolean }> = [];
  const held: Array<() => void> = [];
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
      setTimer: (handler, ms) => {
        timers.push(ms);
        let live = true;
        const fire = () => {
          if (live) handler();
        };
        if (holdTimers) held.push(fire);
        else queueMicrotask(fire);
        return () => {
          if (live) cancelled.push(ms);
          live = false;
        };
      },
      setSpinnerTimer: (handler) => {
        const spinner = { cancelled: false };
        spinners.push(spinner);
        held.push(() => {
          if (!spinner.cancelled) handler();
        });
        return () => {
          spinner.cancelled = true;
        };
      },
      delay: () => Promise.resolve(),
      onGrammarLoad: () => () => {},
      pushIo: ({ write, step }, signal) => {
        signals.push(signal);
        const io = pushIo(signal);
        return {
          ...io,
          write,
          step,
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
      files: realFileGateway(),
      parseInBackground: () => {
        throw new Error("these tests parse nothing in the background");
      },
    };
    await runPager(
      parseDocument("const a = 1;\n"),
      { color: false, showLineNumbers: false },
      undefined,
      source,
      deps,
    );
  };
  /** Runs each timer held so far that has not been cancelled. */
  const releaseTimers = () => {
    for (const fire of held.splice(0)) fire();
  };
  return {
    run,
    frame,
    writes,
    signals,
    handlers,
    exits,
    timers,
    cancelled,
    spinners,
    releaseTimers,
  };
}

describe("view-push", () => {
  describe("pushBranch()", () => {
    it("force-pushes the checked-out branch to origin as it stands", async () => {
      const { io, ran, opened } = fakeIo();

      expect(plainText(await pushBranch(io))).toBe("Pushed feature to origin.");
      expect(ran).toEqual([PUSH_FEATURE]);
      expect(opened).toEqual([]);
    });

    it("says which branch it pushes where before git starts", async () => {
      const { io, shown } = fakeIo();
      let shownWhenRun: string[] = [];

      await pushBranch({
        ...io,
        run: (args) => {
          shownWhenRun = [...shown];
          return io.run(args);
        },
      });

      expect(shownWhenRun).toEqual([
        `${ASKED_ORIGIN}...`,
        "Pushing feature to origin...",
      ]);
    });

    it("shows the step that pushes done once git succeeds, and only then", async () => {
      for (const pushSucceeds of [true, false]) {
        const { io, done } = fakeIo({ pushSucceeds });
        let doneWhenRun: string[] = [];

        await pushBranch({
          ...io,
          run: (args) => {
            doneWhenRun = [...done];
            return io.run(args);
          },
        });

        expect(doneWhenRun).toEqual([ASKED_ORIGIN]);
        expect(done).toEqual(
          pushSucceeds
            ? [ASKED_ORIGIN, "Pushing feature to origin"]
            : [ASKED_ORIGIN],
        );
      }
    });

    it("hands what git printed to its failure callback when the push fails or is aborted", async () => {
      for (const abort of [false, true]) {
        const handed: Array<[string, string | undefined]> = [];
        const failed = (output: string, main?: string) => {
          handed.push([output, main]);
        };
        const controller = new AbortController();
        const { io } = fakeIo({
          pushSucceeds: false,
          pushOutput: "fatal: no network",
          answers: { [ASK_ORIGIN_DEFAULT]: symrefListing("trunk") },
        });

        const summary = await pushBranch(
          abort ? abortingPush(io, controller) : io,
          controller.signal,
          undefined,
          failed,
        );

        expect(plainText(summary)).toBe(
          abort ? "Push aborted." : "Pushing feature to origin failed.",
        );
        expect(handed).toEqual([["fatal: no network", "trunk"]]);
      }
    });

    it("hands what follows the push to its callback, with no page when the server offers none, and appends what it says", async () => {
      const handed: Array<[string, string | null]> = [];
      const then = (branch: string, url: string | null) => {
        handed.push([branch, url]);
        return url === null ? [] : say`Then this.`;
      };

      expect(plainText(await pushBranch(fakeIo().io, undefined, then))).toBe(
        "Pushed feature to origin.",
      );
      expect(
        plainText(
          await pushBranch(
            fakeIo({ pushOutput: GITHUB_OFFER }).io,
            undefined,
            then,
          ),
        ),
      ).toBe("Pushed feature to origin. Then this.");
      expect(handed).toEqual([
        ["feature", null],
        ["feature", "https://github.com/fork/repo/pull/new/feature"],
      ]);
    });

    it("opens the pull request page the server offers", async () => {
      const { io, opened } = fakeIo({ pushOutput: GITHUB_OFFER });

      expect(plainText(await pushBranch(io))).toBe(
        "Pushed feature to origin. Opened " +
          "https://github.com/fork/repo/pull/new/feature",
      );
      expect(opened).toEqual(["https://github.com/fork/repo/pull/new/feature"]);
    });

    it("returns the offered page's address when the browser cannot open", async () => {
      const { io } = fakeIo({ pushOutput: GITHUB_OFFER, opens: false });

      expect(plainText(await pushBranch(io))).toBe(
        "Pushed feature to origin. Create a pull request at " +
          "https://github.com/fork/repo/pull/new/feature",
      );
    });

    it("says the push was aborted when it failed after its signal aborted", async () => {
      const controller = new AbortController();
      const { io, ran } = fakeIo({ pushSucceeds: false });

      expect(
        plainText(
          await pushBranch(abortingPush(io, controller), controller.signal),
        ),
      ).toBe("Push aborted.");
      expect(ran).toEqual([PUSH_FEATURE]);
    });

    it("says the branch was pushed when the push succeeded although its signal aborted", async () => {
      const controller = new AbortController();
      const { io } = fakeIo();

      expect(
        plainText(
          await pushBranch(abortingPush(io, controller), controller.signal),
        ),
      ).toBe("Pushed feature to origin.");
    });

    it("reports a failed push and opens nothing", async () => {
      const { io, opened } = fakeIo({
        pushSucceeds: false,
        pushOutput: GITHUB_OFFER,
      });

      expect(plainText(await pushBranch(io))).toBe(
        "Pushing feature to origin failed.",
      );
      expect(opened).toEqual([]);
    });

    it("runs nothing outside a git repository", async () => {
      const { io, ran } = fakeIo({
        answers: { "rev-parse --absolute-git-dir": null },
      });

      expect(plainText(await pushBranch(io))).toBe(
        "This is not a git repository.",
      );
      expect(ran).toEqual([]);
    });

    it("runs nothing when git is paging output for another repository", async () => {
      const { io, ran } = fakeIo({ pagedGitDir: "/elsewhere/.git" });

      expect(plainText(await pushBranch(io))).toBe(
        "Not pushing: git is paging output for /elsewhere/.git, but the " +
          "viewer is running in /work/.git.",
      );
      expect(ran).toEqual([]);
    });

    it("pushes when git is paging output for the same repository", async () => {
      const { io } = fakeIo({ pagedGitDir: "/work/.git" });

      expect(plainText(await pushBranch(io))).toBe("Pushed feature to origin.");
    });

    it("runs nothing on a detached checkout", async () => {
      const { io, ran } = fakeIo({
        answers: { "symbolic-ref --quiet HEAD": null },
      });

      expect(plainText(await pushBranch(io))).toBe(
        "This checkout is not on a branch. Check out or create a branch first.",
      );
      expect(ran).toEqual([]);
    });

    it("runs nothing on the branch origin's server names as its default, whatever git cached on cloning", async () => {
      const { io, ran } = fakeIo({
        answers: {
          "symbolic-ref --quiet HEAD": "refs/heads/trunk\n",
          [ASK_ORIGIN_DEFAULT]: symrefListing("trunk"),
        },
      });

      expect(plainText(await pushBranch(io))).toBe(
        "Rename the branch first. You were about to push your trunk branch.",
      );
      expect(ran).toEqual([]);
    });

    it("pushes the branch git cached as origin's default once origin's server names another", async () => {
      const { io, ran } = fakeIo({
        answers: {
          "symbolic-ref --quiet HEAD": "refs/heads/main\n",
          [ASK_ORIGIN_DEFAULT]: symrefListing("trunk"),
        },
      });

      expect(plainText(await pushBranch(io))).toBe("Pushed main to origin.");
      expect(ran).toEqual([
        "push --force-with-lease --force-if-includes --progress " +
        "origin HEAD:refs/heads/main",
      ]);
    });

    it("runs nothing when origin's server names no default branch, even when git cached one", async () => {
      const { io, ran } = fakeIo({
        answers: { [ASK_ORIGIN_DEFAULT]: "0123456789abcdef\tHEAD\n" },
      });

      expect(plainText(await pushBranch(io))).toBe(
        "Not pushing: origin's default branch is unknown.",
      );
      expect(ran).toEqual([]);
    });

    it("runs nothing, showing what git printed, leaving the step that asks unfinished, and calling `onFailed` with nothing, when git cannot ask origin's server", async () => {
      const { io, ran, shown, done } = fakeIo({
        answers: { [ASK_ORIGIN_DEFAULT]: null },
      });
      const handed: string[] = [];

      expect(
        plainText(
          await pushBranch(io, undefined, undefined, (o) => handed.push(o)),
        ),
      ).toBe(
        "Not pushing: origin's default branch is unknown.",
      );
      expect(shown).toEqual([
        `${ASKED_ORIGIN}...`,
        "fatal: no answer to git ls-remote\n",
      ]);
      expect(done).toEqual([]);
      expect(handed).toEqual([""]);
      expect(ran).toEqual([]);
    });

    it("says the push was aborted, running nothing, calling `onFailed` with nothing and not calling `ask`, when an abort follows origin's answer", async () => {
      const controller = new AbortController();
      const { io, ran } = fakeIo({ answers: FEATURE_PUSHED });
      const handed: string[] = [];
      let asks = 0;

      const summary = await pushBranch(
        {
          ...io,
          queryAsync: (args) => {
            controller.abort();
            return io.queryAsync(args);
          },
        },
        controller.signal,
        undefined,
        (output) => handed.push(output),
        () => Promise.resolve(() => say`asked ${String(++asks)}`),
      );

      expect(plainText(summary)).toBe("Push aborted.");
      expect(asks).toBe(0);
      expect(handed).toEqual([""]);
      expect(ran).toEqual([]);
    });

    it("says the push was aborted, running nothing, when asking origin's server stops for an abort", async () => {
      const { io, ran } = fakeIo({ answers: { [ASK_ORIGIN_DEFAULT]: null } });

      expect(plainText(await pushBranch(io, AbortSignal.abort()))).toBe(
        "Push aborted.",
      );
      expect(ran).toEqual([]);
    });

    it("returns what `ask` returns, given how origin's branch stands and origin's default branch, and runs nothing, when origin already has the branch", async () => {
      const { io, ran, shown } = fakeIo({
        answers: {
          ...FEATURE_PUSHED,
          [ASK_ORIGIN_DEFAULT]: symrefListing("trunk"),
        },
      });
      const asked: Array<[string, PushedBranch, string]> = [];

      const summary = await pushBranch(
        io,
        undefined,
        undefined,
        undefined,
        (branch, pushed) =>
          Promise.resolve((main: string) => {
            asked.push([branch, pushed, main]);
            return "asked";
          }),
      );

      expect(summary).toBe("asked");
      expect(asked).toEqual([
        ["feature", {
          commit: "0123456789abcdef",
          counts: { removed: 1, added: 2 },
        }, "trunk"],
      ]);
      expect(ran).toEqual([]);
      expect(shown).toEqual([`${ASKED_ORIGIN}...`]);
    });

    it("refuses the branch origin names as its default without calling `ask`, even when origin has it", async () => {
      const { io, ran } = fakeIo({
        answers: {
          "symbolic-ref --quiet HEAD": "refs/heads/main\n",
          "rev-parse --verify --quiet refs/remotes/origin/main":
            "0123456789abcdef\n",
          "rev-list --left-right --count refs/remotes/origin/main...HEAD":
            "0\t1\n",
        },
      });
      let asks = 0;

      const summary = await pushBranch(
        io,
        undefined,
        undefined,
        undefined,
        () => Promise.resolve(() => say`asked ${String(++asks)}`),
      );

      expect(plainText(summary)).toBe(
        "Rename the branch first. You were about to push your main branch.",
      );
      expect(asks).toBe(0);
      expect(ran).toEqual([]);
    });

    it("refuses the default branch it is given without preparing to ask, preparing for any other branch origin has", async () => {
      for (const branch of ["trunk", "feature"]) {
        const prepared: string[] = [];
        const { io, ran } = fakeIo({
          answers: {
            "symbolic-ref --quiet HEAD": `refs/heads/${branch}\n`,
            [`rev-parse --verify --quiet refs/remotes/origin/${branch}`]:
              "0123456789abcdef\n",
            [`rev-list --left-right --count refs/remotes/origin/${branch}...HEAD`]:
              "0\t1\n",
          },
        });

        const summary = await pushBranch(
          io,
          undefined,
          undefined,
          undefined,
          (name) => {
            prepared.push(name);
            return Promise.resolve(() => say`asked`);
          },
          "trunk",
        );

        expect(plainText(summary)).toBe(
          branch === "trunk"
            ? "Rename the branch first. You were about to push your trunk branch."
            : "asked",
        );
        expect(prepared).toEqual(branch === "trunk" ? [] : ["feature"]);
        expect(ran).toEqual([]);
      }
    });

    it("keeps to the default branch it is given, asking origin's server nothing", async () => {
      for (const branch of ["main", "trunk"]) {
        const asked: string[] = [];
        const { io, ran, shown } = fakeIo({
          answers: { "symbolic-ref --quiet HEAD": `refs/heads/${branch}\n` },
        });

        const summary = await pushBranch(
          {
            ...io,
            queryAsync: (args) => {
              asked.push(args.join(" "));
              return io.queryAsync(args);
            },
          },
          undefined,
          undefined,
          undefined,
          undefined,
          "trunk",
        );

        expect(asked).toEqual([]);
        expect(shown).not.toContain(`${ASKED_ORIGIN}...`);
        expect(plainText(summary)).toBe(
          branch === "trunk"
            ? "Rename the branch first. You were about to push your trunk branch."
            : "Pushed main to origin.",
        );
        expect(ran).toHaveLength(branch === "trunk" ? 0 : 1);
      }
    });

    it("asks origin's server which branch is its default once, before pushing or refusing to", async () => {
      for (const branch of ["feature", "main"]) {
        const asked: string[] = [];
        const { io, ran } = fakeIo({
          answers: { "symbolic-ref --quiet HEAD": `refs/heads/${branch}` },
        });

        const summary = await pushBranch({
          ...io,
          queryAsync: (args) => {
            asked.push(args.join(" "));
            return io.queryAsync(args);
          },
        });

        expect(asked).toEqual([ASK_ORIGIN_DEFAULT]);
        expect(plainText(summary)).toBe(
          branch === "main"
            ? "Rename the branch first. You were about to push your main branch."
            : "Pushed feature to origin.",
        );
        expect(ran).toHaveLength(branch === "main" ? 0 : 1);
      }
    });

    it("asks origin's server which branch is its default while it prepares to ask, before the server answers", async () => {
      const { io, ran } = fakeIo({ answers: FEATURE_PUSHED });
      let asked = false;
      let answered = false;
      let answeredWhenPrepared: boolean | undefined;
      let askedWhilePreparing: boolean | undefined;

      const summary = await pushBranch(
        {
          ...io,
          queryAsync: async (args) => {
            asked = true;
            const answer = await io.queryAsync(args);
            answered = true;
            return answer;
          },
        },
        undefined,
        undefined,
        undefined,
        () => {
          answeredWhenPrepared = answered;
          return Promise.resolve().then(() => {
            askedWhilePreparing = asked;
            return (main: string) => `asked about ${main}`;
          });
        },
      );

      expect(answeredWhenPrepared).toBe(false);
      expect(askedWhilePreparing).toBe(true);
      expect(answered).toBe(true);
      expect(summary).toBe("asked about main");
      expect(ran).toEqual([]);
    });

    it("pushes without asking when origin does not have the branch, or there is no `ask`", async () => {
      const cases: ReadonlyArray<
        readonly [Readonly<Record<string, string | null>>, boolean]
      > = [[{}, true], [FEATURE_PUSHED, false]];
      for (const [answers, ask] of cases) {
        const { io, ran } = fakeIo({ answers });
        const asked: string[] = [];

        const summary = await pushBranch(
          io,
          undefined,
          undefined,
          undefined,
          ask
            ? (branch) => Promise.resolve(() => String(asked.push(branch)))
            : undefined,
        );

        expect(summary).toEqual(say`Pushed ${"feature"} to ${"origin"}.`);
        expect(asked).toEqual([]);
        expect(ran).toEqual([PUSH_FEATURE]);
      }
    });
  });

  describe("settleBoth()", () => {
    it("resolves with what each resolves with, in order", async () => {
      expect(await settleBoth(Promise.resolve(1), "two")).toEqual([1, "two"]);
    });

    it("rejects with the first rejection, in order, whichever rejects first", async () => {
      const second = Promise.reject(new Error("second"));
      second.catch(() => {});

      await expect(
        settleBoth(Promise.reject(new Error("first")), second),
      ).rejects.toThrow("first");
      await expect(settleBoth(Promise.resolve(1), second)).rejects.toThrow(
        "second",
      );
    });

    it("rejects only once the other has settled", async () => {
      const events: string[] = [];
      const second = deferred<string>();
      const both = settleBoth(
        Promise.reject(new Error("first")),
        second.promise,
      )
        .catch((error) => events.push(`rejected: ${error.message}`));

      // A rejection that does not wait for the second would land within
      // these turns of the microtask queue.
      for (let turn = 0; turn < 10; turn++) await null;
      events.push("second settles");
      second.resolve("second");
      await both;

      expect(events).toEqual(["second settles", "rejected: first"]);
    });
  });

  describe("pushedBranch()", () => {
    it("returns the commit origin's branch is at, and how many commits each side has that the other does not", () => {
      const query = fakeIo({ answers: FEATURE_PUSHED }).io.query;

      expect(pushedBranch(query, "feature")).toEqual({
        commit: "0123456789abcdef",
        counts: { removed: 1, added: 2 },
      });
    });

    it("returns no counts when the checkout's history is shallow", () => {
      const query = fakeIo({
        answers: {
          ...FEATURE_PUSHED,
          "rev-parse --is-shallow-repository": "true\n",
        },
      }).io.query;

      expect(pushedBranch(query, "feature")).toEqual({
        commit: "0123456789abcdef",
        counts: null,
      });
    });

    it("returns null when git has never seen origin have the branch", () => {
      expect(pushedBranch(fakeIo().io.query, "feature")).toBeNull();
    });

    it("throws when git cannot compare the branch with origin's", () => {
      const query = fakeIo({
        answers: { ...FEATURE_PUSHED, [COUNT_FEATURE]: null },
      }).io.query;

      expect(() => pushedBranch(query, "feature")).toThrow(
        "git could not compare feature with origin's",
      );
    });
  });

  describe("describePush()", () => {
    it("says which commit origin's branch is at, and that pushing would add the commits it lacks", () => {
      expect(
        plainText(describePush("feature", {
          commit: "0123456789abcdef",
          counts: { removed: 0, added: 2 },
        })),
      ).toBe(
        "origin already has feature, at 0123456789ab when last fetched or " +
          "pushed. Pushing would add 2 commits to it.",
      );
    });

    it("says that pushing would replace a branch that has commits the checkout does not, and what it would add", () => {
      const said = (removed: number, added: number) =>
        plainText(describePush("feature", {
          commit: "c0ffee",
          counts: { removed, added },
        })).split("pushed. ")[1];

      expect(said(1, 0)).toBe(
        "Pushing would replace it, removing 1 commit that this checkout " +
          "does not have.",
      );
      expect(said(3, 1)).toBe(
        "Pushing would replace it, removing 3 commits that this checkout " +
          "does not have and adding 1 commit.",
      );
    });

    it("marks the remote, the branch, the commit, and the counts as names", () => {
      const said = describePush("feature", {
        commit: "0123456789abcdef",
        counts: { removed: 1, added: 2 },
      });

      expect(
        said.filter((span) => span.tone === "name").map((span) => span.text),
      ).toEqual(["origin", "feature", "0123456789ab", "1", "2"]);
    });

    it("says that pushing would leave a branch at the checked-out commit as it is", () => {
      expect(
        plainText(describePush("feature", {
          commit: "c0ffee",
          counts: { removed: 0, added: 0 },
        })),
      ).toBe(
        "origin already has feature, at c0ffee when last fetched or pushed." +
          " Pushing would leave it as it is.",
      );
    });

    it("says that the commits cannot be counted when the checkout's history is shallow", () => {
      expect(
        plainText(describePush("feature", { commit: "c0ffee", counts: null })),
      ).toBe(
        "origin already has feature, at c0ffee when last fetched or pushed." +
          " This checkout's history is shallow, so the commits pushing " +
          "would add or remove cannot be counted.",
      );
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

  describe("pushRefused()", () => {
    it("returns true when git says the server, or git itself, rejected the update", () => {
      expect(pushRefused(
        "To github.com:fork/repo.git\n" +
          " ! [rejected]        HEAD -> feature (stale info)\n" +
          "error: failed to push some refs\n",
      )).toBe(true);
      expect(pushRefused(
        " ! [remote rejected] HEAD -> feature (pre-receive hook declined)\n",
      )).toBe(true);
    });

    it("returns true when GitHub denies the account permission to push, over HTTPS or SSH", () => {
      expect(pushRefused(
        "remote: Permission to octo/repo.git denied to someone.\n" +
          "fatal: unable to access 'https://github.com/octo/repo.git/': " +
          "The requested URL returned error: 403\n",
      )).toBe(true);
      expect(pushRefused(
        "ERROR: Permission to octo/repo.git denied to someone.\n" +
          "fatal: Could not read from remote repository.\n",
      )).toBe(true);
      expect(pushRefused("remote: Permission to push is checked here.\n"))
        .toBe(false);
    });

    it("returns false when git could not reach the server or finish", () => {
      for (
        const output of [
          "ssh: Could not resolve hostname github.com: nodename nor servname " +
          "provided, or not known\nfatal: Could not read from remote " +
          "repository.\n",
          "error: RPC failed; curl 56 Recv failure: Connection reset by peer\n" +
          "fatal: the remote end hung up unexpectedly\n",
          "",
        ]
      ) {
        expect(pushRefused(output)).toBe(false);
      }
    });
  });

  describe("realPushIo()", () => {
    it("starts no git once its signal has aborted", async () => {
      const { root, env, origin, work } = repositories();
      try {
        const written: string[] = [];
        const io = realPushIo({
          step: NO_STEP,
          cwd: work,
          env,
          signal: AbortSignal.abort(),
          write: (text) => written.push(text),
        });

        expect(await io.run(["push", "origin", "HEAD:refs/heads/feature"]))
          .toEqual({ success: false, output: "" });
        expect(await io.queryAsync(["ls-remote", "origin"])).toBeNull();
        expect(git(origin, env, "branch", "--list", "feature")).toBe("");
        expect(io.query(["--version"])).toMatch(/^git version /);
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("resolves `queryAsync` with git's output, showing nothing, or with null, showing git's error output, when git fails", async () => {
      const { root, env, work } = repositories();
      try {
        const written: string[] = [];
        const io = realPushIo({
          step: NO_STEP,
          cwd: work,
          env,
          write: (text) => written.push(text),
        });

        expect(
          await io.queryAsync(["ls-remote", "--symref", "origin", "HEAD"]),
        ).toMatch(/^ref: refs\/heads\/main\tHEAD\n[0-9a-f]+\tHEAD\n$/);
        expect(written).toEqual([]);
        expect(await io.queryAsync(["ls-remote", "nowhere"])).toBeNull();
        expect(written.join("")).toMatch(
          /^fatal: 'nowhere' does not appear to be a git repository\n/,
        );
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

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
        const steps: string[] = [];

        const summary = await pushBranch(
          realPushIo({
            step: (text) => {
              steps.push(`${plainText(text)}...`);
              return () => steps.push(`${plainText(text)} ✓`);
            },
            cwd: work,
            env,
            opener,
            write: (text) => written.push(text),
          }),
        );

        expect(steps).toEqual([
          `${ASKED_ORIGIN}...`,
          `${ASKED_ORIGIN} ✓`,
          "Pushing feature to origin...",
          "Pushing feature to origin ✓",
        ]);
        expect(plainText(summary)).toBe(
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

    it("asks once origin has the branch, counting the commits a rewrite removes and adds", async () => {
      const { root, env, work } = repositories();
      try {
        const io = realPushIo({
          step: NO_STEP,
          cwd: work,
          env,
          write: () => {},
        });
        const push = () =>
          pushBranch(
            io,
            undefined,
            () => [],
            undefined,
            (_, pushed) => Promise.resolve(() => pushed),
          );

        expect(await push()).toEqual(say`Pushed ${"feature"} to ${"origin"}.`);
        const pushedCommit = git(work, env, "rev-parse", "HEAD");
        expect(await push()).toEqual({
          commit: pushedCommit,
          counts: { removed: 0, added: 0 },
        });
        git(work, env, "commit", "--quiet", "--amend", "-m", "Amended");
        git(work, env, "commit", "--quiet", "--allow-empty", "-m", "More");

        expect(await push()).toEqual({
          commit: pushedCommit,
          counts: { removed: 1, added: 2 },
        });
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("counts no commits once origin has the branch in a shallow clone", async () => {
      const { root, env, origin, work } = repositories();
      try {
        const io = realPushIo({
          step: NO_STEP,
          cwd: work,
          env,
          write: () => {},
        });
        expect(plainText(await pushBranch(io, undefined, () => []))).toBe(
          "Pushed feature to origin.",
        );
        const shallow = join(root, "shallow");
        git(
          root,
          env,
          "clone",
          "--quiet",
          "--depth",
          "1",
          "--no-single-branch",
          `file://${origin}`,
          shallow,
        );
        git(shallow, env, "switch", "--quiet", "feature");

        expect(
          await pushBranch(
            realPushIo({ step: NO_STEP, cwd: shallow, env, write: () => {} }),
            undefined,
            () => [],
            undefined,
            (_, remote) => Promise.resolve(() => remote),
          ),
        ).toEqual({
          commit: git(work, env, "rev-parse", "HEAD"),
          counts: null,
        });
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("does not overwrite commits on origin that the repository has not fetched", async () => {
      const { root, env, origin, seed, work } = repositories();
      try {
        const io = realPushIo({
          step: NO_STEP,
          cwd: work,
          env,
          opener: "true",
          write() {},
        });
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

        expect(plainText(await pushBranch(io))).toBe(
          "Pushing feature to origin failed.",
        );
        expect(git(origin, env, "rev-parse", "feature")).toBe(theirs);
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("does not overwrite commits on origin that the branch never included, even once fetched", async () => {
      const { root, env, origin, work } = repositories();
      try {
        const io = realPushIo({
          step: NO_STEP,
          cwd: work,
          env,
          opener: "true",
          write() {},
        });
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

        expect(plainText(await pushBranch(io))).toBe(
          "Pushing feature to origin failed.",
        );
        expect(git(origin, env, "rev-parse", "feature")).toBe(theirs);
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("refuses the branch origin's server names as its default once that changes, pushes the one git cached on cloning, and leaves the cache as it was", async () => {
      const { root, env, origin, work } = repositories();
      try {
        const io = realPushIo({
          step: NO_STEP,
          cwd: work,
          env,
          opener: "true",
          write() {},
        });
        const main = git(origin, env, "rev-parse", "main");
        git(origin, env, "branch", "trunk", "main");
        git(origin, env, "symbolic-ref", "HEAD", "refs/heads/trunk");
        git(work, env, "branch", "trunk", "main");
        git(work, env, "switch", "--quiet", "trunk");

        expect(plainText(await pushBranch(io))).toBe(
          "Rename the branch first. You were about to push your trunk branch.",
        );
        git(work, env, "switch", "--quiet", "main");
        Deno.writeTextFileSync(join(work, "more.txt"), "more\n");
        git(work, env, "add", "more.txt");
        git(work, env, "commit", "--quiet", "-m", "more");
        expect(plainText(await pushBranch(io, undefined, () => []))).toBe(
          "Pushed main to origin.",
        );
        expect(git(origin, env, "rev-parse", "main")).toBe(
          git(work, env, "rev-parse", "HEAD"),
        );
        expect(git(origin, env, "rev-parse", "trunk")).toBe(main);
        expect(git(work, env, "symbolic-ref", "refs/remotes/origin/HEAD"))
          .toBe("refs/remotes/origin/main");
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("works on the repository at its directory when git exports another", async () => {
      const { root, env, origin, seed, work } = repositories();
      try {
        const io = realPushIo({
          step: NO_STEP,
          cwd: work,
          env: { ...env, GIT_DIR: join(seed, ".git") },
          opener: "true",
          write: () => {},
        });

        expect(io.query(["rev-parse", "--absolute-git-dir"])?.trim()).toBe(
          join(work, ".git"),
        );
        expect(io.pagedGitDir()).toBe(join(seed, ".git"));
        expect(plainText(await pushBranch(io))).toBe(
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
        realPushIo({ step: NO_STEP, env: PATH_ONLY, write() {} }).query(
          printPromptEnv,
        ),
      ).toBe("0,false,force,");
      expect(
        realPushIo({
          step: NO_STEP,
          env: { ...PATH_ONLY, SSH_ASKPASS: "my-askpass" },
          write() {},
        }).query(printPromptEnv),
      ).toBe("0,my-askpass,force,");
    });

    it("stops a running git when its signal aborts", async () => {
      const controller = new AbortController();
      const io = realPushIo({
        step: NO_STEP,
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
      expect(
        realPushIo({ step: NO_STEP, env: PATH_ONLY, write() {} }).pagedGitDir(),
      )
        .toBeNull();
    });

    it("returns an exported git directory that git cannot resolve as it is", () => {
      const io = realPushIo({
        step: NO_STEP,
        env: { ...PATH_ONLY, GIT_DIR: "/cf-view-no-such-git-dir" },
        write() {},
      });

      expect(io.pagedGitDir()).toBe("/cf-view-no-such-git-dir");
    });

    it("returns false from `open()` when there is no program to open with", () => {
      const io = realPushIo({
        step: NO_STEP,
        opener: "cf-view-no-such-opener",
        write() {},
      });

      expect(io.open("https://example.test/")).toBe(false);
    });

    it("throws from `open()` when the program to open with cannot be started for a reason other than its absence", () => {
      const root = Deno.makeTempDirSync();
      try {
        const opener = join(root, "opener");
        Deno.writeTextFileSync(opener, "#!/bin/sh\n");
        Deno.chmodSync(opener, 0o644);
        const io = realPushIo({ step: NO_STEP, opener, write() {} });

        expect(() => io.open("https://example.test/")).toThrow(
          Deno.errors.PermissionDenied,
        );
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("runs git from the process's own directory and environment by default", async () => {
      const written: string[] = [];
      const io = realPushIo({
        step: NO_STEP,
        write: (text) => written.push(text),
      });

      expect(io.query(["--version"])).toMatch(/^git version /);
      const result = await io.run(["--version"]);
      expect(result.success).toBe(true);
      expect(result.output).toMatch(/^git version /);
      expect(written.join("")).toBe(result.output);
    });
  });

  describe("relayText()", () => {
    const encoder = new TextEncoder();

    it("passes each decoded piece of the stream to its writer", async () => {
      const written: string[] = [];
      const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
          controller.enqueue(encoder.encode("one "));
          controller.enqueue(encoder.encode("two"));
          controller.close();
        },
      });

      await relayText(stream, (text) => written.push(text));

      expect(written.join("")).toBe("one two");
    });

    it("rejects with the stream's own failure", async () => {
      const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
          controller.error(new Error("the pipe broke"));
        },
      });

      await expect(
        relayText(stream, () => {}, new AbortController().signal),
      ).rejects.toThrow("the pipe broke");
    });

    it("resolves with what arrived when its signal aborts", async () => {
      const controller = new AbortController();
      const written: string[] = [];
      // A stream that never ends, as when a process git started holds the pipe.
      const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(stream) {
          stream.enqueue(encoder.encode("started"));
        },
      });

      await relayText(stream, (text) => {
        written.push(text);
        controller.abort();
      }, controller.signal);

      expect(written).toEqual(["started"]);
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
        "  Writing 100%",
        "  To origin",
        "   * [new branch] feature",
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
      expect(dialog.body.length).toBe(22);
      expect(dialog.body.slice(0, 3)).toEqual([
        "  To origin",
        "   * [new branch] feature",
        "",
      ]);
      const box = dialogBox(view, dialog);
      expect([box.boxW, box.boxH]).toEqual([86, 28]);
      expect([box.x, box.y]).toEqual([57, 16]);
    });

    it("breaks an indented word wider than the dialog without leaving an empty row", () => {
      const session = editableSession();
      session.beginTask("Push", () => {});
      const word = "x".repeat(80);

      session.appendTaskOutput(`  ${word}\n`);

      expect(session.view().dialog!.body.slice(0, 3)).toEqual([
        `    ${word.slice(0, 68)}`,
        `  ${word.slice(68)}`,
        "",
      ]);
    });

    it("keeps an address no wider than the dialog on one row", () => {
      const session = editableSession();
      session.resize(200, 60);
      session.beginTask("Push", () => {});
      const url = "https://github.com/commonfabric/labs/pull/new/feature";

      session.appendTaskOutput(`remote:      ${url}\n`);
      session.finishTask(say`${PUSHED} Opened ${link(url)}`);

      expect(session.view().dialog!.body.slice(0, 5)).toEqual([
        `  remote:      ${url}`,
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
        "a-branch-na";
      expect(offer.length).toBe(70);

      session.appendTaskOutput(`${offer}        \nTo origin\n`);

      expect(session.view().dialog!.body.slice(0, 3)).toEqual([
        `  ${offer}`,
        "  To origin",
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
      ).toEqual(["  line 4", "  line 5", "  line 6", "  line 7", "  line 8"]);
    });

    it("wraps a line wider than the dialog after its last space that fits, breaking a word wider than the dialog", () => {
      const session = editableSession();
      session.beginTask("Push", () => {});
      const url = "https://github.com/commonfabric/labs/pull/new/" +
        "a-branch-whose-name-runs-on-and-on";

      session.finishTask(say`${PUSHED} Opened ${link(url)}`);

      expect(session.view().dialog!.body.slice(0, 4)).toEqual([
        "Pushed feature to origin. Opened",
        url.slice(0, 72),
        url.slice(72),
        "",
      ]);
    });

    it("wraps by the columns the characters take, not by how many there are", () => {
      // Forty Han characters take eighty columns, so the first thirty-six
      // fill a row of the dialog's seventy-two. Seventy-two letters with
      // combining accents take seventy-two columns, and so a row of their
      // own, though they are twice as many code points.
      const session = editableSession();
      session.beginTask("Push", () => {});
      const han = "漢".repeat(40);
      const accented = "e\u0301".repeat(72);

      session.finishTask(words(`${han}\n${accented}`));

      expect(session.view().dialog!.body.slice(0, 4)).toEqual([
        han.slice(0, 36),
        han.slice(36),
        accented,
        "",
      ]);
    });

    it("gives a character wider than the dialog a row of its own", () => {
      // The view is nine columns wide, so the dialog's rows are one column
      // wide, too narrow for a Han character.
      const session = editableSession();
      session.resize(9, 24);
      session.beginTask("Push", () => {});

      session.finishTask(say`漢字a`);

      expect(session.view().dialog!.body.slice(0, 3)).toEqual([
        "漢",
        "字",
        "a",
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

      session.finishTask(PUSHED);

      const dialog = session.view().dialog!;
      expect(dialog.buttons.map((b) => b.label)).toEqual(["Close", "Quit"]);
      expect(dialog.body.slice(0, 3).map((line) => line.trimEnd())).toEqual([
        "  To origin",
        "",
        "Pushed feature to origin.",
      ]);
      session.handleKey({ name: "enter" });
      expect(session.view().dialog).toBeNull();
      expect(session.view().message).toBe("Pushed feature to origin.");
      expect(session.quit).toBe(false);
      expect(aborted).toBe(0);
    });

    it("keeps the output and how the last task ended when another task continues the dialog, which then offers Abort to stop it", () => {
      const session = editableSession();
      let aborted = 0;
      session.beginTask("Push", () => {});
      session.appendTaskOutput("To origin\n");
      session.finishTask(
        say`Failed. To retry, press ${"Retry push"}.`,
        "Retry push",
      );

      session.continueTask(() => aborted++);
      session.appendTaskOutput("Pushing again.\n");

      const dialog = session.view().dialog!;
      expect(dialog.title).toBe("Push");
      expect(dialog.buttons.map((b) => b.label)).toEqual(["Abort"]);
      expect(dialog.body.slice(0, 5).map((line) => line.trimEnd())).toEqual([
        "  To origin",
        "",
        "Failed. To retry, press Retry push.",
        "",
        "  Pushing again.",
      ]);
      session.handleKey({ name: "a", char: "a" });
      expect(aborted).toBe(1);
    });

    it("quits on `Q` once the push ends, and not on `q` or while it runs", () => {
      const session = editableSession();
      session.beginTask("Push", () => {});

      session.handleKey({ name: "Q", char: "Q" });
      expect(session.quit).toBe(false);
      expect(session.view().dialog?.title).toBe("Push");

      session.finishTask(PUSHED);
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
      session.finishTask(PUSHED);
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
      session.finishTask(PUSHED);

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
      session.finishTask(PUSHED);
      const close = cellOf(drawnRows(session), "Close");
      const quit = cellOf(drawnRows(session), "Quit");

      session.handleKey(mouseKey(true, close));
      session.handleKey(mouseKey(false, close));
      expect(session.view().dialog).toBeNull();
      expect(session.view().message).toBe("Pushed feature to origin.");
      expect(session.quit).toBe(false);

      session.beginTask("Push", () => {});
      session.finishTask(PUSHED);
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
      session.beginWatchStep(say`Waiting for the pull request to open`);

      expect(session.view().dialog!.body.map((line) => line.trimEnd()))
        .toEqual([
          "  line 6",
          "  line 7",
          "  line 8",
          "",
          "Waiting for the pull request to open... ◐",
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
      session.finishTask(PUSHED);

      session.stopPullRequestWatch(
        say`no webhook relay is set in the settings.`,
      );

      const dialog = session.view().dialog!;
      expect(dialog.body.length).toBe(4);
      expect(dialog.body[0]).not.toBe("");
      expect(drawnRows(session).join("\n")).toContain(" Close ");
    });

    it("gives the address and says it is quitting when the pull request opens while the dialog is up, then closes it and quits, keeping the address to print", () => {
      const session = editableSession();
      session.beginTask("Push", () => {});
      session.finishTask(PUSHED);
      expect(session.exitMessage).toBeNull();
      expect(session.pullRequestQuitPending).toBe(false);

      session.quitForPullRequest(PULL_REQUEST, 2000);

      expect(session.pullRequestQuitPending).toBe(true);
      expect(session.taskDialogUp).toBe(true);
      expect(session.quit).toBe(false);
      const body = session.view().dialog!.body;
      expect(body.filter((row) => row !== "").slice(-2)).toEqual([
        `Pull request: ${PULL_REQUEST}`,
        "Quitting... ◐",
      ]);
      session.completePullRequestQuit();

      expect(session.pullRequestQuitPending).toBe(false);
      expect(session.taskDialogUp).toBe(false);
      expect(session.view().message).toBe("Pushed feature to origin.");
      expect(session.quit).toBe(true);
      expect(session.exitMessage).toBe(PULL_REQUEST);
    });

    it("waits for a push still running to end before quitting for the pull request", () => {
      const session = editableSession();
      session.beginTask("Push", () => {});

      session.quitForPullRequest(PULL_REQUEST, 2000);
      expect(session.pullRequestQuitPending).toBe(false);
      expect(session.view().dialog!.body.join("\n")).not.toContain("Quitting");
      session.finishTask(PUSHED);
      expect(session.pullRequestQuitPending).toBe(true);
      session.completePullRequestQuit();

      expect(session.view().message).toBe("Pushed feature to origin.");
      expect(session.quit).toBe(true);
      expect(session.exitMessage).toBe(PULL_REQUEST);
    });

    it("quits for the pull request at once, without saying it is quitting, when its delay is 16 ms or less, waiting for a push still running to end", () => {
      const ended = editableSession();
      ended.beginTask("Push", () => {});
      ended.finishTask(PUSHED);
      const running = editableSession();
      running.beginTask("Push", () => {});
      const longer = editableSession();
      longer.beginTask("Push", () => {});
      longer.finishTask(PUSHED);

      ended.quitForPullRequest(PULL_REQUEST, 16);
      running.quitForPullRequest(PULL_REQUEST, 5);
      longer.quitForPullRequest(PULL_REQUEST, 17);

      expect(ended.quit).toBe(true);
      expect(ended.exitMessage).toBe(PULL_REQUEST);
      expect(running.quit).toBe(false);
      expect(running.view().dialog!.body.join("\n")).not.toContain("Quitting");
      running.finishTask(PUSHED);
      expect(running.quit).toBe(true);
      expect(running.exitMessage).toBe(PULL_REQUEST);
      expect(longer.quit).toBe(false);
      expect(longer.pullRequestQuitDelay).toBe(17);
      expect(longer.view().dialog!.body.join("\n")).toContain("Quitting");
    });

    it("quits for the pull request, keeping the address to print, when Quit is pressed while the dialog says it is quitting", () => {
      const session = editableSession();
      session.beginTask("Push", () => {});
      session.finishTask(PUSHED);
      session.quitForPullRequest(PULL_REQUEST, 2000);

      session.handleKey({ name: "Q", char: "Q" });

      expect(session.quit).toBe(true);
      expect(session.exitMessage).toBe(PULL_REQUEST);
    });

    it("quits for the pull request, keeping the address to print, when an interrupt arrives while the dialog says it is quitting, by way of the save prompt when there are unsaved edits", () => {
      for (const edited of [false, true]) {
        const session = editableSession();
        if (edited) {
          session.handleKey({ name: "e", char: "e" });
          session.handleKey({ name: "X", char: "X" });
          session.handleKey({ name: "escape" });
        }
        session.beginTask("Push", () => {});
        session.finishTask(PUSHED);
        session.quitForPullRequest(PULL_REQUEST, 2000);

        expect(session.requestQuitFromSignal()).toBe(edited);

        if (edited) {
          expect(session.view().dialog?.title).toBe("Save Changes");
          session.handleKey({ name: "d", char: "d" });
        }
        expect(session.quit).toBe(true);
        expect(session.exitMessage).toBe(PULL_REQUEST);
      }
    });

    it("does not quit for the pull request once Close takes the dialog down while it says it is quitting", () => {
      const session = editableSession();
      session.beginTask("Push", () => {});
      session.finishTask(PUSHED);
      session.quitForPullRequest(PULL_REQUEST, 2000);

      session.handleKey({ name: "c", char: "c" });
      session.completePullRequestQuit();

      expect(session.pullRequestQuitPending).toBe(false);
      expect(session.quit).toBe(false);
    });

    it("does nothing when the pull request opens once the dialog is down", () => {
      const session = editableSession();
      session.beginTask("Push", () => {});
      session.finishTask(PUSHED);
      session.handleKey({ name: "c", char: "c" });

      session.quitForPullRequest(PULL_REQUEST, 2000);

      expect(session.quit).toBe(false);
      session.beginTask("Push", () => {});
      session.finishTask(PUSHED);
      expect(session.quit).toBe(false);
    });

    it("asks to save unsaved edits before the pull request opening quits", () => {
      const session = editableSession();
      session.handleKey({ name: "e", char: "e" });
      session.handleKey({ name: "X", char: "X" });
      session.handleKey({ name: "escape" });
      session.beginTask("Push", () => {});
      session.finishTask(PUSHED);

      session.quitForPullRequest(PULL_REQUEST, 2000);
      session.completePullRequestQuit();

      expect(session.quit).toBe(false);
      expect(session.view().dialog?.title).toBe("Save Changes");
      session.handleKey({ name: "d", char: "d" });
      expect(session.exitMessage).toBe(PULL_REQUEST);
    });

    it("asks at once to save unsaved edits when the pull request opens with a delay of 16 ms or less", () => {
      const session = editableSession();
      session.handleKey({ name: "e", char: "e" });
      session.handleKey({ name: "X", char: "X" });
      session.handleKey({ name: "escape" });
      session.beginTask("Push", () => {});
      session.finishTask(PUSHED);

      session.quitForPullRequest(PULL_REQUEST, 16);

      expect(session.quit).toBe(false);
      expect(session.pullRequestQuitDelay).toBeNull();
      expect(session.view().dialog?.title).toBe("Save Changes");
      session.handleKey({ name: "d", char: "d" });
      expect(session.quit).toBe(true);
      expect(session.exitMessage).toBe(PULL_REQUEST);
    });

    it("prints no address on a later quit once the save prompt the pull request raised is cancelled", () => {
      const session = editableSession();
      session.handleKey({ name: "e", char: "e" });
      session.handleKey({ name: "X", char: "X" });
      session.handleKey({ name: "escape" });
      session.beginTask("Push", () => {});
      session.finishTask(PUSHED);
      session.quitForPullRequest(PULL_REQUEST, 2000);
      session.completePullRequestQuit();

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
      session.finishTask(PUSHED);

      session.handleKey({ name: "Q", char: "Q" });

      expect(session.quit).toBe(false);
      expect(session.view().dialog?.title).toBe("Save Changes");
      session.handleKey({ name: "d", char: "d" });
      expect(session.quit).toBe(true);
    });

    describe("steps", () => {
      /** The rows of the task dialog's body, without the blank rows. */
      const shown = (session: Session) =>
        session.view().dialog!.body.filter((row) => row !== "");

      it("shows a step still running when the task ends, or asks a question, as having ended without being done", () => {
        const finished = editableSession();
        finished.beginTask("Push", () => {});
        finished.beginTaskStep(say`Pushing`);
        finished.finishTask(say`Push aborted.`);
        const asked = editableSession();
        asked.beginTask("Push", () => {});
        asked.beginTaskStep(say`Looking`);
        asked.confirmPush(say`Push?`);

        expect(shown(finished)).toEqual(["Pushing... ✗", "Push aborted."]);
        expect(shown(asked)).toEqual(["Looking... ✗", "Push?"]);
      });

      it("spins only while the dialog is up with a step of the task or of the watch running", () => {
        const session = editableSession();
        expect(session.taskSpinning).toBe(false);
        session.beginTask("Push", () => {});
        expect(session.taskSpinning).toBe(false);

        const pushed = session.beginTaskStep(say`Pushing`);
        expect(session.taskSpinning).toBe(true);
        pushed();
        expect(session.taskSpinning).toBe(false);
        session.finishTask(PUSHED);
        session.beginWatchStep(say`Waiting`);
        expect(session.taskSpinning).toBe(true);
        session.handleKey({ name: "c", char: "c" });

        expect(session.taskSpinning).toBe(false);
      });

      it("turns the spinner of the last running step a frame at a time, showing three dots alone on a running step before it", () => {
        const session = editableSession();
        session.beginTask("Push", () => {});
        session.beginTaskStep(say`Pushing`);
        session.beginWatchStep(say`Waiting`);

        session.advanceSpinner();

        expect(shown(session)).toEqual(["Pushing...", "Waiting... ◓"]);
      });

      it("spins nothing while the last running step waits for a person, even while a step before it runs", () => {
        const session = editableSession();
        session.resize(80, 24);
        session.beginTask("Push", () => {});
        session.beginTaskStep(say`Pushing`);
        const touched = session.beginTaskStep(say`Touch the key`, "person");

        expect(shown(session)).toEqual(["Pushing...", "Touch the key"]);
        expect(session.taskSpinning).toBe(false);
        touched();

        expect(shown(session)).toEqual(["Pushing... ◐", "Touch the key ✓"]);
        expect(session.taskSpinning).toBe(true);
      });

      it("says under how the task ended that it is not watching, and why, ending the watch's running steps", () => {
        const session = editableSession();
        session.resize(80, 24);
        session.beginTask("Push", () => {});
        session.beginWatchStep(say`Connecting`);
        session.finishTask(PUSHED);

        session.stopPullRequestWatch(quote("connection refused"));

        expect(shown(session)).toEqual([
          "Pushed feature to origin.",
          "Connecting... ✗",
          "Not watching for the pull request:",
          "  connection refused",
        ]);
      });

      it("shows the watch's running steps done when it says it is quitting for the pull request", () => {
        const session = editableSession();
        session.resize(80, 24);
        session.beginTask("Push", () => {});
        session.beginWatchStep(say`Waiting for the pull request to open`);
        session.finishTask(PUSHED);

        session.quitForPullRequest(PULL_REQUEST, 2000);

        expect(shown(session)).toEqual([
          "Pushed feature to origin.",
          "Waiting for the pull request to open... ✓",
          `Pull request: ${PULL_REQUEST}`,
          "Quitting... ◐",
        ]);
        expect(session.taskSpinning).toBe(true);
      });

      it("shows the end of its output when it says it is quitting for the pull request, however far it was scrolled back", () => {
        const session = editableSession();
        session.beginTask("Push", () => {});
        session.appendTaskOutput(
          Array.from({ length: 9 }, (_, i) => `line ${i}\n`).join(""),
        );
        session.finishTask(PUSHED);
        session.handleKey({ name: "home" });
        expect(shown(session)).not.toContain("Quitting... ◐");

        session.quitForPullRequest(PULL_REQUEST, 2000);

        expect(shown(session).at(-1)).toBe("Quitting... ◐");
      });

      it("shows the watch's running steps done as soon as the pull request opens, though the task is still running", () => {
        const session = editableSession();
        session.resize(80, 24);
        session.beginTask("Push", () => {});
        session.beginWatchStep(say`Waiting for the pull request to open`);

        session.quitForPullRequest(PULL_REQUEST, 2000);

        expect(shown(session)).toEqual([
          "Waiting for the pull request to open... ✓",
        ]);
        expect(session.taskSpinning).toBe(false);
      });

      it("forgets what the watch said when another task continues the dialog", () => {
        const session = editableSession();
        session.resize(80, 24);
        session.beginTask("Push", () => {});
        session.finishTask(PUSHED);
        session.stopPullRequestWatch(say`the watch was aborted.`);

        session.continueTask(() => {});

        expect(shown(session)).toEqual(["Pushed feature to origin."]);
      });
    });

    describe("tones", () => {
      /** A push dialog drawn with color `color` that shows text another
       * program wrote, the viewer's words with a name in them, and a step
       * running, one done, and one that ended without being done. */
      function toned(color: boolean): string[] {
        const session = new Session(
          parseDocument("const a = 1;\n"),
          { color, showLineNumbers: false },
          { width: 80, height: 24 },
        );
        session.beginTask("Push", () => {});
        session.appendTaskOutput("quoted\n");
        session.beginTaskStep(say`Done step`)();
        session.beginTaskStep(say`Failed step`);
        session.finishTask(say`Pushed ${"feature"}.`);
        session.beginWatchStep(say`Busy step`);
        return drawnRows(session);
      }

      it("draws each piece of the task dialog's text in its tone's style while color is on", () => {
        const drawn = toned(true);
        // The escape that sets the style of `text`, the first time it is
        // drawn after `after`.
        const styleOf = (text: string, after = "") => {
          const row = drawn.find((r) => stripAnsi(r).includes(after + text))!;
          const at = row.indexOf(text, row.indexOf(after) + after.length);
          return row.slice(0, at).split("\x1b[").at(-1)!.split("m")[0];
        };
        const expected = (style: object) =>
          sgr({ ...style, bg: ui.overlayBg }).slice(2, -1);

        expect(styleOf("quoted")).toBe(expected(ui.dialogText));
        expect(styleOf("Pushed")).toBe(expected(ui.dialogEmphasis));
        expect(styleOf("feature")).toBe(expected(ui.dialogName));
        expect(styleOf("✓", "Done step... ")).toBe(expected(ui.dialogDone));
        expect(styleOf("✗", "Failed step... ")).toBe(expected(ui.dialogFailed));
        expect(styleOf("◐", "Busy step... ")).toBe(expected(ui.dialogBusy));
      });

      it("draws the task dialog's text with no style while color is off", () => {
        const drawn = toned(false).join("\n");

        expect(drawn).toContain("Busy step... ◐");
        // Every escape that sets a style only resets it.
        expect(drawn.split("\x1b[").slice(1).map((part) => part.slice(0, 2)))
          .toEqual(drawn.split("\x1b[").slice(1).map(() => "0m"));
      });
    });

    describe("asking whether to push", () => {
      /** A session whose push dialog, having looked, asks whether to push. */
      function asking(): Session {
        const session = editableSession();
        session.beginTask("Push", () => {});
        session.appendTaskOutput("Looking.\n");
        session.confirmPush(
          say`${"origin"} already has ${"feature"}.\nPushing would add.`,
        );
        return session;
      }

      it("asks under what the task found, offering Push and Cancel with no button as its default", () => {
        const dialog = asking().view().dialog!;

        expect(dialog.title).toBe("Push");
        expect(dialog.body.filter((row) => row !== "")).toEqual([
          "  Looking.",
          "origin already has feature.",
          "Pushing would add.",
        ]);
        const tones = (row: string) =>
          dialog.spans![dialog.body.indexOf(row)].map((span) => span.tone);
        expect(tones("  Looking.")).toEqual(["plain"]);
        expect(tones("origin already has feature.")).toEqual([
          "name",
          "bright",
          "name",
          "bright",
        ]);
        expect(tones("Pushing would add.")).toEqual(["bright"]);
        expect(dialog.buttons.map((b) => b.label)).toEqual(["Push", "Cancel"]);
        expect(dialog.buttons.some((b) => b.kind === "default")).toBe(false);
        expect(dialog.focus).toBe(-1);
      });

      it("asks nothing unless a task is running in the task dialog", () => {
        const session = editableSession();
        session.confirmPush(say`Push?`);
        expect(session.view().dialog).toBeNull();
        session.beginTask("Push", () => {});
        session.finishTask(say`Done.`);

        session.confirmPush(say`Push?`);

        expect(session.view().dialog!.buttons.map((b) => b.label)).toEqual([
          "Close",
          "Quit",
        ]);
      });

      it("asks for the push on Push, keeping the dialog up for it, and for none on `P` or on Enter until a button has the focus", () => {
        for (
          const keys of [
            [{ name: "u", char: "u" }],
            [{ name: "U", char: "U" }],
            [
              { name: "P", char: "P" },
              { name: "enter" },
              { name: "tab" },
              { name: "enter" },
            ],
          ]
        ) {
          const session = asking();

          for (const key of keys) {
            expect(session.pushConfirmed).toBe(false);
            expect(session.branchPushRequested).toBe(false);
            session.handleKey(key);
          }

          expect(session.pushConfirmed).toBe(true);
          expect(session.view().dialog!.title).toBe("Push");
        }
      });

      it("asks for no push on Cancel or Escape, which take the dialog down", () => {
        for (const key of [{ name: "c", char: "c" }, { name: "escape" }]) {
          const session = asking();

          session.handleKey(key);

          expect(session.pushConfirmed).toBe(false);
          expect(session.view().dialog).toBeNull();
        }
      });
    });

    describe("links", () => {
      const LONG = `https://example.test/${"a".repeat(80)}`;

      /** A push dialog on a screen whose rows are `color`ed, with web
       * addresses in its output and in what it says about the watch. */
      function linking(color: boolean): Session {
        const session = new Session(
          parseDocument("const a = 1;\n"),
          { color, showLineNumbers: false },
          { width: 80, height: 24 },
        );
        session.beginTask("Push", () => {});
        session.appendTaskOutput(`See ${PULL_REQUEST}.\n${LONG}\n`);
        session.finishTask(say`Done.`);
        session.quitForPullRequest(OCTO_PULL_REQUEST, 2000);
        return session;
      }

      it("links each web address in the output and under it to the whole address, on each row it wraps onto", () => {
        const dialog = linking(false).view().dialog!;
        const linksOf = (text: string) =>
          dialog.spans![dialog.body.indexOf(text)].filter((span) => span.url);

        expect(linksOf(`  See ${PULL_REQUEST}.`)).toEqual([
          {
            from: 6,
            to: 6 + PULL_REQUEST.length,
            tone: "plain",
            url: PULL_REQUEST,
          },
        ]);
        expect(linksOf(`  ${LONG.slice(0, 70)}`)).toEqual([
          { from: 2, to: 72, tone: "plain", url: LONG },
        ]);
        expect(linksOf(`  ${LONG.slice(70)}`)).toEqual([
          { from: 2, to: 2 + LONG.length - 70, tone: "plain", url: LONG },
        ]);
        expect(linksOf(`Pull request: ${OCTO_PULL_REQUEST}`)).toEqual([
          {
            from: 14,
            to: 14 + OCTO_PULL_REQUEST.length,
            tone: "name",
            url: OCTO_PULL_REQUEST,
          },
        ]);
        expect(dialog.spans).toHaveLength(dialog.body.length);
      });

      it("draws each link as a terminal link around its text when drawing in color, and none otherwise", () => {
        const colored = drawnRows(linking(true)).join("\n");
        const plain = drawnRows(linking(false)).join("\n");

        // The text each link to `url` covers, leaving out links that cover
        // none.
        const linked = (url: string) =>
          colored.split(term.linkStart(url)).slice(1).map((part) =>
            stripAnsi(part.split(term.linkEnd)[0])
          ).filter((text) => text !== "");

        expect(linked(PULL_REQUEST)).toEqual([PULL_REQUEST]);
        expect(linked(OCTO_PULL_REQUEST)).toEqual([OCTO_PULL_REQUEST]);
        expect(linked(LONG)).toEqual([LONG.slice(0, 70), LONG.slice(70)]);
        expect(plain).not.toContain("\x1b]8;");
        expect(plain).toContain(`See ${PULL_REQUEST}.`);
      });

      it("links an address after wide characters by code points, and draws the link over the address's columns", () => {
        // The Han characters take two columns each but one code point.
        const session = new Session(
          parseDocument("const a = 1;\n"),
          { color: true, showLineNumbers: false },
          { width: 80, height: 24 },
        );
        session.beginTask("Push", () => {});
        session.appendTaskOutput(`漢字 ${PULL_REQUEST}\n`);
        const row = `  漢字 ${PULL_REQUEST}`;
        const dialog = session.view().dialog!;
        const drawn = drawnRows(session).join("\n");
        // The text each link covers, leaving out links that cover none.
        const linked = drawn.split(term.linkStart(PULL_REQUEST)).slice(1)
          .map((part) => stripAnsi(part.split(term.linkEnd)[0]))
          .filter((text) => text !== "");

        expect(
          dialog.spans![dialog.body.indexOf(row)].filter((span) => span.url),
        ).toEqual([{
          from: 5,
          to: 5 + PULL_REQUEST.length,
          tone: "plain",
          url: PULL_REQUEST,
        }]);
        expect(linked).toEqual([PULL_REQUEST]);
      });
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
      expect(runningFrame).toContain("║    Writing objects: 100%");
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
      const running = harness.frame((text) => text.includes(PUSHING));
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
      const running = harness.frame((text) => text.includes(PUSHING));
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

    it("draws nothing for a step's spinner that comes due while a pressed button is drawn, and turns it again once the press ends", async () => {
      let attempts = 0;
      const harness = pagerHarness((signal) => ({
        ...fakeIo().io,
        run: () =>
          ++attempts === 1
            ? Promise.resolve({ success: false, output: "" })
            : new Promise((resolve) =>
              signal.addEventListener(
                "abort",
                () => resolve({ success: false, output: "" }),
              )
            ),
      }), { holdTimers: true });
      const retryable = harness.frame((text) => text.includes("Retry push"));
      let retried = Promise.resolve();
      let drawn: string[] = [];
      let armed = 0;

      await harness.run([
        "P",
        () => retryable,
        () => {
          retried = harness.frame((text) => text.includes(PUSHING));
          return Promise.resolve();
        },
        "P",
        () => retried,
        () => {
          const before = harness.writes.length;
          const spinners = harness.spinners.length;
          harness.releaseTimers();
          drawn = harness.writes.slice(before);
          armed = harness.spinners.length - spinners;
          return Promise.resolve();
        },
      ]);

      expect(attempts).toBe(2);
      expect(drawn).toHaveLength(1);
      expect(drawn[0]).toContain("Pushing feature to origin... ◐");
      expect(armed).toBe(1);
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
      const running = harness.frame((text) => text.includes(PUSHING));

      await harness.run(["P", () => running]);
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
      const running = harness.frame((text) => text.includes(PUSHING));

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

    it("says which branch it pushes in the dialog before git prints anything", async () => {
      const harness = pagerHarness(() => fakeIo().io);
      const opened = harness.frame((text) => text.includes(" Push "));
      const closable = harness.frame((text) => text.includes(" Close "));

      await harness.run(["P", () => opened, () => closable, "c"]);

      const first = harness.writes.find((text) =>
        text.includes("Pushing feature to origin")
      )!;
      expect(first).toContain("Pushing feature to origin... ◐");
      expect(first).not.toContain("Writing objects");
    });

    it("offers Retry push when git cannot ask origin which branch is its default, which asks again and pushes", async () => {
      let asks = 0;
      const harness = pagerHarness(() => {
        const { io } = fakeIo();
        return {
          ...io,
          queryAsync: (args) =>
            asks++ === 0 ? Promise.resolve(null) : io.queryAsync(args),
        };
      });
      const failed = harness.frame((text) => text.includes("P Retry push"));
      const pushed = harness.frame((text) =>
        text.includes("Pushed feature to origin.")
      );

      await harness.run(["P", () => failed, "p", () => pushed, "c"]);

      expect(asks).toBe(2);
      const retrying = harness.writes.find((text) =>
        text.includes("P Retry push")
      )!;
      expect(retrying).toContain(`${ASKED_ORIGIN}... ✗`);
      expect(retrying).toContain(
        "Not pushing: origin's default branch is unknown. To retry, press",
      );
    });

    it("offers Retry push when the push fails or is aborted, which pushes again continuing the dialog's output", async () => {
      for (const abort of [false, true]) {
        let pushes = 0;
        let asks = 0;
        const harness = pagerHarness((signal) => ({
          ...fakeIo().io,
          queryAsync: (args) => {
            asks++;
            return fakeIo().io.queryAsync(args);
          },
          run: () => {
            if (pushes++ > 0) {
              return Promise.resolve({ success: true, output: "" });
            }
            if (!abort) {
              return Promise.resolve({
                success: false,
                output: "fatal: the remote end hung up unexpectedly\n",
              });
            }
            return new Promise((resolve) =>
              signal.addEventListener(
                "abort",
                () => resolve({ success: false, output: "" }),
              )
            );
          },
        }));
        const running = harness.frame((text) => text.includes(PUSHING));
        const failed = harness.frame((text) => text.includes("P Retry push"));
        const pushed = harness.frame((text) =>
          text.includes("Pushed feature to origin.")
        );

        await harness.run([
          "P",
          ...(abort ? [() => running, "a"] : []),
          () => failed,
          "p",
          () => pushed,
          "c",
        ]);

        expect(pushes).toBe(2);
        // The retry keeps to the default branch the failed push learned.
        expect(asks).toBe(1);
        const retrying = harness.writes.find((text) =>
          text.includes(" Abort ") && text.includes("To retry") &&
          text.includes("Pushing feature to origin...")
        )!;
        expect(retrying).toContain(
          abort
            ? "Push aborted. To retry, press Retry push."
            : "Pushing feature to origin failed. To retry, press Retry push.",
        );
        expect(retrying).toContain(" Push ═");
        const shown = harness.writes.find((text) =>
          text.includes("Pushed feature to origin.")
        )!;
        expect(shown).not.toContain("P Retry push");
      }
    });

    it("offers no retry when the server refused the push", async () => {
      const harness = pagerHarness(() =>
        fakeIo({
          pushSucceeds: false,
          pushOutput: " ! [rejected]        HEAD -> feature (stale info)\n",
        }).io
      );
      const closable = harness.frame((text) => text.includes(" Close "));

      await harness.run(["P", () => closable, "c"]);

      const shown = harness.writes.find((text) => text.includes(" Close "))!;
      expect(shown).toContain("Pushing feature to origin failed.");
      expect(shown).not.toContain("Retry push");
    });

    it("reports a push whose operations cannot be set up", async () => {
      const harness = pagerHarness(() => {
        throw new Error("no git");
      });
      const closable = harness.frame((text) => text.includes(" Close "));

      await harness.run(["P", () => closable, "c"]);

      expect(harness.writes.at(-2)).toContain("Push failed: no git");
    });

    describe("the spinner", () => {
      /** How many spinner frames `harness` has set a timer for. */
      const spins = (harness: { spinners: readonly unknown[] }) =>
        harness.spinners.length;

      it("turns the spinner of a running step a frame at a time, writing only the rows each frame changes", async () => {
        const push = deferred<{ success: boolean; output: string }>();
        const harness = pagerHarness(() => ({
          ...fakeIo().io,
          run: () => push.promise,
        }));
        const running = harness.frame((text) =>
          text.includes("Pushing feature to origin... ◐")
        );
        const turned = harness.frame((text) =>
          text.includes("Pushing feature to origin... ◓")
        );
        const closable = harness.frame((text) => text.includes(" Close "));
        let spinsWhenRunning = 0;
        let spinsWhenTurned = 0;

        await harness.run([
          "P",
          async () => {
            await running;
            spinsWhenRunning = spins(harness);
            harness.releaseTimers();
            await turned;
            spinsWhenTurned = spins(harness);
            push.resolve({ success: true, output: "" });
            await closable;
          },
          "c",
        ]);

        expect(spinsWhenRunning).toBe(1);
        expect(spinsWhenTurned).toBe(2);
        const frame = harness.writes.find((text) =>
          text.includes("Pushing feature to origin... ◓")
        )!;
        expect(frame).not.toContain("═");
        expect(frame).not.toContain("Abort");
      });

      it("sets no timer for the spinner once no step runs, and draws nothing when a frame comes due after that", async () => {
        const harness = pagerHarness(() => fakeIo().io);
        const closable = harness.frame((text) => text.includes(" Close "));
        let spinsWhenClosable = 0;
        let writesWhenClosable = 0;
        let writesAfterFrame = 0;

        await harness.run([
          "P",
          async () => {
            await closable;
            spinsWhenClosable = spins(harness);
            writesWhenClosable = harness.writes.length;
            harness.releaseTimers();
            writesAfterFrame = harness.writes.length;
          },
          "c",
        ]);

        expect(spinsWhenClosable).toBe(1);
        expect(writesAfterFrame).toBe(writesWhenClosable);
        expect(spins(harness)).toBe(1);
      });

      it("sets no timer for the spinner, and shows no spinner, while the only step running waits for a person, such as the watch waiting for the pull request", async () => {
        const relay = fakeRelay();
        const harness = pagerHarness(
          () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
          {
            git: viewerGit(),
            relay: (address) => address === RELAY ? relay.connect : undefined,
          },
        );
        const watching = harness.frame((text) =>
          text.includes("Waiting for the pull request to open")
        );
        let spinsWhenWatching = 0;
        let spinsAfterDraw = 0;

        await harness.run([
          "P",
          async () => {
            await watching;
            spinsWhenWatching = spins(harness);
            // A frame held from a step that has ended comes due, and the
            // scroll draws the dialog again, either of which would set the
            // spinner's timer again if anything spun.
            harness.releaseTimers();
          },
          "\x1b[B",
          async () => {
            spinsAfterDraw = spins(harness);
            relay.deliver("pull_request", pullRequestPayload());
            await relay.closed();
          },
        ]);

        expect(spinsAfterDraw).toBe(spinsWhenWatching);
        const shown = harness.writes.find((text) =>
          text.includes("Waiting for the pull request to open")
        )!;
        expect(shown).toContain("Waiting for the pull request to open.");
        expect(shown).not.toMatch(/open\.\.\./);
      });

      it("cancels the spinner's next frame when the viewer closes", async () => {
        const harness = pagerHarness(() => ({
          ...fakeIo().io,
          run: () => new Promise<never>(() => {}),
        }));

        await harness.run(["P"]);

        expect(harness.spinners.map((spinner) => spinner.cancelled)).toEqual([
          true,
        ]);
      });
    });

    describe("asking before pushing a branch origin has", () => {
      /** A GitHub API that finds pull request 7 of `octo/repo` open. */
      const findingGitHub: GitHubApi = {
        ...unusedGitHub,
        find: () => Promise.resolve({ number: 7, url: OCTO_PULL_REQUEST }),
      };

      /** Drives the viewer over a checkout of `feature` that `origin`
       * already has, recording each push in `ran`, and each question to a
       * server in `asked`. */
      function pushedHarness(
        options: Partial<Pick<PagerDeps, "git" | "github">> = {},
      ) {
        const ran: string[] = [];
        const asked: string[] = [];
        const harness = pagerHarness(
          () => {
            const fake = fakeIo({ answers: FEATURE_PUSHED });
            return {
              ...fake.io,
              queryAsync: (args) => {
                asked.push(args.join(" "));
                return fake.io.queryAsync(args);
              },
              run: (args) => {
                ran.push(args.join(" "));
                return fake.io.run(args);
              },
            };
          },
          { git: viewerGit({}, UPSTREAM), github: findingGitHub, ...options },
        );
        return { ...harness, ran, asked };
      }

      it("looks for the pull request while origin's server is asked for its default branch, asking whether to push once it answers", async () => {
        const answer = deferred();
        const harness = pagerHarness(() => {
          const { io } = fakeIo({ answers: FEATURE_PUSHED });
          return {
            ...io,
            queryAsync: async (args) => {
              await answer.promise;
              return io.queryAsync(args);
            },
          };
        }, { git: viewerGit({}, UPSTREAM), github: findingGitHub });
        const asked = harness.frame((text) => text.includes(" Cancel "));
        let unanswered = "";

        await harness.run([
          "P",
          () => {
            unanswered = harness.writes.join("");
            answer.resolve();
            return asked;
          },
          "c",
        ]);

        expect(unanswered).toContain(`${ASKED_ORIGIN}...`);
        expect(unanswered).toContain(
          "Looking for the pull request of feature in octo/repo...",
        );
        // The question that decides whether to push is shown first.
        expect(unanswered.indexOf(ASKED_ORIGIN)).toBeLessThan(
          unanswered.indexOf("Looking for the pull request"),
        );
        expect(unanswered).not.toContain(" Cancel ");
        expect(harness.writes.join("")).toContain(
          "Pull request 7 is open from it:",
        );
      });

      it("asks again whether to push when Retry push follows a failure to ask origin which branch is its default", async () => {
        let asks = 0;
        const ran: string[] = [];
        const harness = pagerHarness(() => {
          const { io } = fakeIo({ answers: FEATURE_PUSHED });
          return {
            ...io,
            queryAsync: (args) =>
              asks++ === 0 ? Promise.resolve(null) : io.queryAsync(args),
            run: (args) => {
              ran.push(args.join(" "));
              return io.run(args);
            },
          };
        }, { git: viewerGit({}, UPSTREAM), github: findingGitHub });
        const failed = harness.frame((text) => text.includes("P Retry push"));
        const settled = harness.frame((text) =>
          text.includes(" Cancel ") || text.includes("Pushed feature")
        );

        await harness.run(["P", () => failed, "p", () => settled, "c"]);

        expect(asks).toBe(2);
        expect(ran).toEqual([]);
        expect(harness.writes.some((text) => text.includes(" Cancel "))).toBe(
          true,
        );
      });

      it("pushes again without asking whether to push, or asking origin's server again for its default branch, when Retry push follows a confirmed push that failed", async () => {
        let asks = 0;
        const ran: string[] = [];
        const harness = pagerHarness(() => {
          const { io } = fakeIo({ answers: FEATURE_PUSHED });
          return {
            ...io,
            queryAsync: (args) => {
              asks++;
              return io.queryAsync(args);
            },
            run: (args) => {
              ran.push(args.join(" "));
              return Promise.resolve({ success: ran.length > 1, output: "" });
            },
          };
        }, { git: viewerGit({}, UPSTREAM), github: findingGitHub });
        const asked = harness.frame((text) => text.includes(" Cancel "));
        const failed = harness.frame((text) => text.includes("P Retry push"));
        let settled = Promise.resolve();

        await harness.run([
          "P",
          () => asked,
          "u",
          () => failed,
          () => {
            settled = harness.frame((text) =>
              text.includes(" Cancel ") ||
              text.includes("Pushed feature to origin.")
            );
            return Promise.resolve();
          },
          "p",
          () => settled,
          "c",
        ]);

        expect(ran).toEqual([PUSH_FEATURE, PUSH_FEATURE]);
        expect(asks).toBe(1);
      });

      it("says what pushing would do and which pull request is open, pushing nothing until Push, which continues the dialog", async () => {
        const harness = pushedHarness();
        const asked = harness.frame((text) => text.includes(" Cancel "));
        const pushed = harness.frame((text) =>
          text.includes("Pushed feature to origin.")
        );
        let ranWhenAsked: string[] = [];

        await harness.run([
          "P",
          async () => {
            await asked;
            ranWhenAsked = [...harness.ran];
          },
          "P",
          "u",
          () => pushed,
          "c",
        ]);

        expect(ranWhenAsked).toEqual([]);
        expect(harness.ran).toEqual([PUSH_FEATURE]);
        // Origin's server is asked for its default branch before the question,
        // and the push the question confirms keeps to that answer.
        expect(harness.asked).toEqual([ASK_ORIGIN_DEFAULT]);
        // The push that asked, and the one Push started; the second `P`
        // started none.
        expect(harness.signals).toHaveLength(2);
        const question = frameRows(
          harness.writes.find((text) => text.includes(" Cancel "))!,
        ).join("\n");
        expect(harness.writes.join("")).toContain(
          "Looking for the pull request of feature in octo/repo... ✓",
        );
        expect(question).toContain(
          "origin already has feature, at 0123456789ab",
        );
        expect(question).toContain(
          "Pushing would replace it, removing 1 commit that this checkout",
        );
        expect(question).toContain(
          "have and adding 2 commits. Pull request 7 is open from it:",
        );
        expect(question).toContain(OCTO_PULL_REQUEST);
        expect(question).toContain(" Push ");
        expect(question).not.toContain(" Abort ");
        const after = harness.writes.find((text) =>
          text.includes("Pushed feature to origin.")
        )!;
        expect(harness.writes.join("")).toContain(
          "Pushing feature to origin... ✓",
        );
        expect(after).toMatch(/═ Push ═/);
      });

      it("pushes nothing on Cancel, which takes the dialog down", async () => {
        const harness = pushedHarness();
        const asked = harness.frame((text) => text.includes(" Cancel "));

        await harness.run(["P", () => asked, "c"]);

        expect(harness.ran).toEqual([]);
        expect(harness.writes.at(-2)).not.toContain(" Push ═");
      });

      it("says when the branch has no open pull request, or why it could not look for one", async () => {
        const cases: ReadonlyArray<
          readonly [
            Partial<Pick<PagerDeps, "git" | "github">>,
            readonly string[],
          ]
        > = [
          [{ github: unusedGitHub }, [
            "adding 2 commits. It has no open pull request.",
          ]],
          [
            {
              github: {
                ...unusedGitHub,
                find: () => Promise.reject(new Error("GitHub is down")),
              },
            },
            [
              "adding 2 commits. Could not look for its pull request: GitHub",
              "is down.",
            ],
          ],
          [
            {
              git: viewerGit({}, {
                "remote get-url --push origin": "/srv/repo.git\n",
              }),
            },
            [
              "adding 2 commits. Could not look for its pull request: origin",
              "is not a GitHub repository.",
            ],
          ],
        ];
        for (const [options, said] of cases) {
          const harness = pushedHarness(options);
          const asked = harness.frame((text) => text.includes(" Cancel "));

          await harness.run(["P", () => asked, "c"]);

          const question = harness.writes.find((text) =>
            text.includes(" Cancel ")
          )!;
          for (const piece of said) expect(question).toContain(piece);
          expect(question).toContain(" Push ");
        }
      });

      it("stops looking for the pull request on Abort, and asks without it, pushing on Push", async () => {
        const harness = pushedHarness({
          github: {
            ...unusedGitHub,
            find: (_, signal) =>
              new Promise((_, reject) =>
                signal.addEventListener("abort", () => reject(signal.reason))
              ),
          },
        });
        const looking = harness.frame((text) =>
          text.includes(`${ASKED_ORIGIN}... ✓`) &&
          text.includes("Looking for the pull request")
        );
        const asked = harness.frame((text) => text.includes(" Cancel "));
        const pushed = harness.frame((text) =>
          text.includes("Pushed feature to origin.")
        );
        let ranWhenAsked: string[] = [];

        await harness.run([
          "P",
          () => looking,
          "a",
          async () => {
            await asked;
            ranWhenAsked = [...harness.ran];
          },
          "u",
          () => pushed,
          "c",
        ]);

        expect(ranWhenAsked).toEqual([]);
        expect(harness.ran).toEqual([PUSH_FEATURE]);
        expect(harness.writes.find((text) => text.includes(" Cancel ")))
          .toContain(
            "Stopped looking for its pull request.",
          );
      });
      it("stops the push on Abort while origin's server has not answered, asking nothing", async () => {
        const harness = pagerHarness((signal) => {
          const { io } = fakeIo({ answers: FEATURE_PUSHED });
          return {
            ...io,
            queryAsync: () =>
              new Promise((resolve) =>
                signal.addEventListener("abort", () => resolve(null))
              ),
          };
        }, {
          git: viewerGit({}, UPSTREAM),
          github: {
            ...unusedGitHub,
            find: (_, signal) =>
              new Promise((_, reject) =>
                signal.addEventListener("abort", () => reject(signal.reason))
              ),
          },
        });
        const looking = harness.frame((text) =>
          text.includes(`${ASKED_ORIGIN}...`) &&
          text.includes("Looking for the pull request")
        );
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["P", () => looking, "a", () => closable, "c"]);

        const shown = harness.writes.join("");
        expect(shown).toContain("Push aborted.");
        expect(shown).not.toContain(" Cancel ");
        expect(shown).not.toContain("Stopped looking for its pull request.");
      });
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
            git: viewerGit({ ...QUITTING, "cf-view.quitDelay": "6300" }),
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
        expect(shown).toContain("Waiting for the pull request to open");
        expect(harness.timers).toContain(6300);
        expect(harness.timers).not.toContain(2000);
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
          text.includes("Connecting to the webhook relay... ◐")
        );
        const watching = harness.frame((text) =>
          text.includes("Waiting for the pull request to open")
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
          text.includes("Connecting to the webhook relay... ◐")
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
        // The summary's first row has scrolled above the 12-row screen by
        // then, so it is found in an earlier frame.
        expect(shown).toContain(
          "https://github.com/fork/repo/pull/new/feature",
        );
        expect(harness.writes.join("")).toContain(
          "Pushed feature to origin. Opened",
        );
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
        const running = harness.frame((text) => text.includes(PUSHING));
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

      it("reports the push as it went when git fails as the settings are read after a push the server offers no page for", async () => {
        const harness = pagerHarness(() => fakeIo().io, {
          git: () => {
            throw new Error("git is gone");
          },
        });
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["P", () => closable, "c"]);

        const shown = harness.writes.find((text) => text.includes(" Close "))!;
        expect(shown).toContain("Pushed feature to origin.");
        expect(shown).not.toContain("git is gone");
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

      it("says why it is not watching when git fails as it names what was pushed, and reports the push as it went", async () => {
        const answers = viewerGit();
        const harness = pagerHarness(
          () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
          {
            git: (args) => {
              if (args.join(" ") === "rev-parse --verify --quiet HEAD") {
                throw new Error("git is gone");
              }
              return answers(args);
            },
            relay: () => fakeRelay().connect,
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

      it("sets nothing going to quit for a pull request that opened as the viewer closed", async () => {
        const delivered = Promise.withResolvers<void>();
        const harness = pagerHarness(
          () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
          {
            git: viewerGit(),
            relay: () => () =>
              Promise.resolve({
                readable: new ReadableStream<Uint8Array>({
                  // The delivery reaches the read in progress, and then the
                  // viewer is told to terminate before it reads what came.
                  pull: (controller) => {
                    controller.enqueue(
                      relayFrame("pull_request", pullRequestPayload()),
                    );
                    try {
                      harness.handlers.get("SIGTERM")!();
                    } catch {
                      // The harness's exit throws in place of ending the
                      // process.
                    }
                    delivered.resolve();
                  },
                }, { highWaterMark: 0 }),
                close: () => {},
              }),
          },
        );
        const watching = harness.frame((text) =>
          text.includes("Waiting for the pull request to open")
        );

        await harness.run(["P", async () => {
          await watching;
          await delivered.promise;
        }]);

        expect(harness.exits).toEqual([143]);
        expect(harness.timers).not.toContain(500);
        expect(harness.writes.at(-1)?.endsWith("\x1b[?1049l")).toBe(true);
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

      it("creates it into the branch upstream's server names as its default, titled as the first commit that branch lacks, whatever git cached on cloning", async () => {
        const created: CreateRequest[] = [];
        const harness = pagerHarness(
          () =>
            fakeIo({
              pushOutput: GITHUB_OFFER,
              answers: {
                "ls-remote --symref upstream HEAD": symrefListing("trunk"),
              },
            }).io,
          {
            git: viewerGit({ "cf-view.pullRequestTool": "api" }, {
              ...UPSTREAM,
              "symbolic-ref --quiet refs/remotes/upstream/HEAD":
                "refs/remotes/upstream/main\n",
              [
                "rev-list --reverse --no-merges --right-only --cherry-pick " +
                "--end-of-options refs/remotes/upstream/trunk...HEAD --"
              ]: "c2\n",
              "-c log.showSignature=false log -1 --format=%s%x00%b c2 --":
                "Add the widget\0",
            }),
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

        expect(created).toEqual([{
          repository: "octo/repo",
          head: "fork:feature",
          base: "trunk",
          title: "Add the widget",
          body: "",
        }]);
      });

      it("fails, offering to retry, when upstream's server names no default branch or cannot be asked", async () => {
        for (const listing of ["0123456789abcdef\tHEAD\n", null]) {
          const created: CreateRequest[] = [];
          const harness = pagerHarness(
            () =>
              fakeIo({
                pushOutput: GITHUB_OFFER,
                answers: { "ls-remote --symref upstream HEAD": listing },
              }).io,
            {
              git: viewerGit({ "cf-view.pullRequestTool": "api" }, UPSTREAM),
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

          expect(created).toEqual([]);
          const shown = harness.writes.find((text) =>
            text.includes(" Close ")
          )!;
          expect(shown).toContain(
            "Asking upstream which branch is its default... ✗",
          );
          expect(shown).toContain(
            "Creating the pull request failed: upstream's",
          );
          expect(shown).toContain(
            "default branch is unknown. To retry, press Create PR.",
          );
        }
      });

      it("gives the created pull request's address in the dialog, saying it is quitting, for the delay the settings set before it quits", async () => {
        const harness = pagerHarness(
          () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
          {
            git: viewerGit(
              {
                "cf-view.pullRequestTool": "api",
                "cf-view.quitDelay": "250",
                ...QUITTING,
              },
              UPSTREAM,
            ),
            github: {
              ...unusedGitHub,
              create: () => Promise.resolve(OCTO_PULL_REQUEST),
            },
          },
        );

        await harness.run(["P", forever]);

        const quitting = harness.writes.findIndex((text) =>
          text.includes("Quitting...")
        );
        expect(quitting).toBeGreaterThan(-1);
        expect(harness.writes[quitting]).toContain(
          `Pull request: ${OCTO_PULL_REQUEST}`,
        );
        expect(harness.writes[quitting]).toContain(" Close ");
        expect(harness.timers).toContain(250);
        expect(harness.timers).not.toContain(2000);
        expect(harness.writes.at(-1)).toMatch(
          new RegExp(`\\x1b\\[\\?1049l${OCTO_PULL_REQUEST}\\n$`),
        );
      });

      it("quits for the created pull request at once, without saying it is quitting, when the settings set a delay of 16 ms or less", async () => {
        for (const delay of ["16", "5"]) {
          const harness = pagerHarness(
            () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
            {
              git: viewerGit(
                {
                  "cf-view.pullRequestTool": "api",
                  "cf-view.quitDelay": delay,
                  ...QUITTING,
                },
                UPSTREAM,
              ),
              github: {
                ...unusedGitHub,
                create: () => Promise.resolve(OCTO_PULL_REQUEST),
              },
            },
          );

          await harness.run(["P", forever]);

          expect(harness.writes.join("")).toContain(OCTO_PULL_REQUEST);
          expect(harness.writes.join("")).not.toContain("Quitting...");
          expect(harness.timers).not.toContain(16);
          expect(harness.timers).not.toContain(2000);
          expect(harness.writes.at(-1)).toMatch(
            new RegExp(`\\x1b\\[\\?1049l${OCTO_PULL_REQUEST}\\n$`),
          );
        }
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
                create: (_request, step) => {
                  step(say`Touch the security key`)();
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
        expect(shown).toContain("Touch the security key... ✓");
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
          if (listed) expect(shown).not.toContain("Asking upstream");
        }
      });

      it("shows the search for the open pull request done once GitHub answers, while upstream's server has not", async () => {
        let looked = Promise.resolve();
        const harness = pagerHarness(() => {
          const { io } = fakeIo({ pushOutput: GITHUB_OFFER });
          return {
            ...io,
            queryAsync: async (args) => {
              if (args.includes("upstream")) await looked;
              return io.queryAsync(args);
            },
          };
        }, {
          git: viewerGit({ "cf-view.pullRequestTool": "api" }, UPSTREAM),
          github: {
            ...unusedGitHub,
            create: () => Promise.resolve(OCTO_PULL_REQUEST),
          },
        });
        looked = harness.frame((text) =>
          text.includes(
            "Looking for the pull request of feature in octo/repo... ✓",
          ) && text.includes("Asking upstream which branch is its default...")
        );
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["P", () => closable, "c"]);

        expect(harness.writes.join("")).toContain(
          `Created ${OCTO_PULL_REQUEST}`,
        );
        expect(harness.writes.join("")).toContain(
          "Asking upstream which branch is its default... ✓",
        );
      });

      it("asks upstream's server for its default branch while it asks GitHub for the open pull request, once the user's list names none", async () => {
        const events: string[] = [];
        const harness = pagerHarness(() => {
          const { io } = fakeIo({ pushOutput: GITHUB_OFFER });
          return {
            ...io,
            queryAsync: (args) => {
              if (!args.includes("upstream")) return io.queryAsync(args);
              events.push("ask upstream");
              return io.queryAsync(args).then((answer) => {
                events.push("upstream answered");
                return answer;
              });
            },
          };
        }, {
          git: viewerGit({ "cf-view.pullRequestTool": "api" }, UPSTREAM),
          pullRequestList: () => {
            events.push("read the list");
            return Promise.resolve(null);
          },
          github: {
            ...unusedGitHub,
            find: () => {
              events.push("ask GitHub");
              return Promise.resolve(null).then((found) => {
                events.push("GitHub answered");
                return found;
              });
            },
            create: () => Promise.resolve(OCTO_PULL_REQUEST),
          },
        });
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["P", () => closable, "c"]);

        expect(events[0]).toBe("read the list");
        expect(events.slice(1, 3).sort()).toEqual([
          "ask GitHub",
          "ask upstream",
        ]);
        expect(events.slice(3).sort()).toEqual([
          "GitHub answered",
          "upstream answered",
        ]);
        expect(harness.writes.join("")).toContain(
          `Created ${OCTO_PULL_REQUEST}`,
        );
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
        expect(shown).toContain(
          "Asking upstream which branch is its default... ✓",
        );
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
                create: () =>
                  Promise.reject(new Error(`no token named ${token}`)),
              };
            },
          },
        );
        const failed = harness.frame((text) => text.includes("P Create PR"));
        const refailed = harness.frame((text) =>
          text.includes("no token named mine") && text.includes("P Create PR")
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

      it("keeps offering Create PR when git fails as a retry reads the settings", async () => {
        const settingsGit = viewerGit(
          { "cf-view.pullRequestTool": "api" },
          UPSTREAM,
        );
        let broken = false;
        let attempts = 0;
        const harness = pagerHarness(
          () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
          {
            git: (args) => {
              if (broken && args[0] === "config") {
                throw new Error("git is gone");
              }
              return settingsGit(args);
            },
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
        const gitFailed = harness.frame((text) =>
          text.includes("Git failed: git is gone.") &&
          text.includes("P Create PR")
        );
        const created = harness.frame((text) =>
          text.includes(`Created ${OCTO_PULL_REQUEST}`)
        );

        await harness.run([
          "P",
          async () => {
            await failed;
            broken = true;
          },
          "p",
          async () => {
            await gitFailed;
            broken = false;
          },
          "p",
          () => created,
          "c",
        ]);

        expect(attempts).toBe(2);
      });

      it("gives only GitHub's status, as the viewer's words, when GitHub's refusal gives no reason", async () => {
        const harness = pagerHarness(
          () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
          {
            git: viewerGit({ "cf-view.pullRequestTool": "api" }, UPSTREAM),
            github: {
              ...unusedGitHub,
              create: () => Promise.reject(new GitHubRefusal(500, "{}")),
            },
          },
        );
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["P", () => closable, "c"]);

        const shown = harness.writes.find((text) => text.includes(" Close "))!;
        expect(shown).toContain("Creating the pull request failed: GitHub");
        expect(shown).toContain("answered 500. To retry, press Create PR.");
        expect(shown).not.toContain("║    GitHub answered");
      });

      it("offers no Create PR when GitHub says the pull request cannot be created", async () => {
        const harness = pagerHarness(
          () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
          {
            git: viewerGit({ "cf-view.pullRequestTool": "api" }, UPSTREAM),
            github: {
              ...unusedGitHub,
              create: () =>
                Promise.reject(
                  new GitHubRefusal(
                    422,
                    JSON.stringify({ message: "Validation Failed" }),
                  ),
                ),
            },
          },
        );
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["P", () => closable, "c"]);

        const shown = harness.writes.find((text) => text.includes(" Close "))!;
        expect(shown).toContain("Creating the pull request failed: GitHub");
        expect(shown).toContain("answered 422:");
        expect(shown).toContain("║    Validation Failed");
        expect(shown).not.toContain("║    GitHub answered");
        expect(shown).not.toContain("Create PR");
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
          "Pushed feature to origin. Created the pull request:",
        );
        expect(harness.writes.join("")).toContain("║    it was made");
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
        expect(shown).not.toContain("P Create PR");
        expect(shown).toContain(" Push ═");
        const retrying = harness.writes.filter((text) =>
          text.includes(" Abort ")
        ).at(-1)!;
        expect(harness.writes.join("")).toContain("failed: timed out.");
        expect(harness.writes.join("")).toContain(
          "Looking for the pull request of feature in octo/repo... ✓",
        );
        expect(retrying).toContain("Creating a pull request in octo/repo");
      });

      it("says the creation was aborted when Abort stops it", async () => {
        const harness = pagerHarness(
          () => fakeIo({ pushOutput: GITHUB_OFFER }).io,
          {
            git: viewerGit({ "cf-view.pullRequestTool": "api" }, UPSTREAM),
            github: {
              ...unusedGitHub,
              create: (_request, step, signal) => {
                step(say`Creating`);
                return new Promise((_, reject) =>
                  signal.addEventListener("abort", () => reject(signal.reason))
                );
              },
            },
          },
        );
        const creating = harness.frame((text) =>
          text.includes("Creating... ◐")
        );
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
        const shown = harness.writes.find((text) => text.includes("no open"))!;
        expect(shown).toContain(" Land ");
        expect(shown).toContain(
          "Looking for the pull request of feature in octo/repo... ✓",
        );
        expect(shown).toContain(
          "feature has no open pull request in octo/repo.",
        );
        expect(shown).toContain(" Close ");
      });

      it("says in the dialog why it cannot land, keeping the dialog up", async () => {
        const harness = pagerHarness(() => fakeIo().io, {
          git: viewerGit(
            { "cf-view.pullRequestTool": "api" },
            { ...UPSTREAM, "remote get-url --push origin": null },
          ),
        });
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["L", () => closable, "c"]);

        const shown = harness.writes.find((text) => text.includes(" Close "))!;
        expect(shown).toContain(" Land ");
        expect(shown).toContain(
          "Cannot land: origin is not a GitHub repository.",
        );
        expect(harness.writes.at(-2)).toContain(
          "Cannot land: origin is not a GitHub repository",
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
              return Promise.resolve();
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
          "Merging pull request 7 of octo/repo by rebase... ✓",
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

      it("offers Merge PR when the merge fails, which merges the same pull request again with the settings as they are then, continuing the dialog's output", async () => {
        const config: Record<string, string> = {
          "cf-view.pullRequestTool": "touch-gate",
          "cf-view.touchGateToken": "mine",
        };
        const merged: Array<[string, MergeRequest]> = [];
        let lookups = 0;
        const harness = pagerHarness(() => fakeIo().io, {
          git: viewerGit(config, UPSTREAM),
          pullRequestList: () => {
            lookups++;
            return Promise.resolve("octo/repo\tfeature\t7\n");
          },
          touchGate: () => ({
            ...unusedGitHub,
            merge: (request) => {
              merged.push(["touch-gate", request]);
              return Promise.reject(new Error("the key stopped answering"));
            },
          }),
          github: {
            ...unusedGitHub,
            merge: (request) => {
              merged.push(["api", request]);
              return Promise.resolve();
            },
          },
        });
        const failed = harness.frame((text) => text.includes("P Merge PR"));
        const done = harness.frame((text) =>
          text.includes(`Merged ${OCTO_PULL_REQUEST}`)
        );

        await harness.run([
          "L",
          async () => {
            await failed;
            config["cf-view.pullRequestTool"] = "api";
          },
          "p",
          () => done,
          "c",
        ]);

        const request = {
          repository: "octo/repo",
          number: 7,
          method: "squash",
          sha: "c0ffee",
        };
        expect(merged).toEqual([["touch-gate", request], ["api", request]]);
        expect(lookups).toBe(1);
        const shown = harness.writes.find((text) =>
          text.includes(`Merged ${OCTO_PULL_REQUEST}`)
        )!;
        expect(shown).toContain(
          "Landing failed: the key stopped answering.",
        );
        expect(shown).toContain("To retry, press Merge PR.");
        expect(shown).toContain(" Land ═");
        expect(shown).not.toContain("P Merge PR");
      });

      it("offers Merge PR when GitHub's refusal could change, and not when it says the merge cannot succeed", async () => {
        for (
          const [status, offered] of [[502, true], [405, false]] as const
        ) {
          const harness = pagerHarness(() => fakeIo().io, {
            git: viewerGit(
              {
                "cf-view.pullRequestTool": "touch-gate",
                "cf-view.touchGateToken": "mine",
              },
              UPSTREAM,
            ),
            pullRequestList: () => Promise.resolve("octo/repo\tfeature\t7\n"),
            touchGate: () => ({
              ...unusedGitHub,
              merge: () =>
                Promise.reject(
                  new GitHubRefusal(
                    status,
                    JSON.stringify({ message: "Merge already in progress" }),
                  ),
                ),
            }),
          });
          const closable = harness.frame((text) => text.includes(" Close "));

          await harness.run(["L", () => closable, "c"]);

          const shown = harness.writes.find((text) =>
            text.includes(" Close ")
          )!;
          expect(shown).toContain(`Landing failed: GitHub answered ${status}:`);
          expect(shown).toContain("║    Merge already in progress");
          if (offered) expect(shown).toContain("P Merge PR");
          else expect(shown).not.toContain("Merge PR");
        }
      });

      it("says when the settings no longer merge pull requests as Merge PR is pressed", async () => {
        const config: Record<string, string> = {
          "cf-view.pullRequestTool": "touch-gate",
          "cf-view.touchGateToken": "mine",
        };
        const harness = pagerHarness(() => fakeIo().io, {
          git: viewerGit(config, UPSTREAM),
          pullRequestList: () => Promise.resolve("octo/repo\tfeature\t7\n"),
          touchGate: () => ({
            ...unusedGitHub,
            merge: () => Promise.reject(new Error("refused")),
          }),
        });
        const failed = harness.frame((text) => text.includes("P Merge PR"));
        const declined = harness.frame((text) =>
          text.includes("The settings no longer merge pull requests.")
        );

        await harness.run([
          "L",
          async () => {
            await failed;
            config["cf-view.pullRequestTool"] = "link";
          },
          "p",
          () => declined,
          "c",
        ]);

        expect(harness.writes.at(-2)).toContain(
          "The settings no longer merge pull requests.",
        );
      });

      it("asks whether to merge in the dialog that found the pull request, and merges in it, its output going on from the question", async () => {
        const harness = pagerHarness(() => fakeIo().io, {
          git: viewerGit({ "cf-view.pullRequestTool": "api" }, UPSTREAM),
          pullRequestList: () => Promise.resolve("octo/repo\tfeature\t7\n"),
          github: {
            ...unusedGitHub,
            merge: () => Promise.resolve(),
          },
        });
        const asking = harness.frame((text) => text.includes(" Merge "));
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["L", () => asking, "m", () => closable, "c"]);

        const asked = harness.writes.find((text) => text.includes(" Merge "))!;
        expect(asked).toContain(" Land ");
        expect(asked).toContain("Looking for the pull request of feature");
        expect(asked).toContain(
          "Squash and merge pull request 7 of octo/repo,",
        );
        const merging = harness.writes.find((text) =>
          text.includes("Merging pull request 7")
        )!;
        expect(merging).toContain("if its head is still c0ffee?");
        expect(merging).toContain(" Land ");
        expect(harness.writes.find((text) => text.includes(" Close ")))
          .toContain(`Merged ${OCTO_PULL_REQUEST}`);
      });

      it("gives the merged pull request's address in the dialog, saying it is quitting, for the delay the settings set before it quits, when the settings say to", async () => {
        const harness = pagerHarness(() => fakeIo().io, {
          git: viewerGit(
            {
              "cf-view.pullRequestTool": "touch-gate",
              "cf-view.touchGateToken": "mine",
              "cf-view.quitDelay": "7900",
              ...QUITTING,
            },
            UPSTREAM,
          ),
          pullRequestList: () => Promise.resolve("octo/repo\tfeature\t7\n"),
          touchGate: () => ({
            ...unusedGitHub,
            merge: () => Promise.resolve(),
          }),
        });

        await harness.run(["L", forever]);

        const quitting = harness.writes.find((text) =>
          text.includes("Quitting...")
        )!;
        expect(quitting).toContain(" Land ");
        expect(quitting).toContain(`Pull request: ${OCTO_PULL_REQUEST}`);
        expect(harness.timers).toContain(7900);
        expect(harness.timers).not.toContain(2000);
        expect(harness.writes.at(-1)).toMatch(
          new RegExp(`\\x1b\\[\\?1049l${OCTO_PULL_REQUEST}\\n$`),
        );
      });

      it("keeps quitting for the merged pull request after a key that leaves the dialog up, and stops once Close takes it down", async () => {
        for (const close of [false, true]) {
          const harness = pagerHarness(() => fakeIo().io, {
            git: viewerGit(
              {
                "cf-view.pullRequestTool": "touch-gate",
                "cf-view.touchGateToken": "mine",
                ...QUITTING,
              },
              UPSTREAM,
            ),
            pullRequestList: () => Promise.resolve("octo/repo\tfeature\t7\n"),
            touchGate: () => ({
              ...unusedGitHub,
              merge: () => Promise.resolve(),
            }),
            holdTimers: true,
          });
          const quitting = harness.frame((text) =>
            text.includes("Quitting...")
          );

          await harness.run([
            "L",
            () => quitting,
            close ? "c" : "\x1b[B",
            () => {
              harness.releaseTimers();
              return Promise.resolve();
            },
            ...(close ? ["q"] : []),
          ]);

          const printed = new RegExp(
            `\\x1b\\[\\?1049l${OCTO_PULL_REQUEST}\\n$`,
          );
          if (close) expect(harness.writes.at(-1)).not.toMatch(printed);
          else expect(harness.writes.at(-1)).toMatch(printed);
        }
      });

      it("watches the relay once it opens the pull request, and quits printing the address once a delivery says it merged", async () => {
        const relay = fakeRelay();
        let connectedBeforePage = false;
        const harness = pagerHarness(() => fakeIo().io, {
          git: viewerGit(
            { "cf-view.pullRequestTool": "browser", ...QUITTING },
            UPSTREAM,
          ),
          pullRequestList: () => Promise.resolve("octo/repo\tfeature\t7\n"),
          relay: (address) => address === RELAY ? relay.connect : undefined,
          open: () => {
            connectedBeforePage = relay.connections === 1;
            return true;
          },
        });
        const watching = harness.frame((text) =>
          text.includes("Waiting for the pull request to merge")
        );

        await harness.run([
          "L",
          async () => {
            await watching;
            relay.deliver(
              "pull_request",
              mergedPayload({ repository: "octo/repo", number: 8 }),
            );
            relay.deliver(
              "pull_request",
              mergedPayload({
                repository: "octo/repo",
                url: OCTO_PULL_REQUEST,
              }),
            );
            await relay.closed();
          },
          forever,
        ]);

        expect(connectedBeforePage).toBe(true);
        const shown = harness.writes.find((text) =>
          text.includes("Waiting for the pull request to merge") &&
          text.includes(" Close ")
        )!;
        expect(shown).toContain(`Opened ${OCTO_PULL_REQUEST}`);
        expect(harness.writes.at(-1)).toMatch(
          new RegExp(`\\x1b\\[\\?1049l${OCTO_PULL_REQUEST}\\n$`),
        );
      });

      it("says the merge was aborted when Abort stops it", async () => {
        const harness = pagerHarness(() => fakeIo().io, {
          git: viewerGit({ "cf-view.pullRequestTool": "api" }, UPSTREAM),
          pullRequestList: () => Promise.resolve("octo/repo\tfeature\t7\n"),
          github: {
            ...unusedGitHub,
            merge: (_request, _step, signal) =>
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
          text.includes(
            "Looking for the pull request of feature in octo/repo... ◐",
          )
        );

        await harness.run(["L", () => looking, "m", "\x1b"]);
        found.resolve(null);

        expect(stopped?.aborted).toBe(true);
        expect(harness.writes.join("")).not.toContain("and merge pull request");
        expect(harness.writes.join("")).not.toContain("no open pull request");
      });

      it("stops looking on Abort while the user's list is still being read, saying so in the dialog", async () => {
        const asked: string[] = [];
        const reading = Promise.withResolvers<void>();
        const harness = pagerHarness(() => fakeIo().io, {
          git: viewerGit({ "cf-view.pullRequestTool": "api" }, UPSTREAM),
          pullRequestList: () => {
            reading.resolve();
            return new Promise<never>(() => {});
          },
          github: {
            ...unusedGitHub,
            find: () => {
              asked.push("find");
              return Promise.resolve(null);
            },
          },
        });
        const closable = harness.frame((text) => text.includes(" Close "));

        await harness.run(["L", () => reading.promise, "\x1b", () => closable]);

        expect(asked).toEqual([]);
        const shown = harness.writes.find((text) => text.includes(" Close "))!;
        expect(shown).toContain("Looking for the pull request of feature");
        expect(shown).toContain("Landing aborted.");
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
              return Promise.resolve();
            },
          },
          touchGate: () => ({
            ...unusedGitHub,
            merge: () => {
              merged.push("touch-gate");
              return Promise.resolve();
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
              return Promise.resolve();
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
          "Cannot land: there is no token.",
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
        // The viewer says in its own words why it cannot land off a branch or
        // with nothing checked out, and quotes the reason a lookup gave.
        const cases = [
          [
            { "symbolic-ref --quiet HEAD": null },
            ["Cannot land: this checkout is not on a branch."],
          ],
          [
            { "remote get-url --push origin": null },
            ["Cannot land: origin is not a GitHub repository."],
          ],
          [
            { "rev-parse --verify --quiet HEAD": null },
            ["Cannot land: nothing is checked out."],
          ],
        ] as const;
        for (const [answers, said] of cases) {
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

          for (const piece of said) {
            expect(harness.writes.join("")).toContain(piece);
          }
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
