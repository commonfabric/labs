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
  type GitHubDelivery,
  relayAddress,
  type RelayConnect,
} from "@commonfabric/github-webhooks/relay";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { CSI, term } from "./ansi.ts";
import {
  type ParseJob,
  type ParseOutcome,
  recolorBatch,
  workerParser,
} from "./backgroundparse.ts";
import { type BlameRunner, blameRunner } from "./blame.ts";
import type { Document } from "./model.ts";
import { decodeKeys } from "./keys.ts";
import { cursorScreenPos, renderFrame, type ViewState } from "./render.ts";
import { type PushedFrame, Session, type SessionOptions } from "./session.ts";
import { ui } from "./theme.ts";
import { onGrammarLoad, type Semantics } from "./languages/language.ts";
import type { EditableSource } from "./editsource.ts";
import { type FileGateway, realFileGateway } from "./filegateway.ts";
import { ViewError } from "./errors.ts";
import { join } from "@std/path";
import {
  abortable,
  type GitHubApi,
  githubApi,
  GitHubRefusal,
  githubToken,
  listedPullRequest,
  type MergeRequest,
  type PullRequestService,
  type PullRequestTarget,
  pullRequestTarget,
  pullRequestText,
  pullRequestUrl,
  readPullRequestList,
} from "./github.ts";
import {
  mergedPullRequest,
  openedPullRequest,
  PULL_REQUEST_URL,
  pushedHead,
  watchForPullRequest,
} from "./pullrequest.ts";
import {
  defaultBranch,
  describePush,
  type GitQuery,
  openPage,
  pushBranch,
  type PushedBranch,
  type PushIo,
  pushRefused,
  realPushIo,
} from "./push.ts";
import { readSettings, saveSettings, type ViewSettings } from "./settings.ts";
import {
  type BeginStep,
  link,
  name,
  pullRequest,
  quote,
  say,
  type TaskOutput,
  type TaskText,
  words,
} from "./tasklog.ts";
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

/** Gap between the frames of the spinner of a running step in the task
 * dialog. */
const SPINNER_FRAME_MS = 150;

/** How long the task dialog gives the address of the pull request that quits
 * the viewer, saying it is quitting, before the viewer closes. */
const PULL_REQUEST_QUIT_MS = 2000;

export type PagerOptions = SessionOptions & {
  /** Whole-file parses the view left for the pager to finish while it takes
   * keys, whose file sides it shows as plain text until then. */
  readonly parses?: readonly ParseJob[];
};

/** Why `error` happened, to follow a colon in the task dialog, with the
 * reason GitHub gave quoted when GitHub refused a request. */
function failure(error: unknown): TaskText {
  if (!(error instanceof GitHubRefusal)) {
    return words(`${describeFailure(error)}.`);
  }
  const status = `${error.status}`;
  return error.reason === ""
    ? say`GitHub answered ${status}.`
    : say`GitHub answered ${status}: ${quote(error.reason)}`;
}

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

  /** Schedule `handler` to turn the task dialog's spinner a frame, after
   * {@link SPINNER_FRAME_MS}; returns a function that cancels it. */
  setSpinnerTimer(handler: () => void): () => void;

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
   * is running in, saying what it does and showing git's output with
   * `output`, and stopping git when `signal` aborts. */
  pushIo(output: TaskOutput, signal: AbortSignal): PushIo;

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

  /** The files the viewer can open from its file picker. */
  files: FileGateway;

  /** Starts running `jobs` away from the thread that takes keys, giving each
   * batch of outcomes to `deliver` as it arrives; returns a function that
   * stops the jobs still running. */
  parseInBackground(
    jobs: readonly ParseJob[],
    deliver: (outcomes: readonly ParseOutcome[]) => void,
  ): () => void;
}

/** The real terminal and process operations, which find the user's files
 * in `home`. */
export function realPagerDeps(
  home: string = Deno.env.get("HOME") ?? "",
): PagerDeps {
  let io: PushIo | undefined;
  const repository = () =>
    io ??= realPushIo({ write: () => {}, step: () => () => {} });
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
    setSpinnerTimer: (handler) => {
      const id = setTimeout(handler, SPINNER_FRAME_MS);
      return () => clearTimeout(id);
    },
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onGrammarLoad,
    pushIo: (output, signal) => realPushIo({ ...output, signal }),
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
    files: realFileGateway(),
    parseInBackground: (jobs, deliver) => workerParser(jobs, deliver),
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
    deps.files,
  );

  // While a dialog is up, the terminal reports every key in full, so that
  // Alt with a letter reaches the dialog as Alt even from iTerm2 with Option
  // set to type characters. A request to report every key counts as made as
  // soon as it is written, and one to stop only once the write is done, so
  // that a failed write leaves the closing viewer still asking to stop.
  let reportingAllKeys = false;

  // The rows the last frame painted, which a frame painted with
  // `changedOnly` compares against, writing only the rows that differ. Every
  // other frame writes every row, so that whatever else disturbed the screen
  // is painted over.
  let painted: readonly string[] = [];
  const paint = (doc: Document, view: ViewState, changedOnly = false) => {
    const rows = renderFrame(doc, view);
    const allKeys = view.dialog != null;
    // Re-assert the padding background on every frame that writes every row.
    // Some terminals drop the OSC 11 default set at startup after the first
    // repaint, so setting it once is not enough; re-sending the same value is
    // a no-op where it already holds.
    let out =
      (allKeys === reportingAllKeys
        ? ""
        : allKeys
        ? term.reportAllKeys
        : term.reportKeysAsBefore) +
      (padBg && !changedOnly ? term.setDefaultBg(padBg) : "") +
      `${CSI}?7l${term.hideCursor}`; // disable autowrap while drawing
    for (let i = 0; i < rows.length; i++) {
      if (changedOnly && rows[i] === painted[i]) continue;
      out += term.moveTo(i + 1, 1) + term.clearLine + rows[i];
    }
    painted = rows;
    out += `${CSI}?7h`;
    // Show the text cursor at its cell when edit mode has one; otherwise the
    // terminal cursor stays hidden.
    const cur = cursorScreenPos(doc, view);
    if (cur) out += term.moveTo(cur.row, cur.col) + term.showCursor;
    reportingAllKeys ||= allKeys;
    deps.write(out);
    reportingAllKeys = allKeys;
  };

  // Drawing the blame column can ask for files' blame. Each load runs while
  // keys keep arriving, and draws again when it lands, unless a reveal or a
  // button press is playing its frames, which end with a draw of their own.
  // Closing the viewer stops the loads still running.
  const blameController = new AbortController();
  const draw = (changedOnly = false) => {
    // A push still running when the viewer closes ends after the screen is
    // gone, and has nothing left to draw on.
    if (cleanedUp) return;
    paint(session.displayDoc(), session.view(), changedOnly);
    if (session.taskSpinning || session.highlighting) {
      cancelSpin ??= deps.setSpinnerTimer(spin);
    }
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

  // While the task dialog shows a running step, or the status bar shows
  // highlighting progress, its spinner turns a frame at a time, writing only
  // the rows it changes, except while a pressed button is drawn, whose own
  // draw starts its timer again.
  let cancelSpin: (() => void) | undefined;
  const spin = () => {
    cancelSpin = undefined;
    if (!(session.taskSpinning || session.highlighting) || cancelPush) return;
    session.advanceSpinner();
    draw(true);
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
  const startPush = (push: PushedFrame) => {
    paint(push.doc, push.view);
    cancelPush = deps.setTimer(() => {
      cancelPush = undefined;
      session.pendingPush = null;
      draw();
      startExpiry();
    }, PUSH_FRAME_MS);
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
  // dialog again. However the viewer ends, a task still running stops.
  let taskController: AbortController | undefined;

  // While the task dialog is up, the viewer can watch the webhook relay for
  // the pushed branch's pull request to open, or for the landed one to merge,
  // and stops watching once the dialog closes. When that quits the viewer,
  // the viewer prints the pull request's address as it closes.
  let watchController: AbortController | undefined;
  const stopWatching = () => {
    watchController?.abort();
    watchController = undefined;
  };

  // Something other than a key, such as the pull request opening, can quit
  // the viewer while it waits for a key.
  const quitting = Promise.withResolvers<null>();

  // The complete files whose parses the view left are shown as plain text,
  // and parse in the background while keys keep arriving, while the status
  // bar shows how much of their source has been parsed. The document is
  // parsed again and drawn each time a batch of source has finished parsing
  // since it was last parsed again, and once more when every parse has ended.
  // Parsing it again builds only the file sections whose parses finished, so
  // the batch bounds how long that takes. The parses stop when the viewer
  // closes, or when opening another file ends the progress.
  const parses = options.parses ?? [];
  let stopParses: (() => void) | undefined;
  const endParses = (message?: string) => {
    stopParses?.();
    stopParses = undefined;
    session.showHighlightProgress(null);
    if (message !== undefined) session.showMessage(message);
  };
  const startParses = () => {
    const total = parses.reduce((sum, job) => sum + job.text.length, 0);
    let parsed = 0;
    let shown = 0;
    let unfinished = parses.length;
    const batch = recolorBatch(session.doc.text.length);
    const failures: string[] = [];
    const deliver = (outcomes: readonly ParseOutcome[]) => {
      if (cleanedUp) return;
      if (!session.highlighting) {
        endParses();
        return;
      }
      try {
        for (const outcome of outcomes) {
          const job = parses[outcome.index];
          parsed += job.text.length;
          unfinished--;
          if (outcome.kind === "parsed") {
            job.finish(outcome.result);
          } else {
            job.fail();
            failures.push(outcome.failure);
          }
        }
        if (unfinished > 0) {
          session.showHighlightProgress(parsed / Math.max(1, total));
          // The spinner's next frame draws the gauge.
          if (parsed - shown < batch) return;
          shown = parsed;
          session.reparse({ force: true });
        } else {
          session.reparse({ force: true });
          endParses(
            failures.length === 0 ? undefined : "Some files could not be " +
              `highlighted, and are shown as plain text: ${failures[0]}`,
          );
        }
      } catch (error) {
        endParses(`Highlighting failed: ${describeFailure(error)}`);
      }
      draw();
    };
    session.showHighlightProgress(0);
    try {
      const stop = deps.parseInBackground(parses, deliver);
      // Outcomes delivered before it returned may have ended the parses.
      if (session.highlighting) stopParses = stop;
      else stop();
    } catch (error) {
      endParses(`Highlighting failed: ${describeFailure(error)}`);
    }
    draw(true);
  };

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    stopParses?.();
    taskController?.abort();
    stopWatching();
    cancelQuit?.();
    cancelSpin?.();
    blameController.abort();
    try {
      tty.setRaw(false);
    } catch { /* ignore */ }
    try {
      deps.write(
        (reportingAllKeys ? term.reportKeysAsBefore : "") +
          `${term.disableMouse}${CSI}?7h` +
          term.showCursor +
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

  // The task dialog quits the viewer from outside the key loop when the pull
  // request opens or merges, or when a task ends after it did, once it has
  // given the pull request's address for a moment.
  let cancelQuit: (() => void) | undefined;
  const drawOrQuit = () => {
    if (session.quit) {
      quitting.resolve(null);
      return;
    }
    draw();
    if (session.pullRequestQuitPending) {
      cancelQuit ??= deps.setTimer(() => {
        cancelQuit = undefined;
        session.completePullRequestQuit();
        drawOrQuit();
      }, PULL_REQUEST_QUIT_MS);
    }
  };

  const notWatching = (reason: TaskText) =>
    session.stopPullRequestWatch(reason);

  // While the task dialog is up, the viewer can watch the relay for the
  // delivery that `match` returns the pull request's address for, saying
  // `waiting` while it does. `match` returns null when there is nothing to
  // watch for, as when `origin` is not on GitHub. A watch that cannot start
  // says why in the task dialog, and leaves the task it follows to be
  // reported as it went. The relay keeps nothing for a subscriber that is not
  // connected, so the page that leads to the pull request opening or merging
  // opens once the connection is open or has failed, or once `task`, the
  // task's own signal, aborts, which abandons the connection.
  const startWatching = async (
    settings: ViewSettings,
    task: AbortSignal,
    waiting: TaskText,
    match: () => ((delivery: GitHubDelivery) => string | null) | null,
  ) => {
    try {
      if (!settings.quitOnPullRequest) return;
      const connect = deps.relay(settings.webhookRelay);
      if (connect === undefined) {
        notWatching(say`no webhook relay is set in the settings.`);
        return;
      }
      const matcher = match();
      if (matcher === null) {
        notWatching(say`${name("origin")} is not a GitHub repository.`);
        return;
      }
      if (task.aborted) {
        notWatching(say`the watch was aborted.`);
        return;
      }
      const controller = new AbortController();
      watchController = controller;
      const ready = Promise.withResolvers<void>();
      // What aborts the task draws the dialog itself.
      const abandon = () => {
        controller.abort();
        notWatching(say`the watch was aborted.`);
        ready.resolve();
      };
      task.addEventListener("abort", abandon, { once: true });
      const connecting = session.beginWatchStep(
        say`Connecting to the webhook relay`,
      );
      draw();
      watchForPullRequest(connect, matcher, controller.signal, () => {
        task.removeEventListener("abort", abandon);
        connecting();
        session.beginWatchStep(waiting, "person");
        draw();
        ready.resolve();
      }).then((url) => {
        if (controller.signal.aborted) return;
        session.quitForPullRequest(url);
        drawOrQuit();
      }, (error) => {
        task.removeEventListener("abort", abandon);
        ready.resolve();
        if (controller.signal.aborted) return;
        notWatching(failure(error));
        draw();
      });
      await ready.promise;
    } catch (error) {
      notWatching(failure(error));
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

  /** Shows `text` as a step of the task in the task dialog, and returns the
   * function that shows the step is done. */
  const step: BeginStep = (text, kind) => {
    const done = session.beginTaskStep(text, kind);
    draw();
    return () => {
      done();
      draw();
    };
  };

  // What creating or merging a pull request waits for, such as a security
  // key's touch, shows even when the output was scrolled back.
  const serviceStep: BeginStep = (text, kind) => {
    session.showTaskEnd();
    return step(text, kind);
  };

  const taskOutput: TaskOutput = {
    write: (text) => {
      session.appendTaskOutput(text);
      draw();
    },
    step,
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

  /** Says in the task dialog where it looks for `branch`'s open pull
   * request, and resolves with where that is and the pull request, or null
   * when there is none. */
  const lookForPullRequest = async (branch: string, signal: AbortSignal) => {
    const target = pullRequestTarget(deps.git, branch);
    const looking = step(
      say`Looking for the pull request of ${branch} in ${target.repository}`,
    );
    const found = await findPullRequest(target, signal);
    looking();
    return { target, found };
  };

  // A push, or creating or merging a pull request, that fails leaves a button
  // in the task dialog that tries it again, as `retry` says.
  let retry: { readonly label: string; readonly run: () => void } | null = null;
  const RETRY_CREATE = "Create PR";
  const RETRY_MERGE = "Merge PR";
  const RETRY_PUSH = "Retry push";

  /** Whether trying again what failed with `error` could end otherwise:
   * not when GitHub refused it as a request that cannot succeed. */
  const retryable = (error: unknown) =>
    !(error instanceof GitHubRefusal) || error.retryable;

  /** Ends the task the task dialog shows with `summary`, offering to try
   * again what failed. */
  const endTask = (summary: TaskText) => {
    const label = retry?.label ?? "";
    session.finishTask(
      label === "" ? summary : say`${summary} To retry, press ${label}.`,
      label,
    );
    drawOrQuit();
  };

  // Trying again uses the settings as they are then, so that fixing them,
  // such as the touch-gate token, takes effect, and continues the task
  // dialog's output.
  const retryTask = async (
    work: (settings: ViewSettings, signal: AbortSignal) => Promise<TaskText>,
    declined: TaskText,
  ) => {
    const controller = new AbortController();
    taskController = controller;
    session.continueTask(() => controller.abort());
    draw();
    let summary: TaskText;
    try {
      const settings = readSettings(deps.git);
      // Settings that cannot be read leave the same retry to try again.
      retry = null;
      const tool = settings.pullRequestTool;
      summary = tool === "api" || tool === "touch-gate"
        ? await work(settings, controller.signal)
        : declined;
    } catch (error) {
      summary = say`Git failed: ${failure(error)}`;
    }
    endTask(summary);
  };

  // Creating the pushed branch's pull request, unless one is already open,
  // quits the viewer as the pull request opening would, when the settings
  // say to. A creation that fails, unless GitHub refused it as one that
  // cannot succeed, offers to try it again, which looks for an open pull
  // request first, in case the failed attempt created one.
  const createPullRequest = async (
    settings: ViewSettings,
    branch: string,
    signal: AbortSignal,
  ): Promise<TaskText> => {
    try {
      const { target, found: open } = await lookForPullRequest(branch, signal);
      if (open !== null) {
        return say`Pull request ${
          pullRequest(open.number, open.url)
        } is open: ${link(open.url)}`;
      }
      const { repository, head, remote } = target;
      const asking = step(say`Asking ${remote} which branch is its default`);
      const base = await defaultBranch(
        deps.pushIo(taskOutput, signal).queryAsync,
        remote,
      );
      if (base === null) {
        throw new Error(`${remote}'s default branch is unknown`);
      }
      asking();
      const { title, body } = pullRequestText(deps.git, target, base);
      const creating = step(
        say`Creating a pull request in ${repository} from ${head} into ${base}`,
      );
      const url = await service(settings).create(
        { repository, head, base, title, body },
        serviceStep,
        signal,
      );
      creating();
      if (settings.quitOnPullRequest && PULL_REQUEST_URL.test(url)) {
        session.quitForPullRequest(url);
      }
      return PULL_REQUEST_URL.test(url)
        ? say`Created ${link(url)}`
        : say`Created the pull request: ${quote(url)}`;
    } catch (error) {
      if (retryable(error)) {
        retry = {
          label: RETRY_CREATE,
          run: () =>
            retryTask(
              (settings, signal) => createPullRequest(settings, branch, signal),
              say`The settings no longer create pull requests.`,
            ),
        };
      }
      return signal.aborted
        ? say`Creating the pull request was aborted. It may have been created anyway.`
        : say`Creating the pull request failed: ${failure(error)}`;
    }
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
  ): Promise<TaskText> => {
    let settings: ViewSettings;
    try {
      settings = readSettings(deps.git);
    } catch (error) {
      if (url === null) return [];
      notWatching(failure(error));
      return openPage(io, url);
    }
    const tool = settings.pullRequestTool;
    if (tool === "api" || tool === "touch-gate") {
      return await createPullRequest(settings, branch, signal);
    }
    if (url === null) return [];
    await startWatching(
      settings,
      signal,
      say`Waiting for the pull request to open.`,
      () => {
        const head = pushedHead(deps.git, branch);
        return head && ((delivery) => openedPullRequest(delivery, head));
      },
    );
    return tool === "browser"
      ? openPage(io, url)
      : say`Create a pull request at ${link(url)}`;
  };

  // A push that fails, unless the server refused it, can be tried again, as
  // when the network failed it, asking first as the failed push would have,
  // and keeping to the default branch it kept to. The push dialog's output
  // goes on from how the failed push ended.
  const pushFailed = (output: string, confirmed: boolean, main?: string) => {
    if (!pushRefused(output)) {
      retry = {
        label: RETRY_PUSH,
        run: () => startBranchPush(true, confirmed, main),
      };
    }
  };

  // The default branch origin named before the push dialog asked whether to
  // push, which the push the dialog confirms keeps to.
  let confirmedMain: string | undefined;

  // Pushing a branch that origin already has asks first, saying what the
  // push would do, and which pull request is open from the branch, if one
  // is. A pull request that cannot be looked for, or whose search Abort
  // stops, leaves the push to ask without it.
  const askToPush = async (
    branch: string,
    remote: PushedBranch,
    main: string,
    signal: AbortSignal,
  ): Promise<null> => {
    confirmedMain = main;
    let open: TaskText;
    try {
      const { found } = await lookForPullRequest(branch, signal);
      open = found === null
        ? say`It has no open pull request.`
        : say`Pull request ${
          pullRequest(found.number, found.url)
        } is open from it: ${link(found.url)}`;
    } catch (error) {
      open = signal.aborted
        ? say`Stopped looking for its pull request.`
        : say`Could not look for its pull request: ${failure(error)}`;
    }
    session.confirmPush(say`${describePush(branch, remote)} ${open}`);
    return null;
  };

  // Once the push dialog has asked, or a push has failed, pushing again
  // continues the dialog. A push the user has confirmed asks nothing, and
  // keeps to `main` as origin's default branch when given one.
  const startBranchPush = async (
    again = false,
    confirmed = again,
    main?: string,
  ) => {
    session.branchPushRequested = false;
    session.pushConfirmed = false;
    // A watch is for the push whose dialog it outlived.
    stopWatching();
    const controller = new AbortController();
    taskController = controller;
    if (again) session.continueTask(() => controller.abort());
    else session.beginTask("Push", () => controller.abort());
    retry = null;
    let summary: TaskText | null;
    try {
      const io = deps.pushIo(taskOutput, controller.signal);
      summary = await pushBranch(
        io,
        controller.signal,
        (branch, url) => pushed(io, branch, url, controller.signal),
        (output) => pushFailed(output, confirmed, main),
        confirmed
          ? undefined
          : (branch, remote, main) =>
            askToPush(branch, remote, main, controller.signal),
        main,
      );
    } catch (error) {
      summary = say`Push failed: ${failure(error)}`;
    }
    if (summary === null) draw();
    else endTask(summary);
  };

  // A merge that fails, unless GitHub refused it as one that cannot succeed,
  // offers to try it again, merging the same pull request at the same
  // commit. One that succeeds quits the viewer as the pull
  // request merging would, when the settings say to.
  const mergePullRequest = async (
    request: MergeRequest,
    settings: ViewSettings,
    signal: AbortSignal,
  ): Promise<TaskText> => {
    const { repository, number, method } = request;
    const url = pullRequestUrl(repository, number);
    try {
      const merging = step(
        say`Merging pull request ${
          pullRequest(number, url)
        } of ${repository} by ${method}`,
      );
      await service(settings).merge(request, serviceStep, signal);
      merging();
      if (settings.quitOnPullRequest) session.quitForPullRequest(url);
      return say`Merged ${link(url)}`;
    } catch (error) {
      if (retryable(error)) {
        retry = {
          label: RETRY_MERGE,
          run: () =>
            retryTask(
              (settings, signal) => mergePullRequest(request, settings, signal),
              say`The settings no longer merge pull requests.`,
            ),
        };
      }
      return signal.aborted
        ? say`Landing aborted. The pull request may have merged anyway.`
        : say`Landing failed: ${failure(error)}`;
    }
  };

  // Landing finds the checked-out branch's open pull request, in the user's
  // list when it names one and otherwise by asking GitHub, and then gives
  // its address, opens it, or merges it, as the settings say, all in one
  // task dialog. Keys typed while the pull request is looked for reach no
  // merge button, and Abort stops the search. A merge through the API asks
  // first, and then uses the settings as they were when it asked.
  let mergeSettings: ViewSettings | undefined;

  /** Finds the pull request to land, and lands it as the settings say.
   * Resolves with how that ended, or with null once the task dialog asks
   * whether to merge. */
  const land = async (signal: AbortSignal): Promise<TaskText | null> => {
    const settings = readSettings(deps.git);
    const branch = /^refs\/heads\/(.+)$/.exec(
      deps.git(["symbolic-ref", "--quiet", "HEAD"])?.trim() ?? "",
    )?.[1];
    if (branch === undefined) {
      throw new Error("this checkout is not on a branch");
    }
    const { target, found } = await lookForPullRequest(branch, signal);
    signal.throwIfAborted();
    if (found === null) {
      return say`${branch} has no open pull request in ${target.repository}.`;
    }
    const tool = settings.pullRequestTool;
    if (tool === "link" || tool === "browser") {
      await startWatching(
        settings,
        signal,
        say`Waiting for the pull request to merge.`,
        () => (delivery) =>
          mergedPullRequest(delivery, target.repository, found.number),
      );
      return tool === "browser" && deps.open(found.url)
        ? say`Opened ${link(found.url)}`
        : say`Pull request ${pullRequest(found.number, found.url)}: ${
          link(found.url)
        }`;
    }
    const sha = deps.git(["rev-parse", "--verify", "--quiet", "HEAD"])?.trim();
    if (!sha) throw new Error("nothing is checked out");
    const request = {
      repository: target.repository,
      number: found.number,
      method: await deps.github.mergeMethod(target.repository, signal),
      sha,
    };
    signal.throwIfAborted();
    // A touch of the security key approves a merge through touch-gate, so
    // only a merge through the API asks first.
    if (tool === "touch-gate") {
      return await mergePullRequest(request, settings, signal);
    }
    mergeSettings = settings;
    session.confirmLand(request);
    return null;
  };

  const startLand = async () => {
    session.landRequested = false;
    stopWatching();
    retry = null;
    mergeSettings = undefined;
    const controller = new AbortController();
    taskController = controller;
    session.beginTask("Land", () => controller.abort());
    let summary: TaskText | null;
    try {
      summary = await land(controller.signal);
    } catch (error) {
      summary = controller.signal.aborted
        ? say`Landing aborted.`
        : say`Cannot land: ${failure(error)}`;
    }
    if (summary === null) draw();
    else endTask(summary);
  };

  const startMerge = async (request: MergeRequest, settings: ViewSettings) => {
    session.mergeRequested = null;
    retry = null;
    const controller = new AbortController();
    taskController = controller;
    session.continueTask(() => controller.abort());
    endTask(await mergePullRequest(request, settings, controller.signal));
  };

  const startRequested = () => {
    if (session.branchPushRequested) startBranchPush();
    if (session.pushConfirmed) startBranchPush(true, true, confirmedMain);
    if (session.retryRequested) {
      session.retryRequested = false;
      retry?.run();
    }
    if (session.landRequested) startLand();
    if (session.mergeRequested && mergeSettings) {
      startMerge(session.mergeRequested, mergeSettings);
    }
  };

  try {
    tty.setRaw(true);
    deps.write(
      `${term.enterAltScreen}${term.enableMouse}${term.hideCursor}` +
        (padBg ? term.setDefaultBg(padBg) : ""),
    );
    draw();
    if (parses.length > 0) startParses();
    // Start building the TypeScript program in a worker once the first frame
    // is on screen, so that keys are answered while it builds and the first
    // info card does not pay the one-time build cost.
    semantics?.prewarm();
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
        session.handleKey(key, (push) => {
          // activateButton calls this after capturing the pushed frame and
          // before running the action, so a slow synchronous save leaves the
          // button visibly depressed for the duration of the work.
          startPush(push);
          pushStarted = true;
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
      if (stopParses && !session.highlighting) endParses();
      if (!session.pullRequestQuitPending) {
        cancelQuit?.();
        cancelQuit = undefined;
      }
      // A reveal or a button press draws its own frames, ending on the finished
      // one; otherwise draw the new state now.
      if (!startReveal() && !pushStarted) {
        draw();
        startExpiry(); // starts the clock on the message the draw put up
      }
      if (session.needsReparse) scheduleReparse();
    }
  } finally {
    semantics?.dispose();
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
