/**
 * Interactive less-like controller. The only module that touches the TTY: it
 * reads keystrokes from `/dev/tty` (stdin is the piped source text), renders
 * frames to `Deno.stdout`, and restores the terminal on every exit path.
 *
 * All state and key handling live in {@link Session} (testable, no I/O); this
 * driver wires it to the terminal and the {@link renderFrame} renderer. The raw
 * terminal and process operations are reached through an injectable {@link
 * PagerDeps} so the driver's control flow can be exercised without a real TTY;
 * {@link realPagerDeps} supplies the genuine Deno calls.
 */

import {
  relayAddress,
  type RelayConnect,
} from "@commonfabric/github-webhooks/relay";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { CSI, term } from "./ansi.ts";
import { type BlameRunner, blameRunner } from "./blame.ts";
import type { Document } from "./model.ts";
import { decodeKeys } from "./keys.ts";
import { cursorScreenPos, renderFrame, type ViewState } from "./render.ts";
import { Session, type SessionOptions } from "./session.ts";
import { ui } from "./theme.ts";
import { onGrammarLoad, type Semantics } from "./languages/language.ts";
import type { EditableSource } from "./editsource.ts";
import { realFileGateway } from "./filegateway.ts";
import { ViewError } from "./errors.ts";
import { join } from "@std/path";
import {
  abortable,
  type GitHubApi,
  githubApi,
  githubToken,
  listedPullRequest,
  type MergeRequest,
  type PullRequestService,
  type PullRequestTarget,
  pullRequestTarget,
  pullRequestText,
  readPullRequestList,
} from "./github.ts";
import {
  PULL_REQUEST_URL,
  pushedHead,
  watchForPullRequest,
} from "./pullrequest.ts";
import {
  type GitQuery,
  openPage,
  pushBranch,
  type PushIo,
  realPushIo,
} from "./push.ts";
import { readSettings, saveSettings, type ViewSettings } from "./settings.ts";
import { connectPinned, runTool, touchGate } from "./touchgate.ts";

const encoder = new TextEncoder();

/** Idle gap after the last keystroke before the deferred structure re-parse
 * runs. Highlighting is not deferred — it re-runs on every keystroke. */
const REPARSE_DEBOUNCE_MS = 150;

/** Gap between frames while the lines a Ctrl-L revealed land, one per frame. */
const REVEAL_FRAME_MS = 16;

/** How long a prompt button stays drawn pushed after it is activated, before
 * its action's result shows. Long enough to register as a press, short enough
 * not to hold up the answer. */
const PUSH_FRAME_MS = 90;

/** How long a status message that takes itself away stands before it goes. Long
 * enough to read twice over, short enough not to outstay what prompted it. */
const MESSAGE_LINGER_MS = 2000;

export type PagerOptions = SessionOptions;

/** The keyboard handle the pager reads from — satisfied by a `Deno.FsFile`. */
export interface PagerTty {
  read(buffer: Uint8Array): Promise<number | null>;
  setRaw(mode: boolean): void;
  close(): void;
}

/** The terminal/process operations the pager performs, injected so the driver
 * is testable without a real terminal. */
export interface PagerDeps {
  /** Open the controlling terminal for reading; throws when there is none. */
  openTty(): PagerTty;

  write(text: string): void;

  /** The terminal size; may throw when there is no console. */
  consoleSize(): { columns: number; rows: number };

  env(key: string): string | undefined;
  addSignalListener(signal: Deno.Signal, handler: () => void): void;
  removeSignalListener(signal: Deno.Signal, handler: () => void): void;
  exit(code: number): never;

  /** Schedule `handler` after `ms`; returns a function that cancels it. */
  setTimer(handler: () => void, ms: number): () => void;

  /** Resolve after `ms`. Used to hold a frame on screen for a moment on a path
   * that then tears the screen down, where a cancellable timer has nothing left
   * to run in. */
  delay(ms: number): Promise<void>;

  /**
   * Call `listener` each time a language's parser load ends, with the reason
   * when it failed; returns a function that stops the calls.
   */
  onGrammarLoad(listener: (failure?: string) => void): () => void;

  /** The operations a branch push performs, against the repository the viewer
   * is running in, showing git's output with `write` and stopping git when
   * `signal` aborts. */
  pushIo(write: (text: string) => void, signal: AbortSignal): PushIo;

  /** Runs git in the repository the viewer is running in, for its standard
   * output, or returns null when git fails. Nothing is shown. */
  git: GitQuery;

  /** Starts opening `url` in the browser, returning whether that could
   * start. */
  open(url: string): boolean;

  /** GitHub's REST API. */
  github: GitHubApi;

  /** Returns the touch-gate service that uses the token named `token`. */
  touchGate(token: string): PullRequestService;

  /** Resolves with the list of open pull requests that the user's cache
   * keeps, or null when it keeps none. */
  pullRequestList(): Promise<string | null>;

  /** Returns the way to connect to the GitHub webhook relay at `address`, as
   * `host:port`, or undefined for an empty address. */
  relay(address: string): RelayConnect | undefined;

  /** Attribute each line of a file with `git blame`, rejecting with git's
   * message when it cannot, and stopping git when `signal` aborts. */
  blame: BlameRunner;
}

/** The real terminal and process operations, which find the user's files
 * in `home`. */
export function realPagerDeps(
  home: string = Deno.env.get("HOME") ?? "",
): PagerDeps {
  let io: PushIo | undefined;
  const repository = () => io ??= realPushIo({ write: () => {} });
  return {
    openTty: () => Deno.openSync("/dev/tty", { read: true }),
    write: (text) => {
      Deno.stdout.writeSync(encoder.encode(text));
    },
    consoleSize: Deno.consoleSize,
    env: (key) => Deno.env.get(key),
    addSignalListener: Deno.addSignalListener,
    removeSignalListener: Deno.removeSignalListener,
    exit: Deno.exit,
    setTimer: (handler, ms) => {
      const id = setTimeout(handler, ms);
      return () => clearTimeout(id);
    },
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onGrammarLoad,
    pushIo: (write, signal) => realPushIo({ write, signal }),
    git: (args) => repository().query(args),
    open: (url) => repository().open(url),
    github: githubApi(githubToken),
    touchGate: (token) =>
      touchGate(token, {
        directory: join(home, ".config", "touch-gate"),
        tool: runTool,
        connect: connectPinned,
      }),
    pullRequestList: () =>
      readPullRequestList(join(home, ".cache", "github-prs.tsv")),
    relay: relayAddress,
    blame: blameRunner(),
  };
}

export async function runPager(
  doc: Document,
  options: PagerOptions,
  semantics: Semantics | undefined,
  editSource?: EditableSource,
  deps: PagerDeps = realPagerDeps(),
): Promise<void> {
  let tty: PagerTty;
  try {
    tty = deps.openTty();
  } catch (error) {
    throw new ViewError(
      `cf view: cannot open /dev/tty for keyboard input (${
        describeFailure(error)
      }). Pipe through a real terminal, or use --plain.`,
    );
  }

  // The terminal fills the area outside the character grid (the sub-cell padding
  // below the last row) with its default background. Set that to the status
  // bar's color so the strip beneath the last line blends in instead of showing
  // the terminal's own background; restore it on exit. Only with color on.
  const padBg = options.color ? ui.statusBar.bg : undefined;

  const session = new Session(
    doc,
    options,
    consoleSize(deps),
    semantics,
    editSource,
    realFileGateway(),
  );

  const paint = (doc: Document, view: ViewState) => {
    // A push still running when the viewer closes ends after the screen is
    // gone, and has nothing left to draw on.
    if (cleanedUp) return;
    const rows = renderFrame(doc, view);
    // Re-assert the padding background every frame. Some terminals drop the
    // OSC 11 default set at startup after the first repaint, so setting it once
    // is not enough; re-sending the same value is a no-op where it already holds.
    let out = (padBg ? term.setDefaultBg(padBg) : "") +
      `${CSI}?7l${term.hideCursor}`; // disable autowrap while drawing
    for (let i = 0; i < rows.length; i++) {
      out += term.moveTo(i + 1, 1) + term.clearLine + rows[i];
    }
    out += `${CSI}?7h`;
    // Show the text cursor at its cell when edit mode has one; otherwise the
    // terminal cursor stays hidden.
    const cur = cursorScreenPos(doc, view);
    if (cur) out += term.moveTo(cur.row, cur.col) + term.showCursor;
    deps.write(out);
  };

  // Drawing the blame column can ask for files' blame. Each load runs while
  // keys keep arriving, and draws again when it lands, unless a reveal or a
  // button press is playing its frames, which end with a draw of their own.
  // Closing the viewer stops the loads still running.
  const blameController = new AbortController();
  const draw = () => {
    if (cleanedUp) return;
    paint(session.displayDoc(), session.view());
    for (const load of session.takeBlameLoads()) {
      deps.blame(load.request, blameController.signal).then(
        (lines) => session.finishBlameLoad(load, lines),
        (error) =>
          session.failBlameLoad(
            load,
            describeFailure(error),
          ),
      ).then(() => {
        if (!cancelReveal && !cancelPush) draw();
      });
    }
  };

  // Ctrl-L leaves the session at the finished state; these frames walk the lines
  // it revealed in one at a time so where they land is visible. Any key, or a
  // resize, drops the frames left and the draw that follows shows the finish.
  let cancelReveal: (() => void) | undefined;
  const stopReveal = () => {
    if (cancelReveal) {
      cancelReveal();
      cancelReveal = undefined;
    }
  };
  const startReveal = (): boolean => {
    const reveal = session.pendingReveal;
    if (!reveal || reveal.count < 2) return false; // one line lands on its own
    let shown = 1;
    const step = () => {
      const frame = shown < reveal.count ? session.revealFrame(shown) : null;
      if (!frame) {
        cancelReveal = undefined;
        draw();
        // What it says stands from when the lines finish landing, not from
        // before they started.
        startExpiry();
        return;
      }
      paint(frame.doc, frame.view);
      shown++;
      cancelReveal = deps.setTimer(step, REVEAL_FRAME_MS);
    };
    cancelReveal = deps.setTimer(step, REVEAL_FRAME_MS);
    return true;
  };

  // A prompt button press shows the button pushed for a moment before its result
  // lands. The captured pushed frame is painted before the button's synchronous
  // action starts. A timer then draws the real state (the dialog closed, or the
  // next prompt up). Any key drops the wait.
  let cancelPush: (() => void) | undefined;
  const stopPush = () => {
    if (cancelPush) {
      cancelPush();
      cancelPush = undefined;
    }
  };
  const startPush = (): boolean => {
    const push = session.pendingPush;
    if (!push) return false;
    paint(push.doc, push.view);
    cancelPush = deps.setTimer(() => {
      cancelPush = undefined;
      session.pendingPush = null;
      draw();
      startExpiry();
    }, PUSH_FRAME_MS);
    return true;
  };

  // Ctrl-L pressed where the bar does not offer it says why, and the key changed
  // nothing else. The reason has served its purpose once it has been read, so it
  // stands for a moment and then goes rather than sitting in the bar describing
  // a keypress the user has long since moved on from.
  let cancelExpiry: (() => void) | undefined;
  const stopExpiry = () => {
    if (cancelExpiry) {
      cancelExpiry();
      cancelExpiry = undefined;
    }
  };
  const startExpiry = () => {
    if (!session.transientMessage) return;
    cancelExpiry = deps.setTimer(() => {
      cancelExpiry = undefined;
      session.expireMessage();
      draw();
    }, MESSAGE_LINGER_MS);
  };

  // The session re-highlights on every keystroke but defers the full parse;
  // run it once typing pauses so the structure tree and cross-references catch
  // up without making each keystroke pay for the whole-AST build.
  let cancelReparse: (() => void) | undefined;
  const scheduleReparse = () => {
    if (cancelReparse) {
      cancelReparse();
    }
    cancelReparse = deps.setTimer(() => {
      cancelReparse = undefined;
      session.reparse();
      draw();
    }, REPARSE_DEBOUNCE_MS);
  };

  // A task, such as a push, runs while keys keep arriving, so that its
  // dialog's Abort button works. Its output, and its end, each draw the
  // dialog again. However the viewer ends, a task still running stops, and so
  // does a search for a pull request to land.
  let taskController: AbortController | undefined;
  const closing = new AbortController();

  // While the push dialog is up, the viewer can watch the webhook relay for
  // the pushed branch's pull request to open, and stops watching once the
  // dialog closes. When the pull request opening quits the viewer, the viewer
  // prints the pull request's address as it closes.
  let watchController: AbortController | undefined;
  const stopWatching = () => {
    watchController?.abort();
    watchController = undefined;
  };

  // Something other than a key, such as the pull request opening, can quit
  // the viewer while it waits for a key.
  const quitting = Promise.withResolvers<null>();

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    taskController?.abort();
    closing.abort();
    stopWatching();
    blameController.abort();
    try {
      tty.setRaw(false);
    } catch { /* ignore */ }
    try {
      deps.write(
        `${term.disableMouse}${CSI}?7h${term.showCursor}` +
          (padBg ? term.resetDefaultBg : "") + term.leaveAltScreen +
          (session.exitMessage === null ? "" : `${session.exitMessage}\n`),
      );
    } catch { /* ignore */ }
    try {
      tty.close();
    } catch { /* ignore */ }
  };

  const onResize = () => {
    const s = consoleSize(deps);
    stopReveal(); // the frames left were laid out for the old size
    stopExpiry();
    stopPush(); // the captured pushed frame was laid out for the old size
    session.resize(s.width, s.height);
    draw();
    // A message that takes itself away is still up after the redraw, so start
    // its clock again — the one just cancelled would have left it there for good.
    startExpiry();
  };
  const terminate = (code: number) => {
    cleanup();
    deps.exit(code);
  };
  // A SIGINT (Ctrl+C reaching us as a signal rather than the in-band 0x03 byte,
  // e.g. a forwarded interrupt) routes through the save prompt when there are
  // unsaved edits; the read loop then handles the y/n/c answer. A second
  // interrupt, or a clean buffer, terminates.
  const onInterrupt = () => {
    stopReveal();
    stopExpiry();
    stopPush();
    if (session.requestQuitFromSignal()) draw();
    else terminate(130);
  };
  const onTerminate = () => terminate(143);

  try {
    deps.addSignalListener("SIGWINCH", onResize);
  } catch { /* not on this platform */ }
  deps.addSignalListener("SIGINT", onInterrupt);
  deps.addSignalListener("SIGTERM", onTerminate);
  // A file opened in a language whose parser has not loaded is drawn as plain
  // text and starts the load; once it loads, parse the document again.
  const stopParserListener = deps.onGrammarLoad((failure) => {
    if (failure === undefined) {
      session.reparse({ force: true });
    } else {
      session.showMessage(`${failure} Its files are shown as plain text.`);
    }
    draw();
  });

  const buf = new Uint8Array(4096);
  let leftover: Uint8Array = new Uint8Array(0);

  // The push dialog quits the viewer from outside the key loop when the pull
  // request opens, or when a push ends after it opened.
  const drawOrQuit = () => {
    if (session.quit) quitting.resolve(null);
    else draw();
  };

  const notWatching = (reason: string) =>
    session.setPullRequestWatch(
      `Not watching for the pull request: ${reason}.`,
    );

  // A watch that cannot start says why in the push dialog, and leaves the
  // push it follows to be reported as it went. The relay keeps nothing for a
  // subscriber that is not connected, so the page for creating the pull
  // request opens once the connection is open or has failed, or once `push`,
  // the push's own signal, aborts, which abandons the connection.
  const startWatching = async (
    branch: string,
    push: AbortSignal,
    settings: ViewSettings,
  ) => {
    try {
      if (!settings.quitOnPullRequest) return;
      const connect = deps.relay(settings.webhookRelay);
      if (connect === undefined) {
        notWatching("no webhook relay is set in the settings");
        return;
      }
      const head = pushedHead(deps.git, branch);
      if (head === null) {
        notWatching("origin is not a GitHub repository");
        return;
      }
      if (push.aborted) {
        notWatching("the watch was aborted");
        return;
      }
      const controller = new AbortController();
      watchController = controller;
      const ready = Promise.withResolvers<void>();
      // What aborts the push draws the dialog itself.
      const abandon = () => {
        controller.abort();
        notWatching("the watch was aborted");
        ready.resolve();
      };
      push.addEventListener("abort", abandon, { once: true });
      session.setPullRequestWatch("Connecting to the webhook relay.");
      draw();
      watchForPullRequest(connect, head, controller.signal, () => {
        push.removeEventListener("abort", abandon);
        session.setPullRequestWatch("Quitting when the pull request opens.");
        draw();
        ready.resolve();
      }).then((url) => {
        if (controller.signal.aborted) return;
        session.quitForPullRequest(url);
        drawOrQuit();
      }, (error) => {
        push.removeEventListener("abort", abandon);
        ready.resolve();
        if (controller.signal.aborted) return;
        notWatching(describeFailure(error));
        draw();
      });
      await ready.promise;
    } catch (error) {
      notWatching(describeFailure(error));
    }
  };

  // The settings dialog shows git's configuration as it stands when the
  // dialog opens, and OK saves what it shows there.
  const serviceSettings = () => {
    try {
      if (session.settingsRequested) {
        session.settingsRequested = false;
        session.openSettings(readSettings(deps.git));
      }
      const save = session.settingsToSave;
      if (save) {
        session.settingsToSave = null;
        session.showMessage(
          saveSettings(deps.git, save.shown, save.settings)
            ? "Settings saved."
            : "Git could not save the settings.",
        );
      }
    } catch (error) {
      session.showMessage(`Git failed: ${describeFailure(error)}`);
    }
  };

  const writeTask = (text: string) => {
    session.appendTaskOutput(text);
    draw();
  };

  // What creating or merging a pull request waits for, such as a security
  // key's touch, shows even when the output was scrolled back.
  const writeRequest = (text: string) => {
    session.appendTaskOutput(text, true);
    session.showTaskEnd();
    draw();
  };

  /** The service that creates and merges pull requests as `settings` say. */
  const service = (settings: ViewSettings): PullRequestService =>
    settings.pullRequestTool === "touch-gate"
      ? deps.touchGate(settings.touchGateToken)
      : deps.github;

  /** Resolves with `target`'s open pull request, which the user's list
   * names, or else GitHub, or null when there is none. */
  const findPullRequest = async (
    target: PullRequestTarget,
    signal: AbortSignal,
  ) => {
    const list = await abortable(deps.pullRequestList(), signal);
    return (list === null ? null : listedPullRequest(list, target)) ??
      await deps.github.find(target, signal);
  };

  // Creating the pushed branch's pull request, unless one is already open,
  // quits the viewer as the pull request opening would, when the settings
  // say to. When it fails, the task dialog offers to try again, which looks
  // for an open pull request first, in case the failed attempt created one.
  let retryCreate: (() => void) | null = null;
  const RETRY_CREATE = "Create PR";
  const createPullRequest = async (
    settings: ViewSettings,
    branch: string,
    signal: AbortSignal,
  ): Promise<string> => {
    try {
      const target = pullRequestTarget(deps.git, branch);
      const open = await findPullRequest(target, signal);
      if (open !== null) {
        return `Pull request ${open.number} is open: ${open.url}`;
      }
      const { title, body } = pullRequestText(deps.git, target);
      const { repository, head, base } = target;
      const url = await service(settings).create(
        { repository, head, base, title, body },
        writeRequest,
        signal,
      );
      if (settings.quitOnPullRequest && PULL_REQUEST_URL.test(url)) {
        session.quitForPullRequest(url);
      }
      return PULL_REQUEST_URL.test(url)
        ? `Created ${url}`
        : `Created the pull request: ${url}`;
    } catch (error) {
      retryCreate = () => startCreate(branch);
      return (signal.aborted
        ? "Creating the pull request was aborted. It may have been created " +
          "anyway."
        : `Creating the pull request failed: ${describeFailure(error)}.`) +
        ` To retry, press ${RETRY_CREATE}.`;
    }
  };

  // Trying the creation again uses the settings as they are then, so that
  // fixing them, such as the touch-gate token, takes effect.
  const startCreate = async (branch: string) => {
    retryCreate = null;
    const controller = new AbortController();
    taskController = controller;
    session.beginTask(RETRY_CREATE, () => controller.abort());
    draw();
    let summary: string;
    try {
      const settings = readSettings(deps.git);
      const tool = settings.pullRequestTool;
      summary = tool === "api" || tool === "touch-gate"
        ? await createPullRequest(settings, branch, controller.signal)
        : "The settings no longer create pull requests.";
    } catch (error) {
      summary = `Git failed: ${describeFailure(error)}`;
    }
    session.finishTask(summary, retryCreate === null ? "" : RETRY_CREATE);
    drawOrQuit();
  };

  // Once the push succeeds, the settings say whether to create the pushed
  // branch's pull request, unless one is open, or, when the server offers a
  // page for creating one, to give its address or open it. Settings that
  // cannot be read leave the page to open.
  const pushed = async (
    io: PushIo,
    branch: string,
    url: string | null,
    signal: AbortSignal,
  ): Promise<string> => {
    let settings: ViewSettings;
    try {
      settings = readSettings(deps.git);
    } catch (error) {
      if (url === null) return "";
      notWatching(describeFailure(error));
      return openPage(io, url);
    }
    const tool = settings.pullRequestTool;
    if (tool === "api" || tool === "touch-gate") {
      return await createPullRequest(settings, branch, signal);
    }
    if (url === null) return "";
    await startWatching(branch, signal, settings);
    return tool === "browser"
      ? openPage(io, url)
      : `Create a pull request at ${url}`;
  };

  const startBranchPush = async () => {
    session.branchPushRequested = false;
    // A watch is for the push whose dialog it outlived.
    stopWatching();
    const controller = new AbortController();
    taskController = controller;
    session.beginTask("Push", () => controller.abort());
    retryCreate = null;
    let summary: string;
    try {
      const io = deps.pushIo(writeTask, controller.signal);
      summary = await pushBranch(
        io,
        controller.signal,
        (branch, url) => pushed(io, branch, url, controller.signal),
      );
    } catch (error) {
      summary = `Push failed: ${describeFailure(error)}`;
    }
    session.finishTask(summary, retryCreate === null ? "" : RETRY_CREATE);
    drawOrQuit();
  };

  // Landing finds the checked-out branch's open pull request, in the user's
  // list when it names one and otherwise by asking GitHub, and then gives
  // its address, opens it, or merges it, as the settings say. The
  // land dialog is up from the start, so that keys typed while the pull
  // request is looked for reach no merge button, and its Cancel stops the
  // search.
  // The merge the land dialog asks about uses the service the settings named
  // when it asked.
  let mergeService: PullRequestService | undefined;
  const startLand = async () => {
    session.landRequested = false;
    mergeService = undefined;
    const looking = new AbortController();
    const signal = AbortSignal.any([looking.signal, closing.signal]);
    try {
      const settings = readSettings(deps.git);
      const branch = /^refs\/heads\/(.+)$/.exec(
        deps.git(["symbolic-ref", "--quiet", "HEAD"])?.trim() ?? "",
      )?.[1];
      if (branch === undefined) {
        throw new Error("this checkout is not on a branch");
      }
      const target = pullRequestTarget(deps.git, branch);
      session.beginLand(
        `Looking for the pull request of ${branch} in ${target.repository}.`,
        () => looking.abort(),
      );
      draw();
      const found = await findPullRequest(target, signal);
      if (signal.aborted) return;
      const tool = settings.pullRequestTool;
      if (found === null) {
        session.endLand(
          `${branch} has no open pull request in ${target.repository}.`,
        );
      } else if (
        tool === "link" || (tool === "browser" && !deps.open(found.url))
      ) {
        session.endLand(`Pull request ${found.number}: ${found.url}`);
      } else if (tool === "browser") {
        session.endLand(`Opened ${found.url}`);
      } else {
        const sha = deps.git(["rev-parse", "--verify", "--quiet", "HEAD"])
          ?.trim();
        if (!sha) throw new Error("nothing is checked out");
        const request = {
          repository: target.repository,
          number: found.number,
          method: await deps.github.mergeMethod(target.repository, signal),
          sha,
        };
        if (signal.aborted) return;
        // A touch of the security key approves a merge through touch-gate,
        // so only a merge through the API asks first.
        if (tool === "touch-gate") {
          session.endLand("");
          startMerge(request, service(settings));
        } else {
          mergeService = service(settings);
          session.confirmLand(request);
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      session.endLand(`Cannot land: ${describeFailure(error)}`);
    }
    draw();
  };

  const startRequested = () => {
    if (session.branchPushRequested) startBranchPush();
    if (session.retryRequested) {
      session.retryRequested = false;
      retryCreate?.();
    }
    if (session.landRequested) startLand();
    if (session.mergeRequested && mergeService) {
      startMerge(session.mergeRequested, mergeService);
    }
  };

  const startMerge = async (
    request: MergeRequest,
    merger: PullRequestService,
  ) => {
    session.mergeRequested = null;
    stopWatching();
    const controller = new AbortController();
    taskController = controller;
    session.beginTask("Land", () => controller.abort());
    let summary: string;
    try {
      writeTask(
        `Merging pull request ${request.number} of ${request.repository} ` +
          `by ${request.method}.\n`,
      );
      summary = await merger.merge(request, writeRequest, controller.signal);
    } catch (error) {
      summary = controller.signal.aborted
        ? "Landing aborted. The pull request may have merged anyway."
        : `Landing failed: ${describeFailure(error)}`;
    }
    session.finishTask(summary);
    drawOrQuit();
  };
  try {
    tty.setRaw(true);
    deps.write(
      `${term.enterAltScreen}${term.enableMouse}${term.hideCursor}` +
        (padBg ? term.setDefaultBg(padBg) : ""),
    );
    draw();
    // Warm the TypeScript program after the first frame is on screen, while the
    // user is reading it and before any keypress arrives, so the first info card
    // does not pay the one-time build cost on the interactive path.
    if (semantics) deps.setTimer(() => semantics.prewarm(), 0);
    while (!session.quit) {
      // A read that quitting interrupts is left unfinished, for the viewer is
      // closing.
      const n = await Promise.race([tty.read(buf), quitting.promise]);
      if (n === null) {
        break;
      }
      const chunk = concat(leftover, buf.subarray(0, n));
      const { keys, rest } = decodeKeys(chunk);
      leftover = rest;
      // A partial key sequence has not changed the session. Keep any active
      // animation on screen while its remaining bytes arrive.
      if (keys.length === 0) continue;
      let pushStarted = false;
      for (const key of keys) {
        // A new key ends animations and short-lived messages left by the
        // previous key, including an earlier key decoded from this same read.
        stopReveal();
        stopExpiry();
        stopPush();
        pushStarted = false;
        session.handleKey(key, () => {
          // activateButton calls this after capturing the pushed frame and
          // before running the action, so a slow synchronous save leaves the
          // button visibly depressed for the duration of the work.
          pushStarted = startPush();
        });
        serviceSettings();
        // A task starts as soon as its key is handled, so that the keys after
        // it in the same read reach its dialog rather than starting another.
        startRequested();
        if (session.quit) break;
      }
      if (session.quit) {
        stopReveal();
        stopExpiry();
        // A committing button can set quit as its action. Its pressed frame is
        // already on screen. Hold it for the rest of the press moment before
        // tearing the screen down. A bare `q` exits at once.
        if (pushStarted) {
          stopPush();
          await deps.delay(PUSH_FRAME_MS);
        }
        break;
      }
      if (!session.taskDialogUp) stopWatching();
      // A reveal or a button press draws its own frames, ending on the finished
      // one; otherwise draw the new state now.
      if (!startReveal() && !pushStarted) {
        draw();
        startExpiry(); // starts the clock on the message the draw put up
      }
      if (session.needsReparse) scheduleReparse();
    }
  } finally {
    stopParserListener();
    stopReveal();
    stopExpiry();
    stopPush();
    if (cancelReparse) {
      cancelReparse();
    }
    try {
      deps.removeSignalListener("SIGINT", onInterrupt);
      deps.removeSignalListener("SIGTERM", onTerminate);
      deps.removeSignalListener("SIGWINCH", onResize);
    } catch { /* ignore */ }
    cleanup();
  }
}

function consoleSize(deps: PagerDeps): { width: number; height: number } {
  try {
    const { columns, rows } = deps.consoleSize();
    if (columns > 0 && rows > 0) return { width: columns, height: rows };
  } catch { /* fall through to env / defaults */ }
  const envW = Number.parseInt(deps.env("COLUMNS") ?? "", 10);
  const envH = Number.parseInt(deps.env("LINES") ?? "", 10);
  return {
    width: Number.isFinite(envW) && envW > 0 ? envW : 80,
    height: Number.isFinite(envH) && envH > 0 ? envH : 24,
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b.slice();
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
